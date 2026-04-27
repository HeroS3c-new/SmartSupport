Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "Server Launcher"
$form.Size = New-Object System.Drawing.Size(300,200)
$form.StartPosition = "CenterScreen"

$label = New-Object System.Windows.Forms.Label
$label.Text = "Scegli il server da avviare:"
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(50,20)
$form.Controls.Add($label)

$button1 = New-Object System.Windows.Forms.Button
$button1.Text = "Node.js"
$button1.Location = New-Object System.Drawing.Point(50,60)
$button1.Add_Click({ Start-Process cmd "/k node --expose-gc index.js --max-old-space-size=65536"; $form.Close() })
$form.Controls.Add($button1)

$button2 = New-Object System.Windows.Forms.Button
$button2.Text = "Prediction Engine"
$button2.Location = New-Object System.Drawing.Point(150,60)
$button2.Add_Click({ Start-Process cmd "/k py prediction_server.py"; $form.Close() })
$form.Controls.Add($button2)

$button3 = New-Object System.Windows.Forms.Button
$button3.Text = "MkDocs"
$button3.Location = New-Object System.Drawing.Point(50,100)
$button3.Add_Click({ Start-Process cmd "/k py -m mkdocs serve -a 0.0.0.0:8000"; $form.Close() })
$form.Controls.Add($button3)

$button4 = New-Object System.Windows.Forms.Button
$button4.Text = "Tutti"
$button4.Location = New-Object System.Drawing.Point(150,100)
$button4.Add_Click({
    Start-Process cmd "/k node --expose-gc index.js --max-old-space-size=65536"
    Start-Process cmd "/k py prediction_server.py"
    Start-Process cmd "/k py -m mkdocs serve -a 0.0.0.0:8000"
    $form.Close()
})
$form.Controls.Add($button4)

$form.ShowDialog()
