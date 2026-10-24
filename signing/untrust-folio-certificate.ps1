# Remove Folio's self-signed certificate from this computer (current Windows user).
# Run: right-click > "Run with PowerShell"

$ErrorActionPreference = 'Stop'
$cerPath = Join-Path $PSScriptRoot 'Folio-Certificate.cer'
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cerPath)
$removed = 0
foreach ($store in 'Root', 'TrustedPublisher') {
    $item = Get-ChildItem "Cert:\CurrentUser\$store" | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
    if ($item) { $item | Remove-Item; $removed++ }
}
Write-Host "Removed the Folio certificate from $removed store(s)." -ForegroundColor Green
Read-Host "Press Enter to close"
