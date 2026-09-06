// 右键菜单扫描 / 备份 / 删除 PowerShell 脚本
// 扫描逻辑对齐参考实现 ContextMenuManager（BluePointLilac）：
//   - 场景路径常量（MENUPATH_*）：HKCR\* / Folder / Directory / Background / DesktopBackground /
//     Drive / AllFilesystemObjects / CLSID\{20D04FE0}(此电脑) / CLSID\{645FF040}(回收站) /
//     LibraryFolder(库) / SystemFileAssociations\.exe(exe) 等
//   - Shell 项菜单名解析：MUIVerb(含 @dll,-id 资源串) > 默认值(非多级菜单) > 键名
//   - ShellEx 项：GUID 从键默认值解析，失败回退键名本身；名称取 CLSID
//     LocalizedString/InfoTip/默认值 > InprocServer32 DLL 的 FileDescription > 键名
//   - 厂商：DLL VersionInfo.CompanyName > CLSID 键 Company 值
//   - 去重：同一场景内 keyName 去重 + 全局 category|name|clsid 去重；跳过
//     -ContextMenuHandlers 禁用前缀键（规避幽灵项与重复扫描）
// 扫描分类：文件、EXE文件、LNK文件、目录、文件夹、驱动器、回收站、目录背景、
//           桌面背景、此电脑、库、发送到、UWP应用

const DIAG = require('../main/diag');

const SCAN_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
\$OutputEncoding = [System.Text.Encoding]::UTF8
\$ErrorActionPreference = 'SilentlyContinue'
\$ProgressPreference = 'SilentlyContinue'

\$script:results = @()

# ==================== 间接资源串解析（@shell32.dll,-30345 形式） ====================
# 对齐参考实现 ResourceString.GetDirectString：LoadLibrary + LoadString
if (-not ('WinCleanRes' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinCleanRes {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr LoadLibraryW(string lpFileName);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool FreeLibrary(IntPtr hModule);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern int LoadStringW(IntPtr hInstance, int uID, StringBuilder lpBuffer, int nBufferMax);
  public static string GetString(string dllPath, int id) {
    IntPtr h = LoadLibraryW(dllPath);
    if (h == IntPtr.Zero) return null;
    try {
      StringBuilder sb = new StringBuilder(1024);
      int len = LoadStringW(h, id, sb, sb.Capacity);
      return len > 0 ? sb.ToString() : null;
    } finally { FreeLibrary(h); }
  }
}
"@
}

function Get-ResourceString {
  param([string]\$Ref)
  if ([string]::IsNullOrWhiteSpace(\$Ref)) { return \$null }
  \$m = [regex]::Match(\$Ref.Trim(), '^@\\s*([^,]+?)\\s*,\\s*-(\\d+)')
  if (-not \$m.Success) { return \$null }
  \$dllPath = \$m.Groups[1].Value.Trim('"').Trim()
  if ([string]::IsNullOrWhiteSpace(\$dllPath)) { return \$null }
  \$dllPath = [Environment]::ExpandEnvironmentVariables(\$dllPath)
  if (-not (\$dllPath -match '[\\\\/]')) {
    # 相对库名（如 shell32.dll）：尝试系统目录
    \$sysCandidate = Join-Path \$env:WINDIR ('System32\\' + \$dllPath)
    if (Test-Path -LiteralPath \$sysCandidate) { \$dllPath = \$sysCandidate }
  }
  if (-not (Test-Path -LiteralPath \$dllPath)) { return \$null }
  try { return [WinCleanRes]::GetString(\$dllPath, [int]\$m.Groups[2].Value) } catch { return \$null }
}

# 直接字符串：@ 引用串优先走资源解析，解析失败回退原文
function Get-DirectString {
  param([string]\$Value)
  if ([string]::IsNullOrWhiteSpace(\$Value)) { return '' }
  \$v = \$Value.Trim()
  if (\$v.StartsWith('@')) {
    \$resolved = Get-ResourceString \$v
    if (\$resolved) { return \$resolved }
    return ''
  }
  return \$v
}

# ==================== 工具 ====================
function Test-GuidText {
  param([string]\$Text)
  if ([string]::IsNullOrWhiteSpace(\$Text)) { return \$false }
  return \$Text.Trim() -match '^\\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\\}\$'
}

# PSPath -> 标准注册表路径（HKEY_CLASSES_ROOT\\...，去除 Registry:: 提供程序前缀）
function Convert-ToStdRegPath {
  param([string]\$PsPath)
  return ([string]\$PsPath) -replace '^Microsoft\\.PowerShell\\.Core\\\\Registry::', ''
}

# 清洗字符串：移除会导致 JSON / UTF-8 输出损坏的字符
# （孤立代理 U+D800~U+DFFF、非字符 U+FFFE/U+FFFF、控制字符 U+0000~U+001F 与 U+007F）
# 这些字符常见于注册表脏数据，会破坏 JSON 字符串终止引号
function Format-CleanStr {
  param([string]\$s)
  if ([string]::IsNullOrEmpty(\$s)) { return '' }
  \$sb = New-Object System.Text.StringBuilder
  foreach (\$ch in \$s.ToCharArray()) {
    \$cp = [int][char]\$ch
    if (\$cp -lt 0x20) { continue }
    if (\$cp -eq 0x7f) { continue }
    if (\$cp -ge 0xD800 -and \$cp -le 0xDFFF) { continue }
    if (\$cp -eq 0xFFFE -or \$cp -eq 0xFFFF) { continue }
    \$null = \$sb.Append(\$ch)
  }
  return \$sb.ToString()
}

# 安全 JSON 序列化：手工拼出合法 JSON 字符串字面量，把所有非 ASCII 字符转义为 \\uXXXX，
# 使整段输出为纯 ASCII，彻底规避两类问题：
#   (1) PowerShell ConvertTo-Json 对注册表脏数据偶发丢失字符串终止引号的缺陷；
#   (2) 管道输出 UTF-8/UTF-16LE 编码不一致导致的中文乱码（\\uXXXX 与流编码无关，JSON.parse 可还原）。
function ConvertTo-JsonSafeString {
  param([string]\$s)
  if (\$null -eq \$s) { \$s = '' }
  \$s = [string]\$s
  \$sb = New-Object System.Text.StringBuilder
  \$null = \$sb.Append('"')
  foreach (\$ch in \$s.ToCharArray()) {
    \$cp = [int][char]\$ch
    if (\$cp -eq 34) { \$null = \$sb.Append('\\"'); }        # " 双引号
    elseif (\$cp -eq 92) { \$null = \$sb.Append('\\\\'); }    # \ 反斜杠
    elseif (\$cp -eq 8) { \$null = \$sb.Append('\\b'); }
    elseif (\$cp -eq 12) { \$null = \$sb.Append('\\f'); }
    elseif (\$cp -eq 10) { \$null = \$sb.Append('\\n'); }
    elseif (\$cp -eq 13) { \$null = \$sb.Append('\\r'); }
    elseif (\$cp -eq 9) { \$null = \$sb.Append('\\t'); }
    elseif (\$cp -lt 0x20 -or (\$cp -ge 0x7f -and \$cp -le 0x9f) -or \$cp -ge 0x80) {
      \$null = \$sb.Append('\\u' + \$cp.ToString('x4'))
    }
    else { \$null = \$sb.Append(\$ch) }
  }
  \$null = \$sb.Append('"')
  return \$sb.ToString()
}

function ConvertTo-JsonSafeBool {
  param([bool]\$b)
  if (\$b) { return 'true' } else { return 'false' }
}

\$protectedCLSIDs = @(
  '{20D04FE0-3AEA-1069-A2D8-08002B30309D}',
  '{450D8FBA-AD25-11D0-98A8-0800361B1103}',
  '{208D2C60-3AEA-1069-A2D2-08002B30309D}',
  '{1F4DE370-D627-11D1-BA4F-00A0C91EEDBA}',
  '{59031A47-3F72-35A7-89EC-6E8B9A8A5B5E}',
  '{59BE1D4E-E3A4-4D8A-91A3-69D69F66A4AC}',
  '{645FF040-5081-101B-9F08-00AA002F954E}'
)

\$knownSystem = @(
  'CopyAsPathMenu', 'FileExplorerClassic', 'ModernSharing', 'WorkFolders', 'EPP',
  'FileSyncConfig', 'OpenWithList', 'Open', 'Explore', 'find', 'printto', 'Properties',
  'RunAs', 'RunAsUser', 'CompatibilityPage', 'Map Network Drive', 'Disconnect Network Drive',
  'EmptyRecycleBin', 'Delete', 'Restore', 'Cut', 'Copy', 'Paste', 'Rename', 'open', 'explore',
  'opennewprocess', 'opennewtab', 'opennewwindow', 'pintohome', 'pintohomefile', 'runas',
  'runasuser', 'cmd', 'Powershell', 'change-passphrase', 'change-pin', 'encrypt-bde',
  'manage-bde', 'resume-bde', 'unlock-bde', 'empty', 'Personalize', 'Display',
  'DesktopSlideshow', 'New', 'Compatibility', 'OpenWith', 'PinToStartScreen', 'Preview',
  'edit', 'print', 'play', 'Set defaults', 'Sync', 'Share', 'GiveAccessTo', 'UpdatePerUserSystemParameters',
  '获取所有权', 'takeown', 'Print', 'PinToQuickAccess', 'UnpinFromQuickAccess', 'SyncCenter',
  'IncludeInLibrary', 'PinToStart', 'PinToTaskbar', 'PreviousVersions', 'ScanWithWindowsDefender',
  'Windows.ModernShare', 'Windows.Share', 'Windows.PinToHome', 'Windows.Cut', 'Windows.Copy',
  'Windows.Paste', 'Windows.Rename', 'Windows.Delete', 'Windows.Properties'
)

# ==================== CLSID 信息解析（对齐参考 GuidInfo.GetFilePath / GetText） ====================
# CLSID 查找视图：HKCR\\CLSID（主）、HKCR\\WOW6432Node\\CLSID、HKLM 32 位视图
\$clsidViews = @(
  'Registry::HKEY_CLASSES_ROOT\\CLSID',
  'Registry::HKEY_CLASSES_ROOT\\WOW6432Node\\CLSID',
  'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\Wow6432Node\\CLSID'
)
\$script:clsidCache = @{}

function Get-ClsidInfo {
  param([string]\$GuidText)
  \$g = ([string]\$GuidText).Trim()
  \$empty = @{ name = ''; company = ''; filePath = '' }
  if (-not (Test-GuidText \$g)) { return \$empty }
  if (\$script:clsidCache.ContainsKey(\$g)) { return \$script:clsidCache[\$g] }

  \$info = @{ name = ''; company = ''; filePath = '' }
  foreach (\$view in \$clsidViews) {
    \$keyPath = '{0}\\{1}' -f \$view, \$g
    if (-not (Test-Path -LiteralPath \$keyPath)) { continue }
    try {
      \$key = Get-Item -LiteralPath \$keyPath -ErrorAction Stop
      # 名称链（对齐 GuidInfo.GetText）：LocalizedString > InfoTip > 默认值（均支持 @dll,-id 资源串）
      foreach (\$vn in @('LocalizedString', 'InfoTip', '')) {
        \$raw = if (\$vn) { [string]\$key.GetValue(\$vn) } else { [string]\$key.GetValue('') }
        \$resolved = Get-DirectString \$raw
        if (\$resolved) { \$info.name = \$resolved; break }
      }
      # 厂商：CLSID 键 Company 值
      \$companyRaw = [string]\$key.GetValue('Company')
      if (\$companyRaw) { \$info.company = \$companyRaw }
      # 文件路径（对齐 GuidInfo.GetFilePath：InprocServer32 > LocalServer32，CodeBase 优先）
      \$filePath = ''
      foreach (\$sub in @('InprocServer32', 'LocalServer32')) {
        \$serverKey = Get-Item -LiteralPath (\$keyPath + '\\' + \$sub) -ErrorAction SilentlyContinue
        if (-not \$serverKey) { continue }
        \$candidate = ''
        \$codeBase = [string]\$serverKey.GetValue('CodeBase')
        if (\$codeBase) {
          \$candidate = \$codeBase.Replace('file:///', '').Replace('/', '\\')
        }
        if (-not \$candidate) { \$candidate = ([string]\$serverKey.GetValue('')).Trim().Trim('"') }
        if (-not \$candidate) { continue }
        \$candidate = [Environment]::ExpandEnvironmentVariables(\$candidate)
        # 可执行命令可能带参数：提取实际文件路径
        if (\$candidate -match '^"([^"]+)"') { \$candidate = \$Matches[1] }
        elseif (\$candidate -match '^(\\S+\\.(dll|exe|ocx|cpl|sys))') { \$candidate = \$Matches[1] }
        if (\$candidate -and (Test-Path -LiteralPath \$candidate)) { \$filePath = \$candidate; break }
      }
      if (\$filePath) {
        \$info.filePath = \$filePath
        try {
          \$fileItem = Get-Item -LiteralPath \$filePath -ErrorAction SilentlyContinue
          if (\$fileItem -and \$fileItem.VersionInfo) {
            # 厂商优先取文件版本信息（比注册表 Company 值更可靠）
            if (\$fileItem.VersionInfo.CompanyName) { \$info.company = [string]\$fileItem.VersionInfo.CompanyName }
            # 名称回退：DLL 的 FileDescription（对齐参考实现最后回退链）
            if (-not \$info.name -and \$fileItem.VersionInfo.FileDescription) {
              \$info.name = [string]\$fileItem.VersionInfo.FileDescription
            }
          }
        } catch {}
      }
    } catch { continue }
    break
  }
  \$script:clsidCache[\$g] = \$info
  return \$info
}

# ==================== 第三方判定 ====================
function Is-ThirdParty {
  param([string]\$Name, [string]\$Company, [string]\$Source, [string]\$FilePath)
  # 微软厂商 → 系统原生
  if (\$Company -match '(?i)microsoft|windows\\s+(corp|corporation)') { return \$false }
  # 系统目录下的 DLL 且无厂商信息 → 系统组件（shell32/shellext 等未签名描述的扩展）
  if ([string]::IsNullOrWhiteSpace(\$Company) -and \$FilePath -match '(?i)^C:\\\\Windows\\\\') { return \$false }
  if (\$knownSystem -contains \$Name) { return \$false }
  if (\$Source -eq 'shell' -and \$Name -match '(?i)^@?.*(Windows|System32|shell32|themecpl|display)') { return \$false }
  if ([string]::IsNullOrWhiteSpace(\$Company) -and \$Name -match '^(Open|Explore|Properties|RunAs|新建|发送到|打开|打开方式|打开文件位置|打开所在位置|在资源管理器中打开|在.+中打开|固定到|固定|复制|剪切|粘贴|删除|重命名|属性|共享|压缩|添加到|发送|扫描|打印|编辑|播放|预览|打开文件|解压|挂载|装载)$') { return \$false }
  return \$true
}

// ==================== 结果收集 ====================
function Add-Result {
  param([string]\$Name, [string]\$CLSID, [string]\$RegPath, [string]\$Location,
        [string]\$Category, [string]\$Source, [string]\$CompanyOverride = '', [string]\$FilePath = '', [string]\$Command = '',
        [bool]\$Enabled = \$true)
  # 幽灵项过滤：无有效名称不输出
  if ([string]::IsNullOrWhiteSpace(\$Name)) { return }
  # 注册表类来源必须有有效路径，否则后续删除/启停/备份无法定位，直接丢弃
  if (\$Source -ne 'filesystem' -and [string]::IsNullOrWhiteSpace(\$RegPath)) { return }
  \$clsidText = ([string]\$CLSID).Trim()
  \$company = [string]\$CompanyOverride
  \$filePath = [string]\$FilePath
  if (Test-GuidText \$clsidText) {
    \$info = Get-ClsidInfo \$clsidText
    if (-not \$company) { \$company = \$info.company }
    if (-not \$filePath) { \$filePath = \$info.filePath }
  }
  \$isThirdParty = Is-ThirdParty -Name \$Name -Company \$company -Source \$Source -FilePath \$filePath
  \$isProtected = \$protectedCLSIDs -contains \$clsidText
  \$risk = if (\$isProtected) { 'protected' } elseif (\$isThirdParty) { 'high' } else { 'low' }
  \$script:results += [pscustomobject]@{
    name = \$Name; clsid = \$clsidText; regPath = \$RegPath; company = \$company
    location = \$Location; category = \$Category; source = \$Source; filePath = \$filePath; command = [string]\$Command
    isThirdParty = \$isThirdParty; isProtected = \$isProtected; risk = \$risk; enabled = \$Enabled
  }
}

# ==================== Shell 项扫描（对齐 LoadShellItems + ShellItem 解析） ====================
# 菜单名优先级：MUIVerb(资源串解析) > 默认值(多级母菜单除外) > 键名
function Scan-ShellItems {
  param([string]\$Category, [string]\$ShellPath, [hashtable]\$SeenKeys)
  if (-not (Test-Path -LiteralPath \$ShellPath)) { return }
  \$shellKey = Get-Item -LiteralPath \$ShellPath -ErrorAction SilentlyContinue
  if (-not \$shellKey) { return }
  foreach (\$child in @(\$shellKey.GetSubKeyNames())) {
    try {
      # 同一场景内键名去重（多视图扫描防重复）
      if (\$SeenKeys.ContainsKey(\$child)) { continue }
      \$SeenKeys[\$child] = \$true
      \$keyPath = \$ShellPath + '\\' + \$child
      \$key = Get-Item -LiteralPath \$keyPath -ErrorAction Stop

      # 菜单名称（对齐 ShellItem.ItemText）
      \$name = Get-DirectString ([string]\$key.GetValue('MUIVerb'))
      if (-not \$name) {
        # 多级母菜单（SubCommands/ExtendedSubCommandsKey）不支持默认值作名称
        \$hasSub = [string]\$key.GetValue('SubCommands')
        \$extSub = [string]\$key.GetValue('ExtendedSubCommandsKey')
        if (-not \$hasSub -and -not \$extSub) {
          \$name = Get-DirectString ([string]\$key.GetValue(''))
        }
      }
      if (-not \$name) { \$name = \$child }

      # GUID 提取（对齐 ShellItem.Guid：command\\DelegateExecute > DropTarget\\CLSID > ExplorerCommandHandler）
      \$clsid = ''
      \$commandKey = Get-Item -LiteralPath (\$keyPath + '\\command') -ErrorAction SilentlyContinue
      if (\$commandKey) {
        \$v = [string]\$commandKey.GetValue('DelegateExecute')
        if (Test-GuidText \$v) { \$clsid = \$v.Trim() }
      }
      if (-not \$clsid) {
        \$dropKey = Get-Item -LiteralPath (\$keyPath + '\\DropTarget') -ErrorAction SilentlyContinue
        if (\$dropKey) {
          \$v = [string]\$dropKey.GetValue('CLSID')
          if (Test-GuidText \$v) { \$clsid = \$v.Trim() }
        }
      }
      if (-not \$clsid) {
        \$v = [string]\$key.GetValue('ExplorerCommandHandler')
        if (Test-GuidText \$v) { \$clsid = \$v.Trim() }
      }

      \$command = ''
      if (\$commandKey) { \$command = Get-DirectString ([string]\$commandKey.GetValue('')) }

      # 启用状态：LegacyDisable / Blocked 值存在即视为已禁用（Windows 自身的禁用约定）；
      # 键名带 'AutorunsDisabled_' 前缀为重命名禁用约定，同样视为已禁用
      \$enabled = \$true
      foreach (\$vn in @('LegacyDisable', 'Blocked')) {
        if (\$null -ne \$key.GetValue(\$vn)) { \$enabled = \$false; break }
      }
      if (\$enabled -and \$child -like 'AutorunsDisabled_*') { \$enabled = \$false }
      Add-Result -Name \$name -CLSID \$clsid -RegPath (Convert-ToStdRegPath \$key.PSPath) -Location \$ShellPath -Category \$Category -Source 'shell' -Command \$command -Enabled \$enabled
    } catch { continue }
  }
}

# ==================== ShellEx 项扫描（对齐 GetPathAndGuids） ====================
# 读取 ContextMenuHandlers（含禁用重命名形态）：
#   - 子键名以 '-' 开头（如 -Foo）→ 已禁用的单个处理器，输出时还原名称并标记 enabled=false
#   - 父键被改名为 '-ContextMenuHandlers' → 整组禁用，由 Scan-Scene 以 HandlersDirName 指定扫描
function Scan-ShellExHandlers {
  param([string]\$Category, [string]\$ShellExPath, [hashtable]\$SeenKeys, [string]\$HandlersDirName = 'ContextMenuHandlers')
  \$cmPath = \$ShellExPath + '\\' + \$HandlersDirName
  if (-not (Test-Path -LiteralPath \$cmPath)) { return }
  \$cmKey = Get-Item -LiteralPath \$cmPath -ErrorAction SilentlyContinue
  if (-not \$cmKey) { return }
  foreach (\$child in @(\$cmKey.GetSubKeyNames())) {
    try {
      # 启用状态与真实键名（'-' 前缀为禁用标记）
      \$enabled = \$true
      \$realName = [string]\$child
      if (\$realName.StartsWith('-')) { \$enabled = \$false; \$realName = \$realName.Substring(1) }
      if (-not \$realName) { continue }
      if (\$SeenKeys.ContainsKey(\$child)) { continue }
      \$SeenKeys[\$child] = \$true
      \$keyPath = \$cmPath + '\\' + \$child
      \$key = Get-Item -LiteralPath \$keyPath -ErrorAction Stop
      \$defaultValue = [string]\$key.GetValue('')
      # GUID：默认值优先，失败回退真实键名（对齐 GuidEx.TryParse(keyName)）
      \$guid = \$defaultValue
      if (-not (Test-GuidText \$guid)) { \$guid = \$realName }
      if (-not (Test-GuidText \$guid)) { continue }
      \$guid = \$guid.Trim()

      \$info = Get-ClsidInfo \$guid
      # 名称（对齐 ShellExItem.ItemText）：CLSID 友好名 > (键名为 GUID 时用默认值) > 真实键名
      \$name = \$info.name
      if (-not \$name) {
        if ((Test-GuidText \$realName) -and \$defaultValue -and -not (Test-GuidText \$defaultValue)) {
          \$name = \$defaultValue
        } else {
          \$name = \$realName
        }
      }
      Add-Result -Name \$name -CLSID \$guid -RegPath (Convert-ToStdRegPath \$key.PSPath) -Location \$cmPath -Category \$Category -Source 'shellex' -CompanyOverride \$info.company -FilePath \$info.filePath -Enabled \$enabled
    } catch { continue }
  }
}

# ==================== 场景扫描（对齐 ShellList.LoadItems：shell + ShellEx 两个子树） ====================
function Scan-Scene {
  param([string]\$Category, [string[]]\$ScenePaths)
  foreach (\$scenePath in @(\$ScenePaths)) {
    if ([string]::IsNullOrWhiteSpace(\$scenePath)) { continue }
    if (-not (Test-Path -LiteralPath \$scenePath)) { continue }
    Scan-ShellItems -Category \$Category -ShellPath (\$scenePath + '\\shell') -SeenKeys @{}
    Scan-ShellExHandlers -Category \$Category -ShellExPath (\$scenePath + '\\ShellEx') -SeenKeys @{}
    # 整组禁用形态：父键改名为 '-ContextMenuHandlers'（其子键全部视为禁用项）
    Scan-ShellExHandlers -Category \$Category -ShellExPath (\$scenePath + '\\ShellEx') -SeenKeys @{} -HandlersDirName '-ContextMenuHandlers'
  }
}

# 注册表视图：HKCR 合并视图（主，天然合并 HKCU+HKLM）+ HKCU 显式视图（捕获被
# HKLM 同名键遮蔽的用户级项）+ HKLM 32 位视图（原路径 Software\\WOW6432Node\\Classes
# 实为无效路径，修正为 Software\\Classes\\Wow6432Node）
\$HKCR = 'Registry::HKEY_CLASSES_ROOT'
\$HKCU_CLASSES = 'Registry::HKEY_CURRENT_USER\\Software\\Classes'
\$HKLM_WOW64_CLASSES = 'Registry::HKEY_LOCAL_MACHINE\\Software\\Classes\\Wow6432Node'

function Get-SceneViews {
  param([string]\$Suffix)
  return @(
    (\$HKCR + \$Suffix),
    (\$HKCU_CLASSES + \$Suffix),
    (\$HKLM_WOW64_CLASSES + \$Suffix)
  )
}

# ---- 场景清单（对齐参考 MENUPATH_* 常量与 Scenes 映射）----
# 文件（HKCR\\*，AllFilesystemObjects 归入文件分类）
Scan-Scene '文件' (Get-SceneViews '\\*')
Scan-Scene '文件' (Get-SceneViews '\\AllFilesystemObjects')
# EXE 文件（对齐 Scenes.ExeFile：exefile + SystemFileAssociations\\.exe）
Scan-Scene 'EXE文件' (Get-SceneViews '\\exefile')
Scan-Scene 'EXE文件' (Get-SceneViews '\\SystemFileAssociations\\.exe')
# LNK 文件
Scan-Scene 'LNK文件' (Get-SceneViews '\\lnkfile')
Scan-Scene 'LNK文件' (Get-SceneViews '\\SystemFileAssociations\\.lnk')
# 目录 / 文件夹 / 驱动器 / 目录背景 / 桌面背景
Scan-Scene '目录' (Get-SceneViews '\\Directory')
Scan-Scene '文件夹' (Get-SceneViews '\\Folder')
Scan-Scene '驱动器' (Get-SceneViews '\\Drive')
Scan-Scene '目录背景' (Get-SceneViews '\\Directory\\Background')
Scan-Scene '桌面背景' (Get-SceneViews '\\DesktopBackground')
# 回收站（对齐参考：CLSID\\{645FF040} 主路径 + RecycleBinFolder 补充）
Scan-Scene '回收站' @((\$HKCR + '\\CLSID\\{645FF040-5081-101B-9F08-00AA002F954E}'), (\$HKCR + '\\RecycleBinFolder'))
# 此电脑（新增，对齐 MENUPATH_COMPUTER）
Scan-Scene '此电脑' @((\$HKCR + '\\CLSID\\{20D04FE0-3AEA-1069-A2D8-08002B30309D}'))
# 库（新增，对齐 Scenes.Library：LibraryFolder + Background + UserLibraryFolder 三个子树）
Scan-Scene '库' @((\$HKCR + '\\LibraryFolder'), (\$HKCR + '\\LibraryFolder\\Background'), (\$HKCR + '\\UserLibraryFolder'))

# ---- 发送到（文件系统目录，非注册表） ----
\$sendToPaths = @(
  ([Environment]::GetFolderPath('ApplicationData') + '\\Microsoft\\Windows\\SendTo'),
  (\$env:ProgramData + '\\Microsoft\\Windows\\SendTo')
)
foreach (\$sendToPath in \$sendToPaths) {
  if (-not (Test-Path -LiteralPath \$sendToPath)) { continue }
  foreach (\$item in @(Get-ChildItem -LiteralPath \$sendToPath -Force -ErrorAction SilentlyContinue)) {
    if (\$item.Name -ieq 'desktop.ini') { continue }
    \$systemExtensions = @('.DeskLink', '.MAPIMail', '.ZFSendToTarget', '.mydocs')
    \$company = if (\$systemExtensions -contains \$item.Extension) { 'Microsoft Corporation' } else { '' }
    Add-Result -Name \$item.BaseName -CLSID '' -RegPath \$item.FullName -Location \$sendToPath -Category '发送到' -Source 'filesystem' -CompanyOverride \$company
  }
}

# ---- UWP / 打包应用（PackagedCom 与 FileExplorerContextMenus 合约） ----
\$uwpRoots = @('Registry::HKEY_CLASSES_ROOT\\PackagedCom',
              'Registry::HKEY_CURRENT_USER\\Software\\Classes\\PackagedCom',
              'Registry::HKEY_LOCAL_MACHINE\\Software\\Classes\\PackagedCom')
foreach (\$uwpRoot in \$uwpRoots) {
  if (-not (Test-Path -LiteralPath \$uwpRoot)) { continue }
  foreach (\$key in @(Get-ChildItem -LiteralPath \$uwpRoot -Recurse -ErrorAction SilentlyContinue)) {
    if (\$key.PSPath -notmatch '(?i)(ContextMenu|ShellExt|ExplorerCommand|IContextMenu)') { continue }
    \$props = Get-ItemProperty -LiteralPath \$key.PSPath -ErrorAction SilentlyContinue
    \$clsid = [string]\$props.'(default)'
    if (-not \$clsid) { continue }
    \$packageName = (\$key.PSPath -split '\\\\')[-2]
    if ([string]::IsNullOrWhiteSpace(\$packageName)) { \$packageName = [string]\$key.PSChildName }
    Add-Result -Name \$packageName -CLSID \$clsid -RegPath (Convert-ToStdRegPath \$key.PSPath) -Location \$uwpRoot -Category 'UWP应用' -Source 'packagedcom'
  }
}

\$uwpContractRoots = @('Registry::HKEY_CLASSES_ROOT\\Extensions\\ContractId\\Windows.FileExplorerContextMenus',
                      'Registry::HKEY_CURRENT_USER\\Software\\Classes\\Extensions\\ContractId\\Windows.FileExplorerContextMenus',
                      'Registry::HKEY_LOCAL_MACHINE\\Software\\Classes\\Extensions\\ContractId\\Windows.FileExplorerContextMenus')
foreach (\$contractRoot in \$uwpContractRoots) {
  if (-not (Test-Path -LiteralPath \$contractRoot)) { continue }
  foreach (\$key in @(Get-ChildItem -LiteralPath \$contractRoot -Recurse -ErrorAction SilentlyContinue)) {
    \$props = Get-ItemProperty -LiteralPath \$key.PSPath -ErrorAction SilentlyContinue
    \$packageName = [string]\$props.PackageId
    if (-not \$packageName -and \$key.PSPath -match '(?i)PackageId\\\\([^\\\\]+)') { \$packageName = \$Matches[1] }
    if (-not \$packageName) { continue }
    \$clsid = [string]\$props.Clsid
    if (-not \$clsid) { \$clsid = [string]\$props.'(default)' }
    Add-Result -Name \$packageName -CLSID \$clsid -RegPath (Convert-ToStdRegPath \$key.PSPath) -Location \$contractRoot -Category 'UWP应用' -Source 'uwp-contract'
  }
}

# ---- 全局去重：同一分类、名称、CLSID、启用状态在多个注册表视图中只展示一次 ----
# （enabled 参与去重：同名处理器可能在活跃组与 '-ContextMenuHandlers' 禁用组各出现一次）
\$seen = @{}
\$deduped = @()
foreach (\$result in @(\$script:results)) {
  \$enabledText = if (\$result.enabled) { '1' } else { '0' }
  \$key = if ([string]::IsNullOrWhiteSpace([string]\$result.clsid)) {
    '{0}|{1}|{2}|{3}|{4}' -f \$result.category, \$result.name, \$result.source, \$result.regPath, \$enabledText
  } else {
    '{0}|{1}|{2}|{3}' -f \$result.category, \$result.name, \$result.clsid, \$enabledText
  }
  if (\$seen.ContainsKey(\$key)) { continue }
  \$seen[\$key] = \$true
  \$deduped += \$result
}
# ---- 手工构建合法 JSON（纯 ASCII：非 ASCII 字符转义为 \\uXXXX），彻底规避 ConvertTo-Json 对脏数据的缺陷 ----
\$jsonParts = @()
foreach (\$result in @(\$deduped)) {
  \$obj = '{' +
    '"name":' + (ConvertTo-JsonSafeString (Format-CleanStr \$result.name)) + ',' +
    '"clsid":' + (ConvertTo-JsonSafeString (Format-CleanStr \$result.clsid)) + ',' +
    '"regPath":' + (ConvertTo-JsonSafeString (Format-CleanStr \$result.regPath)) + ',' +
    '"company":' + (ConvertTo-JsonSafeString (Format-CleanStr \$result.company)) + ',' +
    '"location":' + (ConvertTo-JsonSafeString (Format-CleanStr \$result.location)) + ',' +
    '"category":' + (ConvertTo-JsonSafeString (Format-CleanStr \$result.category)) + ',' +
    '"source":' + (ConvertTo-JsonSafeString (Format-CleanStr \$result.source)) + ',' +
    '"filePath":' + (ConvertTo-JsonSafeString (Format-CleanStr \$result.filePath)) + ',' +
    '"command":' + (ConvertTo-JsonSafeString (Format-CleanStr \$result.command)) + ',' +
    '"isThirdParty":' + (ConvertTo-JsonSafeBool \$result.isThirdParty) + ',' +
    '"isProtected":' + (ConvertTo-JsonSafeBool \$result.isProtected) + ',' +
    '"risk":' + (ConvertTo-JsonSafeString (Format-CleanStr \$result.risk)) + ',' +
    '"enabled":' + (ConvertTo-JsonSafeBool \$result.enabled) +
    '}'
  \$jsonParts += \$obj
}
if (\$jsonParts.Count -eq 0) { '[]' } else { '[' + (\$jsonParts -join ',') + ']' }
`;

const BACKUP_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
\$OutputEncoding = [System.Text.Encoding]::UTF8
\$ErrorActionPreference = 'SilentlyContinue'
\$items = '__ITEMS_JSON__' | ConvertFrom-Json
\$desktop = [Environment]::GetFolderPath('Desktop')
\$backupDir = Join-Path \$desktop ('右键菜单备份_' + (Get-Date -Format 'yyyyMMdd_HHmmss'))
New-Item -ItemType Directory -Path \$backupDir -Force | Out-Null
\$filesDir = Join-Path \$backupDir 'files'
New-Item -ItemType Directory -Path \$filesDir -Force | Out-Null
\$backupFiles = @()
\$fileRecords = @()
\$index = 0

function Convert-ToRegPath([string]\$Path) {
  \$p = [string]\$Path
  \$p = \$p -replace '^.*?Registry::', ''
  \$p = \$p -replace '^HKEY_CLASSES_ROOT', 'HKCR'
  \$p = \$p -replace '^HKEY_CURRENT_USER', 'HKCU'
  \$p = \$p -replace '^HKEY_LOCAL_MACHINE', 'HKLM'
  \$p = \$p -replace '^HKEY_USERS', 'HKU'
  return \$p
}

foreach (\$item in @(\$items)) {
  \$index++
  \$source = [string]\$item.source
  \$regPath = [string]\$item.regPath
  if (\$source -eq 'filesystem') {
    if (-not (Test-Path -LiteralPath \$regPath)) { continue }
    \$name = 'sendto_{0}_{1}_{2}' -f \$index, ([IO.Path]::GetFileNameWithoutExtension(\$regPath)), ([IO.Path]::GetExtension(\$regPath).TrimStart('.'))
    \$dest = Join-Path \$filesDir \$name
    try { Copy-Item -LiteralPath \$regPath -Destination \$dest -Force -Recurse; \$fileRecords += [pscustomobject]@{ source = \$regPath; backup = \$dest }; \$backupFiles += \$dest } catch {}
    continue
  }
  if ([string]::IsNullOrWhiteSpace(\$regPath)) { continue }
  \$nativePath = Convert-ToRegPath \$regPath
  \$safeName = (\$nativePath -replace '[\\/:*?"<>|]', '_')
  \$regFile = Join-Path \$backupDir ('registry_{0}_{1}.reg' -f \$index, \$safeName)
  try {
    \$proc = Start-Process -FilePath 'reg.exe' -ArgumentList @('export', ('"' + \$nativePath + '"'), ('"' + \$regFile + '"'), '/y') -Wait -PassThru -NoNewWindow
    if (\$proc.ExitCode -eq 0) { \$backupFiles += \$regFile }
  } catch {}
}

\$manifest = [pscustomobject]@{ version = 1; created = (Get-Date).ToString('o'); items = @(\$items); files = @(\$fileRecords) }
\$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path \$backupDir 'manifest.json') -Encoding UTF8
[pscustomobject]@{ backupDir = \$backupDir; files = @(\$backupFiles); count = \$backupFiles.Count } | ConvertTo-Json -Compress
`;

const REMOVE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
\$OutputEncoding = [System.Text.Encoding]::UTF8
\$ErrorActionPreference = 'SilentlyContinue'
${DIAG.PS_PREAMBLE}
\$items = '__ITEMS_JSON__' | ConvertFrom-Json
\$success = 0
\$failed = 0
\$results = @()
foreach (\$item in @(\$items)) {
  if (\$item.risk -eq 'protected') { \$results += @{ name = \$item.name; status = 'skip'; message = '系统保护项' }; continue }
  try {
    \$target = [string]\$item.regPath
    if ([string]::IsNullOrWhiteSpace(\$target) -or \$target -match '(?i)^(Registry::)?HKEY_(CLASSES_ROOT|LOCAL_MACHINE|CURRENT_USER|USERS|CURRENT_CONFIG)\\\\?\$') {
      \$results += @{ name = \$item.name; status = 'skip'; message = '无效或过宽路径' }; continue
    }
    # 标准路径（HKEY_CLASSES_ROOT\\...）转 PowerShell 提供程序路径
    if (\$target -match '^HKEY_') { \$target = 'Registry::' + \$target }
    if (Test-Path -LiteralPath \$target) {
      Remove-Item -LiteralPath \$target -Recurse -Force -ErrorAction Stop
      \$success++
      \$results += @{ name = \$item.name; status = 'ok'; message = '已删除' }
    } else { \$results += @{ name = \$item.name; status = 'skip'; message = '路径不存在' } }
  } catch { \$failed++; Write-TFDiag -Stage 'contextmenu.remove' -Mutation 'rolled_back' -Detail ([string]\$item.regPath + ' -> ' + \$_.Exception.Message); \$results += @{ name = \$item.name; status = 'error'; message = \$_.Exception.Message } }
}
[pscustomobject]@{ success = \$success; failed = \$failed; results = @(\$results) } | ConvertTo-Json -Depth 6 -Compress
`;

const RESTORE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
\$OutputEncoding = [System.Text.Encoding]::UTF8
\$ErrorActionPreference = 'SilentlyContinue'
\$desktop = [Environment]::GetFolderPath('Desktop')
\$backupDirs = Get-ChildItem -LiteralPath \$desktop -Directory -Filter '右键菜单备份_*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
if (-not \$backupDirs) { @{ success = \$false; message = '未找到备份目录' } | ConvertTo-Json -Compress; exit }
\$latestBackup = \$backupDirs[0].FullName
\$imported = 0
\$failed = 0
foreach (\$regFile in @(Get-ChildItem -LiteralPath \$latestBackup -Filter '*.reg' -ErrorAction SilentlyContinue)) {
  try { \$proc = Start-Process -FilePath 'reg.exe' -ArgumentList @('import', ('"' + \$regFile.FullName + '"')) -Wait -PassThru -NoNewWindow; if (\$proc.ExitCode -eq 0) { \$imported++ } else { \$failed++ } } catch { \$failed++ }
}
\$restored = 0
\$manifestPath = Join-Path \$latestBackup 'manifest.json'
if (Test-Path -LiteralPath \$manifestPath) {
  try {
    \$manifest = Get-Content -LiteralPath \$manifestPath -Raw | ConvertFrom-Json
    foreach (\$record in @(\$manifest.files)) {
      if ((Test-Path -LiteralPath \$record.backup) -and \$record.source) {
        try { New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName(\$record.source)) -Force | Out-Null; Copy-Item -LiteralPath \$record.backup -Destination \$record.source -Force -Recurse; \$restored++ } catch { \$failed++ }
      }
    }
  } catch {}
}
[pscustomobject]@{ success = ((\$imported + \$restored) -gt 0 -and \$failed -eq 0); backupDir = \$latestBackup; imported = \$imported; restored = \$restored; failed = \$failed } | ConvertTo-Json -Compress
`;

// 启停切换脚本（勾选=启用，取消=禁用，可逆操作）
// 禁用/启用约定：
//   - shell 项：写入/删除 LegacyDisable 值（Windows 自身禁用动词的约定；顺带清理 Blocked）
//   - shellex 项：处理器键名加/去 '-' 前缀（重命名，可逆）
//   - 发送到（filesystem）：切换文件 Hidden 属性（发送到菜单忽略隐藏文件）
//   - UWP（packagedcom / uwp-contract）：无公开可逆禁用机制，明确拒绝
// 每项操作后均回读验证，权限不足（HKLM 需要管理员）时报告失败而非静默假成功
const TOGGLE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
\$OutputEncoding = [System.Text.Encoding]::UTF8
\$ErrorActionPreference = 'SilentlyContinue'
\$items = '__ITEMS_JSON__' | ConvertFrom-Json
\$success = 0
\$failed = 0
\$results = @()

foreach (\$item in @(\$items)) {
  \$name = [string]\$item.name
  \$source = [string]\$item.source
  \$target = [string]\$item.regPath
  # ConvertFrom-Json 已将 enabled 解析为布尔，直接比较避免 -not/-and 优先级陷阱
  \$wantEnabled = (\$item.enabled -eq \$true)
  if ([string]::IsNullOrWhiteSpace(\$target)) { \$results += @{ name = \$name; regPath = ''; status = 'skip'; message = '缺少目标路径' }; continue }

  try {
    # ---- UWP：不支持可逆启停 ----
    if (\$source -eq 'packagedcom' -or \$source -eq 'uwp-contract') {
      \$results += @{ name = \$name; regPath = \$target; status = 'skip'; message = 'UWP 项暂不支持启停切换' }
      continue
    }

    # ---- 发送到：Hidden 属性切换 ----
    if (\$source -eq 'filesystem') {
      if (-not (Test-Path -LiteralPath \$target)) { \$results += @{ name = \$name; regPath = \$target; status = 'skip'; message = '文件不存在' }; continue }
      \$file = Get-Item -LiteralPath \$target -Force
      if (\$wantEnabled) {
        \$file.Attributes = \$file.Attributes -band (-bnot [IO.FileAttributes]::Hidden)
      } else {
        \$file.Attributes = \$file.Attributes -bor [IO.FileAttributes]::Hidden
      }
      \$nowHidden = (([IO.FileAttributes]::Hidden -band (Get-Item -LiteralPath \$target -Force).Attributes) -ne 0)
      if (\$nowHidden -eq (-not \$wantEnabled)) {
        \$success++; \$results += @{ name = \$name; regPath = \$target; status = 'ok'; message = (\$(if (\$wantEnabled) { '已启用' } else { '已禁用' })) }
      } else {
        \$failed++; \$results += @{ name = \$name; regPath = \$target; status = 'error'; message = '切换未生效' }
      }
      continue
    }

    # ---- 注册表项：统一转 PowerShell 提供程序路径 ----
    \$regPath = \$target
    if (\$regPath -match '^HKEY_') { \$regPath = 'Registry::' + \$regPath }
    if (-not (Test-Path -LiteralPath \$regPath)) { \$results += @{ name = \$name; regPath = \$target; status = 'skip'; message = '注册表路径不存在' }; continue }

    if (\$source -eq 'shell') {
      # shell 动词：LegacyDisable / Blocked 值的写入与清除；
      # 启用时兼容还原 'AutorunsDisabled_' 前缀重命名
      # （Split-Path 对 'Registry::' 路径会报参数集冲突，用字符串切分）
      \$sepIdx = \$regPath.LastIndexOf('\\')
      \$leaf = if (\$sepIdx -ge 0) { \$regPath.Substring(\$sepIdx + 1) } else { \$regPath }
      \$parent = if (\$sepIdx -gt 0) { \$regPath.Substring(0, \$sepIdx) } else { '' }
      if (\$wantEnabled) {
        if (\$leaf -like 'AutorunsDisabled_*') {
          \$origName = \$leaf.Substring('AutorunsDisabled_'.Length)
          if (-not \$origName) { \$results += @{ name = \$name; regPath = \$target; status = 'skip'; message = '无效的重命名键' }; continue }
          Rename-Item -LiteralPath \$regPath -NewName \$origName -ErrorAction Stop
          \$regPath = \$parent + '\\' + \$origName
        }
        Remove-ItemProperty -LiteralPath \$regPath -Name 'LegacyDisable' -ErrorAction SilentlyContinue
        Remove-ItemProperty -LiteralPath \$regPath -Name 'Blocked' -ErrorAction SilentlyContinue
      } else {
        New-ItemProperty -LiteralPath \$regPath -Name 'LegacyDisable' -PropertyType String -Value '' -Force -ErrorAction Stop | Out-Null
      }
      \$nowDisabled = (\$null -ne (Get-Item -LiteralPath \$regPath).GetValue('LegacyDisable')) -or (\$null -ne (Get-Item -LiteralPath \$regPath).GetValue('Blocked'))
      if (\$nowDisabled -eq (-not \$wantEnabled)) {
        # newRegPath 统一为标准格式（剥离 Registry:: 提供程序前缀），与扫描输出一致
        \$success++; \$results += @{ name = \$name; regPath = \$target; newRegPath = (\$regPath -replace '^Registry::', ''); status = 'ok'; message = (\$(if (\$wantEnabled) { '已启用' } else { '已禁用' })) }
      } else {
        \$failed++; \$results += @{ name = \$name; regPath = \$target; status = 'error'; message = '切换未生效（可能需要管理员权限）' }
      }
      continue
    }

    # ---- shellex：处理器键名 '-' 前缀重命名 ----
    # 注意：PowerShell 7 的 Split-Path/Join-Path 对 'Registry::' 提供程序路径会报参数集冲突，
    # 这里一律用字符串切分与拼接
    \$sepIdx = \$regPath.LastIndexOf('\\')
    \$parent = if (\$sepIdx -gt 0) { \$regPath.Substring(0, \$sepIdx) } else { '' }
    \$leaf = if (\$sepIdx -ge 0) { \$regPath.Substring(\$sepIdx + 1) } else { \$regPath }
    if (\$wantEnabled) {
      if (-not \$leaf.StartsWith('-')) { \$success++; \$results += @{ name = \$name; regPath = \$target; status = 'ok'; message = '已处于启用状态' }; continue }
      \$newName = \$leaf.Substring(1)
    } else {
      if (\$leaf.StartsWith('-')) { \$success++; \$results += @{ name = \$name; regPath = \$target; status = 'ok'; message = '已处于禁用状态' }; continue }
      \$newName = '-' + \$leaf
    }
    Rename-Item -LiteralPath \$regPath -NewName \$newName -ErrorAction Stop
    \$newPath = \$parent + '\\' + \$newName
    if ((Test-Path -LiteralPath \$newPath) -and -not (Test-Path -LiteralPath \$regPath)) {
      # 返回重命名后的新路径（标准格式，剥离 Registry:: 前缀），渲染层据此更新条目
      \$success++; \$results += @{ name = \$name; regPath = \$target; newRegPath = (\$newPath -replace '^Registry::', ''); status = 'ok'; message = (\$(if (\$wantEnabled) { '已启用' } else { '已禁用' })) }
    } else {
      \$failed++; \$results += @{ name = \$name; regPath = \$target; status = 'error'; message = '重命名未生效（可能需要管理员权限）' }
    }
  } catch {
    \$failed++
    \$results += @{ name = \$name; regPath = \$target; status = 'error'; message = \$_.Exception.Message }
  }
}
[pscustomobject]@{ success = \$success; failed = \$failed; results = @(\$results) } | ConvertTo-Json -Depth 6 -Compress
`;

// 图标提取脚本：根据 CLSID 解析 InprocServer32 指向的 DLL 并提取程序图标（PNG base64）
const ICONS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
\$OutputEncoding = [System.Text.Encoding]::UTF8
\$ErrorActionPreference = 'SilentlyContinue'
\$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing

\$items = '__ITEMS_JSON__' | ConvertFrom-Json
\$icons = @{}

foreach (\$it in \$items) {
  \$clsid = ([string]\$it.clsid).Trim()
  if (-not \$clsid -or -not \$clsid.StartsWith('{')) { continue }
  \$dll = ''
  foreach (\$view in @('Registry::HKEY_CLASSES_ROOT\\CLSID', 'Registry::HKEY_CLASSES_ROOT\\WOW6432Node\\CLSID', 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\Wow6432Node\\CLSID')) {
    \$regPath = \$view + '\\' + \$clsid + '\\InprocServer32'
    if (-not (Test-Path -LiteralPath \$regPath)) { continue }
    \$serverKey = Get-Item -LiteralPath \$regPath -ErrorAction SilentlyContinue
    if (\$serverKey) {
      \$dll = ([string]\$serverKey.GetValue('')).Trim().Trim('"')
      if (\$dll) { break }
    }
  }
  if (-not \$dll) { continue }
  \$dll = [Environment]::ExpandEnvironmentVariables(\$dll)
  if (-not (Test-Path -LiteralPath \$dll)) { continue }
  try {
    \$icon = [System.Drawing.Icon]::ExtractAssociatedIcon(\$dll)
    if (-not \$icon) { continue }
    \$bmp = \$icon.ToBitmap()
    \$ms = New-Object System.IO.MemoryStream
    \$bmp.Save(\$ms, [System.Drawing.Imaging.ImageFormat]::Png)
    \$b64 = [Convert]::ToBase64String(\$ms.ToArray())
    \$icons[\$clsid] = 'data:image/png;base64,' + \$b64
    \$ms.Dispose(); \$bmp.Dispose(); \$icon.Dispose()
  } catch {}
}

\$icons | ConvertTo-Json -Compress
`;

function serializeItems(items) {
  const json = JSON.stringify(Array.isArray(items) ? items : []);
  return json.replace(/'/g, "''");
}

module.exports = {
  scan() { return SCAN_SCRIPT; },
  backup(items) { return BACKUP_SCRIPT.replace('__ITEMS_JSON__', serializeItems(items)); },
  remove(items) { return REMOVE_SCRIPT.replace('__ITEMS_JSON__', serializeItems(items)); },
  toggle(items) { return TOGGLE_SCRIPT.replace('__ITEMS_JSON__', serializeItems(items)); },
  restore() { return RESTORE_SCRIPT; },
  icons(items) { return ICONS_SCRIPT.replace('__ITEMS_JSON__', serializeItems(items)); }
};
