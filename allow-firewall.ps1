#Requires -RunAsAdministrator
# Allows phones on your PRIVATE networks to reach SnapBridge. Usage: .\allow-firewall.ps1 [-Port 8000]
param([int]$Port = 8000)

Remove-NetFirewallRule -DisplayName "SnapBridge" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "SnapBridge" -Direction Inbound -Protocol TCP -LocalPort $Port `
  -Action Allow -Profile Private | Out-Null
Write-Host "Firewall rule added: inbound TCP $Port on Private networks."
