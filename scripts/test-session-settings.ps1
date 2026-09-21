# Read-only launcher configuration checks; no services or process receipts are changed.
. (Join-Path $PSScriptRoot 'common.ps1')
$session = [pscustomobject]@{
    url = 'http://127.0.0.1:8787'
    processes = @([pscustomobject]@{ name = 'api' })
    settings = [pscustomobject]@{ listenAddress = '127.0.0.1' }
}
Assert-NexaSessionSettings $session 'http://127.0.0.1:8787' '127.0.0.1' $true
function Assert-Refused([scriptblock]$Action, [string]$Expected) {
    $message = ''
    try { & $Action } catch { $message = $_.Exception.Message }
    if ($message -notlike "*$Expected*") { throw "Expected '$Expected' rejection; received '$message'." }
}
Assert-Refused { Assert-NexaSessionSettings $session 'http://127.0.0.1:8878' '127.0.0.1' $true } 'address or port'
Assert-Refused { Assert-NexaSessionSettings $session 'http://127.0.0.1:8787' '127.0.0.1' $false } 'model mode'
Assert-Refused { Assert-NexaSessionSettings $session 'http://127.0.0.1:8787' '0.0.0.0' $true } 'network binding'
$session.processes += @('generation','embedding','qdrant') | ForEach-Object { [pscustomobject]@{ name = $_ } }
Assert-NexaSessionSettings $session 'http://127.0.0.1:8787' '127.0.0.1' $false
Assert-Refused { Assert-NexaSessionSettings $session 'http://127.0.0.1:8787' '127.0.0.1' $true } 'model mode'
$session.PSObject.Properties.Remove('settings')
Assert-NexaSessionSettings $session 'http://127.0.0.1:8787' '127.0.0.1' $false
Write-Host 'Launcher session checks passed (same settings, changed port, model mode, bind address, legacy receipt).'
