# Read-only regression checks; does not start or stop services or write process receipts.
. (Join-Path $PSScriptRoot 'common.ps1')
$current = Get-Process -Id $PID
$script:NexaRoot = Split-Path -Parent $current.Path
$record = @{ name = 'test'; pid = $current.Id; executable = $current.Path; startedAt = $current.StartTime.ToUniversalTime().ToString('o') }
if (-not (Get-NexaOwnedProcess $record)) { throw 'ISO timestamp ownership check failed.' }
$decoded = $record | ConvertTo-Json | ConvertFrom-Json
if (-not (Get-NexaOwnedProcess $decoded)) { throw 'JSON roundtrip timestamp ownership check failed.' }
$decoded.startedAt = $current.StartTime.ToUniversalTime().AddTicks(1)
if (Get-NexaOwnedProcess $decoded) { throw 'A different start timestamp was accepted.' }
$decoded.startedAt = $current.StartTime.ToUniversalTime()
$decoded.executable = Join-Path $script:NexaRoot 'different.exe'
if (Get-NexaOwnedProcess $decoded) { throw 'A different executable was accepted.' }

# Test an unverified live PID without allowing this test to call the real Stop-Process.
$script:stopAttempts = 0
function Get-NexaOwnedProcess($Record) { return $null }
function Get-Process { param($Id, $ErrorAction) return [pscustomobject]@{ Id = $Id } }
function Stop-Process { $script:stopAttempts++; throw 'The test must never call Stop-Process.' }
$refused = $false
try { Stop-NexaRecords @($record) } catch { $refused = $_.Exception.Message -like '*process record is preserved*' }
if (-not $refused -or $script:stopAttempts -ne 0) { throw 'An unverified live process did not prevent successful stop cleanup.' }
Write-Host 'Process ownership regression checks passed (JSON timestamps, exact start time, executable path, unverified live PID).'
