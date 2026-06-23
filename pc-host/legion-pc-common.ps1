# legion-pc-common.ps1
# Shared configuration + busy-detection used by the readiness sidecar and the
# prime task. Dot-source this file: `. "$PSScriptRoot\legion-pc-common.ps1"`.
#
# Busy = "Gun is doing something GPU-heavy, do not steal the GPU / interrupt him."
# When busy, the sidecar returns 503 so Legion fails the health probe fast and
# routes the cycle to the Oracle VM instead.
#
# Policy: light desktop use (browsing, typing) is NOT busy — Legion is welcome to
# run then. Only real GPU contention blocks it: an exclusive-fullscreen app, a lot
# of non-Ollama VRAM in use (a game/render), or a named heavy process running.
# Keyboard/mouse input is reported for diagnostics but never marks the box busy.

# ---- Configuration (override via environment variables) ---------------------

# Where the local Ollama actually listens. Setup binds Ollama to localhost only
# (OLLAMA_HOST=127.0.0.1:11434); the sidecar is the sole tailnet-facing process.
$script:OllamaUrl = if ($env:LEGION_OLLAMA_URL) { $env:LEGION_OLLAMA_URL } else { 'http://127.0.0.1:11434' }

# Tailnet-facing gate port. Legion's HOME_OLLAMA_URL must point here, e.g.
# http://<pc-tailnet-ip>:11435
$script:GatePort = if ($env:LEGION_GATE_PORT) { [int]$env:LEGION_GATE_PORT } else { 11435 }

# Model to keep warm / advertise.
$script:Model = if ($env:LEGION_HOME_MODEL) { $env:LEGION_HOME_MODEL } else { 'qwen3:8b' }

# BUSY if non-Ollama processes hold more than this much VRAM (a running game, a
# render, etc.). MiB. Set high enough to clear ordinary desktop/browser GPU use
# (DWM + a browser's hardware acceleration is typically 1-2 GiB) while still
# catching a real game (4 GiB+).
$script:VramThresholdMiB = if ($env:LEGION_VRAM_THRESHOLD_MIB) { [int]$env:LEGION_VRAM_THRESHOLD_MIB } else { 4000 }

# BUSY if any of these processes are running, regardless of VRAM/fullscreen — a
# belt-and-suspenders allowlist for heavy apps to keep off the GPU. Comma-separated
# process names without the .exe suffix (as Get-Process reports them), e.g.
# LEGION_BUSY_PROCESSES="Cyberpunk2077,obs64,Blender". Empty by default (off).
$script:BusyProcesses = if ($env:LEGION_BUSY_PROCESSES) {
  $env:LEGION_BUSY_PROCESSES -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
} else { @() }

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
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO mi);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    const int GWL_STYLE = -16;
    const int WS_CAPTION = 0x00C00000;       // title bar = WS_BORDER | WS_DLGFRAME
    const uint MONITOR_DEFAULTTONEAREST = 2;

    // Process name owning the foreground window, or "" when there is no accessible
    // foreground window - which is what the default desktop sees while the box is
    // locked / on the secure (logon) desktop. Lets the busy check tell a locked or
    // asleep machine (free for Legion) apart from someone actively using it.
    public static string ForegroundProcessName() {
      IntPtr fg = GetForegroundWindow();
      if (fg == IntPtr.Zero) return "";
      uint pid;
      GetWindowThreadProcessId(fg, out pid);
      try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
      catch { return ""; }
    }

    // True only for a real exclusive/borderless full-screen app (a game or a
    // full-screen video): the foreground window must cover its OWN monitor (not the
    // primary one - multi-monitor safe) AND have no title bar. A normal maximized
    // editor/browser keeps WS_CAPTION and is never treated as full-screen, so it no
    // longer falsely marks the box busy.
    public static bool ForegroundIsFullscreen() {
      IntPtr fg = GetForegroundWindow();
      if (fg == IntPtr.Zero) return false;
      if (fg == GetDesktopWindow() || fg == GetShellWindow()) return false;
      if ((GetWindowLong(fg, GWL_STYLE) & WS_CAPTION) == WS_CAPTION) return false;
      RECT r;
      if (!GetWindowRect(fg, out r)) return false;
      IntPtr mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
      MONITORINFO mi = new MONITORINFO();
      mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (!GetMonitorInfo(mon, ref mi)) return false;
      int w = r.Right - r.Left, h = r.Bottom - r.Top;
      int mw = mi.rcMonitor.Right - mi.rcMonitor.Left;
      int mh = mi.rcMonitor.Bottom - mi.rcMonitor.Top;
      return w >= mw && h >= mh;
    }
  }
}
"@
}

function Get-IdleSeconds {
  try { return [Legion.IdleInfo]::IdleSeconds() } catch { return 0 }
}

function Test-ForegroundFullscreen {
  try { return [Legion.IdleInfo]::ForegroundIsFullscreen() } catch { return $false }
}

# Foreground-owning processes that mean the workstation is locked or showing the
# logon UI. The lock screen is itself a borderless, monitor-covering window, so
# without this it would read as a full-screen app — exactly backwards, since a
# locked / asleep box is the BEST time for Legion to use the GPU.
$script:LockScreenProcesses = @('LockApp', 'LogonUI', 'Winlogon')

# True when the session is locked / asleep: either the lock-screen process owns the
# foreground, or there is no accessible foreground window (secure desktop).
function Test-SessionLocked {
  try {
    $name = [Legion.IdleInfo]::ForegroundProcessName()
    return ([string]::IsNullOrEmpty($name) -or $script:LockScreenProcesses -contains $name)
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

# First configured process that is currently running, or $null. Used to keep the
# GPU clear of named heavy apps even when they are windowed / below the VRAM bar.
function Get-RunningBusyProcess {
  foreach ($name in $script:BusyProcesses) {
    if (Get-Process -Name $name -ErrorAction SilentlyContinue) { return $name }
  }
  return $null
}

# Returns a PSCustomObject: Busy (bool), Reason (string), IdleSec, Locked, Fullscreen, NonOllamaVramMiB.
# Input idle time is measured for diagnostics only — light desktop use does not
# mark the box busy; only GPU contention (fullscreen / VRAM / a named process) does.
# A locked / asleep box is treated as FREE: its lock screen is a borderless
# full-screen window, so the fullscreen reason is suppressed while locked. A named
# busy process or real non-Ollama VRAM use still counts even when locked (e.g. a
# background render the user left running).
function Get-BusyState {
  $idle = Get-IdleSeconds
  $locked = Test-SessionLocked
  $full = if ($locked) { $false } else { Test-ForegroundFullscreen }
  $vram = Get-NonOllamaVramMiB
  $proc = Get-RunningBusyProcess
  $reasons = @()
  if ($full) { $reasons += 'fullscreen-app' }
  if ($vram -gt $script:VramThresholdMiB) { $reasons += "non-ollama-vram(${vram}MiB)" }
  if ($proc) { $reasons += "process(${proc})" }
  return [pscustomobject]@{
    Busy             = ($reasons.Count -gt 0)
    Reason           = if ($reasons.Count) { $reasons -join ',' } else { if ($locked) { 'ready(locked)' } else { 'ready' } }
    IdleSec          = [math]::Round($idle)
    Locked           = $locked
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
