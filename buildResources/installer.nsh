!include x64.nsh
!include LogicLib.nsh
!include StrFunc.nsh
!include nsDialogs.nsh
${StrRep}

; ── Board selection page variables ────────────────────────────────────────────
Var BoardDialog
Var Check_Arduino
Var Check_ESP32
Var Check_ESP8266
Var Check_RP2040
Var Check_Maixduino
Var Check_SparkFun

Var State_Arduino
Var State_ESP32
Var State_ESP8266
Var State_RP2040
Var State_Maixduino
Var State_SparkFun

; ── Board selection page (shown before Welcome) ───────────────────────────────
Function BoardSelectionPage
    nsDialogs::Create 1018
    Pop $BoardDialog
    ${If} $BoardDialog == error
        Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 24u "Select the board families you want to install.$\nYou can install additional boards later from within the application."
    Pop $0

    ${NSD_CreateLabel} 0 30u 100% 10u "Board Family"
    Pop $0

    ${NSD_CreateCheckbox} 0 42u 100% 14u "Arduino boards  —  Uno, Nano, Leonardo, Mega, UNO R4  (759 MB)"
    Pop $Check_Arduino
    ${NSD_Check} $Check_Arduino

    ${NSD_CreateCheckbox} 0 58u 100% 14u "ESP32 boards  —  ESP32, ESP32-S3 and all variants  (3,476 MB)"
    Pop $Check_ESP32
    ${NSD_Check} $Check_ESP32

    ${NSD_CreateCheckbox} 0 74u 100% 14u "ESP8266 boards  —  NodeMCU, D1 Mini and variants  (338 MB)"
    Pop $Check_ESP8266

    ${NSD_CreateCheckbox} 0 90u 100% 14u "Raspberry Pi Pico boards  —  Pico, Pico W, Pico 2, Pico 2W  (1,406 MB)"
    Pop $Check_RP2040

    ${NSD_CreateCheckbox} 0 106u 100% 14u "Maixduino boards  —  Sipeed MaixDock, Maixduino K210  (149 MB)"
    Pop $Check_Maixduino

    ${NSD_CreateCheckbox} 0 122u 100% 14u "SparkFun boards  —  SparkFun AVR variants  (4 MB)"
    Pop $Check_SparkFun

    ${NSD_CreateLabel} 0 142u 100% 20u "Note: Uninstalled boards can be added later without re-running this installer.$\nAll board archives are kept in the installation folder."
    Pop $0

    nsDialogs::Show
FunctionEnd

Function LeaveBoardSelectionPage
    ${NSD_GetState} $Check_Arduino   $State_Arduino
    ${NSD_GetState} $Check_ESP32     $State_ESP32
    ${NSD_GetState} $Check_ESP8266   $State_ESP8266
    ${NSD_GetState} $Check_RP2040    $State_RP2040
    ${NSD_GetState} $Check_Maixduino $State_Maixduino
    ${NSD_GetState} $Check_SparkFun  $State_SparkFun
FunctionEnd

; Register our custom page BEFORE the normal installer pages
Page custom BoardSelectionPage LeaveBoardSelectionPage "Board Support"

!macro preInit

    ${If} ${RunningX64}
        SetRegView 64
    ${EndIf}

    ${StrRep} $0 "${UNINSTALL_REGISTRY_KEY}" "Software" "SOFTWARE"
    ${StrRep} $1 "${INSTALL_REGISTRY_KEY}" "Software" "SOFTWARE"

    ReadRegStr $R0 HKCU "$0" "UninstallString"
    ReadRegStr $R1 HKCU "$1" "InstallLocation"

    StrCmp $R0 "" 0 +4

    ReadRegStr $R0 HKLM "$0" "UninstallString"
    ReadRegStr $R1 HKLM "$1" "InstallLocation"

    StrCmp $R0 "" 0 done
    StrCmp $R1 "" 0 done

    WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\RoboCoders-Studio"
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\RoboCoders-Studio"

done:
    ${If} ${RunningX64}
        SetRegView LastUsed
    ${EndIf}

!macroend

; ── Extract selected board packs after main files are installed ───────────────
!macro customInstall

    ; Helper macro to extract one board pack via PowerShell Expand-Archive
    !define ExtractPack "!insertmacro _ExtractPack"
    !macro _ExtractPack PkgId PkgName
        DetailPrint "Installing ${PkgName} board support..."
        nsExec::ExecWait 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \
            "Expand-Archive -Path \"$INSTDIR\board-packs\${PkgId}.zip\" \
            -DestinationPath \"$INSTDIR\tools\Arduino\packages\" -Force"'
        Pop $0
        ${If} $0 != 0
            MessageBox MB_OK|MB_ICONEXCLAMATION \
                "Warning: Failed to install ${PkgName} board support (code $0).$\nYou can install it later from within the application."
        ${EndIf}
    !macroend

    ${If} $State_Arduino == ${BST_CHECKED}
        !insertmacro _ExtractPack "arduino" "Arduino"
    ${EndIf}

    ${If} $State_ESP32 == ${BST_CHECKED}
        !insertmacro _ExtractPack "esp32" "ESP32"
    ${EndIf}

    ${If} $State_ESP8266 == ${BST_CHECKED}
        !insertmacro _ExtractPack "esp8266" "ESP8266"
    ${EndIf}

    ${If} $State_RP2040 == ${BST_CHECKED}
        !insertmacro _ExtractPack "rp2040" "Raspberry Pi Pico"
    ${EndIf}

    ${If} $State_Maixduino == ${BST_CHECKED}
        !insertmacro _ExtractPack "Maixduino" "Maixduino"
    ${EndIf}

    ${If} $State_SparkFun == ${BST_CHECKED}
        !insertmacro _ExtractPack "SparkFun" "SparkFun"
    ${EndIf}

!macroend

!macro customUnInstall

    ${If} ${RunningX64}
        SetRegView 64
    ${EndIf}

    DeleteRegKey HKLM "${INSTALL_REGISTRY_KEY}"
    DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"

    ${If} ${RunningX64}
        SetRegView LastUsed
    ${EndIf}

!macroend
