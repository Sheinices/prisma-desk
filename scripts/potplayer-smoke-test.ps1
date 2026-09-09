param(
    [string]$PotPlayerPath = "C:\Program Files\PotPlayer\PotPlayerMini64.exe",
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [int]$Samples = 5
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PotPlayerPath -PathType Leaf)) {
    throw "PotPlayer not found: $PotPlayerPath"
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class PotPlayerIpcSmoke {
    private const uint WM_USER = 0x0400;
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

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

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

    public static long[] Read(uint requestedPid) {
        IntPtr selected = IntPtr.Zero;
        uint selectedPid = 0;
        EnumWindows((hWnd, _) => {
            var name = new StringBuilder(128);
            GetClassName(hWnd, name, name.Capacity);
            if (!name.ToString().Equals("PotPlayer64", StringComparison.OrdinalIgnoreCase) &&
                !name.ToString().Equals("PotPlayer", StringComparison.OrdinalIgnoreCase)) {
                return true;
            }
            GetWindowThreadProcessId(hWnd, out var candidatePid);
            if (requestedPid == 0 || candidatePid == requestedPid) {
                selected = hWnd;
                selectedPid = candidatePid;
                return false;
            }
            return true;
        }, IntPtr.Zero);

        if (selected == IntPtr.Zero) return new long[] { -1, -1, -1, 0 };

        long Query(UIntPtr command) {
            var ok = SendMessageTimeout(
                selected,
                WM_USER,
                command,
                IntPtr.Zero,
                SMTO_BLOCK | SMTO_ABORTIFHUNG,
                700,
                out var result
            );
            return ok == IntPtr.Zero ? -1 : (long)result.ToUInt64();
        }

        return new long[] {
            Query(GET_CURRENT_TIME),
            Query(GET_TOTAL_TIME),
            Query(GET_PLAY_STATUS),
            selectedPid
        };
    }
}
"@

Write-Host "Starting PotPlayer: $PotPlayerPath"
$process = Start-Process -FilePath $PotPlayerPath -ArgumentList @($Url, "/new") -PassThru
Start-Sleep -Seconds 5

$previous = -1
for ($i = 1; $i -le $Samples; $i++) {
    $state = [PotPlayerIpcSmoke]::Read([uint32]$process.Id)
    $positionMs = $state[0]
    $durationMs = $state[1]
    $status = $state[2]
    $windowPid = $state[3]

    if ($positionMs -lt 0) {
        Write-Warning "PotPlayer window/IPC response not found. Check UAC level and PotPlayer window class."
    } else {
        $positionSec = [math]::Round($positionMs / 1000.0, 3)
        $durationSec = [math]::Round($durationMs / 1000.0, 3)
        Write-Host ("sample={0} pid={1} positionSec={2} durationSec={3} status={4}" -f $i, $windowPid, $positionSec, $durationSec, $status)
        if ($previous -ge 0 -and $positionMs -lt $previous -and $status -eq 2) {
            throw "Position moved backwards while PotPlayer reported running."
        }
        $previous = $positionMs
    }

    Start-Sleep -Seconds 2
}

Write-Host "Smoke test finished. The script does not terminate PotPlayer; close it manually when done."
