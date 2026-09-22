[CmdletBinding()]
param(
    [string]$ListenAddress = '127.0.0.1',
    [ValidateRange(1024,65535)][int]$Port = 8787,
    [string]$DataDirectory,
    [switch]$NoModels,
    [switch]$CheckOnly,
    [ValidateRange(10,900)][int]$StartupTimeoutSeconds = 180
)
. (Join-Path $PSScriptRoot 'common.ps1')
$llmProvider = if ($env:NEXA_LLM_PROVIDER) { $env:NEXA_LLM_PROVIDER.Trim().ToLowerInvariant() } else { 'local' }
if ($llmProvider -notin @('local','openai','anthropic','github-copilot')) { throw 'NEXA_LLM_PROVIDER must be local, openai, anthropic, or github-copilot.' }
if ($llmProvider -ne 'local') {
    $llmKey = $env:NEXA_LLM_API_KEY
    if (-not $llmKey) {
        $llmKey = switch ($llmProvider) {
            'openai' { $env:OPENAI_API_KEY }
            'anthropic' { $env:ANTHROPIC_API_KEY }
            'github-copilot' { if ($env:COPILOT_GITHUB_TOKEN) { $env:COPILOT_GITHUB_TOKEN } elseif ($env:GH_TOKEN) { $env:GH_TOKEN } else { $env:GITHUB_TOKEN } }
        }
    }
    if (-not $llmKey) { throw "Set the API key environment variable for the $llmProvider provider before starting Nexa." }
    if ($NoModels) { throw 'An external LLM still needs the local embedding and Qdrant services. Omit -NoModels when using NEXA_LLM_PROVIDER.' }
}
Assert-NexaPlatform
$dataRoot = Get-NexaDataPath $DataDirectory
$runRoot = Join-Path $dataRoot 'run'
$logRoot = Join-Path $dataRoot 'logs'
$statePath = Join-Path $runRoot 'processes.json'
$parsedAddress = $null
if ($ListenAddress -ne 'localhost' -and -not [Net.IPAddress]::TryParse($ListenAddress, [ref]$parsedAddress)) { throw '-ListenAddress must be an IP address or localhost.' }
$apiProbeAddress = if ($ListenAddress -eq '0.0.0.0') { '127.0.0.1' } elseif ($ListenAddress -eq '::') { '::1' } else { $ListenAddress }
if ($apiProbeAddress.Contains(':')) { $apiProbeAddress = '[' + $apiProbeAddress + ']' }
$apiUrl = 'http://{0}:{1}' -f $apiProbeAddress, $Port
if ($ListenAddress -notin @('127.0.0.1','localhost','::1') -and (-not $env:NEXA_API_KEY -or $env:NEXA_API_KEY.Length -lt 24)) { throw 'LAN binding requires NEXA_API_KEY with at least 24 characters. Set a long random team access key before using -ListenAddress.' }
$apiHeaders = @{}
if ($env:NEXA_API_KEY) { $apiHeaders['Authorization'] = 'Bearer ' + $env:NEXA_API_KEY }
if ($Port -in @(18181,18182,16333,16334)) { throw 'API port conflicts with a reserved local backend port.' }
$required = @('.runtime\bun\bun.exe','vendor\hono\src\index.ts','vendor\tree-sitter\web-tree-sitter.js','vendor\tree-sitter\web-tree-sitter.wasm','vendor\tree-sitter\tree-sitter-c.wasm','vendor\tree-sitter\tree-sitter-cpp.wasm','.runtime\poppler\Library\bin\pdftotext.exe')
$required += @('.runtime\pandoc\pandoc.exe', '.runtime\git\cmd\git.exe')
if (-not $NoModels) {
    $required += @('.runtime\llama\llama-server.exe','.runtime\qdrant\qdrant.exe','.models\embeddinggemma-300M-Q8_0.gguf')
    if ($llmProvider -eq 'local') { $required += '.models\qwen35-4b.gguf' }
}
foreach ($relative in $required) { if (-not (Test-Path -LiteralPath (Join-Path $script:NexaRoot $relative) -PathType Leaf)) { throw "Missing $relative. Run scripts\setup.cmd or scripts\setup.ps1 first." } }
if (-not (Test-Path -LiteralPath (Join-Path $script:NexaRoot 'src\server.ts') -PathType Leaf)) { throw 'Missing src\server.ts. Restore the complete Nexa source checkout before starting.' }
if (-not $NoModels) {
    $nvidia = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if (-not $nvidia) { throw 'NVIDIA driver/nvidia-smi was not found. Install a compatible driver through your normal IT process, or use -NoModels.' }
    $gpu = @(& $nvidia.Source --query-gpu=name,driver_version,memory.total --format=csv,noheader)
    if ($LASTEXITCODE -ne 0) { throw 'NVIDIA driver check failed.' }
    Write-Host ('GPU: ' + ($gpu -join '; '))
    $runtimeKey = 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
    $vc = Get-ItemProperty -LiteralPath $runtimeKey -ErrorAction SilentlyContinue
    if (-not $vc -or $vc.Installed -ne 1) { throw 'Microsoft Visual C++ 2015-2022 x64 runtime was not detected. Ask IT to install it; this script does not run external installers.' }
    Write-Host "Visual C++ x64 runtime: $($vc.Version)"
}
if ($CheckOnly) { Write-Host "Preflight passed. API: $apiUrl; data: $dataRoot; LLM provider: $llmProvider; models enabled: $(-not $NoModels)"; return }
New-Item -ItemType Directory -Path $runRoot,$logRoot -Force | Out-Null
$lockPath = Join-Path $runRoot 'launcher.lock'
try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch { throw 'Another start/stop operation is already running for this data directory.' }
$started = New-Object Collections.Generic.List[object]
$savedEnvironment = @{}
function Set-ChildEnvironment([string]$Name, [string]$Value) {
    if (-not $savedEnvironment.ContainsKey($Name)) { $savedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process') }
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}
function Wait-Healthy([string]$Name, [string]$Url, $Process) {
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    do {
        $Process.Refresh()
        if ($Process.HasExited) { throw "$Name exited (code $($Process.ExitCode)); inspect $logRoot\$Name.stderr.log and $Name.stdout.log." }
        try {
            $headers = if ($Name -eq 'api') { $apiHeaders } else { @{} }
            $response = Invoke-WebRequest -Uri $Url -Headers $headers -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Name did not become ready within $StartupTimeoutSeconds seconds. Inspect $logRoot."
}
function Start-Component([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$HealthUrl) {
    # Start-Process joins ArgumentList; explicitly quote paths with spaces without invoking a shell.
    $quoted = @($Arguments | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '(\\*)"','$1$1\"' -replace '(\\+)$','$1$1') + '"' } else { $_ }
    })
    $process = Start-Process -FilePath $Executable -ArgumentList $quoted -WorkingDirectory $script:NexaRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot "$Name.stdout.log") -RedirectStandardError (Join-Path $logRoot "$Name.stderr.log")
    $record = @{ name = $Name; pid = $process.Id; executable = $Executable; startedAt = $process.StartTime.ToUniversalTime().ToString('o') }
    $started.Add($record)
    Write-NexaState $statePath $started.ToArray() $apiUrl @{ listenAddress = $ListenAddress; llmProvider = $llmProvider }
    Write-Host "Waiting for $Name..."
    Wait-Healthy $Name $HealthUrl $process
}
try {
    if (Test-Path -LiteralPath $statePath) {
        $existing = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($existing.root -ne $script:NexaRoot) { throw 'Data directory is owned by another Nexa project.' }
        $unverified = @($existing.processes | Where-Object { (Get-Process -Id $_.pid -ErrorAction SilentlyContinue) -and -not (Get-NexaOwnedProcess $_) })
        if ($unverified.Count -gt 0) { throw 'A recorded process is alive but ownership cannot be verified. The process record is preserved; inspect it before recovery.' }
        $live = @($existing.processes | Where-Object { Get-NexaOwnedProcess $_ })
        if ($live.Count -gt 0) {
            $api = @($live | Where-Object name -eq 'api')
            if ($api.Count -eq 1 -and $live.Count -eq @($existing.processes).Count) {
                Assert-NexaSessionSettings $existing $apiUrl $ListenAddress ([bool]$NoModels) $llmProvider
                try { $health = Invoke-WebRequest -Uri ($existing.url + '/api/v1/health') -Headers $apiHeaders -UseBasicParsing -TimeoutSec 3 } catch { throw 'Nexa processes exist but API health failed. Check NEXA_API_KEY or run scripts\stop.cmd or scripts\stop.ps1 before restarting.' }
                if ($health.StatusCode -eq 200) { Write-Host "Nexa is already running: $($existing.url)"; return }
            }
            throw 'A partial Nexa session is still running. Run scripts\stop.cmd or scripts\stop.ps1 before restarting.'
        }
        Remove-Item -LiteralPath $statePath -Force
    }
    $ports = @($Port)
    if (-not $NoModels) { $ports += @(18181,18182,16333,16334) }
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    foreach ($candidate in $ports) { if (@($listeners | Where-Object Port -eq $candidate).Count -gt 0) { throw "Port $candidate is occupied by a process outside this launcher session; no process was stopped." } }
    Set-ChildEnvironment 'NEXA_HOST' $ListenAddress
    Set-ChildEnvironment 'NEXA_PORT' ([string]$Port)
    Set-ChildEnvironment 'NEXA_DATA_DIR' $dataRoot
    Set-ChildEnvironment 'BUN_CONFIG_NO_CLEAR_TERMINAL' '1'
    if (-not $NoModels) {
        Set-ChildEnvironment 'NEXA_MODE' 'full'
        Set-ChildEnvironment 'NEXA_GENERATION_URL' 'http://127.0.0.1:18181'
        Set-ChildEnvironment 'NEXA_EMBEDDING_URL' 'http://127.0.0.1:18182'
        Set-ChildEnvironment 'NEXA_QDRANT_URL' 'http://127.0.0.1:16333'
        $llama = Join-Path $script:NexaRoot '.runtime\llama\llama-server.exe'
        if ($llmProvider -eq 'local') {
            Start-Component 'generation' $llama @('-m',(Join-Path $script:NexaRoot '.models\qwen35-4b.gguf'),'--host','127.0.0.1','--port','18181','--offline','--no-webui','-ngl','99','-np','1','-c','4096') 'http://127.0.0.1:18181/health'
        } else {
            Write-Host "Using external LLM provider: $llmProvider"
        }
        Start-Component 'embedding' $llama @('-m',(Join-Path $script:NexaRoot '.models\embeddinggemma-300M-Q8_0.gguf'),'--host','127.0.0.1','--port','18182','--offline','--no-webui','-ngl','99','-np','1','-c','2048','-b','2048','-ub','2048','--embedding','--pooling','mean') 'http://127.0.0.1:18182/health'
        $qdrantRoot = Join-Path $dataRoot 'qdrant'
        New-Item -ItemType Directory -Path $qdrantRoot -Force | Out-Null
        Set-ChildEnvironment 'QDRANT__SERVICE__HOST' '127.0.0.1'
        Set-ChildEnvironment 'QDRANT__SERVICE__HTTP_PORT' '16333'
        Set-ChildEnvironment 'QDRANT__SERVICE__GRPC_PORT' '16334'
        Set-ChildEnvironment 'QDRANT__STORAGE__STORAGE_PATH' (Join-Path $qdrantRoot 'storage')
        Set-ChildEnvironment 'QDRANT__STORAGE__SNAPSHOTS_PATH' (Join-Path $qdrantRoot 'snapshots')
        Set-ChildEnvironment 'QDRANT__TELEMETRY_DISABLED' 'true'
        Start-Component 'qdrant' (Join-Path $script:NexaRoot '.runtime\qdrant\qdrant.exe') @('--disable-telemetry') 'http://127.0.0.1:16333/healthz'
    } else {
        Set-ChildEnvironment 'NEXA_MODE' 'keyword'
    }
    Start-Component 'api' (Join-Path $script:NexaRoot '.runtime\bun\bun.exe') @('--no-install','src/server.ts') ($apiUrl + '/api/v1/health')
    Write-Host "Nexa is ready: $apiUrl"
    Write-Host "Admin key file: $(Join-Path $dataRoot 'admin-key.txt')"
    Write-Host "Logs: $logRoot"
} catch {
    Stop-NexaRecords $started.ToArray()
    if ($started.Count -gt 0 -and (Test-Path -LiteralPath $statePath)) { Remove-Item -LiteralPath $statePath -Force }
    throw
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    $lock.Dispose()
}
