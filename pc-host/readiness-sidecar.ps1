# readiness-sidecar.ps1
# Tailnet-facing gate in front of the local Ollama. Legion points HOME_OLLAMA_URL
# at this process (http://<pc-tailnet-ip>:11435). Behaviour:
#
#   GET  /ready          -> JSON { ready, reason, gpuFreeMiB, idleSec, ... } (never proxied)
#   GET  /api/tags       -> 503 when busy (Legion's health probe), else proxied to Ollama
#   *    /api/*          -> 503 when busy, else reverse-proxied to the local Ollama
#
# When busy (a fullscreen app, non-Ollama VRAM in use, or a named busy process)
# every /api/* call returns 503 so Legion fails over to the Oracle VM instead of
# stealing the GPU. Ollama itself listens only on 127.0.0.1, so this gate is the
# single network entry point.
#
# CONCURRENCY: a worker POOL services the shared HttpListener so a long-running
# /api/generate (qwen3:14b can think for minutes) NEVER blocks the cheap /ready and
# /api/tags health probes — a single-threaded loop did, which made every concurrent
# agent's 1.5s probe time out and spill the sweep to Oracle. Multiple workers also let
# Ollama's OLLAMA_NUM_PARALLEL slots actually serve more than one agent at a time.
#
# Runs forever; the setup registers it as an at-logon scheduled task that restarts
# on failure. Run manually to test: powershell -ExecutionPolicy Bypass -File readiness-sidecar.ps1

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\legion-pc-common.ps1"
$cfgFile = Join-Path $PSScriptRoot 'legion-pc.config.ps1'
if (Test-Path $cfgFile) { . $cfgFile }  # optional setup-written overrides

$prefix = "http://+:$script:GatePort/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
} catch {
  Write-Error "Failed to bind $prefix. Run the setup script (it registers the sidecar elevated so HttpListener can bind '+'). $_"
  exit 1
}

# How many requests can be in flight at once. Needs to cover OLLAMA_NUM_PARALLEL
# concurrent generates PLUS headroom for the cheap probes that arrive meanwhile.
$workerCount = if ($env:LEGION_SIDECAR_WORKERS) { [int]$env:LEGION_SIDECAR_WORKERS } else { 6 }
Write-Host "[sidecar] listening on $prefix -> $script:OllamaUrl (model $script:Model), $workerCount workers"

# One worker's accept+handle loop. Dot-sources the shared module so it has the busy
# helpers and config in its own runspace; owns its own HttpClient (HttpClient is
# thread-safe, but a per-worker instance keeps the long generate timeout isolated).
$worker = {
  param($listener, $scriptRoot)

  . "$scriptRoot\legion-pc-common.ps1"
  $cfg = Join-Path $scriptRoot 'legion-pc.config.ps1'
  if (Test-Path $cfg) { . $cfg }

  Add-Type -AssemblyName System.Net.Http
  # Generate calls can run for minutes; give the proxy client a generous timeout.
  $http = [System.Net.Http.HttpClient]::new()
  $http.Timeout = [TimeSpan]::FromMinutes(20)

  function Write-Json($context, [int]$status, $obj) {
    $json = $obj | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $context.Response.StatusCode = $status
    $context.Response.ContentType = 'application/json'
    $context.Response.ContentLength64 = $bytes.Length
    $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $context.Response.OutputStream.Close()
  }

  while ($listener.IsListening) {
    $context = $null
    try {
      $context = $listener.GetContext()   # thread-safe; blocks this worker only
      $path = $context.Request.Url.AbsolutePath
      $method = $context.Request.HttpMethod

      # Diagnostic endpoint - never gated, never proxied.
      if ($path -eq '/ready') {
        $b = Get-BusyState
        Write-Json $context 200 @{
          ready            = (-not $b.Busy)
          reason           = $b.Reason
          idleSec          = $b.IdleSec
          fullscreen       = $b.Fullscreen
          nonOllamaVramMiB = $b.NonOllamaVramMiB
          gpuFreeMiB       = (Get-GpuFreeMiB)
          model            = $script:Model
        }
        continue
      }

      # Only Ollama API paths are proxied; everything else is 404.
      if ($path -notlike '/api/*') {
        Write-Json $context 404 @{ error = 'not found' }
        continue
      }

      # Busy gate: fail the probe (and any call) so Legion routes to Oracle.
      $busy = Get-BusyState
      if ($busy.Busy) {
        Write-Json $context 503 @{ ready = $false; reason = $busy.Reason }
        continue
      }

      # Reverse-proxy to the local Ollama.
      $target = "$script:OllamaUrl$($context.Request.Url.PathAndQuery)"
      $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($method), $target)
      if ($context.Request.HasEntityBody) {
        $reader = [System.IO.StreamReader]::new($context.Request.InputStream, $context.Request.ContentEncoding)
        $bodyText = $reader.ReadToEnd(); $reader.Close()
        $ctype = if ($context.Request.ContentType) { $context.Request.ContentType } else { 'application/json' }
        $req.Content = [System.Net.Http.StringContent]::new($bodyText, [System.Text.Encoding]::UTF8, ($ctype -split ';')[0])
      }

      $resp = $http.SendAsync($req).GetAwaiter().GetResult()
      $bytes = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
      $context.Response.StatusCode = [int]$resp.StatusCode
      $context.Response.ContentType = if ($resp.Content.Headers.ContentType) { $resp.Content.Headers.ContentType.ToString() } else { 'application/json' }
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      $context.Response.OutputStream.Close()
    } catch {
      Write-Host "[sidecar] error: $($_.Exception.Message)"
      if ($context) {
        try { Write-Json $context 502 @{ error = 'sidecar proxy error' } } catch { }
      }
    }
  }
}

# Spin up the worker pool, all sharing the one listener, then park the main thread.
$pool = [runspacefactory]::CreateRunspacePool(1, $workerCount)
$pool.Open()
$running = @()
for ($i = 0; $i -lt $workerCount; $i++) {
  $ps = [powershell]::Create()
  $ps.RunspacePool = $pool
  [void]$ps.AddScript($worker).AddArgument($listener).AddArgument($PSScriptRoot)
  $running += [pscustomobject]@{ PS = $ps; Handle = $ps.BeginInvoke() }
}

try {
  while ($listener.IsListening) { Start-Sleep -Seconds 60 }
} finally {
  $listener.Stop()
  foreach ($r in $running) { try { $r.PS.Dispose() } catch { } }
  $pool.Dispose()
}
