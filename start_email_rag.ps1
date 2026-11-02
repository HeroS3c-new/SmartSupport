# Avvia llama-server (porta 8081) e il servizio dell'assistente (porta 5009), entrambi solo su 127.0.0.1.
param(
    [string]$GgufFile = 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    [int]$Threads = 3
)
$root = $PSScriptRoot
$llama = Join-Path $root 'llama_cpp\llama-server.exe'
$model = Join-Path $root "models\rag\$GgufFile"
$python = Join-Path $root '.venv_rag\Scripts\python.exe'
# Avviato da un'attivita' pianificata non ha finestre: gli errori si leggono solo qui.
$logDir = Join-Path $root 'logs\email_rag'

foreach ($required in $llama, $model, $python) {
    if (-not (Test-Path $required)) { throw "Manca $required. Esegui prima setup_email_rag.ps1" }
}
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host '[Assistente] llama-server gia'' attivo sulla porta 8081.' -ForegroundColor Green
} else {
    # ctx-size 2048 basta per 3 chunk piu' la risposta, e ogni token di contesto in meno e' RAM risparmiata.
    # --prio -1: a bassa priorita', Node e i classificatori non devono rallentare per una risposta dell'assistente.
    $llamaArgs = "--host 127.0.0.1 --port 8081 --model '$model' --ctx-size 2048 --parallel 1 --threads $Threads --threads-batch $Threads --no-webui --cache-ram 0 --prio -1"
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "do { & '$llama' $llamaArgs *>> '$logDir\llama.log'; Start-Sleep 5 } while (`$true)"
}

if (Get-NetTCPConnection -LocalPort 5009 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host '[Assistente] Servizio gia'' attivo sulla porta 5009.' -ForegroundColor Green
} else {
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "cd '$root'; do { & '$python' email_rag_server.py *>> '$logDir\server.log'; Start-Sleep 5 } while (`$true)"
}
