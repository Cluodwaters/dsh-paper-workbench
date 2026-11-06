; Keep the maintained electron-builder installer; customize only validation.
; Directory validation runs when the user leaves the page, not on each key.
!include LogicLib.nsh
!ifndef BUILD_UNINSTALLER
!define MUI_DIRECTORYPAGE_VERIFYONLEAVE
!define MUI_DIRECTORYPAGE_TEXT_TOP "请选择程序的安装位置，与论文资料库分开放置。安装器会先检查所选目录能否写入。"

Var PWInstallError
Var PWInstallTarget

!macro customHeader
  Function PWValidateDirectory
    Push $0
    Push $1
    Push $2
    StrCpy $PWInstallError ""
    StrCpy $PWInstallTarget "$INSTDIR"
    ; Match the default assisted installer's final directory calculation.
    ${IfNot} ${Silent}
      ${StrContains} $0 "${APP_FILENAME}" $PWInstallTarget
      ${If} $0 == ""
        StrCpy $PWInstallTarget "$PWInstallTarget\${APP_FILENAME}"
      ${EndIf}
    ${EndIf}

    IfFileExists "$INSTDIR\library.sqlite" data_directory
    IfFileExists "$PWInstallTarget\library.sqlite" data_directory
    ClearErrors
    CreateDirectory "$PWInstallTarget"
    IfErrors access_denied
    GetTempFileName $1 "$PWInstallTarget"
    IfErrors access_denied
    FileOpen $2 "$1" w
    IfErrors probe_failed
    FileWrite $2 "Paper Workbench installation write check."
    FileClose $2
    IfErrors probe_failed
    Delete "$1"
    IfErrors access_denied
    Goto validation_done

    probe_failed:
      Delete "$1"
    access_denied:
      StrCpy $PWInstallError "无法写入安装目录：$\r$\n$PWInstallTarget$\r$\n$\r$\n请选择可写目录，或返回选择为所有用户安装（Windows 会请求管理员权限）。这不是程序正在运行的提示。"
      Goto validation_done
    data_directory:
      StrCpy $PWInstallError "所选目录包含文献资料库。请选择独立的程序安装目录，以便升级和卸载时保留论文与标注。"
    validation_done:
      ; A local diagnostic survives a failed or silent installation.
      FileOpen $2 "$TEMP\PaperWorkbench-setup-${VERSION}.log" a
      ${IfNot} ${Errors}
        FileWrite $2 "source=$EXEPATH$\r$\ntarget=$PWInstallTarget$\r$\nerror=$PWInstallError$\r$\n$\r$\n"
        FileClose $2
      ${EndIf}
      Pop $2
      Pop $1
      Pop $0
      ${If} $PWInstallError != ""
        DetailPrint "$PWInstallError"
        MessageBox MB_OK|MB_ICONEXCLAMATION "$PWInstallError" /SD IDOK
        SetErrors
      ${Else}
        ClearErrors
      ${EndIf}
  FunctionEnd

  Function .onVerifyInstDir
    Call PWValidateDirectory
    ${If} ${Errors}
      Abort
    ${EndIf}
  FunctionEnd
!macroend

!macro customInit
  ; Silent installs skip the directory page but need the same validation.
  ${If} ${Silent}
    Call PWValidateDirectory
    ${If} ${Errors}
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customFiles_x64
  ; Fail before registry/shortcut creation if extraction did not produce a
  ; runnable installation. Do not report an incomplete payload as success.
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 payload_incomplete
  IfFileExists "$INSTDIR\resources\app.asar" 0 payload_incomplete
  IfFileExists "$INSTDIR\resources\runtime\node.exe" 0 payload_incomplete
  IfFileExists "$INSTDIR\resources\backend\src\server\main.mjs" 0 payload_incomplete
  IfFileExists "$INSTDIR\resources\backend\resources\bin\PaperWorkbench.OfficeBridge.exe" 0 payload_incomplete
  Goto payload_complete
  payload_incomplete:
    MessageBox MB_OK|MB_ICONSTOP "安装文件未完整解压到：$\r$\n$INSTDIR$\r$\n请确认目录可写和磁盘空间充足，然后重试。" /SD IDOK
    SetErrorLevel 2
    Quit
  payload_complete:
!macroend

!endif
