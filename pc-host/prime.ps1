# prime.ps1
# Fired by the RTC-wake scheduled task ~10 minutes before each cycle. Warms the
# model into VRAM so the first vote of the sweep is fast - but only when it makes
# sense: skip on US market-closed days, and skip while Gun is using the PC.
#
# The wake tasks fire every local day (TZ conversion makes weekday mapping
# fragile), so this guards on the actual US trading calendar instead.

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\legion-pc-common.ps1"
$cfgFile = Join-Path $PSScriptRoot 'legion-pc.config.ps1'
if (Test-Path $cfgFile) { . $cfgFile }

if (-not (Test-UsTradingDay)) {
  Write-Host "[prime] US market closed today (ET weekend) - not warming; box will idle-sleep."
  exit 0
}

$busy = Get-BusyState
if ($busy.Busy) {
  Write-Host "[prime] busy ($($busy.Reason)) - not warming; Gun is using the PC."
  exit 0
}

Write-Host "[prime] warming $script:Model (keep_alive $script:KeepAlive)..."
try {
  $body = @{ model = $script:Model; prompt = 'warmup'; stream = $false; keep_alive = $script:KeepAlive } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$script:OllamaUrl/api/generate" -Body $body -ContentType 'application/json' -TimeoutSec 600 | Out-Null
  Write-Host "[prime] model resident."
} catch {
  Write-Host "[prime] warm failed: $($_.Exception.Message) (cycle will cold-load on first call)."
  exit 1
}
