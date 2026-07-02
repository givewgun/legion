# readiness-sidecar.ps1
# Tailnet-facing gate in front of the local Ollama. Legion points HOME_OLLAMA_URL
# at this process (http://<pc-tailnet-ip>:11435). Behaviour:
#
#   GET  /ready          -> JSON { ready, reason, gpuFreeMiB, idleSec, ... } (never proxied)
#   GET  /api/tags       -> 503 when busy (model-list probe), else proxied to Ollama
#   *    /api/*          -> 503 when busy, else reverse-proxied to the local Ollama
#
# When busy (a fullscreen app, non-Ollama VRAM in use, or a named busy process)
# every /api/* call returns 503 so Legion fails over to the Oracle VM instead of
# stealing the GPU. Ollama itself listens only on 127.0.0.1, so this gate is the
# single network entry point.
#
# CONCURRENCY — TWO ISOLATED LISTENER POOLS (the key to PC-preferred routing):
# Legion's readiness probe is GET /ready; it must answer in ~1.5s or the agent
# load-sheds to Oracle. A long /api/generate (qwen3 can think for minutes) holds its
# worker the whole time. With a SINGLE shared pool, a full sweep occupies every
# worker and the cheap /ready probe waits behind them, times out, and spills the
# sweep to Oracle even though the PC is merely BUSY WITH OTHER VOTES (not offline).
# To make "busy with votes" mean WAIT (not fall back), /ready gets its own dedicated
# HttpListener + pool that NEVER proxies a generate, so it answers instantly under
# any load. HTTP.sys routes by URL path prefix, so two listeners can share the port:
#   - health listener  (prefix /ready/) : tiny pool, only the cheap busy-state check.
#   - proxy  listener  (prefix /api/)   : main pool, generates + tags (queues behind
#                                          OLLAMA_NUM_PARALLEL slots, the wanted wait).
# Net: PC reachable+idle -> /ready 200 ready:true -> Legion commits & queues on the PC.
#      PC busy-gated (you're gaming) -> /ready 200 ready:false -> Legion -> Oracle.
#      PC offline -> /ready unreachable -> Legion -> Oracle.
#      Ollama down (sidecar alive) -> /ready 200 ready:false -> Legion -> Oracle.
#
# The last case matters because the sidecar is an auto-restarting scheduled task and can
# outlive the Ollama process. Busy-state alone would then answer ready:true while every
# proxied generate 502s, so Legion commits to the PC and the whole sweep abstains with
# "Ollama request failed: 502" instead of falling back. /ready therefore also pings the
# local Ollama (/api/version) before declaring ready.
#
# Runs forever; the setup registers it as an at-logon scheduled task that restarts
# on failure. Run manually to test: powershell -ExecutionPolicy Bypass -File readiness-sidecar.ps1

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\legion-pc-common.ps1"
$cfgFile = Join-Path $PSScriptRoot 'legion-pc.config.ps1'
if (Test-Path $cfgFile) { . $cfgFile }  # optional setup-written overrides

# Two listeners on the one port, split by URL path prefix so each owns an isolated
# HTTP.sys request queue (and thus an isolated worker pool — see header).
$healthPrefix = "http://+:$script:GatePort/ready/"
$apiPrefix    = "http://+:$script:GatePort/api/"
$healthListener = [System.Net.HttpListener]::new()
$healthListener.Prefixes.Add($healthPrefix)
$apiListener = [System.Net.HttpListener]::new()
$apiListener.Prefixes.Add($apiPrefix)

try {
  $healthListener.Start()
  $apiListener.Start()
} catch {
  Write-Error "Failed to bind on port $script:GatePort. Run the setup script (it registers the sidecar elevated so HttpListener can bind '+'). $_"
  exit 1
}

# Proxy pool size: covers OLLAMA_NUM_PARALLEL concurrent generates PLUS headroom for
# /api/tags. Health pool is small and dedicated — it only runs the cheap busy check,
# never a generate, so a couple of workers keep /ready instant under any sweep.
$workerCount = if ($env:LEGION_SIDECAR_WORKERS) { [int]$env:LEGION_SIDECAR_WORKERS } else { 6 }
$healthWorkerCount = if ($env:LEGION_HEALTH_WORKERS) { [int]$env:LEGION_HEALTH_WORKERS } else { 2 }
Write-Host "[sidecar] /ready x$healthWorkerCount, /api x$workerCount on port $script:GatePort -> $script:OllamaUrl (model $script:Model)"

# Shared response helper, dot-sourceable into either worker's runspace.
$writeJson = @'
function Write-Json($context, [int]$status, $obj) {
  $json = $obj | ConvertTo-Json -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $context.Response.StatusCode = $status
  $context.Response.ContentType = 'application/json'
  $context.Response.ContentLength64 = $bytes.Length
  $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $context.Response.OutputStream.Close()
}
'@

# Health worker: serves ONLY /ready off the health listener. Never proxies, so it can
# never be blocked by an in-flight generate — that isolation is the whole point.
$healthWorker = {
  param($listener, $scriptRoot, $writeJson)

  . "$scriptRoot\legion-pc-common.ps1"
  $cfg = Join-Path $scriptRoot 'legion-pc.config.ps1'
  if (Test-Path $cfg) { . $cfg }
  Invoke-Expression $writeJson

  Add-Type -AssemblyName System.Net.Http
  # Ollama liveness ping stays cheap: a live localhost server answers /api/version in ~ms
  # and a dead one refuses the connection instantly. The timeout only bounds a hung
  # process, and stays well under Legion's probe timeout so /ready itself never stalls.
  $http = [System.Net.Http.HttpClient]::new()
  $http.Timeout = [TimeSpan]::FromSeconds(2)

  while ($listener.IsListening) {
    $context = $null
    try {
      $context = $listener.GetContext()
      $ollamaUp = $false
      try {
        $ollamaUp = $http.GetAsync("$script:OllamaUrl/api/version").GetAwaiter().GetResult().IsSuccessStatusCode
      } catch { }
      $b = Get-BusyState
      $reason = if (-not $ollamaUp) { 'ollama down' } else { $b.Reason }
      Write-Json $context 200 @{
        ready            = ($ollamaUp -and -not $b.Busy)
        reason           = $reason
        idleSec          = $b.IdleSec
        locked           = $b.Locked
        fullscreen       = $b.Fullscreen
        nonOllamaVramMiB = $b.NonOllamaVramMiB
        gpuFreeMiB       = (Get-GpuFreeMiB)
        model            = $script:Model
      }
    } catch {
      Write-Host "[sidecar] health error: $($_.Exception.Message)"
      if ($context) { try { Write-Json $context 500 @{ error = 'health error' } } catch { } }
    }
  }
}

# Proxy worker: serves /api/* off the api listener. Dot-sources the shared module so it
# has the busy helpers and config in its own runspace; owns its own HttpClient
# (thread-safe, but a per-worker instance keeps the long generate timeout isolated).
$worker = {
  param($listener, $scriptRoot, $writeJson)

  . "$scriptRoot\legion-pc-common.ps1"
  $cfg = Join-Path $scriptRoot 'legion-pc.config.ps1'
  if (Test-Path $cfg) { . $cfg }
  Invoke-Expression $writeJson

  Add-Type -AssemblyName System.Net.Http
  # Generate calls can run for minutes; give the proxy client a generous timeout.
  $http = [System.Net.Http.HttpClient]::new()
  $http.Timeout = [TimeSpan]::FromMinutes(20)

  while ($listener.IsListening) {
    $context = $null
    try {
      $context = $listener.GetContext()   # thread-safe; blocks this worker only
      $path = $context.Request.Url.AbsolutePath
      $method = $context.Request.HttpMethod

      # Only Ollama API paths reach this listener; guard anything else as 404.
      if ($path -notlike '/api/*') {
        Write-Json $context 404 @{ error = 'not found' }
        continue
      }

      # Busy gate: fail any call so Legion routes to Oracle.
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

# Spin up both pools (each bound to its own listener), then park the main thread.
$pool = [runspacefactory]::CreateRunspacePool(1, $workerCount + $healthWorkerCount)
$pool.Open()
$running = @()
$spawn = {
  param($script, $listener)
  $ps = [powershell]::Create()
  $ps.RunspacePool = $pool
  [void]$ps.AddScript($script).AddArgument($listener).AddArgument($PSScriptRoot).AddArgument($writeJson)
  $script:running += [pscustomobject]@{ PS = $ps; Handle = $ps.BeginInvoke() }
}
for ($i = 0; $i -lt $healthWorkerCount; $i++) { & $spawn $healthWorker $healthListener }
for ($i = 0; $i -lt $workerCount; $i++) { & $spawn $worker $apiListener }

try {
  while ($healthListener.IsListening -and $apiListener.IsListening) { Start-Sleep -Seconds 60 }
} finally {
  $healthListener.Stop()
  $apiListener.Stop()
  foreach ($r in $running) { try { $r.PS.Dispose() } catch { } }
  $pool.Dispose()
}
