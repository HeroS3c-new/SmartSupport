# Installa l'assistente email: venv dedicato, llama.cpp, LLM ed embedding. Si puo' rilanciare: salta cio' che esiste gia'.
# Dopo il setup nessun componente ha bisogno di Internet.
param(
    # Build fissata: "latest" su GitHub punta a una release senza i pacchetti Windows.
    [string]$LlamaTag = 'b12034',
    [string]$GgufRepo = 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    [string]$GgufFile = 'Llama-3.2-3B-Instruct-Q4_K_M.gguf'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = $PSScriptRoot
$modelsDir = Join-Path $root 'models\rag'
$embedDir = Join-Path $modelsDir 'multilingual-e5-small'
$llamaDir = Join-Path $root 'llama_cpp'
$venvDir = Join-Path $root '.venv_rag'

function Get-IfMissing($url, $target) {
    if (Test-Path $target) { Write-Host "Presente: $target"; return }
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    Write-Host "Scarico $url"
    Invoke-WebRequest -Uri $url -OutFile "$target.part" -UseBasicParsing
    Move-Item "$target.part" $target
}

# Venv separato: i servizi in produzione usano il Python di sistema e le loro dipendenze non vanno toccate.
if (-not (Test-Path (Join-Path $venvDir 'Scripts\python.exe'))) { python -m venv $venvDir }
& (Join-Path $venvDir 'Scripts\python.exe') -m pip install --quiet -r (Join-Path $root 'requirements-rag.txt')
if ($LASTEXITCODE -ne 0) { throw 'Installazione dipendenze fallita' }

if (-not (Test-Path (Join-Path $llamaDir 'llama-server.exe'))) {
    $release = Invoke-RestMethod "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$LlamaTag"
    $asset = $release.assets | Where-Object { $_.name -match 'bin-win-cpu-x64\.zip$' } | Select-Object -First 1
    if (-not $asset) { throw "Nessun pacchetto CPU Windows nella release $($release.tag_name)" }
    $zip = Join-Path $env:TEMP $asset.name
    Write-Host "llama.cpp $($release.tag_name): $($asset.name)"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $llamaDir -Force
    Remove-Item $zip
    Set-Content -Path (Join-Path $llamaDir 'VERSION.txt') -Value $release.tag_name
}

Get-IfMissing "https://huggingface.co/$GgufRepo/resolve/main/$GgufFile" (Join-Path $modelsDir $GgufFile)
$xenova = 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/main'
Get-IfMissing "$xenova/onnx/model_quantized.onnx" (Join-Path $embedDir 'onnx\model_quantized.onnx')
Get-IfMissing "$xenova/tokenizer.json" (Join-Path $embedDir 'tokenizer.json')

Write-Host 'Setup completato. Prima indicizzazione: .venv_rag\Scripts\python.exe email_rag_index.py'
