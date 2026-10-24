# Trust Folio's self-signed certificate on THIS computer (current Windows user only).
# After this, Windows shows "Verified publisher: Zac (Folio)" when you install Folio.
#
# Run: right-click this file > "Run with PowerShell"
#   or in PowerShell:  powershell -ExecutionPolicy Bypass -File .\trust-folio-certificate.ps1
#
# Windows will show a security warning asking if you want to install the certificate. Click "Yes".
# Only do this with a certificate you made yourself or got directly from Zac.

$ErrorActionPreference = 'Stop'
$cerPath = Join-Path $PSScriptRoot 'Folio-Certificate.cer'
if (-not (Test-Path $cerPath)) { throw "Folio-Certificate.cer not found next to this script." }

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cerPath)

# Safety check: only accept a code-signing certificate for Folio.
$isCodeSigning = $cert.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq '1.3.6.1.5.5.7.3.3' }
if (-not $isCodeSigning -or $cert.Subject -notmatch 'Folio') {
    throw "This is not the Folio code-signing certificate. Nothing was changed."
}

Write-Host ""
Write-Host "Certificate : $($cert.Subject)"
Write-Host "Thumbprint  : $($cert.Thumbprint)"
Write-Host "Valid until : $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host ""

Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null

Write-Host "Done. Folio's certificate is now trusted for your Windows account." -ForegroundColor Green
Write-Host "To undo this later, run untrust-folio-certificate.ps1."
Write-Host ""
Read-Host "Press Enter to close"
