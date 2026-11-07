# cc-session-manager process helper, for FR-17 (End and Force end) on Windows.
# See docs/design.md, "Ending an interactive session".
#
# Usage:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File process-helper.ps1 `
#     -Action <inspect|break|force> -TargetPid <n> -StartedAtMs <n>
#
# Arguments are numbers only. The helper writes one JSON object to stdout and exits 0 when it
# ran, even if it refused. Exit code 1 means it couldn't run at all.

param(
  [Parameter(Mandatory = $true)][ValidateSet('inspect', 'break', 'force')][string]$Action,
  [Parameter(Mandatory = $true)][ValidateRange(1, [int]::MaxValue)][int]$TargetPid,
  [Parameter(Mandatory = $true)][ValidateRange(1, [long]::MaxValue)][long]$StartedAtMs
)

$ErrorActionPreference = 'Stop'

# The process must have started no more than 5 s before the listing's startedAt, and no more
# than 1 s after it.
$WindowBeforeMs = 5000
$WindowAfterMs = 1000

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class CcsmConsole {
  [DllImport("kernel32", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32", SetLastError = true)] static extern bool AttachConsole(uint pid);
  public delegate bool Handler(uint ctrlType);
  [DllImport("kernel32", SetLastError = true)] static extern bool SetConsoleCtrlHandler(Handler h, bool add);
  [DllImport("kernel32", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
  [DllImport("kernel32", SetLastError = true)] static extern uint GetConsoleProcessList(uint[] list, uint count);

  // Kept in a static field so the delegate isn't garbage collected while registered.
  static readonly Handler Ignore = delegate (uint t) { return true; };

  public static long StartMs(Process p) {
    return new DateTimeOffset(p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();
  }

  // Attaches to the target's console, lists its members, and sends Ctrl+Break only if every
  // member is in the allowed set. The caller holds a handle on the target throughout.
  public static string BreakIfSafe(uint targetPid, uint[] allowed, bool send, out uint[] members) {
    members = new uint[0];
    FreeConsole();
    if (!AttachConsole(targetPid)) {
      return "no-console:" + Marshal.GetLastWin32Error();
    }
    // Register only after attaching. A handler registered before attaching was found not to
    // run, so the break ended this helper before it could report.
    SetConsoleCtrlHandler(Ignore, true);
    try {
      uint[] list = new uint[256];
      uint n = GetConsoleProcessList(list, (uint)list.Length);
      if (n == 0 || n > list.Length) return "member-list-failed";
      uint self = (uint)Process.GetCurrentProcess().Id;
      var others = new List<uint>();
      var allowedSet = new HashSet<uint>(allowed);
      uint unexpected = 0;
      for (int i = 0; i < n; i++) {
        if (list[i] == self) continue;
        others.Add(list[i]);
        if (unexpected == 0 && !allowedSet.Contains(list[i])) unexpected = list[i];
      }
      members = others.ToArray();
      if (unexpected != 0) return "unexpected-member:" + unexpected;
      if (!send) return "ok";
      if (!GenerateConsoleCtrlEvent(1, 0)) return "send-failed:" + Marshal.GetLastWin32Error();
      // Give the event time to arrive before detaching, so this process still handles it.
      Thread.Sleep(300);
      return "sent";
    } finally {
      FreeConsole();
    }
  }
}
'@

function Write-Result([hashtable]$result) {
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
}

function ConvertTo-UnixMs($dateTime) {
  return [DateTimeOffset]::new($dateTime.ToUniversalTime()).ToUnixTimeMilliseconds()
}

try {
  # Open the target first and hold it, so its process ID can't be reused until this script ends.
  try {
    $target = [System.Diagnostics.Process]::GetProcessById($TargetPid)
    $null = $target.Handle
  } catch {
    Write-Result @{ ok = $false; action = $Action; reason = 'not-running' }
    exit 0
  }

  $imageName = $target.ProcessName
  $startMs = [CcsmConsole]::StartMs($target)
  if ($imageName -ne 'claude') {
    Write-Result @{ ok = $false; action = $Action; reason = 'wrong-image'; image = $imageName }
    exit 0
  }
  if ($startMs -lt ($StartedAtMs - $WindowBeforeMs) -or $startMs -gt ($StartedAtMs + $WindowAfterMs)) {
    Write-Result @{ ok = $false; action = $Action; reason = 'start-time-mismatch'; startMs = $startMs }
    exit 0
  }

  # One snapshot of the process table, for ancestors and descendants. A link only counts when
  # the parent started before the child, because process IDs are reused.
  $procs = @{}
  foreach ($p in Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate) {
    $procs[[int]$p.ProcessId] = [pscustomobject]@{
      Id = [int]$p.ProcessId
      Parent = [int]$p.ParentProcessId
      StartMs = (ConvertTo-UnixMs $p.CreationDate)
    }
  }

  $ancestors = @()
  $current = $procs[$TargetPid]
  while ($current -and $procs.ContainsKey($current.Parent)) {
    $parent = $procs[$current.Parent]
    if ($parent.StartMs -gt $current.StartMs) { break }
    $ancestors += $parent.Id
    $current = $parent
  }

  $descendants = @()
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($TargetPid)
  while ($queue.Count -gt 0) {
    $parentId = $queue.Dequeue()
    $parentStart = $procs[$parentId].StartMs
    foreach ($child in $procs.Values) {
      if ($child.Parent -eq $parentId -and $child.StartMs -ge $parentStart -and $child.Id -ne $parentId) {
        $descendants += $child.Id
        $queue.Enqueue($child.Id)
      }
    }
  }

  $allowed = [uint32[]](@($TargetPid) + $ancestors + $descendants)

  switch ($Action) {
    'inspect' {
      $members = $null
      $status = [CcsmConsole]::BreakIfSafe([uint32]$TargetPid, $allowed, $false, [ref]$members)
      Write-Result @{
        ok = ($status -eq 'ok'); action = $Action; reason = $status; startMs = $startMs
        ancestors = $ancestors; descendants = $descendants; members = @($members)
      }
    }
    'break' {
      $members = $null
      $status = [CcsmConsole]::BreakIfSafe([uint32]$TargetPid, $allowed, $true, [ref]$members)
      Write-Result @{
        ok = ($status -eq 'sent'); action = $Action; reason = $status; startMs = $startMs
        members = @($members)
      }
    }
    'force' {
      # Open every handle before ending anything, and re-check each start time through it.
      $held = @($target)
      foreach ($id in $descendants) {
        try {
          $p = [System.Diagnostics.Process]::GetProcessById($id)
          $null = $p.Handle
          if ([CcsmConsole]::StartMs($p) -eq $procs[$id].StartMs) { $held += $p }
        } catch { }
      }
      $ended = @()
      foreach ($p in $held) {
        try {
          if (-not $p.HasExited) { $p.Kill(); $ended += $p.Id }
        } catch { }
      }
      $endedTarget = $ended -contains $TargetPid
      $reason = if ($endedTarget) { 'ended' } else { 'target-not-ended' }
      Write-Result @{ ok = $endedTarget; action = $Action; reason = $reason; ended = $ended }
    }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine("helper error: $($_.Exception.Message)")
  exit 1
}
