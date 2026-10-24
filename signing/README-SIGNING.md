# Signing Folio

Folio's installer and app are signed with a **self-signed** code-signing certificate:
`CN=Zac (Folio), O=Zac, C=MA`, valid until October 2031.

## What self-signing does, and doesn't do

| | On your PC (after trusting the certificate) | On other people's PCs |
|---|---|---|
| Publisher shown when installing | **Zac (Folio)**, "Verified publisher" | "Unknown publisher" |
| Proves the file wasn't changed | Yes. A modified file fails the check | Only if they also trust your certificate |
| Removes the SmartScreen warning | Not reliably. A downloaded file can still show it (Properties > Unblock removes it) | **No** |

Removing SmartScreen for everyone needs a certificate from a trusted company, or publishing on the Microsoft Store (free, Microsoft signs it).

## Trust the certificate on your PC

1. Keep `Folio-Certificate.cer` and `trust-folio-certificate.ps1` in the same folder.
2. Right-click `trust-folio-certificate.ps1` and choose **Run with PowerShell**.
3. Windows asks if you want to install the certificate. Click **Yes**.

This only affects your Windows account. `untrust-folio-certificate.ps1` removes it again.

## Build a signed installer yourself (Windows, PowerShell)

```powershell
npm install
$env:CSC_LINK = "C:\path\to\folio-signing.pfx"
$env:CSC_KEY_PASSWORD = "your pfx password"
npm run dist:win
```

On your own PC the signature also gets a timestamp, so it stays valid even after the certificate expires.
Without `CSC_LINK`, the build still works but isn't signed.

## Your own key (recommended)

The key in `folio-signing.pfx` was created in a cloud workspace. For long-term use, run
`new-signing-certificate.ps1` on your PC. It creates a fresh key that never leaves your computer.
Then trust the new `Folio-Certificate.cer`, and remove the old one with `untrust-folio-certificate.ps1`
**before** you replace the .cer file.

## Rules

- **Never** share `folio-signing.pfx` or its password, or commit it to Git. (`.gitignore` already blocks `*.pfx`.)
- Anyone who has the pfx can sign programs that your PC will trust as "Zac (Folio)".
- Only trust a certificate on another PC if you gave it to that person yourself.
