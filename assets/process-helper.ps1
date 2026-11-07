# cc-session-manager process helper, for FR-17 (End and Force end) on Windows.
# See docs/design.md, "Ending an interactive session".
#
# Usage:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File process-helper.ps1 `
#     -Action <inspect|break|force> -TargetPid <n> -StartedAtMs <n> [-ExpectedStartMs <n>]
#
# -ExpectedStartMs, if given, must match the process's start time, so Force end only acts on
# the process that got the normal close.
#
# Arguments are numbers only. The helper writes one JSON object to stdout and exits 0 when it
# ran, even if it refused or was unavailable. Exit code 1 means it couldn't run at all.
#
# Its one guarantee: it never signals or ends a process other than the verified session and
# descendants verified by start time. When in doubt, it refuses.

param(
  [Parameter(Mandatory = $true)][ValidateSet('inspect', 'break', 'force')][string]$Action,
  [Parameter(Mandatory = $true)][ValidateRange(1, [int]::MaxValue)][int]$TargetPid,
  [Parameter(Mandatory = $true)][ValidateRange(1, [long]::MaxValue)][long]$StartedAtMs,
  [ValidateRange(0, [long]::MaxValue)][long]$ExpectedStartMs = 0
)

$ErrorActionPreference = 'Stop'

# The process must have started no more than 5 s before the listing's startedAt, and no more
# than 1 s after it.
$WindowBeforeMs = 5000
$WindowAfterMs = 1000
# Allowed difference between a process's start time read through .NET and through CIM.
$StartToleranceMs = 2

function Write-Result([hashtable]$result) {
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
}

# Constrained Language Mode, or a policy that blocks Add-Type, makes the helper unavailable.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Result @{ ok = $false; action = $Action; reason = 'unavailable'; detail = 'language-mode' }
  exit 0
}
try {
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

  static string Describe(uint pid) {
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }

  // A console member is allowed only if its ID is in the allowed list and its start time,
  // read now, matches the start time from the snapshot, so a reused ID isn't accepted.
  static bool IsAllowed(uint pid, Dictionary<uint, long> allowed, long toleranceMs) {
    long expected;
    if (!allowed.TryGetValue(pid, out expected)) return false;
    try {
      long actual = StartMs(Process.GetProcessById((int)pid));
      return Math.Abs(actual - expected) <= toleranceMs;
    } catch {
      return false;
    }
  }

  // Attaches to the target's console, lists its members, and sends Ctrl+Break only if every
  // member is allowed. The caller holds a handle on the target throughout.
  public static string BreakIfSafe(uint targetPid, uint[] allowedIds, long[] allowedStarts,
      long toleranceMs, bool send, out uint[] members, out string unexpectedImage) {
    members = new uint[0];
    unexpectedImage = "";
    var allowed = new Dictionary<uint, long>();
    for (int i = 0; i < allowedIds.Length; i++) allowed[allowedIds[i]] = allowedStarts[i];

    FreeConsole();
    if (!AttachConsole(targetPid)) {
      return "no-console:" + Marshal.GetLastWin32Error();
    }
    try {
      // Register only after attaching. A handler registered before attaching was found not to
      // run, so the break ended this helper before it could report.
      SetConsoleCtrlHandler(Ignore, true);
      uint[] list = new uint[1024];
      uint n = GetConsoleProcessList(list, (uint)list.Length);
      if (n == 0 || n > list.Length) return "member-list-failed";
      uint self = (uint)Process.GetCurrentProcess().Id;
      var others = new List<uint>();
      uint unexpected = 0;
      for (int i = 0; i < n; i++) {
        if (list[i] == self) continue;
        others.Add(list[i]);
        if (unexpected == 0 && !IsAllowed(list[i], allowed, toleranceMs)) unexpected = list[i];
      }
      members = others.ToArray();
      if (unexpected != 0) {
        unexpectedImage = Describe(unexpected);
        return "unexpected-member:" + unexpected;
      }
      if (!send) return "ok";
      if (!GenerateConsoleCtrlEvent(1, 0)) return "send-failed:" + Marshal.GetLastWin32Error();
      // Give the event time to arrive before detaching, so this process still handles it.
      Thread.Sleep(300);
      return "sent";
    } finally {
      // Detach first, so a late Ctrl+Break can't reach this process once its handler is gone.
      FreeConsole();
      SetConsoleCtrlHandler(Ignore, false);
    }
  }
}
'@
} catch {
  Write-Result @{ ok = $false; action = $Action; reason = 'unavailable'; detail = 'add-type' }
  exit 0
}

function ConvertTo-UnixMs($dateTime) {
  return [DateTimeOffset]::new($dateTime.ToUniversalTime()).ToUnixTimeMilliseconds()
}

try {
  # Open the target first and hold it, so its process ID can't be reused until this script ends.
  try {
    $target = [System.Diagnostics.Process]::GetProcessById($TargetPid)
  } catch {
    Write-Result @{ ok = $false; action = $Action; reason = 'not-running' }
    exit 0
  }
  try {
    $null = $target.Handle
    $startMs = [CcsmConsole]::StartMs($target)
  } catch {
    Write-Result @{ ok = $false; action = $Action; reason = 'access-denied' }
    exit 0
  }

  $imageName = $target.ProcessName
  if ($imageName -ne 'claude') {
    Write-Result @{ ok = $false; action = $Action; reason = 'wrong-image'; image = $imageName }
    exit 0
  }
  if ($ExpectedStartMs -gt 0 -and [Math]::Abs($startMs - $ExpectedStartMs) -gt $StartToleranceMs) {
    Write-Result @{ ok = $false; action = $Action; reason = 'start-time-mismatch'; startMs = $startMs }
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

  # An exited process leaves the snapshot even while a handle is held. Without its entry, the
  # descendant check would have no start time to compare, so refuse instead.
  if (-not $procs.ContainsKey($TargetPid) -or
      [Math]::Abs($procs[$TargetPid].StartMs - $startMs) -gt $StartToleranceMs -or
      $target.HasExited) {
    Write-Result @{ ok = $false; action = $Action; reason = 'target-exited' }
    exit 0
  }

  $ancestors = @()
  $visited = @{ $TargetPid = $true }
  $current = $procs[$TargetPid]
  while ($current -and $procs.ContainsKey($current.Parent) -and -not $visited.ContainsKey($current.Parent)) {
    $parent = $procs[$current.Parent]
    if ($parent.StartMs -gt $current.StartMs) { break }
    $visited[$parent.Id] = $true
    $ancestors += $parent.Id
    $current = $parent
  }

  $descendants = @()
  $seen = @{ $TargetPid = $true }
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($TargetPid)
  while ($queue.Count -gt 0) {
    $parentId = $queue.Dequeue()
    if (-not $procs.ContainsKey($parentId)) { continue }
    $parentStart = $procs[$parentId].StartMs
    if ($null -eq $parentStart) { continue }
    foreach ($child in $procs.Values) {
      if ($child.Parent -eq $parentId -and -not $seen.ContainsKey($child.Id) -and $child.StartMs -ge $parentStart) {
        $seen[$child.Id] = $true
        $descendants += $child.Id
        $queue.Enqueue($child.Id)
      }
    }
  }

  $allowedIds = [uint32[]](@($TargetPid) + $ancestors + $descendants)
  $allowedStarts = [long[]]@($allowedIds | ForEach-Object { $procs[[int]$_].StartMs })

  switch ($Action) {
    'inspect' {
      $members = $null
      $image = $null
      $status = [CcsmConsole]::BreakIfSafe([uint32]$TargetPid, $allowedIds, $allowedStarts,
        $StartToleranceMs, $false, [ref]$members, [ref]$image)
      Write-Result @{
        ok = ($status -eq 'ok'); action = $Action; reason = $status; startMs = $startMs
        ancestors = @($ancestors); descendants = @($descendants); members = @($members)
        unexpectedImage = $image
      }
    }
    'break' {
      $members = $null
      $image = $null
      $status = [CcsmConsole]::BreakIfSafe([uint32]$TargetPid, $allowedIds, $allowedStarts,
        $StartToleranceMs, $true, [ref]$members, [ref]$image)
      Write-Result @{
        ok = ($status -eq 'sent'); action = $Action; reason = $status; startMs = $startMs
        members = @($members); unexpectedImage = $image
      }
    }
    'force' {
      # Open every handle before ending anything, and re-check each start time through it.
      $held = @($target)
      foreach ($id in $descendants) {
        try {
          $p = [System.Diagnostics.Process]::GetProcessById($id)
          $null = $p.Handle
          if ([Math]::Abs([CcsmConsole]::StartMs($p) - $procs[$id].StartMs) -le $StartToleranceMs) { $held += $p }
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
      Write-Result @{ ok = $endedTarget; action = $Action; reason = $reason; ended = @($ended) }
    }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine("helper error: $($_.Exception.Message)")
  exit 1
}
