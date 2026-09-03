// PowerShell 清理脚本（嵌入为 JS 字符串）
// 参考了 上级目录中的 cmd/bat 清理脚本逻辑：
//   - 删除 Windows 更新缓存.cmd (stop wuauserv + rd SoftwareDistribution + md)
//   - 删除临时文件.cmd (takeown + RD /S /Q + MKDIR)
//   - 删除日志文件.cmd (del *.log)
//   - 清除 DNS 缓存.cmd (ipconfig /flushdns)
//   - 重建性能计数器.cmd (lodctr /r)
// 并扩展为完整版（参考 require.md 中 19 大类）
//
// 数据化（P1-9）：清理项定义以 src/data/cleanup-rules.json 为唯一数据源。
// 扫描脚本所需的 $categoryDefs 由 buildCategoryDefsPs() 从该 JSON 生成 PS 源码，
// 其中 pathPs/candidatesPs/globCandidatesPs 为 PowerShell 表达式字符串，作为源码字面量注入。

const fs = require('fs');
const path = require('path');
const DIAG = require('../diag');

const RULES_FILE = path.join(__dirname, '..', 'data', 'cleanup-rules.json');
let RULES_CACHE = null;
function loadRules() {
  if (RULES_CACHE) return RULES_CACHE;
  const raw = fs.readFileSync(RULES_FILE, 'utf8');
  RULES_CACHE = JSON.parse(raw);
  return RULES_CACHE;
}

// PS 单引号字符串转义：' → ''（用于 name/risk 等字面量值）
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// 展平所有分组（含二级分组）下的清理项
function allRuleItems() {
  const out = [];
  for (const g of loadRules().groups) {
    if (g.subGroups) {
      for (const sg of g.subGroups) for (const it of sg.items) out.push(it);
    } else if (g.items) {
      for (const it of g.items) out.push(it);
    }
  }
  return out;
}

// 由 JSON 生成 PS $categoryDefs 哈希表源码（仅含带 pathPs 的路径型条目；
// dism 等非路径型条目由扫描脚本的专用分支处理，不进入 categoryDefs）。
function buildCategoryDefsPs() {
  const lines = [];
  for (const it of allRuleItems()) {
    if (!it.pathPs) continue;
    const parts = [`name=${psQuote(it.name)}`, `path=${it.pathPs}`, `risk=${psQuote(it.risk)}`];
    if (Array.isArray(it.candidatesPs) && it.candidatesPs.length) {
      parts.push(`candidates=@(${it.candidatesPs.join(', ')})`);
    }
    if (Array.isArray(it.globCandidatesPs) && it.globCandidatesPs.length) {
      parts.push(`globCandidates=@(${it.globCandidatesPs.join(', ')})`);
    }
    lines.push(`  ${psQuote(it.id)} = @{ ${parts.join('; ')} }`);
  }
  return lines.join('\n');
}

const PATHS = {
  // 系统临时
  userTemp: '$env:TEMP',
  systemTemp: '$env:WINDIR + \"\\\\Temp\"',
  localAppTemp: '$env:LOCALAPPDATA + \"\\\\Temp\"',
  prefetch: '$env:WINDIR + \"\\\\Prefetch\"',
  recent: '$env:APPDATA + \"\\\\Microsoft\\\\Windows\\\\Recent\"',
  thumbnailCache: '$env:LOCALAPPDATA + \"\\\\Microsoft\\\\Windows\\\\Explorer\"',
  iconCache: '$env:LOCALAPPDATA + \"\\\\Microsoft\\\\Windows\\\\Explorer\"',
  fontCache: '$env:WINDIR + \"\\\\ServiceProfiles\\\\LocalService\\\\AppData\\\\Local\\\\FontCache\"',
  installerCache: '$env:WINDIR + \"\\\\Installer\\\\$PatchCache$\"',
  // Windows
  windowsUpdateDownload: '$env:WINDIR + \"\\\\SoftwareDistribution\\\\Download\"',
  softwareDistribution: '$env:WINDIR + \"\\\\SoftwareDistribution\"',
  windowsOld: '$env:WINDIR + \"\\\\Windows.old\"',
  windowsWER: '$env:PROGRAMDATA + \"\\\\Microsoft\\\\Windows\\\\WER\"',
  deliveryOptimization: '$env:WINDIR + \"\\\\SoftwareDistribution\\\\DeliveryOptimization\"',
  winsxs: '$env:WINDIR + \"\\\\WinSxS\"',
  minidump: '$env:WINDIR + \"\\\\Minidump\"',
  memoryDump: '$env:WINDIR + \"\\\\MEMORY.DMP\"',
  defenderHistory: '$env:PROGRAMDATA + \"\\\\Microsoft\\\\Windows Defender\\\\Scans\\\\History\"',
  driverStoreTemp: '$env:WINDIR + \"\\\\System32\\\\DriverStore\\\\Temp\"',
  msStoreCache: '$env:LOCALAPPDATA + \"\\\\Packages\"',
  // 显卡
  nvidiaGlCache: '$env:LOCALAPPDATA + \"\\\\NVIDIA\\\\GLCache\"',
  nvidiaDxCache: '$env:LOCALAPPDATA + \"\\\\NVIDIA\\\\DXCache\"',
  nvidiaNvCache: '$env:PROGRAMDATA + \"\\\\NVIDIA Corporation\\\\NV_Cache\"',
  amdDxCache: '$env:LOCALAPPDATA + \"\\\\AMD\\\\DxCache\"',
  amdCache: '$env:APPDATA + \"\\\\AMD\\\\Cache\"',
  intelShaderCache: '$env:LOCALAPPDATA + \"\\\\Intel\\\\ShaderCache\"',
  // 浏览器
  chromeCache: '$env:LOCALAPPDATA + \"\\\\Google\\\\Chrome\\\\User Data\\\\Default\\\\Cache\"',
  chromeCodeCache: '$env:LOCALAPPDATA + \"\\\\Google\\\\Chrome\\\\User Data\\\\Default\\\\Code Cache\"',
  edgeCache: '$env:LOCALAPPDATA + \"\\\\Microsoft\\\\Edge\\\\User Data\\\\Default\\\\Cache\"',
  // 游戏平台
  steamCache: '\"C:\\\\Program Files (x86)\\\\Steam\\\\appcache\"',
  steamShaders: '$env:LOCALAPPDATA + \"\\\\Steam\\\\htmlcache\\\\ShaderCache\"',
  // 系统日志
  setupLog: '$env:WINDIR + \"\\\\setupact.log\"',
  setupLogOld: '$env:WINDIR + \"\\\\setuperr.log\"',
  windowsLog: '$env:WINDIR + \"\\\\System32\\\\winevt\\\\Logs\"',
  diagnosisData: '$env:PROGRAMDATA + \"\\\\Microsoft\\\\Diagnosis\"'
};

function getPath(key) {
  return PATHS[key] || '""';
}

// ==================== 扫描脚本 ====================
const SCAN_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
${DIAG.PS_PREAMBLE}
$results = @()

function Get-PathSize {
  param([string]$Path, [int]$Depth = 0)
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  if ($Depth -lt 1) { $Depth = 8 }
  try {
    $entry = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($entry -and -not $entry.PSIsContainer) { return [long]$entry.Length }
    $size = (Get-ChildItem -LiteralPath $Path -File -Recurse -Depth $Depth -Force -ErrorAction SilentlyContinue |
             Measure-Object -Property Length -Sum).Sum
    return [long]($size -as [long])
  } catch { return 0 }
}

$categories = ('\${CATEGORIES_PLACEHOLDER}' | ConvertFrom-Json)
$configuredPaths = ('\${CONFIGURED_PATHS_PLACEHOLDER}' | ConvertFrom-Json)
$categoryDefs = @{
\${CATEGORY_DEFS_PLACEHOLDER}
}

foreach ($cat in $categories) {
  $def = $categoryDefs[$cat]
  if ($null -eq $def) { continue }
  $path = [string]$def.path
  $pathSource = 'configured'
  $pathCandidates = @()
  $autoPath = ''
  # 应用缓存优先采用设置页已确认的路径；没有确认路径时才走内置候选。
  $configKeyMap = @{
    neteaseMusicCache = 'neteaseCacheDir'
    wechatCache = 'wechatCacheDir'
    douyinCache = 'douyinCacheDir'
    qqCache = 'qqCacheDir'
  }
  $configuredValue = [string]$configuredPaths.$cat
  if ($configKeyMap.ContainsKey($cat)) { $configuredValue = [string]$configuredPaths.($configKeyMap[$cat]) }
  if ($configuredValue) {
    $path = $configuredValue
    $pathSource = 'configured'
  }
  if ($def.candidates) {
    $pathCandidates = @($def.candidates)
    if (-not (Test-Path -LiteralPath $path)) {
      foreach ($candidate in $pathCandidates) {
        if (Test-Path -LiteralPath $candidate) { $autoPath = [string]$candidate; $path = $autoPath; $pathSource = 'auto'; break }
      }
    }
  }
  if ($def.globCandidates) {
    foreach ($pattern in @($def.globCandidates)) {
      $match = Get-ChildItem -Path $pattern -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($match -and -not (Test-Path -LiteralPath $path)) { $autoPath = $match.FullName; $path = $autoPath; $pathSource = 'auto'; $pathCandidates += $match.FullName; break }
    }
  }
  $size = Get-PathSize -Path $path
  # P1-12：逐项流式输出，主进程按行解析后增量推送渲染层（真实进度）
  Write-Output ('@@ITEM@@' + (@{
    id = $cat
    name = $def.name
    configuredPath = [string]$def.path
    path = $path
    pathSource = $pathSource
    pathCandidates = @($pathCandidates)
    autoPath = $autoPath
    autoSize = if ($autoPath) { Get-PathSize -Path $autoPath } else { 0 }
    size = $size
    risk = $def.risk
    exists = (Test-Path -LiteralPath $path)
  } | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

# DISM 组件清理：非路径型条目，固定返回"可执行"状态（大小以实际执行结果为准）
if ($categories -contains 'dismComponentCleanup') {
  $dismItem = @{
    id = 'dismComponentCleanup'
    name = 'DISM 组件清理 (WinSxS /ResetBase)'
    configuredPath = 'C:\Windows\WinSxS'
    path = 'C:\Windows\WinSxS'
    pathSource = 'configured'
    pathCandidates = @()
    autoPath = ''
    autoSize = 0
    size = 0
    risk = 'high'
    exists = $true
  }
  $results += $dismItem
  Write-Output ('@@ITEM@@' + ($dismItem | ConvertTo-Json -Compress -Depth 4))
}

# P1-12：结果经 @@ITEM@@ 行流式回传，主进程按行聚合
`;

// ==================== 清理脚本 ====================
const EXECUTE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
${DIAG.PS_PREAMBLE}

$itemsJson = '\${ITEMS_PLACEHOLDER}'
$force = \${FORCE_PLACEHOLDER}
$items = $itemsJson | ConvertFrom-Json
$totalFreed = 0
$success = 0
$failed = 0
$skipped = 0
$details = @()

# 系统关键进程白名单（这些文件不能删）
$protectedProcesses = @('svchost', 'explorer', 'winlogon', 'csrss', 'lsass')

function Remove-PathSafely {
  param([string]$Path, [bool]$Force, [string]$Risk)
  if (-not (Test-Path -LiteralPath $Path)) {
    return @{ freed = 0; status = 'skip'; message = '路径不存在' }
  }
  try {
    $size = (Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue |
             Where-Object { -not $_.PSIsContainer } |
             Measure-Object -Property Length -Sum).Sum
    $size = [long]($size -as [long])

    if ($Risk -eq 'high' -and -not $Force) {
      return @{ freed = 0; status = 'skip'; message = '高风险项需勾选强制删除' }
    }

    # 检查路径中是否有被保护的进程占用
    $isProtected = $false
    $procCheck = Get-Process | Where-Object { $_.Path -like ($Path + '*') } | Select-Object -First 1
    if ($procCheck -and $protectedProcesses -contains $procCheck.ProcessName) {
      return @{ freed = 0; status = 'skip'; message = '系统关键进程占用' }
    }

    # 高风险：临时文件目录清理后重建（参考 cmd 脚本）
    if ($Path -like '*\\Temp' -or $Path -like '*\\Prefetch' -or $Path -like '*\\Recent') {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
      try { New-Item -ItemType Directory -Path $Path -Force -ErrorAction Stop | Out-Null } catch { return @{ freed = 0; status = 'error'; message = '目录重建失败: ' + $_.Exception.Message } }
      if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return @{ freed = 0; status = 'error'; message = '目录重建未生效' } }
      return @{ freed = $size; status = 'ok'; message = '已清理并重建' }
    }

    # Windows Update Download 需先停止服务
    if ($Path -like '*SoftwareDistribution\\Download*') {
      Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue
      Stop-Service -Name UsoSvc -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue }
      try { New-Item -ItemType Directory -Path $Path -Force -ErrorAction Stop | Out-Null } catch { return @{ freed = 0; status = 'error'; message = '更新缓存目录重建失败: ' + $_.Exception.Message } }
      Start-Service -Name wuauserv -ErrorAction SilentlyContinue
      Start-Service -Name UsoSvc -ErrorAction SilentlyContinue
      $wuOk = ((Get-Service -Name wuauserv -ErrorAction SilentlyContinue).Status -eq 'Running')
      $usoOk = ((Get-Service -Name UsoSvc -ErrorAction SilentlyContinue).Status -eq 'Running')
      if (-not $wuOk -or -not $usoOk) { return @{ freed = $size; status = 'partial'; message = '缓存已处理，但更新服务未全部恢复' } }
      return @{ freed = $size; status = 'ok'; message = '已停止更新服务并清理' }
    }

    # 普通清理
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $Path) {
      Write-TFDiag -Stage 'execute.remove' -Mutation 'partial' -Detail ('路径仍存在(部分删除): ' + $Path)
      return @{ freed = 0; status = 'partial'; message = '部分文件被占用' }
    }
    return @{ freed = $size; status = 'ok'; message = '已清理' }
  } catch {
    Write-TFDiag -Stage 'execute.remove' -Mutation 'rolled_back' -Detail ($Path + ' -> ' + $_.Exception.Message)
    return @{ freed = 0; status = 'error'; message = $_.Exception.Message }
  }
}

foreach ($item in $items) {
  # DISM 组件清理：执行 StartComponentCleanup + ResetBase（不按路径删除）
  if ($item.id -eq 'dismComponentCleanup') {
    $dismOut = & dism.exe /Online /Cleanup-Image /StartComponentCleanup /ResetBase 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
      $success++
      $details += @{ id = 'dismComponentCleanup'; name = $item.name; status = 'ok'; freed = 0; message = 'DISM 组件存储清理完成（/ResetBase 已执行，更新将不可卸载）' }
    } else {
      $failed++
      $tail = ($dismOut -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -Last 2) -join ' '
      Write-TFDiag -Stage 'execute.dism' -Mutation 'partial' -Detail ('dismComponentCleanup exit=' + $LASTEXITCODE + ' ' + $tail)
      $details += @{ id = 'dismComponentCleanup'; name = $item.name; status = 'error'; freed = 0; message = ('DISM 执行失败: ' + $tail) }
    }
    continue
  }
  $result = Remove-PathSafely -Path $item.path -Force $force -Risk $item.risk
  $totalFreed += $result.freed
  switch ($result.status) {
    'ok' { $success++ }
    'skip' { $skipped++ }
    'error' { $failed++ }
    'partial' { $failed++ }
  }
  $details += @{
    id = $item.id
    name = $item.name
    status = $result.status
    freed = $result.freed
    message = $result.message
  }
}

@{
  totalFreed = $totalFreed
  success = $success
  failed = $failed
  skipped = $skipped
  details = $details
} | ConvertTo-Json -Compress -Depth 3
`;

// PowerShell 单引号字符串内转义：' → ''
function psEscapeSingle(s) {
  return String(s).replace(/'/g, "''");
}

module.exports = {
  scan(categories, configuredPaths = {}) {
    const catsJson = psEscapeSingle(JSON.stringify(categories || []));
    const pathsJson = psEscapeSingle(JSON.stringify(configuredPaths || {}));
    return SCAN_SCRIPT
      .replace('\u0024{CATEGORIES_PLACEHOLDER}', () => catsJson)
      .replace('\u0024{CONFIGURED_PATHS_PLACEHOLDER}', () => pathsJson)
      .replace('\u0024{CATEGORY_DEFS_PLACEHOLDER}', () => buildCategoryDefsPs());
  },
  execute(items, force) {
    const itemsJson = psEscapeSingle(JSON.stringify(items || []));
    return EXECUTE_SCRIPT
      .replace('\u0024{FORCE_PLACEHOLDER}', () => (force ? '$true' : '$false'))
      .replace('\u0024{ITEMS_PLACEHOLDER}', () => itemsJson);
  },
  // 供渲染层通过 IPC 读取的清理规则原始数据（P1-9 数据化：唯一数据源）
  rules() {
    return loadRules();
  }
};
