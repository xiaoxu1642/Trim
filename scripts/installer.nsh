; scripts/installer.nsh — electron-builder NSIS 自定义钩子
; 批次：v3.5.1（桌面快捷方式在更新后丢失）
;
; 位置说明：electron-builder 的 nsis.include 路径解析（app-builder-lib/out/platformPackager.js
; 的 getResource）依次尝试 ① buildResources 目录下的同名文件 ② resolve(buildResources, 值)
; ③ resolve(项目根, 值)，命中即用。这里靠 ③ 命中，因此不需要为它单开 buildResources 目录；
; 若日后要加 installerIcon.ico / license.txt 等默认从 buildResources 发现的资源，
; 需在 package.json 里显式指定路径，或重新建 build/ 目录。
;
; ── 根因（读 electron-builder 26.x 自带模板逐行确认）──────────────────
; templates/nsis/include/installer.nsh 的 addDesktopLink 宏在
;   $oldDesktopLink == $newDesktopLink（同名，即 $DESKTOP\Trim.lnk）且该文件已不存在
; 时，只要 ${isUpdated} 为真就**刻意不重建**。本意是「用户自己删掉的快捷方式不要偷偷加回来」。
;
; 但更新流程里，新版安装器会先调用旧版卸载器
; （installUtil.nsh 的 uninstallOldVersion → uninstaller.nsh），而卸载器会执行
;   Delete "$oldDesktopLink"
; 把桌面快捷方式删掉。等安装阶段再判断时文件已经没了，于是被误判成「用户删的」→
; 分支被跳过 → 桌面图标永久消失（旧图标被删、新图标没补）。
; 注意：createDesktopShortcut 置为 true/always 也救不了——模板里那个
; ${ifNot} ${isUpdated} 判断在 RECREATE_DESKTOP_SHORTCUT 分支内依然生效，更新路径照样跳过。
;
; ── 修法 ─────────────────────────────────────────────────────────────
; 1) customInit（installer.nsi 的 .onInit 内，早于旧版卸载器）把「桌面上本来有没有
;    快捷方式」快照进安装注册表键；
; 2) customInstall（installSection.nsh 末尾，晚于 addDesktopLink）若发现快照为「有」
;    而现在「没有」，就补建一次。
; 语义仍然尊重用户选择：用户原本就没有桌面快捷方式的，不会被强行加上去。
;
; 依赖的 define 都是 electron-builder 模板本身在用的（INSTALL_REGISTRY_KEY / SHORTCUT_NAME /
; APP_EXECUTABLE_FILENAME / APP_DESCRIPTION / APP_ID / PRODUCT_FILENAME），没有自造。
; 若日后把 build.nsis.createDesktopShortcut 改成 false，本文件需同步删除。

!include "LogicLib.nsh"

!macro customInit
  ; 目标文件名与 electron-builder 的 setLinkVars（common.nsh:86-93）保持一致：
  ; 老版本可能用过别的 ShortcutName，注册表里有记录就按记录来，否则退回产品文件名。
  ReadRegStr $R0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" ShortcutName
  ${If} $R0 == ""
    StrCpy $R0 "${PRODUCT_FILENAME}"
  ${EndIf}
  ; 每次安装都重新快照，先清旧值，避免上次运行的结果污染本次判断
  DeleteRegValue SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" TrimHadDesktopLink
  ${If} ${FileExists} "$DESKTOP\$R0.lnk"
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" TrimHadDesktopLink "1"
  ${EndIf}
!macroend

!macro customInstall
  ReadRegStr $R1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" TrimHadDesktopLink
  ${If} $R1 == "1"
  ${AndIfNot} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
    ; 通知外壳刷新桌面图标缓存，否则新建的 lnk 可能不立即显示
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend
