[CmdletBinding()]
param(
    [string]$CachePath = (Join-Path $env:LOCALAPPDATA 'Temp\nexa-feasibility-20260921'),
    [switch]$NoModels,
    [switch]$Offline,
    [switch]$CheckOnly
)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-NexaPlatform
$manifestPath = Join-Path $script:NexaRoot 'config\artifacts.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$artifacts = @($manifest.artifacts | Where-Object { -not ($NoModels -and $_.model) })
$downloadRoot = Join-Path $script:NexaRoot '.runtime\downloads'

function Test-ArtifactHash([string]$Path, [string]$Expected) {
    return ((Test-Path -LiteralPath $Path -PathType Leaf) -and (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Expected)
}

function Assert-GitHubUri([uri]$Uri) {
    $allowed = @('github.com', 'api.github.com', 'raw.githubusercontent.com', 'media.githubusercontent.com', 'codeload.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com')
    if ($Uri.Scheme -ne 'https' -or $Uri.Host -notin $allowed -or $Uri.UserInfo -or -not $Uri.IsDefaultPort) { throw "Download URL is not an approved HTTPS GitHub host: $($Uri.Host)" }
}

function Get-GitHubFile([string]$Url, [string]$Destination) {
    # Redirects are handled manually so every target is checked before contacting it.
    Add-Type -AssemblyName System.Net.Http
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object Net.Http.HttpClient $handler
    $client.Timeout = [TimeSpan]::FromMinutes(90)
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('Nexa-GitHub-Setup/1.0')
    try {
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            try {
                $uri = [uri]$Url
                $partial = $Destination + '.partial'
                for ($redirect = 0; $redirect -le 10; $redirect++) {
                    Assert-GitHubUri $uri
                    $request = New-Object Net.Http.HttpRequestMessage ([Net.Http.HttpMethod]::Get), $uri
                    $offset = 0L
                    if (Test-Path -LiteralPath $partial) { $offset = (Get-Item -LiteralPath $partial).Length }
                    if ($offset -gt 0) { $request.Headers.Range = New-Object Net.Http.Headers.RangeHeaderValue $offset, $null }
                    $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
                    $status = [int]$response.StatusCode
                    if ($status -in @(301,302,303,307,308)) {
                        $location = $response.Headers.Location
                        if (-not $location) { throw 'Redirect has no location.' }
                        $uri = New-Object uri $uri, $location
                        $response.Dispose(); $request.Dispose()
                        continue
                    }
                    if ($status -eq 416) {
                        $response.Dispose(); $request.Dispose()
                        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
                        throw 'Partial download cannot be resumed; retrying from the beginning.'
                    }
                    $response.EnsureSuccessStatusCode() | Out-Null
                    $mode = [IO.FileMode]::Create
                    if ($status -eq 206 -and $offset -gt 0) { $mode = [IO.FileMode]::Append }
                    $output = [IO.File]::Open($partial, $mode, [IO.FileAccess]::Write, [IO.FileShare]::None)
                    try { $response.Content.CopyToAsync($output).GetAwaiter().GetResult() } finally { $output.Dispose(); $response.Dispose(); $request.Dispose() }
                    Move-Item -LiteralPath $partial -Destination $Destination -Force
                    return
                }
                throw 'Too many GitHub redirects.'
            } catch {
                if ($attempt -eq 3) { throw }
                Write-Warning "Download attempt $attempt failed; retrying. $($_.Exception.Message)"
                Start-Sleep -Seconds (2 * $attempt)
            }
        }
    } finally { $client.Dispose(); $handler.Dispose() }
}

function Expand-VerifiedArchive([string]$Archive, [string]$Destination) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $listing = @(& tar.exe -tf $Archive)
    if ($LASTEXITCODE -ne 0) { throw "Cannot list archive: $Archive" }
    foreach ($entry in $listing) {
        if ($entry -match '(^[/\\])|(^[A-Za-z]:)|((^|[/\\])\.\.([/\\]|$))|:') { throw "Unsafe archive member: $entry" }
        Assert-NexaChildPath (Join-Path $Destination $entry) $Destination | Out-Null
    }
    $verboseListing = @(& tar.exe -tvf $Archive)
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect archive: $Archive" }
    foreach ($entry in $verboseListing) {
        if ($entry -match '^[lh]') { throw 'Archives containing symbolic/hard links are not supported.' }
    }
    & tar.exe -xf $Archive -C $Destination
    if ($LASTEXITCODE -ne 0) { throw "Cannot extract archive: $Archive" }
}

function Get-Artifact($Artifact) {
    $destination = Join-Path $downloadRoot $Artifact.file
    if (Test-ArtifactHash $destination $Artifact.sha256) { return $destination }
    $cached = if ($CachePath) { Join-Path $CachePath $Artifact.cache } else { '' }
    if ($cached -and (Test-ArtifactHash $cached $Artifact.sha256)) { return $cached }
    if ($Offline) { throw "Artifact missing or hash mismatch in offline cache: $($Artifact.file)" }
    Write-Host "Downloading $($Artifact.id) from GitHub..."
    Get-GitHubFile $Artifact.url $destination
    if (-not (Test-ArtifactHash $destination $Artifact.sha256)) { throw "SHA256 mismatch: $($Artifact.file). File will not be installed." }
    return $destination
}

$drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($script:NexaRoot))
$requiredGiB = if ($NoModels) { 3 } else { 12 }
Write-Host "Windows x64; free disk: $([Math]::Round($drive.AvailableFreeSpace / 1GB, 1)) GiB; setup requires approximately $requiredGiB GiB."
if ($CheckOnly) {
    foreach ($artifact in $artifacts) {
        $cached = if ($CachePath) { Join-Path $CachePath $artifact.cache } else { '' }
        $present = ($cached -and (Test-ArtifactHash $cached $artifact.sha256)) -or (Test-ArtifactHash (Join-Path $downloadRoot $artifact.file) $artifact.sha256)
        Write-Host ('{0}: {1}' -f $artifact.id, $(if ($present) { 'verified cache' } else { 'GitHub download required' }))
    }
    return
}
if ($drive.AvailableFreeSpace -lt ($requiredGiB * 1GB)) { throw "At least $requiredGiB GiB of free disk is required for installation." }
if (Test-Path -LiteralPath (Join-Path $script:NexaRoot 'data\run\processes.json')) { throw 'Stop Nexa before changing runtime files (scripts\stop.cmd or scripts\stop.ps1).' }
$runtimePrefix = (Join-Path $script:NexaRoot '.runtime') + '\'
foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
    try { $executable = $process.Path } catch { continue }
    if ($executable -and $executable.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'A Nexa runtime process is running. Stop it before updating installed files.' }
}
New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
$stage = Join-Path $script:NexaRoot ('.runtime\staging-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$installed = New-Object Collections.Generic.List[object]
try {
    foreach ($artifact in $artifacts) {
        Write-Host "Verifying/installing $($artifact.id)..."
        $source = Get-Artifact $artifact
        $target = Assert-NexaChildPath (Join-Path $script:NexaRoot $artifact.target)
        switch ($artifact.kind) {
            'part' { }
            'file' {
                New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
                if (-not (Test-ArtifactHash $target $artifact.sha256)) { Copy-Item -LiteralPath $source -Destination $target -Force }
            }
            'archive' {
                $expanded = Join-Path $stage $artifact.id
                Expand-VerifiedArchive $source $expanded
                $contentRoot = $expanded
                if ($artifact.stripRoot) {
                    $roots = @(Get-ChildItem -LiteralPath $expanded -Directory)
                    if ($roots.Count -ne 1) { throw "Expected one archive root in $($artifact.id)." }
                    $contentRoot = $roots[0].FullName
                }
                New-Item -ItemType Directory -Path $target -Force | Out-Null
                Get-ChildItem -LiteralPath $contentRoot -Force | Copy-Item -Destination $target -Recurse -Force
            }
            default { throw "Unknown artifact kind: $($artifact.kind)" }
        }
        $installed.Add(@{ id = $artifact.id; url = $artifact.url; sha256 = $artifact.sha256; target = $artifact.target })
    }
    if (-not $NoModels) {
        $qwenTarget = Join-Path $script:NexaRoot $manifest.qwen.target
        if (-not (Test-ArtifactHash $qwenTarget $manifest.qwen.sha256)) {
            $combinedCache = if ($CachePath) { Join-Path $CachePath 'qwen35-4b.gguf' } else { '' }
            New-Item -ItemType Directory -Path (Split-Path -Parent $qwenTarget) -Force | Out-Null
            if ($combinedCache -and (Test-ArtifactHash $combinedCache $manifest.qwen.sha256)) { Copy-Item -LiteralPath $combinedCache -Destination $qwenTarget -Force }
            else {
                $temporary = $qwenTarget + '.partial'
                $output = [IO.File]::Create($temporary)
                try {
                    foreach ($part in @($artifacts | Where-Object kind -eq 'part' | Sort-Object file)) {
                        $inputStream = [IO.File]::OpenRead((Get-Artifact $part))
                        try { $inputStream.CopyTo($output) } finally { $inputStream.Dispose() }
                    }
                } finally { $output.Dispose() }
                if (-not (Test-ArtifactHash $temporary $manifest.qwen.sha256)) { throw 'Combined Qwen model SHA256 mismatch.' }
                Move-Item -LiteralPath $temporary -Destination $qwenTarget -Force
            }
        }
        if (-not (Test-ArtifactHash $qwenTarget $manifest.qwen.sha256)) { throw 'Installed Qwen model SHA256 mismatch.' }
    }
    $receipt = @{ installedAt = [DateTime]::UtcNow.ToString('o'); manifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant(); artifacts = @($installed.ToArray()); qwen = $(if (-not $NoModels) { $manifest.qwen } else { $null }) }
    [IO.File]::WriteAllText((Join-Path $script:NexaRoot '.runtime\installed.json'), ($receipt | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
    Write-Host 'Setup complete. No package registry, Hugging Face, or Ollama downloads were used.'
} finally {
    $safeStage = Assert-NexaChildPath $stage (Join-Path $script:NexaRoot '.runtime')
    if (Test-Path -LiteralPath $safeStage) { Remove-Item -LiteralPath $safeStage -Recurse -Force }
}
