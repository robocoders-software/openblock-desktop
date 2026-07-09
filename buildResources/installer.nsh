!include x64.nsh
!include LogicLib.nsh
!include StrFunc.nsh
!include nsDialogs.nsh
${StrRep}

; ── Board selection page (shown FIRST, before the install-mode page) ───────────
; MUST be registered BEFORE PAGE_INSTALL_MODE: for a per-machine install, electron-builder
; elevates (relaunches as the inner instance) when the user picks "all users" on the install-mode
; page. Any page registered AFTER install-mode therefore renders in the elevated INNER instance,
; where our ${UAC_IsInnerInstance} guard aborts it — so the page would never appear. The
; customWelcomePage hook (assistedInstaller.nsh, before PAGE_INSTALL_MODE) shows it in the OUTER
; instance before elevation; the inner instance re-runs it and the guard skips it (no double show).
;
; Why a macro hook (not a top-level `Page custom`): the page uses ${UAC_IsInnerInstance}, and this
; script is !include'd very early — BEFORE electron-builder registers the UAC plugin directory — so
; a top-level UAC::_ call fails to compile ("Plugin not found"). The hook is expanded later (after
; the plugin dir is registered) and only in the installer pass, never the uninstaller.
;
; The board Var's are declared INSIDE this macro too: they're used only by this page and by the
; customInstall macro (inserted later, in the installer pass). Declaring them at top level would
; leave them unreferenced in the uninstaller pass → NSIS "warning 6001 ... wasting memory", which
; electron-builder treats as a fatal error.
!macro customWelcomePage

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

    ; "1" once the board page's Leave function has run IN THIS PROCESS. With perMachine (single
    ; elevated instance) customInstall runs in the same process, so it can trust the in-memory
    ; $State_* directly; if this is empty there (an older outer/inner UAC split), it falls back
    ; to the registry values written by the UI instance.
    Var BoardSelectionDone

    Function BoardSelectionPage
        ; When the installer elevates (UAC), it relaunches as an "inner" instance that re-runs
        ; every page. Skip this page there — it was already shown in the outer (UI) instance and
        ; the choice is persisted to the registry. Without this guard the user sees it TWICE.
        ${If} ${UAC_IsInnerInstance}
            Abort
        ${EndIf}

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

        ; Mark that the user made a choice in THIS process. customInstall (same process under
        ; perMachine) trusts $State_* directly when this is set.
        StrCpy $BoardSelectionDone "1"

        ; Also persist to the registry as a fallback for an outer/inner UAC split, where
        ; customInstall runs in a different (elevated) process and the in-memory vars are empty.
        WriteRegStr HKCU "Software\RoboCoders-Studio\Setup" "Arduino"   $State_Arduino
        WriteRegStr HKCU "Software\RoboCoders-Studio\Setup" "ESP32"     $State_ESP32
        WriteRegStr HKCU "Software\RoboCoders-Studio\Setup" "ESP8266"   $State_ESP8266
        WriteRegStr HKCU "Software\RoboCoders-Studio\Setup" "RP2040"    $State_RP2040
        WriteRegStr HKCU "Software\RoboCoders-Studio\Setup" "Maixduino" $State_Maixduino
        WriteRegStr HKCU "Software\RoboCoders-Studio\Setup" "SparkFun"  $State_SparkFun
        WriteRegStr HKCU "Software\RoboCoders-Studio\Setup" "Recorded"  "1"
    FunctionEnd

    Page custom BoardSelectionPage LeaveBoardSelectionPage "Board Support"

!macroend

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

; ── Helper: extract one board pack via PowerShell Expand-Archive ─────────────
; Run it through nsExec (NOT ExecWait). ExecWait launches powershell.exe — a CONSOLE app —
; and does NOT suppress its console window, so a black terminal flashes/lingers on screen
; (worst on slow machines and during large packs like ESP32 ≈ 3.4 GB, where the end user
; sees the board software "unzipping in a terminal"). nsExec::ExecToLog runs the process
; fully HIDDEN and pipes any output into the installer's detail log — same as the icacls
; call below. -WindowStyle Hidden alone can't win the race; nsExec removes the window entirely.
!macro _ExtractPack PkgId PkgName
    DetailPrint "Installing ${PkgName} board support..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "Expand-Archive -Path \"$INSTDIR\board-packs\${PkgId}.zip\" -DestinationPath \"$INSTDIR\tools\Arduino\packages\" -Force"'
    Pop $0
    ${If} $0 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION \
            "Warning: Failed to install ${PkgName} board support (code $0).$\nYou can install it later from within the application."
    ${EndIf}
!macroend
!define ExtractPack "!insertmacro _ExtractPack"

; ── Extract selected board packs after main files are installed ───────────────
!macro customInstall

    ; Decide which boards to install.
    ;  • perMachine → RequestExecutionLevel admin → the installer is ONE elevated process, so the
    ;    board page's Leave ran here and $State_* hold the user's real choice. $BoardSelectionDone
    ;    == "1" confirms it — use them directly (this is the case that was previously ignored).
    ;  • Older outer/inner UAC split → $BoardSelectionDone is empty here; read the values the UI
    ;    instance wrote to the registry.
    ;  • Neither (e.g. a silent /S install) → default boards.
    ${If} $BoardSelectionDone != "1"
        ReadRegStr $9 HKCU "Software\RoboCoders-Studio\Setup" "Recorded"
        ${If} $9 == "1"
            ReadRegStr $State_Arduino   HKCU "Software\RoboCoders-Studio\Setup" "Arduino"
            ReadRegStr $State_ESP32     HKCU "Software\RoboCoders-Studio\Setup" "ESP32"
            ReadRegStr $State_ESP8266   HKCU "Software\RoboCoders-Studio\Setup" "ESP8266"
            ReadRegStr $State_RP2040    HKCU "Software\RoboCoders-Studio\Setup" "RP2040"
            ReadRegStr $State_Maixduino HKCU "Software\RoboCoders-Studio\Setup" "Maixduino"
            ReadRegStr $State_SparkFun  HKCU "Software\RoboCoders-Studio\Setup" "SparkFun"
        ${Else}
            StrCpy $State_Arduino ${BST_CHECKED}
            StrCpy $State_ESP32   ${BST_CHECKED}
        ${EndIf}
    ${EndIf}

    ; Visible in the installer's "Show details" log — confirms the exact selection being applied.
    DetailPrint "Board selection (done=$BoardSelectionDone): Arduino=$State_Arduino ESP32=$State_ESP32 ESP8266=$State_ESP8266 RP2040=$State_RP2040 Maixduino=$State_Maixduino SparkFun=$State_SparkFun"

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

    ; Grant the BUILTIN\Users group Modify rights on the Arduino tools folder so that ANY user
    ; (including a standard, non-admin user) can install additional boards from inside the app
    ; later WITHOUT an admin prompt. arduino-cli uses this single folder as its data dir (cores)
    ; and the in-app Board Manager extracts board packs here. The installer runs elevated, so this
    ; is the one place we can safely open up that specific folder. *S-1-5-32-545 is the well-known
    ; SID for the Users group (locale-independent); (OI)(CI) makes new files/dirs inherit the right.
    CreateDirectory "$INSTDIR\tools\Arduino\packages"
    DetailPrint "Configuring board folder permissions..."
    nsExec::ExecToLog 'icacls "$INSTDIR\tools\Arduino" /grant "*S-1-5-32-545:(OI)(CI)M" /T /C'
    Pop $0

    ; Clean up the temporary selection key now that it's been applied.
    DeleteRegKey HKCU "Software\RoboCoders-Studio\Setup"

!macroend

!macro customUnInstall

    ${If} ${RunningX64}
        SetRegView 64
    ${EndIf}

    DeleteRegKey HKLM "${INSTALL_REGISTRY_KEY}"
    DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
    ; Also drop the temporary board-selection key in case a prior install left it behind.
    DeleteRegKey HKCU "Software\RoboCoders-Studio\Setup"

    ${If} ${RunningX64}
        SetRegView LastUsed
    ${EndIf}

    ; ── Full cleanup so the app never appears "still installed" ────────────────────
    ; Make sure the app isn't running, otherwise its open files are LOCKED and can't be deleted —
    ; which leaves a partial install behind and the uninstall entry lingering. (electron-builder
    ; also checks, but this is a hard guarantee.) Non-fatal if the process isn't found.
    nsExec::Exec 'taskkill /f /im "${PRODUCT_FILENAME}.exe"'
    Pop $0
    Sleep 800

    ; Remove EVERYTHING remaining in the install folder, INCLUDING files created at RUNTIME that are
    ; NOT in the uninstaller's manifest: board packs extracted by the in-app Board Manager, Arduino
    ; libraries compiled by device extensions, and the user-writable tools\Arduino cache. The default
    ; uninstaller deletes only the files it installed, so those runtime files would remain — leaving a
    ; non-empty install folder that looks "not uninstalled" and blocks the final RMDir/entry cleanup.
    ; The uninstaller runs from a TEMP copy of itself, so removing $INSTDIR here is safe.
    RMDir /r "$INSTDIR"

!macroend
