; hcom_gui 커스텀 NSIS 설치 스크립트
; - 세련된 모노크롬 브랜딩과 명확한 한국어 안내 문구
; - 실행 중인 구버전을 자동 정리해 제자리 업데이트 지원
; - 사용자 데이터(%LOCALAPPDATA%\hcom_gui)는 업데이트·재설치 시 보존

!macro customHeader
  !ifndef MUI_WELCOMEFINISHPAGE_BITMAP_NOSTRETCH
    !define MUI_WELCOMEFINISHPAGE_BITMAP_NOSTRETCH
  !endif
  !ifndef MUI_HEADERIMAGE_BITMAP_NOSTRETCH
    !define MUI_HEADERIMAGE_BITMAP_NOSTRETCH
  !endif
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "hcom_gui 설치 및 업데이트"
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_WELCOMEPAGE_TEXT "프로젝트별 격리 AI 세션 워크스페이스 hcom_gui를 설치합니다.$\r$\n$\r$\n• 프로젝트마다 독립된 HCOM_DIR, Codex, Antigravity 세션 유지$\r$\n• 최신 설치 파일(.exe)을 실행하면 기존 설정과 데이터(%LOCALAPPDATA%\hcom_gui)를 유지한 채 제자리 업데이트됩니다.$\r$\n$\r$\n계속하려면 [다음]을 클릭하세요."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "hcom_gui 설치가 완료되었습니다"
  !define MUI_FINISHPAGE_TITLE_3LINES
  !define MUI_FINISHPAGE_TEXT "hcom_gui가 준비되었습니다. 로컬 Git 프로젝트를 등록해 프로젝트별 AI 세션을 바로 시작할 수 있습니다."
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customInit
  ; 업데이트 설치 시 실행 중인 기존 hcom_gui.exe를 먼저 종료해 파일 잠금을 해제한다.
  nsExec::ExecToStack 'taskkill /IM "hcom_gui.exe" /T'
  Pop $0
  Pop $1
  Sleep 700
  nsExec::ExecToStack 'taskkill /IM "hcom_gui.exe" /F /T'
  Pop $0
  Pop $1
  Sleep 400
!macroend
