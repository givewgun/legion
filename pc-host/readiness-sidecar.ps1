# readiness-sidecar.ps1
# Tailnet-facing gate in front of the local Ollama. Legion points HOME_OLLAMA_URL
# at this process (http://<pc-tailnet-ip>:11435). Behaviour:
#
#   GET  /ready          -> JSON { ready, reason, gpuFreeMiB, idleSec, ... } (never proxied)
#   GET  /api/tags       -> 503 when busy (Legion's health probe), else proxied to Ollama
#   *    /api/*          -> 503 when busy, else reverse-proxied to the local Ollama
#
# When busy (Gun at the keyboard, a fullscreen app, or non-Ollama VRAM in use)
# every /api/* call returns 503 so Legion fails over to the Oracle VM instead of
# stealing the GPU. Ollama itself listens only on 127.0.0.1, so this gate is the
# single network entry point.
#
# Runs forever; the setup registers it as an at-logon scheduled task that restarts
# on failure. Run manually to test: powershell -ExecutionPolicy Bypass -File readiness-sidecar.ps1

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\legion-pc-common.ps1"
$cfgFile = Join-Path $PSScriptRoot 'legion-pc.config.ps1'
if (Test-Path $cfgFile) { . $cfgFile }  # optional setup-written overrides

Add-Type -AssemblyName System.Net.Http

$prefix = "http://+:$script:GatePort/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

# Generate calls can run for minutes; give the proxy client a generous timeout.
$http = [System.Net.Http.HttpClient]::new()
$http.Timeout = [TimeSpan]::FromMinutes(10)

try {
  $listener.Start()
} catch {
  Write-Error "Failed to bind $prefix. Run the setup script (it registers the sidecar elevated so HttpListener can bind '+'). $_"
  exit 1
}
Write-Host "[sidecar] listening on $prefix -> $script:OllamaUrl (model $script:Model)"

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
    $context = $listener.GetContext()
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
      $body = $reader.ReadToEnd(); $reader.Close()
      $ctype = if ($context.Request.ContentType) { $context.Request.ContentType } else { 'application/json' }
      $req.Content = [System.Net.Http.StringContent]::new($body, [System.Text.Encoding]::UTF8, ($ctype -split ';')[0])
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
