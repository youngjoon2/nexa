Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:NexaRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))

function Assert-NexaChildPath([string]$Path, [string]$Parent = $script:NexaRoot) {
    $full = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Path is outside the intended directory: $full" }
    return $full
}

function Assert-NexaPlatform {
    if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or -not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'The pinned binaries require Windows x64 (not ARM64).' }
    if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { throw 'Windows tar.exe is required (Windows 10 1803 or later).' }
}

function Get-NexaDataPath([string]$DataDirectory) {
    if (-not $DataDirectory) { $DataDirectory = $env:NEXA_DATA_DIR }
    if (-not $DataDirectory) { $DataDirectory = Join-Path $script:NexaRoot 'data' }
    if (-not [IO.Path]::IsPathRooted($DataDirectory)) { $DataDirectory = Join-Path $script:NexaRoot $DataDirectory }
    return [IO.Path]::GetFullPath($DataDirectory)
}

function Get-NexaOwnedProcess($Record) {
    $process = Get-Process -Id $Record.pid -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    try {
        # PowerShell 7 ConvertFrom-Json can convert ISO strings to DateTime; 5.1 leaves strings.
        # Normalize both representations to UTC ticks without dropping sub-second precision.
        if ($Record.startedAt -is [DateTime]) {
            $recordedTicks = $Record.startedAt.ToUniversalTime().Ticks
        } elseif ($Record.startedAt -is [DateTimeOffset]) {
            $recordedTicks = $Record.startedAt.UtcDateTime.Ticks
        } else {
            $recordedTicks = [DateTimeOffset]::Parse([string]$Record.startedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).UtcDateTime.Ticks
        }
        if ($process.Path -ne $Record.executable -or $process.StartTime.ToUniversalTime().Ticks -ne $recordedTicks) { return $null }
        if (-not ([IO.Path]::GetFullPath($process.Path)).StartsWith(($script:NexaRoot + '\'), [StringComparison]::OrdinalIgnoreCase)) { return $null }
        return $process
    } catch { return $null }
}

function Write-NexaState([string]$Path, $Records, [string]$Url) {
    $state = @{ root = $script:NexaRoot; url = $Url; processes = @($Records) }
    $temporary = $Path + '.tmp'
    [IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Stop-NexaRecords($Records) {
    $ordered = @($Records)
    [Array]::Reverse($ordered)
    $unresolved = New-Object Collections.Generic.List[string]
    foreach ($record in $ordered) {
        $process = Get-NexaOwnedProcess $record
        if ($process) {
            Write-Host ('Stopping {0} (PID {1})' -f $record.name, $record.pid)
            try {
                Stop-Process -InputObject $process -ErrorAction Stop
                if (-not $process.WaitForExit(10000)) { $unresolved.Add([string]$record.pid) }
            } catch {
                if (Get-Process -Id $record.pid -ErrorAction SilentlyContinue) { $unresolved.Add([string]$record.pid) }
            }
        } elseif (Get-Process -Id $record.pid -ErrorAction SilentlyContinue) {
            # A reused PID, inaccessible process, or mismatched receipt is never safe to stop.
            $unresolved.Add([string]$record.pid)
        }
    }
    if ($unresolved.Count -gt 0) {
        throw ('Live processes could not be verified or stopped (PID {0}). The process record is preserved; inspect ownership before recovery.' -f ($unresolved -join ', '))
    }
}
