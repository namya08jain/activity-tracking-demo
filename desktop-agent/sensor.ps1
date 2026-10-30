# The desktop helper's sensor. Four times a second it asks Windows the questions a desktop tracking app asks and
# prints the answers as one line of JSON. It reads labels only: when the last key press or mouse move happened,
# the program in front and its window title (the title is used on this laptop to recognise Crizac pages and is
# never sent), whether the screen is locked, and which programs are using the microphone.
# Nothing typed, said or shown on screen is read.
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class TrackerWin {
  [StructLayout(LayoutKind.Sequential)]
  struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int max);

  // The Windows desktop (the wallpaper) is a window of the class Progman or WorkerW inside explorer.exe.
  public static bool IsDesktop(IntPtr window) {
    var name = new StringBuilder(64);
    GetClassName(window, name, 64);
    return name.ToString() == "Progman" || name.ToString() == "WorkerW";
  }

  // The Windows clock tick (milliseconds since start-up) of the last key press or mouse move in this session.
  public static uint LastInputTick() {
    var info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    return GetLastInputInfo(ref info) ? info.dwTime : 0;
  }

  public static uint NowTick() { return unchecked((uint)Environment.TickCount); }

  public static string Title(IntPtr window) {
    var text = new StringBuilder(512);
    GetWindowText(window, text, 512);
    return text.ToString();
  }
}
'@

# Windows announces locking, unlocking, sleeping and waking. If these notices aren't available, the lock screen
# being the program in front (LockApp.exe) still counts as locked.
$script:sessionLocked = $false
try {
  Register-ObjectEvent -InputObject ([Microsoft.Win32.SystemEvents]) -EventName SessionSwitch -SourceIdentifier TrackerSession | Out-Null
  Register-ObjectEvent -InputObject ([Microsoft.Win32.SystemEvents]) -EventName PowerModeChanged -SourceIdentifier TrackerPower | Out-Null
} catch {}

# Which programs are using the microphone right now. Windows notes each program's last use of the microphone
# (what lights up the microphone icon by the clock); a stop time of 0 means "still using it". Desktop programs are
# listed by path with # instead of \ (C:#Program Files#Zoom#bin#Zoom.exe), Store apps by package name.
$micKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
function Get-MicApps {
  $apps = @()
  if (-not (Test-Path $micKey)) { return ,$apps }
  foreach ($key in Get-ChildItem $micKey -Recurse -ErrorAction SilentlyContinue) {
    $values = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
    if ($null -ne $values.LastUsedTimeStop -and $values.LastUsedTimeStop -eq 0 -and $values.LastUsedTimeStart -gt 0) {
      $apps += ($key.PSChildName -split '#')[-1]
    }
  }
  return ,$apps
}

$tick = 0
$micApps = @()
while ($true) {
  $line = [ordered]@{ last = [TrackerWin]::LastInputTick(); now = [TrackerWin]::NowTick() }

  if ($tick % 4 -eq 0) {
    $power = $null
    foreach ($notice in @(Get-Event -ErrorAction SilentlyContinue)) {
      $reason = "$($notice.SourceEventArgs.Reason)$($notice.SourceEventArgs.Mode)"
      if ($reason -eq 'SessionLock') { $script:sessionLocked = $true }
      if ($reason -eq 'SessionUnlock') { $script:sessionLocked = $false }
      if ($reason -eq 'Suspend') { $power = 'sleep' }
      if ($reason -eq 'Resume') { $power = 'wake' }
      Remove-Event -EventIdentifier $notice.EventIdentifier
    }

    $window = [TrackerWin]::GetForegroundWindow()
    $processId = [uint32]0
    [void][TrackerWin]::GetWindowThreadProcessId($window, [ref]$processId)
    $app = ''
    try { $app = (Get-Process -Id $processId).ProcessName + '.exe' } catch {}
    if ([TrackerWin]::IsDesktop($window)) { $app = 'desktop' }
    if ($tick % 8 -eq 0) { $micApps = Get-MicApps }

    $line.app = $app
    $line.title = [TrackerWin]::Title($window)
    $line.locked = $script:sessionLocked -or $app -eq 'LockApp.exe'
    $line.mic = $micApps
    if ($power) { $line.power = $power }
  }

  [Console]::Out.WriteLine(($line | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  $tick++
  Start-Sleep -Milliseconds 250
}
