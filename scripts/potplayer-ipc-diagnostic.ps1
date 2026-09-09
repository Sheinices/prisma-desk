param(
    [string]$PotPlayerPath = "C:\Program Files\PotPlayer\PotPlayerMini64.exe",
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [int]$Samples = 8,
    [int]$StartWaitSeconds = 8,
    [double]$SeekToleranceSec = 1.5,
    [double]$ResumePositionSec = 18,
    [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PotPlayerPath -PathType Leaf)) {
    throw "PotPlayer not found: $PotPlayerPath"
}
if ($Samples -lt 5) {
    throw "Samples must be at least 5"
}

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class PotPlayerWindowInfo {
    public IntPtr Hwnd { get; set; }
    public uint Pid { get; set; }
    public string ClassName { get; set; }
    public string Title { get; set; }
    public bool Visible { get; set; }
}

public static class PotPlayerIpcDiagnostic {
    private const uint WM_COMMAND = 0x0111;
    private const uint WM_USER = 0x0400;
    private const UIntPtr PLAY = (UIntPtr)20001;
    private const UIntPtr GET_TOTAL_TIME = (UIntPtr)0x5002;
    private const UIntPtr GET_CURRENT_TIME = (UIntPtr)0x5004;
    private const UIntPtr GET_PLAY_STATUS = (UIntPtr)0x5006;
    private const uint SMTO_BLOCK = 0x0001;
    private const uint SMTO_ABORTIFHUNG = 0x0002;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder title, int maxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        uint msg,
        UIntPtr wParam,
        IntPtr lParam,
        uint flags,
        uint timeout,
        out UIntPtr result
    );

    public static PotPlayerWindowInfo[] FindWindows() {
        var result = new List<PotPlayerWindowInfo>();
        EnumWindows((hWnd, _) => {
            var className = new StringBuilder(128);
            if (GetClassName(hWnd, className, className.Capacity) <= 0) return true;
            var name = className.ToString();
            if (!name.Equals("PotPlayer", StringComparison.OrdinalIgnoreCase) &&
                !name.Equals("PotPlayer64", StringComparison.OrdinalIgnoreCase)) return true;

            var title = new StringBuilder(512);
            GetWindowText(hWnd, title, title.Capacity);
            GetWindowThreadProcessId(hWnd, out var pid);
            result.Add(new PotPlayerWindowInfo {
                Hwnd = hWnd,
                Pid = pid,
                ClassName = name,
                Title = title.ToString(),
                Visible = IsWindowVisible(hWnd),
            });
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }

    public static long[] Query(IntPtr hWnd, UIntPtr command) {
        var ok = SendMessageTimeout(
            hWnd,
            WM_USER,
            command,
            IntPtr.Zero,
            SMTO_BLOCK | SMTO_ABORTIFHUNG,
            700,
            out var result
        );
        return ok == IntPtr.Zero
            ? new long[] { 0, -1 }
            : new long[] { 1, (long)result.ToUInt64() };
    }

    public static bool Play(IntPtr hWnd) {
        var ok = SendMessageTimeout(
            hWnd,
            WM_COMMAND,
            PLAY,
            IntPtr.Zero,
            SMTO_BLOCK | SMTO_ABORTIFHUNG,
            700,
            out _
        );
        return ok != IntPtr.Zero;
    }
}
"@

function Invoke-Query {
    param(
        [Parameter(Mandatory = $true)]$Window,
        [Parameter(Mandatory = $true)][UIntPtr]$Command
    )
    $result = [PotPlayerIpcDiagnostic]::Query($Window.Hwnd, $Command)
    if ($result[0] -eq 0) { return $null }
    return [int64]$result[1]
}

Write-Host "Starting PotPlayer: $PotPlayerPath"
$process = Start-Process -FilePath $PotPlayerPath -ArgumentList @($Url, "/new") -PassThru
Start-Sleep -Seconds $StartWaitSeconds

$candidates = @([PotPlayerIpcDiagnostic]::FindWindows())
$window = $candidates | Where-Object { $_.Pid -eq [uint32]$process.Id } | Select-Object -First 1
$fallbackUsed = $false
if (-not $window) {
    $window = $candidates | Where-Object { $_.Visible } | Select-Object -First 1
    if (-not $window) { $window = $candidates | Select-Object -First 1 }
    $fallbackUsed = $true
}

if (-not $window) {
    throw ("FAIL window_not_found: spawnedPid={0}; candidates={1}" -f $process.Id, ($candidates | ConvertTo-Json -Compress))
}

Write-Host ("Selected window: hwnd={0} pid={1} class={2} visible={3} fallbackUsed={4} title={5}" -f $window.Hwnd, $window.Pid, $window.ClassName, $window.Visible, $fallbackUsed, $window.Title)

$initialStatus = Invoke-Query -Window $window -Command ([UIntPtr]0x5006)
Write-Host ("Initial playback status: {0}" -f $initialStatus)
if ($initialStatus -ne 2) {
    if (-not [PotPlayerIpcDiagnostic]::Play($window.Hwnd)) {
        throw "FAIL play_command: WM_COMMAND 20001 timed out"
    }
    Start-Sleep -Seconds 2
}

$durationMs = Invoke-Query -Window $window -Command ([UIntPtr]0x5002)
$currentMs = Invoke-Query -Window $window -Command ([UIntPtr]0x5004)
$status = Invoke-Query -Window $window -Command ([UIntPtr]0x5006)

if ($null -eq $durationMs -or $durationMs -le 0) {
    throw "FAIL duration_query: 0x5002 did not return a positive millisecond duration"
}
if ($null -eq $currentMs -or $currentMs -lt 0) {
    throw "FAIL current_time_query: 0x5004 timed out or returned an invalid value"
}
if ($null -eq $status -or $status -ne 2) {
    throw ("FAIL playback_status: expected 2 (running), got {0}. Start playback in PotPlayer and rerun." -f $status)
}

$samplesOut = @()
$previousMs = $currentMs
for ($i = 1; $i -le $Samples; $i++) {
    $sampleCurrentMs = Invoke-Query -Window $window -Command ([UIntPtr]0x5004)
    $sampleDurationMs = Invoke-Query -Window $window -Command ([UIntPtr]0x5002)
    $sampleStatus = Invoke-Query -Window $window -Command ([UIntPtr]0x5006)
    if ($null -eq $sampleCurrentMs -or $null -eq $sampleDurationMs -or $null -eq $sampleStatus) {
        throw "FAIL sample_query: one of 0x5002/0x5004/0x5006 timed out at sample $i"
    }
    $samplesOut += [pscustomobject]@{
        sample = $i
        positionSec = [math]::Round($sampleCurrentMs / 1000.0, 3)
        durationSec = [math]::Round($sampleDurationMs / 1000.0, 3)
        status = $sampleStatus
    }
    Write-Host ("sample={0} positionSec={1} durationSec={2} status={3}" -f $i, [math]::Round($sampleCurrentMs / 1000.0, 3), [math]::Round($sampleDurationMs / 1000.0, 3), $sampleStatus)
    if ($sampleStatus -eq 2 -and $sampleCurrentMs -lt $previousMs) {
        throw ("FAIL non_monotonic_position: previousMs={0}, currentMs={1}" -f $previousMs, $sampleCurrentMs)
    }
    $previousMs = $sampleCurrentMs
    Start-Sleep -Seconds 2
}

$distinctPositions = @($samplesOut | Select-Object -ExpandProperty positionSec -Unique)
if ($distinctPositions.Count -lt 2) {
    throw "FAIL position_not_moving: all successful samples have the same position"
}

if ($ResumePositionSec -lt 3 -or $ResumePositionSec -ge ($durationMs / 1000.0 - 5)) {
    throw "FAIL resume_target: ResumePositionSec must be at least 3 seconds and at least 5 seconds before media end"
}

# Prisma Desk resumes through PotPlayer's documented command-line `/seek`, not WM_USER 0x5005.
# Restarting therefore validates the same production resume contract without treating a direct live seek as required.
Write-Host ("Restarting PotPlayer with /seek={0}" -f $ResumePositionSec)
Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$resumeProcess = Start-Process -FilePath $PotPlayerPath -ArgumentList @($Url, "/new", ("/seek={0}" -f $ResumePositionSec)) -PassThru
Start-Sleep -Seconds 5

$resumeCandidates = @([PotPlayerIpcDiagnostic]::FindWindows())
$resumeWindow = $resumeCandidates | Where-Object { $_.Pid -eq [uint32]$resumeProcess.Id } | Select-Object -First 1
$resumeFallbackUsed = $false
if (-not $resumeWindow) {
    $resumeWindow = $resumeCandidates | Where-Object { $_.Visible } | Select-Object -First 1
    if (-not $resumeWindow) { $resumeWindow = $resumeCandidates | Select-Object -First 1 }
    $resumeFallbackUsed = $true
}
if (-not $resumeWindow) { throw "FAIL resume_window_not_found" }

$resumeStatus = Invoke-Query -Window $resumeWindow -Command ([UIntPtr]0x5006)
if ($resumeStatus -ne 2) {
    if (-not [PotPlayerIpcDiagnostic]::Play($resumeWindow.Hwnd)) { throw "FAIL resume_play_command" }
    Start-Sleep -Seconds 2
}
$resumePositionMs = Invoke-Query -Window $resumeWindow -Command ([UIntPtr]0x5004)
if ($null -eq $resumePositionMs) { throw "FAIL resume_readback: 0x5004 timed out" }
$resumeActualSec = $resumePositionMs / 1000.0
$resumeLowerBound = $ResumePositionSec - $SeekToleranceSec
$resumeUpperBound = $ResumePositionSec + 9
if ($resumeActualSec -lt $resumeLowerBound -or $resumeActualSec -gt $resumeUpperBound) {
    throw ("FAIL resume_round_trip: requestedSec={0}, actualSec={1}, allowedRange=[{2}, {3}]" -f $ResumePositionSec, $resumeActualSec, $resumeLowerBound, $resumeUpperBound)
}
Write-Host ("resumeRoundTrip=PASS requestedSec={0} actualSec={1} fallbackUsed={2}" -f [math]::Round($ResumePositionSec, 3), [math]::Round($resumeActualSec, 3), $resumeFallbackUsed)

$result = [pscustomobject]@{
    pass = $true
    spawnedPid = $process.Id
    windowPid = $window.Pid
    pidMatch = ([uint32]$process.Id -eq [uint32]$window.Pid)
    fallbackUsed = $fallbackUsed
    hwnd = $window.Hwnd.ToString()
    className = $window.ClassName
    title = $window.Title
    durationSec = [math]::Round($durationMs / 1000.0, 3)
    samples = $samplesOut
    resumeRequestedSec = [math]::Round($ResumePositionSec, 3)
    resumeActualSec = [math]::Round($resumeActualSec, 3)
    resumeFallbackUsed = $resumeFallbackUsed
    timestamp = (Get-Date).ToString("o")
}

if ($OutFile) {
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutFile -Encoding UTF8
}
Write-Host "PASS: PotPlayer IPC position, duration, status and production /seek resume round trip are working."
Write-Host ($result | ConvertTo-Json -Depth 8)
Write-Host "PotPlayer remains open for manual Prisma end-to-end testing; close it manually when done."
