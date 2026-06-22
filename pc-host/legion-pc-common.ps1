# legion-pc-common.ps1
# Shared configuration + busy-detection used by the readiness sidecar and the
# prime task. Dot-source this file: `. "$PSScriptRoot\legion-pc-common.ps1"`.
#
# Busy = "Gun is using the PC, do not steal the GPU / interrupt him." When busy,
# the sidecar returns 503 so Legion fails the health probe fast and routes the
# cycle to the Oracle VM instead.

# ---- Configuration (override via environment variables) ---------------------

# Where the local Ollama actually listens. Setup binds Ollama to localhost only
# (OLLAMA_HOST=127.0.0.1:11434); the sidecar is the sole tailnet-facing process.
$script:OllamaUrl = if ($env:LEGION_OLLAMA_URL) { $env:LEGION_OLLAMA_URL } else { 'http://127.0.0.1:11434' }

# Tailnet-facing gate port. Legion's HOME_OLLAMA_URL must point here, e.g.
# http://<pc-tailnet-ip>:11435
$script:GatePort = if ($env:LEGION_GATE_PORT) { [int]$env:LEGION_GATE_PORT } else { 11435 }

# Model to keep warm / advertise.
$script:Model = if ($env:LEGION_HOME_MODEL) { $env:LEGION_HOME_MODEL } else { 'qwen3:14b' }

# BUSY if the user touched the keyboard/mouse within this many seconds.
$script:IdleThresholdSec = if ($env:LEGION_IDLE_THRESHOLD_SEC) { [int]$env:LEGION_IDLE_THRESHOLD_SEC } else { 300 }

# BUSY if non-Ollama processes hold more than this much VRAM (a running game,
# a render, etc.). MiB.
$script:VramThresholdMiB = if ($env:LEGION_VRAM_THRESHOLD_MIB) { [int]$env:LEGION_VRAM_THRESHOLD_MIB } else { 2000 }

# How long Ollama keeps the model resident after the last call. Covers a whole
# back-to-back sweep, then unloads to free VRAM between the 11:00 and 17:00 cycles.
$script:KeepAlive = if ($env:LEGION_KEEP_ALIVE) { $env:LEGION_KEEP_ALIVE } else { '90m' }

# ---- Win32 input-idle probe -------------------------------------------------
# GetLastInputInfo reports ms since the last keyboard/mouse input in the calling
# interactive session. The sidecar/prime MUST run in Gun's logged-in session
# (the setup registers them as user tasks) for this to be meaningful.

if (-not ([System.Management.Automation.PSTypeName]'Legion.IdleInfo').Type) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
namespace Legion {
  public static class IdleInfo {
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("kernel32.dll")] static extern uint GetTickCount();
    public static double IdleSeconds() {
      LASTINPUTINFO lii = new LASTINPUTINFO();
      lii.cbSize = (uint)Marshal.SizeOf(lii);
      if (!GetLastInputInfo(ref lii)) return 0;
      return (GetTickCount() - lii.dwTime) / 1000.0;
    }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    // True when the foreground window covers (or exceeds) the full virtual
    // screen and is not the desktop/shell - i.e. an exclusive-fullscreen game
    // or video. screenW/H are passed in from PowerShell (System.Windows.Forms).
    public static bool ForegroundIsFullscreen(int screenW, int screenH) {
      IntPtr fg = GetForegroundWindow();
      if (fg == IntPtr.Zero) return false;
      if (fg == GetDesktopWindow() || fg == GetShellWindow()) return false;
      RECT r;
      if (!GetWindowRect(fg, out r)) return false;
      int w = r.Right - r.Left;
      int h = r.Bottom - r.Top;
      return w >= screenW && h >= screenH;
    }
  }
}
"@
}

function Get-IdleSeconds {
  try { return [Legion.IdleInfo]::IdleSeconds() } catch { return 0 }
}

function Test-ForegroundFullscreen {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    return [Legion.IdleInfo]::ForegroundIsFullscreen($b.Width, $b.Height)
  } catch { return $false }
}

# Sum of VRAM (MiB) held by processes that are NOT Ollama. nvidia-smi lists each
# compute/graphics app; we subtract anything named *ollama*. If nvidia-smi is
# missing or errors, return 0 so a tooling gap never falsely marks the box busy.
function Get-NonOllamaVramMiB {
  try {
    $lines = & nvidia-smi --query-compute-apps=process_name,used_memory --format=csv,noheader,nounits 2>$null
    if (-not $lines) { return 0 }
    $sum = 0
    foreach ($line in $lines) {
      $parts = $line -split ','
      if ($parts.Count -lt 2) { continue }
      $name = $parts[0].Trim()
      $used = 0; [int]::TryParse($parts[1].Trim(), [ref]$used) | Out-Null
      if ($name -notlike '*ollama*') { $sum += $used }
    }
    return $sum
  } catch { return 0 }
}

# Returns a PSCustomObject: Busy (bool), Reason (string), IdleSec, Fullscreen, NonOllamaVramMiB.
function Get-BusyState {
  $idle = Get-IdleSeconds
  $full = Test-ForegroundFullscreen
  $vram = Get-NonOllamaVramMiB
  $reasons = @()
  if ($idle -lt $script:IdleThresholdSec) { $reasons += "recent-input(${idle}s)" }
  if ($full) { $reasons += 'fullscreen-app' }
  if ($vram -gt $script:VramThresholdMiB) { $reasons += "non-ollama-vram(${vram}MiB)" }
  return [pscustomobject]@{
    Busy             = ($reasons.Count -gt 0)
    Reason           = if ($reasons.Count) { $reasons -join ',' } else { 'ready' }
    IdleSec          = [math]::Round($idle)
    Fullscreen       = $full
    NonOllamaVramMiB = $vram
  }
}

# Free VRAM (MiB) across GPU 0, for the /ready diagnostic. 0 if nvidia-smi absent.
function Get-GpuFreeMiB {
  try {
    $out = & nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    $free = 0; [int]::TryParse(("$out").Trim(), [ref]$free) | Out-Null
    return $free
  } catch { return 0 }
}

# True on US trading weekdays (Mon-Fri in America/New_York). The wake tasks fire
# every local day (TZ conversion makes weekday-mapping fragile), so prime uses
# this to skip warming the GPU on days the US market is closed.
function Test-UsTradingDay {
  try {
    $etz = [System.TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time')
    $nowEt = [System.TimeZoneInfo]::ConvertTime([datetime]::UtcNow, [System.TimeZoneInfo]::Utc, $etz)
    return ($nowEt.DayOfWeek -ne [System.DayOfWeek]::Saturday -and $nowEt.DayOfWeek -ne [System.DayOfWeek]::Sunday)
  } catch { return $true } # fail-open: warm anyway if TZ lookup fails
}
