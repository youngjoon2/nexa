[CmdletBinding()]
param([string]$DataDirectory)
. (Join-Path $PSScriptRoot 'common.ps1')
$dataRoot = Get-NexaDataPath $DataDirectory
$runRoot = Join-Path $dataRoot 'run'
$statePath = Join-Path $runRoot 'processes.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Host 'No Nexa launcher session is recorded.'; return }
try { $lock = [IO.File]::Open((Join-Path $runRoot 'launcher.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch { throw 'Another start/stop operation is in progress.' }
try {
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.root -ne $script:NexaRoot) { throw 'This process record belongs to another project; no processes were stopped.' }
    Stop-NexaRecords $state.processes
    Remove-Item -LiteralPath $statePath -Force
    Write-Host "Nexa stopped. Data and logs are preserved in $dataRoot."
} finally { $lock.Dispose() }
