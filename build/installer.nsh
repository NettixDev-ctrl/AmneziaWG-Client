; Дополнительные шаги установщика Privata VPN (NSIS, electron-builder).
; Служба awg-helper устанавливается один раз (установщик работает с правами администратора).

!macro customInit
  ; При обновлении останавливаем работающие службы, чтобы можно было заменить файлы.
  nsExec::Exec 'sc stop PrivataVPNHelper'
  nsExec::Exec 'sc stop AmneziaWGTunnel$$PrivataVPN'
  Sleep 1500
!macroend

!macro customInstall
  nsExec::ExecToLog '"$INSTDIR\resources\helper\awg-helper.exe" install'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Не удалось установить службу Privata VPN (код $0). Приложение можно будет установить службу позже из окна программы."
  ${EndIf}
  ; Папка конфигураций доступна обычным пользователям для добавления .conf (чтение службой идёт через приложение).
  CreateDirectory "$INSTDIR\configs"
  nsExec::Exec 'icacls "$INSTDIR\configs" /grant *S-1-5-32-545:(OI)(CI)M'
!macroend

!macro customUnInstall
  nsExec::Exec '"$INSTDIR\resources\helper\awg-helper.exe" uninstall'
  nsExec::Exec 'sc stop WinDivert'
  nsExec::Exec 'sc delete WinDivert'
!macroend
