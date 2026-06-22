# uninstall.ps1  -  reverse everything setup.ps1 did on this PC.
#
# Run elevated (PowerShell as Administrator):
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#
# By default it: stops + removes the sidecar and wake/prime scheduled tasks,
# removes the firewall rule, clears the Ollama env overrides, and deletes the
# generated config. It does NOT change power settings or delete the model unless
# you ask (those are shared with the rest of your PC / are a big re-download).
#
#   -RevertPower    also disable wake timers + reset the sleep timeout (-SleepTimeoutMin, default 30).
#                   NOTE: disabling wake timers is system-wide (affects e.g. scheduled Windows Update wake).
#   -RemoveModel    also run `ollama rm` for the model (frees ~9 GB; you'd re-pull to reinstall).
#   -Model          model name for -RemoveModel (default qwen3:14b).
#   -GatePort       firewall port to remove (default 11435).
#   -SleepTimeoutMin sleep timeout to restore with -RevertPower (default 30).

[CmdletBinding()]
param(
  [switch] $RevertPower,
  [switch] $RemoveModel,
  [string] $Model           = 'qwen3:14b',
  [int]    $GatePort        = 11435,
  [int]    $SleepTimeoutMin = 30
)

$ErrorActionPreference = 'Continue'  # best-effort teardown: keep going if a piece is already gone

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) { Write-Error 'Run this elevated (PowerShell as Administrator).'; exit 1 }

Write-Host "== Legion home-PC model server uninstall ==" -ForegroundColor Cyan

# 1. stop the running sidecar process(es)
Write-Host "[1/6] Stopping the running sidecar..."
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*readiness-sidecar.ps1*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Host "      killed PID $($_.ProcessId)" } catch { } }

# 2. remove all Legion scheduled tasks (sidecar + every wake/prime)
Write-Host "[2/6] Removing scheduled tasks (Legion Readiness Sidecar, Legion Wake+Prime *)..."
Get-ScheduledTask -ErrorAction SilentlyContinue |
  Where-Object { $_.TaskName -like 'Legion Readiness Sidecar' -or $_.TaskName -like 'Legion Wake+Prime*' } |
  ForEach-Object { Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false; Write-Host "      removed '$($_.TaskName)'" }

# 3. remove the firewall rule
Write-Host "[3/6] Removing the firewall rule..."
Get-NetFirewallRule -DisplayName 'Legion PC sidecar (tailnet)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue

# 4. clear the Ollama env overrides (back to Ollama defaults)
Write-Host "[4/6] Clearing OLLAMA_HOST / OLLAMA_KEEP_ALIVE / OLLAMA_NUM_PARALLEL machine env..."
[Environment]::SetEnvironmentVariable('OLLAMA_HOST', $null, 'Machine')
[Environment]::SetEnvironmentVariable('OLLAMA_KEEP_ALIVE', $null, 'Machine')
[Environment]::SetEnvironmentVariable('OLLAMA_NUM_PARALLEL', $null, 'Machine')
Write-Host "      Restart Ollama (or reboot) for this to take effect." -ForegroundColor Yellow

# 5. delete the generated config
Write-Host "[5/6] Deleting generated config..."
$cfg = Join-Path $PSScriptRoot 'legion-pc.config.ps1'
if (Test-Path $cfg) { Remove-Item $cfg -Force; Write-Host "      removed legion-pc.config.ps1" }

# 6. optional: power revert + model removal
Write-Host "[6/6] Optional reverts..."
if ($RevertPower) {
  Write-Host "      Reverting power: disabling wake timers, sleep timeout -> $SleepTimeoutMin min..."
  & powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP BD3B718A-0680-4D9D-8AB2-E1D2B4AC806D 0
  & powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_SLEEP BD3B718A-0680-4D9D-8AB2-E1D2B4AC806D 0
  & powercfg /CHANGE standby-timeout-ac $SleepTimeoutMin
  & powercfg /SETACTIVE SCHEME_CURRENT
  Write-Host "      (wake timers disabled system-wide; re-enable in Power Options if other apps need them)" -ForegroundColor DarkGray
} else {
  Write-Host "      Leaving power settings as-is (pass -RevertPower to disable wake timers + reset sleep)."
}
if ($RemoveModel) {
  Write-Host "      Removing model $Model..."
  & ollama rm $Model
} else {
  Write-Host "      Leaving the model installed (pass -RemoveModel to free ~12 GB)."
}

Write-Host "`nDONE. The PC no longer serves Legion." -ForegroundColor Green
Write-Host "On the LEGION side, stop routing to this PC by ONE of:" -ForegroundColor Cyan
Write-Host "  - Dashboard: turn OFF 'Use home PC model' (instant, no redeploy), OR"
Write-Host "  - .env: remove HOME_OLLAMA_URL (and HOME_MODEL / HOME_THINK) and redeploy."
Write-Host "Either makes the tiered 'local' provider pure-Oracle again." -ForegroundColor Cyan
