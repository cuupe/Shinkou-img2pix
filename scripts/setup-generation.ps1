param([string]$RuntimePath = (Join-Path $PSScriptRoot '../.cache/generation'), [string]$PythonExe = 'python')
$ErrorActionPreference = 'Stop'
$runtime = [IO.Path]::GetFullPath($RuntimePath)
$manifest = Get-Content (Join-Path $PSScriptRoot 'generation-models.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$python = Join-Path $runtime 'venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $python)) {
    & $PythonExe -c 'import sys; sys.exit(not ((3, 10) <= sys.version_info[:2] <= (3, 13)))'
    if ($LASTEXITCODE) { throw 'Python 3.10-3.13 is required. Pass its executable with -PythonExe.' }
    & $PythonExe -m venv (Join-Path $runtime 'venv')
    if ($LASTEXITCODE) { throw 'Could not create the isolated Python environment.' }
}
& $python -m pip install --disable-pip-version-check --no-cache-dir torch==2.10.0 torchvision==0.25.0 --index-url https://download.pytorch.org/whl/cu128
if ($LASTEXITCODE) { throw 'CUDA PyTorch installation failed.' }
& $python -c 'import sys, torch; sys.exit(not torch.cuda.is_available())'
if ($LASTEXITCODE) { throw 'CUDA is unavailable. Check the NVIDIA GPU driver before downloading generation models.' }
$comfy = Join-Path $runtime 'ComfyUI'
if (!(Test-Path -LiteralPath (Join-Path $comfy 'main.py'))) {
    $archive = Join-Path $runtime 'comfy.zip'
    Invoke-WebRequest "https://github.com/Comfy-Org/ComfyUI/archive/$($manifest.comfyRevision).zip" -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $runtime -Force
    Move-Item -LiteralPath (Join-Path $runtime "ComfyUI-$($manifest.comfyRevision)") -Destination $comfy
    Remove-Item -LiteralPath $archive
}
& $python -m pip install --disable-pip-version-check --no-cache-dir --index-url https://pypi.org/simple -r (Join-Path $comfy 'requirements.txt')
if ($LASTEXITCODE) { throw 'ComfyUI dependency installation failed.' }
$proxyArgs = @()
if (!$env:HTTPS_PROXY -and !$env:ALL_PROXY) {
    $downloadUri = [Uri]'https://huggingface.co'
    $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy($downloadUri)
    if ($systemProxy -and $systemProxy.Authority -ne $downloadUri.Authority) { $proxyArgs = @('--proxy', $systemProxy.AbsoluteUri) }
}
& $python (Join-Path $PSScriptRoot 'download-generation.py') --models-dir (Join-Path $comfy 'models') @proxyArgs
if ($LASTEXITCODE) { throw 'Model download or verification failed. Run setup again to resume.' }
& $python -m pip freeze | Set-Content -LiteralPath (Join-Path $runtime 'installed-requirements.txt') -Encoding utf8
Write-Host 'Ready. Start the local service with scripts/start-generation.ps1.'
