# Create YOUR OWN Folio code-signing certificate on this computer (recommended long term:
# the private key is made here and never leaves your PC).
#
# Run in PowerShell from this folder:
#   powershell -ExecutionPolicy Bypass -File .\new-signing-certificate.ps1
#
# It creates:
#   folio-signing.pfx        PRIVATE key + certificate (password protected). Keep it secret, back it up.
#   Folio-Certificate.cer    PUBLIC certificate. Safe to share; used by trust-folio-certificate.ps1.

$ErrorActionPreference = 'Stop'
$pfxPath = Join-Path $PSScriptRoot 'folio-signing.pfx'
$cerPath = Join-Path $PSScriptRoot 'Folio-Certificate.cer'

if (Test-Path $pfxPath) { throw "folio-signing.pfx already exists. Move it away first if you really want a new one." }

$password = Read-Host -AsSecureString "Choose a password for the private key (you'll need it when building)"

$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject 'CN=Zac (Folio), O=Zac, C=MA' `
    -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(5) `
    -CertStoreLocation Cert:\CurrentUser\My

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $password | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

# The pfx is the copy you use; remove the one left in the personal store.
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)"

Write-Host ""
Write-Host "Created a new certificate:" -ForegroundColor Green
Write-Host "  Subject    : $($cert.Subject)"
Write-Host "  Thumbprint : $($cert.Thumbprint)"
Write-Host "  Valid until: $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host ""
Write-Host "Next: run trust-folio-certificate.ps1 to trust it on this PC, then build with signing (see README-SIGNING.md)."
