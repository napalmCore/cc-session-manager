# cc-session-manager process helper, for FR-17 (End and Force end) and FR-27 (leftover
# programs) on Windows. See docs/design.md, "Ending an interactive session" and "Leftover
# programs".
#
# Usage:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File process-helper.ps1 `
#     -Action <inspect|break|force|record> -TargetPid <n> -StartedAtMs <n> `
#     [-ExpectedStartMs <n>] [-ToolPid <n>] [-Record]
#   powershell.exe ... -File process-helper.ps1 -Action <check|end-leftovers> [-ToolPid <n>]
#     with JSON on standard input
#
# -ExpectedStartMs must match the process's start time, so Force end only acts on the process
# that got the normal close. It's required for force.
#
# -Record, with break or force, records the session's programs before the signal, within its
# own 4-second budget. -ToolPid is the tool's own process, whose family is never recorded.
#
# check reads { "processes": [{ "pid", "startMs" }], "parents": [{ "pid", "startMs" }] } and
# reports which processes still run, and new children of the parents that still run.
# end-leftovers reads { "entries": [{ "pid", "startMs", "path" }] } and ends each entry whose
# start time and image path still match, through one handle. It never ends a process tree.
#
# Arguments are numbers only. The helper writes one JSON object to stdout and exits 0 when it
# ran, even if it refused or was unavailable. Exit code 1 means it couldn't run at all.
#
# Its one guarantee: it never signals or ends a process other than the verified session,
# descendants verified by start time, or recorded entries verified by start time and image
# path. When in doubt, it refuses.

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('inspect', 'break', 'force', 'record', 'check', 'end-leftovers')][string]$Action,
  [ValidateRange(0, [int]::MaxValue)][int]$TargetPid = 0,
  [ValidateRange(0, [long]::MaxValue)][long]$StartedAtMs = 0,
  [ValidateRange(0, [long]::MaxValue)][long]$ExpectedStartMs = 0,
  [ValidateRange(0, [int]::MaxValue)][int]$ToolPid = 0,
  [switch]$Record
)

$ErrorActionPreference = 'Stop'

# Node writes and reads UTF-8; Windows PowerShell would otherwise use the OEM code page, and a
# path with a non-ASCII character would no longer match.
try {
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }

$SessionActions = @('inspect', 'break', 'force', 'record')
if ($SessionActions -contains $Action -and ($TargetPid -le 0 -or $StartedAtMs -le 0)) {
  [Console]::Error.WriteLine('helper error: -TargetPid and -StartedAtMs are required')
  exit 1
}
# Recording gets its own budget, so a slow record never makes End fail.
$RecordBudgetMs = if ($Action -eq 'record') { 8000 } else { 4000 }
# Console hosts exit with their consoles, and Claude Code's own processes are never leftovers.
$NeverRecorded = @('claude.exe', 'conhost.exe', 'openconsole.exe')
# Limits on standard input, so a bad caller can't make the helper work for long.
$MaxInputChars = 1048576
$MaxEntries = 2000

# The process must have started no more than 5 s before the listing's startedAt, and no more
# than 1 s after it.
$WindowBeforeMs = 5000
$WindowAfterMs = 1000
# Allowed difference between a process's start time read through .NET and through CIM.
$StartToleranceMs = 2

function Write-Result([hashtable]$result) {
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 6))
}

# Constrained Language Mode, or a policy that blocks Add-Type, makes the helper unavailable.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Result @{ ok = $false; action = $Action; reason = 'unavailable'; detail = 'language-mode' }
  exit 0
}
function ConvertTo-UnixMs($dateTime) {
  return [DateTimeOffset]::new($dateTime.ToUniversalTime()).ToUnixTimeMilliseconds()
}

# One snapshot of the process table. A parent link only counts when the parent started
# before the child, because process IDs are reused.
function Get-ProcessTable([bool]$withImages) {
  $properties = @('ProcessId', 'ParentProcessId', 'CreationDate')
  if ($withImages) { $properties += @('Name', 'ExecutablePath') }
  $table = @{}
  foreach ($p in Get-CimInstance -ClassName Win32_Process -Property $properties) {
    if ($null -eq $p.CreationDate) { continue }
    $table[[int]$p.ProcessId] = [pscustomobject]@{
      Id = [int]$p.ProcessId
      Parent = [int]$p.ParentProcessId
      StartMs = (ConvertTo-UnixMs $p.CreationDate)
      Name = if ($withImages) { [string]$p.Name } else { '' }
      Path = if ($withImages) { [string]$p.ExecutablePath } else { '' }
    }
  }
  return $table
}

function Get-Descendants($table, [int]$rootId) {
  $found = [System.Collections.Generic.List[int]]::new()
  $seen = @{ $rootId = $true }
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($rootId)
  while ($queue.Count -gt 0) {
    $parentId = $queue.Dequeue()
    if (-not $table.ContainsKey($parentId)) { continue }
    $parentStart = $table[$parentId].StartMs
    foreach ($child in $table.Values) {
      if ($child.Parent -eq $parentId -and -not $seen.ContainsKey($child.Id) -and $child.StartMs -ge $parentStart) {
        $seen[$child.Id] = $true
        $found.Add($child.Id)
        $queue.Enqueue($child.Id)
      }
    }
  }
  return ,$found
}

function Get-Ancestors($table, [int]$id) {
  $found = [System.Collections.Generic.List[int]]::new()
  $visited = @{ $id = $true }
  $current = $table[$id]
  while ($current -and $table.ContainsKey($current.Parent) -and -not $visited.ContainsKey($current.Parent)) {
    $parent = $table[$current.Parent]
    if ($parent.StartMs -gt $current.StartMs) { break }
    $visited[$parent.Id] = $true
    $found.Add($parent.Id)
    $current = $parent
  }
  return ,$found
}

# The tool's own family: this helper, the tool, their parents, and the tool's descendants.
function Get-ToolFamily($table) {
  $family = [System.Collections.Generic.HashSet[int]]::new()
  $null = $family.Add($PID)
  foreach ($id in (Get-Ancestors $table $PID)) { $null = $family.Add($id) }
  if ($ToolPid -gt 0) {
    $null = $family.Add($ToolPid)
    foreach ($id in (Get-Ancestors $table $ToolPid)) { $null = $family.Add($id) }
    foreach ($id in (Get-Descendants $table $ToolPid)) { $null = $family.Add($id) }
  }
  return ,$family
}

function Test-Recordable($table, $family, [int]$id) {
  if (-not $table.ContainsKey($id) -or $family.Contains($id)) { return $false }
  return -not ($NeverRecorded -contains $table[$id].Name.ToLowerInvariant())
}

# CIM can report a path with ".." in it, as Git's inner bash.exe has; a handle reports the
# resolved one. Both sides are resolved before they're compared.
function Resolve-ImagePath([string]$path) {
  if ([string]::IsNullOrEmpty($path)) { return '' }
  try { return [System.IO.Path]::GetFullPath($path) } catch { return '' }
}

function New-Entry($process) {
  return @{
    pid = $process.Id; startMs = $process.StartMs; name = $process.Name
    path = (Resolve-ImagePath $process.Path)
  }
}

function Read-Input {
  # A caller that writes a byte-order mark shouldn't make the input unreadable.
  $text = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF)
  if ($text.Length -gt $MaxInputChars) { throw 'input too large' }
  return ($text | ConvertFrom-Json)
}

# Reads { pid, startMs } pairs, keeping only whole positive numbers.
function Get-Pairs($items, [bool]$withPath) {
  $pairs = @()
  foreach ($item in @($items)) {
    if ($pairs.Count -ge $MaxEntries) { break }
    if ($null -eq $item) { continue }
    $id = $item.pid
    $start = $item.startMs
    if (-not ($id -is [int] -or $id -is [long]) -or -not ($start -is [int] -or $start -is [long])) { continue }
    if ($id -le 0 -or $id -gt [int]::MaxValue -or $start -le 0) { continue }
    $pair = @{ pid = [int]$id; startMs = [long]$start }
    if ($withPath) {
      if (-not ($item.path -is [string]) -or $item.path.Length -eq 0) { continue }
      $pair.path = $item.path
    }
    $pairs += $pair
  }
  return ,$pairs
}

# The check mode: liveness through Get-Process start times, with no C# compile. The process
# table is read only when a parent to look under still runs.
if ($Action -eq 'check') {
  try {
    $request = Read-Input
    # 'running', 'gone', or 'unverified', by process ID and start time.
    function Get-Liveness($pair) {
      try {
        $process = Get-Process -Id $pair.pid -ErrorAction Stop
      } catch {
        return 'gone'
      }
      try {
        $actual = ConvertTo-UnixMs $process.StartTime
      } catch {
        return 'unverified'
      }
      if ([Math]::Abs($actual - $pair.startMs) -le $StartToleranceMs) { return 'running' }
      return 'gone'
    }
    $running = @()
    $unverified = @()
    $asked = @{}
    foreach ($pair in (Get-Pairs $request.processes $false)) {
      $asked[$pair.pid] = $true
      switch (Get-Liveness $pair) {
        'running' { $running += $pair }
        'unverified' { $unverified += $pair }
      }
    }
    $children = @()
    $parents = @()
    foreach ($pair in (Get-Pairs $request.parents $false)) {
      if ((Get-Liveness $pair) -eq 'running') { $parents += $pair }
    }
    if ($parents.Count -gt 0) {
      $table = Get-ProcessTable $true
      $family = Get-ToolFamily $table
      foreach ($parent in $parents) {
        foreach ($child in $table.Values) {
          if ($child.Parent -eq $parent.pid -and $child.StartMs -ge $parent.startMs -and
              -not $asked.ContainsKey($child.Id) -and (Test-Recordable $table $family $child.Id)) {
            $entry = New-Entry $child
            $entry.parentPid = $parent.pid
            $children += $entry
          }
        }
      }
    }
    Write-Result @{
      ok = $true; action = $Action; reason = 'checked'
      running = @($running); unverified = @($unverified); children = @($children)
    }
    exit 0
  } catch {
    [Console]::Error.WriteLine("helper error: $($_.Exception.Message)")
    exit 1
  }
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

  [DllImport("kernel32", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool QueryFullProcessImageName(IntPtr h, uint flags, System.Text.StringBuilder name, ref uint size);

  public static long StartMs(Process p) {
    return new DateTimeOffset(p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();
  }

  // The image path read through an open handle, or "" if it can't be read.
  public static string ImagePath(IntPtr handle) {
    var name = new System.Text.StringBuilder(32768);
    uint size = (uint)name.Capacity;
    return QueryFullProcessImageName(handle, 0, name, ref size) ? name.ToString() : "";
  }

  // Ends one process through the handle that was checked, never a tree.
  public static bool Terminate(IntPtr handle) {
    return TerminateProcess(handle, 1);
  }

  [DllImport("kernel32", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  const uint QueryLimited = 0x1000, TerminateAccess = 0x0001, Synchronize = 0x00100000;

  static long CreatedMs(IntPtr h) {
    long created, exited, kernel, user;
    if (!GetProcessTimes(h, out created, out exited, out kernel, out user)) return -1;
    return new DateTimeOffset(DateTime.FromFileTimeUtc(created)).ToUnixTimeMilliseconds();
  }

  static bool SamePath(string a, string b) {
    try {
      return string.Equals(System.IO.Path.GetFullPath(a), System.IO.Path.GetFullPath(b),
        StringComparison.OrdinalIgnoreCase);
    } catch {
      return false;
    }
  }

  // Opens one handle, and through it requires the process still to run with the recorded
  // creation time and image path, then ends it through that handle. Never a tree.
  public static string EndIfSame(uint pid, long startMs, string path, long toleranceMs,
      string[] neverNames) {
    IntPtr h = OpenProcess(QueryLimited | TerminateAccess | Synchronize, false, pid);
    if (h == IntPtr.Zero) {
      return Marshal.GetLastWin32Error() == 5 ? "access-denied" : "not-running";
    }
    try {
      if (WaitForSingleObject(h, 0) == 0) return "not-running";
      long created = CreatedMs(h);
      if (created < 0 || Math.Abs(created - startMs) > toleranceMs) return "different-process";
      string actual = ImagePath(h);
      if (actual.Length == 0 || !SamePath(actual, path)) return "different-program";
      string name = System.IO.Path.GetFileName(actual).ToLowerInvariant();
      foreach (string never in neverNames) if (never == name) return "protected";
      return TerminateProcess(h, 1) ? "ended" : "failed";
    } finally {
      CloseHandle(h);
    }
  }

  // Console members of a process verified by creation time, holding its handle throughout so
  // its process ID can't be reused while attached. Null if it isn't that process anymore.
  public static uint[] ConsoleMembersIfSame(uint pid, long startMs, long toleranceMs) {
    IntPtr h = OpenProcess(QueryLimited | Synchronize, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      if (WaitForSingleObject(h, 0) == 0) return null;
      long created = CreatedMs(h);
      if (created < 0 || Math.Abs(created - startMs) > toleranceMs) return null;
      return ConsoleMembers(pid);
    } finally {
      CloseHandle(h);
    }
  }

  // The processes attached to a process's console, or null if it has none this helper can
  // reach. Nothing is sent to the console.
  static uint[] ConsoleMembers(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return null;
    try {
      SetConsoleCtrlHandler(Ignore, true);
      uint[] list = new uint[1024];
      uint n = GetConsoleProcessList(list, (uint)list.Length);
      if (n == 0 || n > list.Length) return null;
      uint self = (uint)Process.GetCurrentProcess().Id;
      var others = new List<uint>();
      for (int i = 0; i < n; i++) if (list[i] != self) others.Add(list[i]);
      return others.ToArray();
    } finally {
      FreeConsole();
    }
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
      // Detach, and keep ignoring Ctrl+Break: a late event can't stop this process before it
      // reports, and the process exits right after.
      FreeConsole();
    }
  }
}
'@
} catch {
  Write-Result @{ ok = $false; action = $Action; reason = 'unavailable'; detail = 'add-type' }
  exit 0
}

# Ends recorded entries, each only if its start time and image path still match through the
# handle that ends it. Claude Code's processes and the tool's own are never ended.
if ($Action -eq 'end-leftovers') {
  try {
    $request = Read-Input
    $entries = Get-Pairs $request.entries $true
    $table = Get-ProcessTable $false
    $family = Get-ToolFamily $table
    $ended = @()
    $skipped = @()
    $done = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($entry in $entries) {
      $id = $entry.pid
      # Each process is acted on once, however many times it's listed.
      if (-not $done.Add($id)) { continue }
      if ($family.Contains($id)) { $skipped += @{ pid = $id; reason = 'protected' }; continue }
      try {
        $status = [CcsmConsole]::EndIfSame([uint32]$id, $entry.startMs, $entry.path,
          $StartToleranceMs, [string[]]$NeverRecorded)
      } catch {
        $status = 'failed'
      }
      if ($status -eq 'ended') { $ended += $id } else { $skipped += @{ pid = $id; reason = $status } }
    }
    Write-Result @{
      ok = $true; action = $Action; reason = 'done'; requested = $done.Count
      ended = @($ended); skipped = @($skipped)
    }
    exit 0
  } catch {
    [Console]::Error.WriteLine("helper error: $($_.Exception.Message)")
    exit 1
  }
}

# Records the session's programs: descendants through parent links, and members of each
# console a descendant owns, if they started after the session did. The session's own console
# is never used, because it can hold the user's shell and terminal. Returns null when it runs
# out of time, so the action goes ahead without a record.
function Get-SessionRecord($table, [int]$sessionPid, [long]$sessionStartMs, $descendants, $clock) {
  $family = Get-ToolFamily $table
  # Keyed by process ID. An ordered dictionary indexed by an int reads a position, so .Add is
  # used, never $entries[$id].
  $entries = [ordered]@{}
  foreach ($id in $descendants) {
    if ((Test-Recordable $table $family $id) -and -not $entries.Contains($id)) {
      $entries.Add($id, (New-Entry $table[$id]))
    }
  }
  $inConsole = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($id in $descendants) {
    if ($clock.ElapsedMilliseconds -gt $RecordBudgetMs) { return $null }
    if ($inConsole.Contains($id) -or $family.Contains($id)) { continue }
    $members = [CcsmConsole]::ConsoleMembersIfSame([uint32]$id, $table[$id].StartMs, $StartToleranceMs)
    if ($null -eq $members) { continue }
    foreach ($member in $members) { $null = $inConsole.Add([int]$member) }
    if ($members -contains [uint32]$sessionPid) { continue }
    foreach ($member in $members) {
      $memberId = [int]$member
      if ($memberId -eq $sessionPid -or $entries.Contains($memberId)) { continue }
      if (-not (Test-Recordable $table $family $memberId)) { continue }
      if ($table[$memberId].StartMs -lt $sessionStartMs) { continue }
      $entries.Add($memberId, (New-Entry $table[$memberId]))
    }
  }
  if ($clock.ElapsedMilliseconds -gt $RecordBudgetMs) { return $null }
  return @{ session = @{ pid = $sessionPid; startMs = $sessionStartMs }; entries = @($entries.Values) }
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
  if ($Action -eq 'force' -and $ExpectedStartMs -le 0) {
    Write-Result @{ ok = $false; action = $Action; reason = 'start-time-mismatch'; startMs = $startMs }
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

  $recording = $Record -or $Action -eq 'record'
  # The record's budget includes reading the process table, its main cost.
  $recordClock = [System.Diagnostics.Stopwatch]::StartNew()
  $procs = Get-ProcessTable $recording

  # An exited process leaves the snapshot even while a handle is held. Without its entry, the
  # descendant check would have no start time to compare, so refuse instead.
  if (-not $procs.ContainsKey($TargetPid) -or
      [Math]::Abs($procs[$TargetPid].StartMs - $startMs) -gt $StartToleranceMs -or
      $target.HasExited) {
    Write-Result @{ ok = $false; action = $Action; reason = 'target-exited' }
    exit 0
  }

  # .ToArray(): @() around a returned list would wrap it as one element, not its items.
  $ancestors = (Get-Ancestors $procs $TargetPid).ToArray()
  $descendants = (Get-Descendants $procs $TargetPid).ToArray()

  # Taken before any signal, so programs that outlive the session can be found afterwards.
  $sessionRecord = $null
  $recordStatus = $null
  if ($recording) {
    try {
      $sessionRecord = Get-SessionRecord $procs $TargetPid $startMs $descendants $recordClock
      $recordStatus = if ($null -eq $sessionRecord) { 'timeout' } else { 'recorded' }
    } catch {
      $recordStatus = 'failed'
    }
  }

  $allowedIds = [uint32[]](@($TargetPid) + $ancestors + $descendants)
  $allowedStarts = [long[]]@($allowedIds | ForEach-Object { $procs[[int]$_].StartMs })

  switch ($Action) {
    'record' {
      Write-Result @{
        ok = ($recordStatus -eq 'recorded'); action = $Action; reason = $recordStatus
        startMs = $startMs; record = $sessionRecord
      }
    }
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
      $result = @{
        ok = ($status -eq 'sent'); action = $Action; reason = $status; startMs = $startMs
        members = @($members); unexpectedImage = $image
      }
      if ($recording) { $result.record = $sessionRecord; $result.recordStatus = $recordStatus }
      Write-Result $result
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
      $result = @{ ok = $endedTarget; action = $Action; reason = $reason; ended = @($ended) }
      if ($recording) { $result.record = $sessionRecord; $result.recordStatus = $recordStatus }
      Write-Result $result
    }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine("helper error: $($_.Exception.Message)")
  exit 1
}
