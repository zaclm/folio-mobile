; Folio installer branding (included by electron-builder before the pages are built)

!macro customHeader
  BrandingText "Folio ${VERSION}"
!macroend

; ---------- Welcome page ----------
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Folio"
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_WELCOMEPAGE_TEXT "Folio is a calm place to read and write Markdown.$\r$\n$\r$\nRead your notes the way they look in Claude, then switch to Edit to change them like a Notion page or a Google Doc. Your files stay on your computer.$\r$\n$\r$\nThis will install Folio ${VERSION}. Click Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ---------- Finish page (keeps the default 'Run Folio' checkbox) ----------
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_TITLE "Folio is ready"
  !define MUI_FINISHPAGE_TITLE_3LINES
  !define MUI_FINISHPAGE_TEXT "Folio has been installed on your computer.$\r$\n$\r$\nTip: right-click any .md file, choose Open with, then Folio, and tick Always to open Markdown files in Folio with a double-click."
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Open Folio now"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend

; ---------- Uninstaller welcome page ----------
!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Uninstall Folio"
  !define MUI_WELCOMEPAGE_TEXT "This will remove Folio from your computer.$\r$\n$\r$\nYour Markdown files are not touched: they stay exactly where they are.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
