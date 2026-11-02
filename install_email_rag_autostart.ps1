#Requires -RunAsAdministrator
# Fa partire l'assistente email al boot con un'attivita' pianificata propria, separata da \AvvioMaeSkimmerTutti:
# se l'assistente ha un problema, l'avvio di Node e degli altri servizi non ne risente.
# Rimozione: Unregister-ScheduledTask -TaskName AvvioAssistenteEmail -Confirm:$false
$ErrorActionPreference = 'Stop'
$taskName = 'AvvioAssistenteEmail'
$script = Join-Path $PSScriptRoot 'start_email_rag.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT1M'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Attivita' $taskName creata."

# Prova subito: si ferma l'istanza gia' attiva, cosi' parte quella di sistema. Solo l'assistente, nessun altro servizio.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -match 'llama-server|email_rag_server' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
foreach ($port in 5009, 8081) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -match 'email_rag_server' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 8

Start-ScheduledTask -TaskName $taskName
$ready = $false
foreach ($i in 1..60) {
    Start-Sleep -Seconds 2
    try {
        Invoke-RestMethod 'http://127.0.0.1:5009/api/assistant/status' -TimeoutSec 3 | Out-Null
        Invoke-RestMethod 'http://127.0.0.1:8081/health' -TimeoutSec 3 | Out-Null
        $ready = $true
        break
    } catch {}
}
if ($ready) {
    Write-Host "OK: assistente attivo. Da ora parte da solo a ogni riavvio." -ForegroundColor Green
} else {
    Write-Host "ERRORE: assistente non partito. Controlla logs\email_rag\ e invia l'esito." -ForegroundColor Red
    exit 1
}
