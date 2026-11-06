param([string]$RuntimePath = (Join-Path $PSScriptRoot '../.cache/generation'))
$ErrorActionPreference = 'Stop'
$runtime = [IO.Path]::GetFullPath($RuntimePath)
$python = Join-Path $runtime 'venv/Scripts/python.exe'
$comfy = Join-Path $runtime 'ComfyUI'
if (!(Test-Path -LiteralPath $python) -or !(Test-Path -LiteralPath (Join-Path $comfy 'main.py'))) {
    throw 'Run scripts/setup-generation.ps1 first.'
}
# Bind to loopback only. Low-VRAM mode offloads weights to RAM; no custom nodes are needed.
& $python (Join-Path $comfy 'main.py') --listen 127.0.0.1 --port 8188 --lowvram --disable-dynamic-vram --cpu-vae --offline --disable-all-custom-nodes --disable-auto-launch
if ($LASTEXITCODE) { throw "Local image generation exited with code $LASTEXITCODE. See the messages above." }
