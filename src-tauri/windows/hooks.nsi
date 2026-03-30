!macro NSIS_HOOK_POSTINSTALL
  ${GetOptions} $CMDLINE "/AUTOSTART" $0
  ${IfNot} ${Errors}
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
!macroend
