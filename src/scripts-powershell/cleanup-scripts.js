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
// 「规则引擎升级（P1）」起条目支持三类目标模型，扫描/执行均按以下优先级路由：
//   1. special === 'dism'   专项分支（DISM /ResetBase，不走文件/注册表模型）
//   2. fileKeys[]           文件模式清理（路径支持 %ENV% 与 * 通配、pattern 文件名
//                           过滤、removeSelf 剪除空目录；excludeKeys 排除目录/文件）
//   3. regKeys[]            注册表清理（扫描只做存在性计数；执行按 value 语义删除：
//                           无 value=删整树（受 excludeKeys reg 保护分支约束）、
//                           value:'*'=仅清键值、value:'名'=删指定值）
//   4. pathPs               目录型条目（整目录，向后兼容既有条目）
// 通用字段：detect[]（安装检测，OR 语义，全部不命中则该条目不参与扫描）；
//           requiredStoppedProcesses（已接线：扫描标注 blockedBy 提示，执行命中即跳过）。
// 规则 JSON 整体经 RULES_JSON_PLACEHOLDER 注入（单引号转义，不注入可执行代码），
// 避免逐字段拼 PS 源码的转义风险。
//
// 「规则库在线更新（P2）」：主进程把更新后的规则写到数据目录 cleanup\rules.json，
// loadRules() 读取优先级 = 数据目录 rules.json > 内置 JSON > 空；custom\*.json
// 为用户自定义规则（同名 id 覆盖生效规则，新 id 追加到同 key 分组）。

const fs = require('fs');
const path = require('path');
const DIAG = require('../main/diag');

const RULES_FILE = path.join(__dirname, '..', 'data', 'cleanup-rules.json');
// 数据目录与 main.js APP_DATA_DIR（%APPDATA%\Trim）保持一致；此处不依赖 electron app
const DATA_RULES_DIR = path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'Trim', 'cleanup');
const DATA_RULES_FILE = path.join(DATA_RULES_DIR, 'rules.json');
const CUSTOM_RULES_DIR = path.join(DATA_RULES_DIR, 'custom');

let RULES_CACHE = null;
let RULES_CACHE_SIG = '';

function safeReadJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && Array.isArray(parsed.groups) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function collectGroupItems(group) {
  if (group.subGroups) return group.subGroups.flatMap(sg => sg.items || []);
  return group.items || [];
}

// 合并自定义规则：同名 id 覆盖生效规则的字段，新 id 追加到同 key 分组（无则新分组）
function mergeRules(base, custom) {
  const merged = JSON.parse(JSON.stringify(base));
  const byId = new Map();
  const keyIndex = new Map();
  merged.groups.forEach((g, gi) => {
    keyIndex.set(g.key, gi);
    for (const it of collectGroupItems(g)) byId.set(it.id, it);
  });
  for (const g of (custom.groups || [])) {
    for (const it of collectGroupItems(g)) {
      if (!it || !it.id) continue;
      const hit = byId.get(it.id);
      if (hit) { Object.assign(hit, it); continue; }
      const gi = keyIndex.get(g.key);
      if (gi != null) {
        const target = merged.groups[gi];
        if (!target.subGroups && !target.items) target.items = [];
        if (target.items) target.items.push(it);
        else if (target.subGroups.length) target.subGroups[0].items.push(it);
        byId.set(it.id, it);
      } else {
        merged.groups.push({ key: g.key || 'custom', title: g.title || '自定义规则', icon: g.icon || '🧩', items: [it] });
      }
    }
  }
  return merged;
}

function loadRules() {
  const custom = [];
  try {
    if (fs.existsSync(CUSTOM_RULES_DIR)) {
      for (const f of fs.readdirSync(CUSTOM_RULES_DIR)) {
        if (!f.toLowerCase().endsWith('.json')) continue;
        const full = path.join(CUSTOM_RULES_DIR, f);
        const stat = fs.statSync(full);
        custom.push({ path: full, mtimeMs: stat.mtimeMs });
      }
    }
  } catch (e) { /* 自定义目录不可读则忽略 */ }
  let dataMTime = 0;
  try { dataMTime = fs.existsSync(DATA_RULES_FILE) ? fs.statSync(DATA_RULES_FILE).mtimeMs : 0; } catch (e) {}
  const sig = dataMTime + '|' + custom.length + '|' + custom.map(c => c.mtimeMs).join(',');
  if (RULES_CACHE && sig === RULES_CACHE_SIG) return RULES_CACHE;

  // 优先级：数据目录（在线更新产物）> 内置
  let rules = (dataMTime && safeReadJson(DATA_RULES_FILE)) || safeReadJson(RULES_FILE);
  if (!rules) rules = { version: 0, rulesVersion: 0, groups: [] };
  for (const c of custom) {
    const parsed = safeReadJson(c.path);
    if (parsed) rules = mergeRules(rules, parsed);
  }
  RULES_CACHE = rules;
  RULES_CACHE_SIG = sig;
  return rules;
}

// PS 单引号字符串转义：' → ''（用于注入 JSON/字面量值）
function psEscapeSingle(s) {
  return String(s).replace(/'/g, "''");
}

// ==================== 扫描脚本 ====================
const SCAN_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
${DIAG.PS_PREAMBLE}

$rulesJson = '\${RULES_JSON_PLACEHOLDER}'
# 超长 JSON 用 -InputObject 解析（管道长字符串在本机 pwsh 有解析异常风险）
$rules = ConvertFrom-Json -InputObject $rulesJson
$categories = ('\${CATEGORIES_PLACEHOLDER}' | ConvertFrom-Json)
$configuredPaths = ('\${CONFIGURED_PATHS_PLACEHOLDER}' | ConvertFrom-Json)

# id -> 规则条目映射（数据目录覆盖与自定义合并已在主进程完成）
$ruleMap = @{}
foreach ($g in $rules.groups) {
  if ($g.subGroups) { foreach ($sg in $g.subGroups) { foreach ($it in $sg.items) { $ruleMap[$it.id] = $it } } }
  elseif ($g.items) { foreach ($it in $g.items) { $ruleMap[$it.id] = $it } }
}

# P1：一次性取全量进程名（requiredStoppedProcesses 扫描侧探测，逐条 Get-Process 太慢）
$runningProcessNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) { $null = $runningProcessNames.Add($p.ProcessName) }

# %ENV% 展开：未定义的变量保持原样，便于在路径列直接看出配置问题
function Expand-EnvPath {
  param([string]$Path)
  return [regex]::Replace($Path, '%([^%]+)%', {
    param($m)
    $v = [Environment]::GetEnvironmentVariable($m.Groups[1].Value)
    if ($v) { $v } else { $m.Value }
  })
}

# 目录通配解析：逐段展开 * / ?（** 暂不支持），返回真实存在的目录列表。
# 跳过 ReparsePoint（junction/symlink）防循环；裸盘符修正为根目录。
function Resolve-GlobDirs {
  param([string]$Pattern)
  $expanded = Expand-EnvPath $Pattern
  if (-not $expanded.Contains('*')) {
    if (Test-Path -LiteralPath $expanded -PathType Container) { return @($expanded) }
    return @()
  }
  $segments = @($expanded -split '[\\\\/]' | Where-Object { $_ })
  if ($segments.Count -eq 0) { return @() }
  $roots = @()
  $start = 0
  if ($segments[0].EndsWith(':')) { $roots = @($segments[0] + '\\'); $start = 1 }
  else { $roots = @('\\') }
  for ($i = $start; $i -lt $segments.Count; $i++) {
    $seg = $segments[$i]
    $next = New-Object System.Collections.Generic.List[string]
    foreach ($r in $roots) {
      if ($seg.Contains('*') -or $seg.Contains('?')) {
        foreach ($c in (Get-ChildItem -Path (Join-Path $r $seg) -Directory -Force -ErrorAction SilentlyContinue)) {
          if (-not ($c.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $next.Add($c.FullName) }
        }
      } else {
        $p = Join-Path $r $seg
        if (Test-Path -LiteralPath $p -PathType Container) { $next.Add($p) }
      }
    }
    $roots = @($next | Select-Object -Unique)
    if ($roots.Count -eq 0) { return @() }
  }
  return $roots
}

# 注册表路径映射：HKCU\\... → Registry::HKEY_CURRENT_USER\\...（不依赖 PSDrive 挂载）
function Convert-RegPath {
  param([string]$RegPath)
  $idx = $RegPath.IndexOf('\\')
  if ($idx -lt 0) { return $null }
  $hive = $RegPath.Substring(0, $idx).ToUpperInvariant()
  $rest = $RegPath.Substring($idx + 1)
  $map = @{ HKCU = 'HKEY_CURRENT_USER'; HKLM = 'HKEY_LOCAL_MACHINE'; HKCR = 'HKEY_CLASSES_ROOT'; HKU = 'HKEY_USERS'; HKCC = 'HKEY_CURRENT_CONFIG' }
  if (-not $map.ContainsKey($hive)) { return $null }
  return ('Registry::' + $map[$hive] + '\\' + $rest)
}

function Test-RegPathExists {
  param([string]$RegPath)
  $p = Convert-RegPath $RegPath
  if (-not $p) { return $false }
  return (Test-Path -LiteralPath $p)
}

# P1：安装检测（OR 语义）——detect 为空视为命中；reg 型查注册表，file 型支持通配
function Test-RuleDetect {
  param($Rule)
  # 注意：属性缺失时 @($null) 的 Count 是 1，必须先判空，否则未声明 detect 的条目会被误判为未命中
  if (-not $Rule.detect) { return $true }
  $d = @($Rule.detect)
  if ($d.Count -eq 0) { return $true }
  foreach ($c in $d) {
    if (-not $c -or -not $c.path) { continue }
    if ($c.type -eq 'reg') {
      if (Test-RegPathExists (Expand-EnvPath ([string]$c.path))) { return $true }
    } else {
      $p = Expand-EnvPath ([string]$c.path)
      if ($p.Contains('*')) {
        if ((Resolve-GlobDirs $p).Count -gt 0) { return $true }
      } elseif (Test-Path -LiteralPath $p) { return $true }
    }
  }
  return $false
}

# P1：requiredStoppedProcesses 扫描侧探测 → blockedBy（渲染层展示提示标签）
function Get-BlockedProcesses {
  param($Rule)
  $out = @()
  foreach ($pn in @($Rule.requiredStoppedProcesses)) {
    if ($pn -and $runningProcessNames.Contains([string]$pn)) { $out += [string]$pn }
  }
  return @($out)
}

# 收集一个条目 fileKeys 的全部候选文件：通配基目录枚举 + pattern 过滤 +
# excludeKeys（dir 前缀 / file 全路径）过滤 + 跨键 FullName 去重 + 跳过 ReparsePoint
function Get-FileKeySnapshot {
  param($Rule)
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  $exclDirs = @(); $exclFiles = @()
  foreach ($ex in @($Rule.excludeKeys)) {
    if (-not $ex -or -not $ex.path -or $ex.type -eq 'reg') { continue }
    $ep = (Expand-EnvPath ([string]$ex.path)).TrimEnd('\\')
    if ($ex.type -eq 'dir') { $exclDirs += $ep.ToLowerInvariant() }
    else { $exclFiles += $ep.ToLowerInvariant() }
  }
  $files = New-Object System.Collections.Generic.List[object]
  foreach ($fk in @($Rule.fileKeys)) {
    if (-not $fk -or -not $fk.path) { continue }
    $pattern = '*'; if ($fk.pattern) { $pattern = [string]$fk.pattern }
    $recurse = $true; if ($fk.recurse -eq $false) { $recurse = $false }
    foreach ($dir in (Resolve-GlobDirs ([string]$fk.path))) {
      $gciArgs = @{ LiteralPath = $dir; Filter = $pattern; File = $true; Force = $true; ErrorAction = 'SilentlyContinue' }
      if ($recurse) { $gciArgs.Recurse = $true; $gciArgs.Depth = 24 }
      foreach ($f in (Get-ChildItem @gciArgs)) {
        if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        $full = $f.FullName
        if (-not $seen.Add($full)) { continue }
        $low = $full.ToLowerInvariant()
        $skip = $false
        foreach ($d in $exclDirs) { if ($low.StartsWith($d + '\\')) { $skip = $true; break } }
        if (-not $skip) { foreach ($fe in $exclFiles) { if ($low -eq $fe) { $skip = $true; break } } }
        if ($skip) { continue }
        $files.Add([pscustomobject]@{ Path = $full; Size = [long]$f.Length })
      }
    }
  }
  # 注意：本机 pwsh 对非空 List[object] 做 @() 包裹会抛 ArgumentException（实测），
  # 必须用 ToArray() 转数组
  return $files.ToArray()
}

# 注册表条目扫描：只做存在性 + 规模计数（删除留到执行阶段）
function Measure-RegRule {
  param($Rule)
  $exists = $false; $count = 0
  foreach ($rk in @($Rule.regKeys)) {
    if (-not $rk -or -not $rk.path) { continue }
    $p = Convert-RegPath (Expand-EnvPath ([string]$rk.path))
    if (-not $p -or -not (Test-Path -LiteralPath $p)) { continue }
    $exists = $true; $count++
    if ($rk.value) { continue }
    $key = Get-Item -LiteralPath $p -ErrorAction SilentlyContinue
    if ($key) {
      $count += @($key.GetValueNames()).Count
      $count += @(Get-ChildItem -LiteralPath $p -ErrorAction SilentlyContinue).Count
    }
  }
  return [pscustomobject]@{ exists = $exists; count = $count }
}

function Get-PathSize {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  try {
    $entry = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($entry -and -not $entry.PSIsContainer) { return [long]$entry.Length }
    $size = (Get-ChildItem -LiteralPath $Path -File -Recurse -Depth 24 -Force -ErrorAction SilentlyContinue |
             Measure-Object -Property Length -Sum).Sum
    return [long]($size -as [long])
  } catch { return 0 }
}

foreach ($cat in $categories) {
  $rule = $ruleMap[$cat]
  if ($null -eq $rule) { continue }

  # DISM 组件清理：非路径型条目，固定返回"可执行"状态（大小以实际执行结果为准）
  if ($rule.special -eq 'dism') {
    $dismItem = @{
      id = $cat
      name = $rule.name
      configuredPath = 'C:\\Windows\\WinSxS'
      path = 'C:\\Windows\\WinSxS'
      pathSource = 'configured'
      pathCandidates = @()
      autoPath = ''
      autoSize = 0
      size = 0
      risk = $rule.risk
      exists = $true
      blockedBy = @()
    }
    Write-Output ('@@ITEM@@' + ($dismItem | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
    continue
  }

  # P1：安装检测——目标应用未安装的条目直接不输出（渲染层扫描后隐藏）
  if (-not (Test-RuleDetect -Rule $rule)) { continue }

  $blocked = @(Get-BlockedProcesses -Rule $rule)

  # ---- 文件模式条目（fileKeys）----
  if ($rule.fileKeys -and @($rule.fileKeys).Count -gt 0) {
    $snap = @(Get-FileKeySnapshot -Rule $rule)
    $total = 0L
    foreach ($f in $snap) { $total += $f.Size }
    $display = [string]$rule.fileKeys[0].path
    if (@($rule.fileKeys).Count -gt 1) { $display = $display + ' 等 ' + @($rule.fileKeys).Count + ' 处' }
    Write-Output ('@@ITEM@@' + (@{
      id = $cat
      name = $rule.name
      configuredPath = $display
      path = $display
      pathSource = 'rules'
      pathCandidates = @()
      autoPath = ''
      autoSize = 0
      size = $total
      fileCount = $snap.Count
      risk = $rule.risk
      exists = ($snap.Count -gt 0)
      blockedBy = $blocked
    } | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
    continue
  }

  # ---- 注册表条目（regKeys）----
  if ($rule.regKeys -and @($rule.regKeys).Count -gt 0) {
    $m = Measure-RegRule -Rule $rule
    $display = [string]$rule.regKeys[0].path
    if (@($rule.regKeys).Count -gt 1) { $display = $display + ' 等 ' + @($rule.regKeys).Count + ' 处' }
    Write-Output ('@@ITEM@@' + (@{
      id = $cat
      name = $rule.name
      configuredPath = $display
      path = $display
      pathSource = 'rules'
      pathCandidates = @()
      autoPath = ''
      autoSize = 0
      size = $null
      fileCount = 0
      regCount = $m.count
      risk = $rule.risk
      exists = $m.exists
      blockedBy = $blocked
    } | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
    continue
  }

  # ---- 目录型条目（pathPs）----
  if (-not $rule.pathPs) { continue }
  # pathPs/candidatesPs/globCandidatesPs 是 PowerShell 表达式（$env:VAR + '\...' 字面量），
  # 沿用 P1-9 注入求值语义：规则来自主进程加载的规则 JSON（渲染层无法注入内容）。
  try { $path = [string](Invoke-Expression ([string]$rule.pathPs)) } catch { $path = '' }
  if (-not $path) { $path = [string]$rule.pathPs }
  $evaluatedPath = $path
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
  if ($rule.candidates) {
    foreach ($cExpr in @($rule.candidates)) {
      if (-not $cExpr) { continue }
      try { $pathCandidates += [string](Invoke-Expression ([string]$cExpr)) } catch {}
    }
    if (-not (Test-Path -LiteralPath $path)) {
      foreach ($candidate in $pathCandidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { $autoPath = [string]$candidate; $path = $autoPath; $pathSource = 'auto'; break }
      }
    }
  }
  if ($rule.globCandidates) {
    foreach ($gExpr in @($rule.globCandidates)) {
      if (-not $gExpr) { continue }
      try { $pat = [string](Invoke-Expression ([string]$gExpr)) } catch { continue }
      $match = Get-ChildItem -Path $pat -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($match -and -not (Test-Path -LiteralPath $path)) { $autoPath = $match.FullName; $path = $autoPath; $pathSource = 'auto'; $pathCandidates += $match.FullName; break }
    }
  }
  $size = Get-PathSize -Path $path
  # P1 修复：autoPath 命中时 size 即是 autoPath 的大小，不再二次枚举（原 autoSize 重复计算）
  $autoSize = 0
  if ($autoPath -and $path -eq $autoPath) { $autoSize = $size }
  # P1-12：逐项流式输出，主进程按行解析后增量推送渲染层（真实进度）
  Write-Output ('@@ITEM@@' + (@{
    id = $cat
    name = $rule.name
    configuredPath = $evaluatedPath
    path = $path
    pathSource = $pathSource
    pathCandidates = @($pathCandidates)
    autoPath = $autoPath
    autoSize = $autoSize
    size = $size
    risk = $rule.risk
    exists = (Test-Path -LiteralPath $path)
    blockedBy = $blocked
  } | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

# P1-12：结果经 @@ITEM@@ 行流式回传，主进程按行聚合
`;

// ==================== 清理脚本 ====================
// P3：toRecycle=true 时进入「回收站模式」——PS 只枚举待删目标并输出 @@RECYCLE@@ 行，
// 实际移入回收站由主进程 shell.trashItem 完成（PS 内不做任何文件删除）；
// 注册表条目与 DISM 无回收站语义，仍在 PS 内直接执行（详情文案注明）。
// 删除模式下每项完成后做「残留复查」（residual：删除后仍存在的文件/注册表计数）。
const EXECUTE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
${DIAG.PS_PREAMBLE}

$itemsJson = '\${ITEMS_PLACEHOLDER}'
$force = \${FORCE_PLACEHOLDER}
$recycle = \${RECYCLE_PLACEHOLDER}
$items = $itemsJson | ConvertFrom-Json
$rulesJson = '\${RULES_JSON_PLACEHOLDER}'
$rules = ConvertFrom-Json -InputObject $rulesJson
$totalFreed = 0
$success = 0
$failed = 0
$skipped = 0
$details = @()

$ruleMap = @{}
foreach ($g in $rules.groups) {
  if ($g.subGroups) { foreach ($sg in $g.subGroups) { foreach ($it in $sg.items) { $ruleMap[$it.id] = $it } } }
  elseif ($g.items) { foreach ($it in $g.items) { $ruleMap[$it.id] = $it } }
}

# 系统关键进程白名单（这些文件不能删）
$protectedProcesses = @('svchost', 'explorer', 'winlogon', 'csrss', 'lsass')

# P1：执行侧一次性进程名快照（requiredStoppedProcesses 复检用）
$runningProcessNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) { $null = $runningProcessNames.Add($p.ProcessName) }

function Expand-EnvPath {
  param([string]$Path)
  return [regex]::Replace($Path, '%([^%]+)%', {
    param($m)
    $v = [Environment]::GetEnvironmentVariable($m.Groups[1].Value)
    if ($v) { $v } else { $m.Value }
  })
}

function Resolve-GlobDirs {
  param([string]$Pattern)
  $expanded = Expand-EnvPath $Pattern
  if (-not $expanded.Contains('*')) {
    if (Test-Path -LiteralPath $expanded -PathType Container) { return @($expanded) }
    return @()
  }
  $segments = @($expanded -split '[\\\\/]' | Where-Object { $_ })
  if ($segments.Count -eq 0) { return @() }
  $roots = @()
  $start = 0
  if ($segments[0].EndsWith(':')) { $roots = @($segments[0] + '\\'); $start = 1 }
  else { $roots = @('\\') }
  for ($i = $start; $i -lt $segments.Count; $i++) {
    $seg = $segments[$i]
    $next = New-Object System.Collections.Generic.List[string]
    foreach ($r in $roots) {
      if ($seg.Contains('*') -or $seg.Contains('?')) {
        foreach ($c in (Get-ChildItem -Path (Join-Path $r $seg) -Directory -Force -ErrorAction SilentlyContinue)) {
          if (-not ($c.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $next.Add($c.FullName) }
        }
      } else {
        $p = Join-Path $r $seg
        if (Test-Path -LiteralPath $p -PathType Container) { $next.Add($p) }
      }
    }
    $roots = @($next | Select-Object -Unique)
    if ($roots.Count -eq 0) { return @() }
  }
  return $roots
}

function Convert-RegPath {
  param([string]$RegPath)
  $idx = $RegPath.IndexOf('\\')
  if ($idx -lt 0) { return $null }
  $hive = $RegPath.Substring(0, $idx).ToUpperInvariant()
  $rest = $RegPath.Substring($idx + 1)
  $map = @{ HKCU = 'HKEY_CURRENT_USER'; HKLM = 'HKEY_LOCAL_MACHINE'; HKCR = 'HKEY_CLASSES_ROOT'; HKU = 'HKEY_USERS'; HKCC = 'HKEY_CURRENT_CONFIG' }
  if (-not $map.ContainsKey($hive)) { return $null }
  return ('Registry::' + $map[$hive] + '\\' + $rest)
}

function Get-BlockedProcesses {
  param($Rule)
  $out = @()
  foreach ($pn in @($Rule.requiredStoppedProcesses)) {
    if ($pn -and $runningProcessNames.Contains([string]$pn)) { $out += [string]$pn }
  }
  return @($out)
}

# 收集 fileKeys 候选文件（与扫描脚本同一实现，执行期重新快照以缩小 TOCTOU 窗口）
function Get-FileKeySnapshot {
  param($Rule)
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  $exclDirs = @(); $exclFiles = @()
  foreach ($ex in @($Rule.excludeKeys)) {
    if (-not $ex -or -not $ex.path -or $ex.type -eq 'reg') { continue }
    $ep = (Expand-EnvPath ([string]$ex.path)).TrimEnd('\\')
    if ($ex.type -eq 'dir') { $exclDirs += $ep.ToLowerInvariant() }
    else { $exclFiles += $ep.ToLowerInvariant() }
  }
  $files = New-Object System.Collections.Generic.List[object]
  foreach ($fk in @($Rule.fileKeys)) {
    if (-not $fk -or -not $fk.path) { continue }
    $pattern = '*'; if ($fk.pattern) { $pattern = [string]$fk.pattern }
    $recurse = $true; if ($fk.recurse -eq $false) { $recurse = $false }
    foreach ($dir in (Resolve-GlobDirs ([string]$fk.path))) {
      $gciArgs = @{ LiteralPath = $dir; Filter = $pattern; File = $true; Force = $true; ErrorAction = 'SilentlyContinue' }
      if ($recurse) { $gciArgs.Recurse = $true; $gciArgs.Depth = 24 }
      foreach ($f in (Get-ChildItem @gciArgs)) {
        if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        $full = $f.FullName
        if (-not $seen.Add($full)) { continue }
        $low = $full.ToLowerInvariant()
        $skip = $false
        foreach ($d in $exclDirs) { if ($low.StartsWith($d + '\\')) { $skip = $true; break } }
        if (-not $skip) { foreach ($fe in $exclFiles) { if ($low -eq $fe) { $skip = $true; break } } }
        if ($skip) { continue }
        $files.Add([pscustomobject]@{ Path = $full; Size = [long]$f.Length })
      }
    }
  }
  # 注意：本机 pwsh 对非空 List[object] 做 @() 包裹会抛 ArgumentException（实测），
  # 必须用 ToArray() 转数组
  return $files.ToArray()
}

function Get-PathSize {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  try {
    $entry = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($entry -and -not $entry.PSIsContainer) { return [long]$entry.Length }
    $size = (Get-ChildItem -LiteralPath $Path -File -Recurse -Depth 24 -Force -ErrorAction SilentlyContinue |
             Measure-Object -Property Length -Sum).Sum
    return [long]($size -as [long])
  } catch { return 0 }
}

# REMOVESELF 语义：自深至浅剪除空目录（含 fileKey 基目录本身）
function Prune-EmptyDirs {
  param([string]$Pattern)
  $n = 0
  foreach ($dir in (Resolve-GlobDirs $Pattern)) {
    $dirs = @(Get-ChildItem -LiteralPath $dir -Directory -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
      Sort-Object { $_.FullName.Length } -Descending)
    foreach ($d in $dirs) {
      if (@(Get-ChildItem -LiteralPath $d.FullName -Force -ErrorAction SilentlyContinue).Count -eq 0) {
        Remove-Item -LiteralPath $d.FullName -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $d.FullName)) { $n++ }
      }
    }
    if (Test-Path -LiteralPath $dir -PathType Container) {
      if (@(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue).Count -eq 0) {
        Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $dir)) { $n++ }
      }
    }
  }
  return $n
}

# 注册表树删除（排除分支保护）：递归删除 $Path 子树，但整体保留 $Protected 命中的分支。
# 受保护内容未清空时键本身保留（Remove-Item 非递归对非空键失败），由调用方按结果计数。
function Remove-RegTreeExcept {
  param([string]$Path, [string[]]$Protected)
  $low = $Path.ToLowerInvariant().TrimEnd('\\')
  foreach ($p in $Protected) {
    $pl = $p.ToLowerInvariant().TrimEnd('\\')
    if ($low -eq $pl -or $low.StartsWith($pl + '\\')) { return 0 }
  }
  $count = 0
  $key = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
  if (-not $key) { return 0 }
  foreach ($v in @($key.GetValueNames())) {
    try { Remove-ItemProperty -LiteralPath $Path -Name $v -Force -ErrorAction Stop; $count++ } catch {}
  }
  foreach ($c in @(Get-ChildItem -LiteralPath $Path -ErrorAction SilentlyContinue)) {
    $count += (Remove-RegTreeExcept -Path ($Path.TrimEnd('\\') + '\\' + $c.PSChildName) -Protected $Protected)
  }
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $Path)) { $count++ }
  return $count
}

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
  $rule = $ruleMap[$item.id]

  # DISM 组件清理：执行 StartComponentCleanup + ResetBase（不按路径删除）
  if ($item.id -eq 'dismComponentCleanup') {
    $dismOut = & dism.exe /Online /Cleanup-Image /StartComponentCleanup /ResetBase 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
      $success++
      $details += @{ id = 'dismComponentCleanup'; name = $item.name; status = 'ok'; freed = 0; message = 'DISM 组件存储清理完成（/ResetBase 已执行，更新将不可卸载）' }
    } else {
      $failed++
      $tail = ($dismOut -split '\\r?\\n' | Where-Object { $_.Trim() } | Select-Object -Last 2) -join ' '
      Write-TFDiag -Stage 'execute.dism' -Mutation 'partial' -Detail ('dismComponentCleanup exit=' + $LASTEXITCODE + ' ' + $tail)
      $details += @{ id = 'dismComponentCleanup'; name = $item.name; status = 'error'; freed = 0; message = ('DISM 执行失败: ' + $tail) }
    }
    continue
  }

  # P1：requiredStoppedProcesses 执行侧复检 → 命中即整体跳过并写明原因（不静默半清）
  $blocked = @()
  if ($rule) { $blocked = @(Get-BlockedProcesses -Rule $rule) }
  if ($blocked.Count -gt 0) {
    $skipped++
    $details += @{ id = $item.id; name = $item.name; status = 'skip'; freed = 0; message = ('请先关闭后再清理: ' + ($blocked -join ', ')) }
    continue
  }

  # ---- 文件模式条目（fileKeys）----
  if ($rule -and $rule.fileKeys -and @($rule.fileKeys).Count -gt 0) {
    if ([string]$rule.risk -eq 'high' -and -not $force) {
      $skipped++
      $details += @{ id = $item.id; name = $item.name; status = 'skip'; freed = 0; message = '高风险项需勾选强制删除' }
      continue
    }
    $snap = @(Get-FileKeySnapshot -Rule $rule)
    if ($snap.Count -eq 0) {
      $skipped++
      $details += @{ id = $item.id; name = $item.name; status = 'skip'; freed = 0; message = '无可清理文件'; residual = 0 }
      continue
    }
    if ($recycle) {
      # P3 回收站模式：PS 只枚举目标（@@RECYCLE@@ 行），移入回收站由主进程 shell.trashItem 执行
      $bytes = 0L
      foreach ($f in $snap) {
        $bytes += $f.Size
        Write-Output ('@@RECYCLE@@' + (@{ id = $item.id; path = $f.Path; size = $f.Size; isDir = $false } | ConvertTo-Json -Compress))
      }
      $details += @{ id = $item.id; name = $item.name; status = 'recycle'; freed = $bytes; message = '待移入回收站'; residual = 0; fileCount = $snap.Count }
      continue
    }
    $freed = 0L; $deleted = 0; $failedFiles = 0
    foreach ($f in $snap) {
      try {
        Remove-Item -LiteralPath $f.Path -Force -ErrorAction Stop
        $freed += $f.Size
        $deleted++
      } catch { $failedFiles++ }
    }
    $pruned = 0
    foreach ($fk in @($rule.fileKeys)) {
      if ($fk -and $fk.removeSelf) { $pruned += (Prune-EmptyDirs -Pattern ([string]$fk.path)) }
    }
    $totalFreed += $freed
    # P3 残留复查：删除后重新快照计数（0 = 清干净）
    $residual = @(Get-FileKeySnapshot -Rule $rule).Count
    if ($failedFiles -eq 0) {
      $success++
      $msg = '已清理 ' + $deleted + ' 个文件'
      if ($pruned -gt 0) { $msg = $msg + '，剪除 ' + $pruned + ' 个空目录' }
      $details += @{ id = $item.id; name = $item.name; status = 'ok'; freed = $freed; message = $msg; residual = $residual }
    } elseif ($deleted -gt 0) {
      $failed++
      $details += @{ id = $item.id; name = $item.name; status = 'partial'; freed = $freed; message = '已清理 ' + $deleted + ' 个文件，' + $failedFiles + ' 个被占用'; residual = $residual }
    } else {
      $failed++
      $details += @{ id = $item.id; name = $item.name; status = 'error'; freed = 0; message = $failedFiles + ' 个文件全部被占用'; residual = $residual }
    }
    continue
  }

  # ---- 注册表条目（regKeys）----
  if ($rule -and $rule.regKeys -and @($rule.regKeys).Count -gt 0) {
    if ([string]$rule.risk -eq 'high' -and -not $force) {
      $skipped++
      $details += @{ id = $item.id; name = $item.name; status = 'skip'; freed = 0; message = '高风险项需勾选强制删除' }
      continue
    }
    $protected = @()
    foreach ($ex in @($rule.excludeKeys)) {
      if ($ex -and $ex.type -eq 'reg' -and $ex.path) {
        $cp = Convert-RegPath (Expand-EnvPath ([string]$ex.path))
        if ($cp) { $protected += $cp }
      }
    }
    $okCount = 0; $regFail = 0
    foreach ($rk in @($rule.regKeys)) {
      if (-not $rk -or -not $rk.path) { continue }
      $p = Convert-RegPath (Expand-EnvPath ([string]$rk.path))
      if (-not $p -or -not (Test-Path -LiteralPath $p)) { continue }
      if ($rk.value) {
        if ([string]$rk.value -eq '*') {
          $key = Get-Item -LiteralPath $p -ErrorAction SilentlyContinue
          if ($key) {
            foreach ($v in @($key.GetValueNames())) {
              try { Remove-ItemProperty -LiteralPath $p -Name $v -Force -ErrorAction Stop; $okCount++ } catch { $regFail++ }
            }
          }
        } else {
          try { Remove-ItemProperty -LiteralPath $p -Name ([string]$rk.value) -Force -ErrorAction Stop; $okCount++ } catch { $regFail++ }
        }
      } elseif ($protected.Count -gt 0) {
        $okCount += (Remove-RegTreeExcept -Path $p -Protected $protected)
      } else {
        try { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop; $okCount++ } catch { $regFail++ }
      }
    }
    if ($regFail -eq 0) {
      $success++
      $msg = '注册表：已清理 ' + $okCount + ' 项'
      if ($recycle) { $msg = $msg + '（注册表不进回收站，已直接删除）' }
      $details += @{ id = $item.id; name = $item.name; status = 'ok'; freed = 0; message = $msg; residual = 0 }
    } elseif ($okCount -gt 0) {
      $failed++
      $details += @{ id = $item.id; name = $item.name; status = 'partial'; freed = 0; message = '注册表：清理 ' + $okCount + ' 项，失败 ' + $regFail + ' 项'; residual = 0 }
    } else {
      $failed++
      $details += @{ id = $item.id; name = $item.name; status = 'error'; freed = 0; message = '注册表：清理失败（可能需要管理员权限）'; residual = 0 }
    }
    continue
  }

  # ---- 目录型条目（pathPs）----
  if ($recycle) {
    # P3 回收站模式：整目录交给主进程移入回收站（跳过 Temp 重建/停服务等删除期特殊分支）
    if (-not (Test-Path -LiteralPath $item.path)) {
      $skipped++
      $details += @{ id = $item.id; name = $item.name; status = 'skip'; freed = 0; message = '路径不存在'; residual = 0 }
      continue
    }
    if ([string]$item.risk -eq 'high' -and -not $force) {
      $skipped++
      $details += @{ id = $item.id; name = $item.name; status = 'skip'; freed = 0; message = '高风险项需勾选强制删除'; residual = 0 }
      continue
    }
    $rsize = Get-PathSize -Path $item.path
    Write-Output ('@@RECYCLE@@' + (@{ id = $item.id; path = $item.path; size = $rsize; isDir = $true } | ConvertTo-Json -Compress))
    $details += @{ id = $item.id; name = $item.name; status = 'recycle'; freed = $rsize; message = '待移入回收站'; residual = 0 }
    continue
  }
  $result = Remove-PathSafely -Path $item.path -Force $force -Risk $item.risk
  $totalFreed += $result.freed
  # P3 残留复查：删除后仍存在的文件计数（'ok' 的重建目录应为 0）
  $residual = 0
  if (($result.status -eq 'ok' -or $result.status -eq 'partial') -and (Test-Path -LiteralPath $item.path)) {
    $residual = @(Get-ChildItem -LiteralPath $item.path -File -Recurse -Depth 6 -ErrorAction SilentlyContinue).Count
  }
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
    residual = $residual
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

// ==================== 条目明细脚本（P3 明细预览，只读枚举） ====================
// 输出协议：@@DETAIL@@ 元信息行（kind/total/truncated）+ @@ITEMFILE@@ 文件行（上限 600）。
// fileKeys 条目走规则快照；目录型优先用渲染层传入的「扫描时已解析路径」；注册表/DISM 仅返回元信息。
const DETAIL_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
${DIAG.PS_PREAMBLE}

$rulesJson = '\${DETAIL_RULES_JSON_PLACEHOLDER}'
$id = '\${DETAIL_ID_PLACEHOLDER}'
$targetPath = '\${DETAIL_PATH_PLACEHOLDER}'
$rules = ConvertFrom-Json -InputObject $rulesJson

$ruleMap = @{}
foreach ($g in $rules.groups) {
  if ($g.subGroups) { foreach ($sg in $g.subGroups) { foreach ($it in $sg.items) { $ruleMap[$it.id] = $it } } }
  elseif ($g.items) { foreach ($it in $g.items) { $ruleMap[$it.id] = $it } }
}

function Expand-EnvPath {
  param([string]$Path)
  return [regex]::Replace($Path, '%([^%]+)%', {
    param($m)
    $v = [Environment]::GetEnvironmentVariable($m.Groups[1].Value)
    if ($v) { $v } else { $m.Value }
  })
}

function Resolve-GlobDirs {
  param([string]$Pattern)
  $expanded = Expand-EnvPath $Pattern
  if (-not $expanded.Contains('*')) {
    if (Test-Path -LiteralPath $expanded -PathType Container) { return @($expanded) }
    return @()
  }
  $segments = @($expanded -split '[\\\\/]' | Where-Object { $_ })
  if ($segments.Count -eq 0) { return @() }
  $roots = @()
  $start = 0
  if ($segments[0].EndsWith(':')) { $roots = @($segments[0] + '\\'); $start = 1 }
  else { $roots = @('\\') }
  for ($i = $start; $i -lt $segments.Count; $i++) {
    $seg = $segments[$i]
    $next = New-Object System.Collections.Generic.List[string]
    foreach ($r in $roots) {
      if ($seg.Contains('*') -or $seg.Contains('?')) {
        foreach ($c in (Get-ChildItem -Path (Join-Path $r $seg) -Directory -Force -ErrorAction SilentlyContinue)) {
          if (-not ($c.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $next.Add($c.FullName) }
        }
      } else {
        $p = Join-Path $r $seg
        if (Test-Path -LiteralPath $p -PathType Container) { $next.Add($p) }
      }
    }
    $roots = @($next | Select-Object -Unique)
    if ($roots.Count -eq 0) { return @() }
  }
  return $roots
}

function Convert-RegPath {
  param([string]$RegPath)
  $idx = $RegPath.IndexOf('\\')
  if ($idx -lt 0) { return $null }
  $hive = $RegPath.Substring(0, $idx).ToUpperInvariant()
  $rest = $RegPath.Substring($idx + 1)
  $map = @{ HKCU = 'HKEY_CURRENT_USER'; HKLM = 'HKEY_LOCAL_MACHINE'; HKCR = 'HKEY_CLASSES_ROOT'; HKU = 'HKEY_USERS'; HKCC = 'HKEY_CURRENT_CONFIG' }
  if (-not $map.ContainsKey($hive)) { return $null }
  return ('Registry::' + $map[$hive] + '\\' + $rest)
}

function Get-FileKeySnapshot {
  param($Rule)
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  $exclDirs = @(); $exclFiles = @()
  foreach ($ex in @($Rule.excludeKeys)) {
    if (-not $ex -or -not $ex.path -or $ex.type -eq 'reg') { continue }
    $ep = (Expand-EnvPath ([string]$ex.path)).TrimEnd('\\')
    if ($ex.type -eq 'dir') { $exclDirs += $ep.ToLowerInvariant() }
    else { $exclFiles += $ep.ToLowerInvariant() }
  }
  $files = New-Object System.Collections.Generic.List[object]
  foreach ($fk in @($Rule.fileKeys)) {
    if (-not $fk -or -not $fk.path) { continue }
    $pattern = '*'; if ($fk.pattern) { $pattern = [string]$fk.pattern }
    $recurse = $true; if ($fk.recurse -eq $false) { $recurse = $false }
    foreach ($dir in (Resolve-GlobDirs ([string]$fk.path))) {
      $gciArgs = @{ LiteralPath = $dir; Filter = $pattern; File = $true; Force = $true; ErrorAction = 'SilentlyContinue' }
      if ($recurse) { $gciArgs.Recurse = $true; $gciArgs.Depth = 24 }
      foreach ($f in (Get-ChildItem @gciArgs)) {
        if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        $full = $f.FullName
        if (-not $seen.Add($full)) { continue }
        $low = $full.ToLowerInvariant()
        $skip = $false
        foreach ($d in $exclDirs) { if ($low.StartsWith($d + '\\')) { $skip = $true; break } }
        if (-not $skip) { foreach ($fe in $exclFiles) { if ($low -eq $fe) { $skip = $true; break } } }
        if ($skip) { continue }
        $files.Add([pscustomobject]@{ Path = $full; Size = [long]$f.Length })
      }
    }
  }
  return $files.ToArray()
}

$rule = $ruleMap[$id]
if (-not $rule) {
  Write-Output ('@@DETAIL@@' + (@{ kind = 'none'; total = 0; truncated = $false } | ConvertTo-Json -Compress))
  exit
}
if ($rule.special -eq 'dism') {
  Write-Output ('@@DETAIL@@' + (@{ kind = 'dism'; total = 0; truncated = $false } | ConvertTo-Json -Compress))
  exit
}
if ($rule.regKeys -and @($rule.regKeys).Count -gt 0) {
  $count = 0
  foreach ($rk in @($rule.regKeys)) {
    if (-not $rk -or -not $rk.path) { continue }
    $p = Convert-RegPath (Expand-EnvPath ([string]$rk.path))
    if (-not $p -or -not (Test-Path -LiteralPath $p)) { continue }
    $count++
    if ($rk.value) { continue }
    $key = Get-Item -LiteralPath $p -ErrorAction SilentlyContinue
    if ($key) {
      $count += @($key.GetValueNames()).Count
      $count += @(Get-ChildItem -LiteralPath $p -ErrorAction SilentlyContinue).Count
    }
  }
  Write-Output ('@@DETAIL@@' + (@{ kind = 'reg'; total = $count; truncated = $false } | ConvertTo-Json -Compress))
  exit
}

$cap = 600
$total = 0
$emitted = 0
if ($rule.fileKeys -and @($rule.fileKeys).Count -gt 0) {
  $snap = @(Get-FileKeySnapshot -Rule $rule)
  foreach ($f in $snap) {
    $total++
    if ($emitted -lt $cap) {
      $emitted++
      Write-Output ('@@ITEMFILE@@' + (@{ path = $f.Path; size = $f.Size } | ConvertTo-Json -Compress))
    }
  }
  Write-Output ('@@DETAIL@@' + (@{ kind = 'files'; total = $total; truncated = ($total -gt $cap) } | ConvertTo-Json -Compress))
  exit
}

# 目录型：优先用扫描时已解析的路径（渲染层传入），否则回退求值 pathPs
$p = $targetPath
if (-not $p) {
  try { $p = [string](Invoke-Expression ([string]$rule.pathPs)) } catch { $p = '' }
}
if (-not $p -or -not (Test-Path -LiteralPath $p)) {
  Write-Output ('@@DETAIL@@' + (@{ kind = 'files'; total = 0; truncated = $false } | ConvertTo-Json -Compress))
  exit
}
foreach ($f in (Get-ChildItem -LiteralPath $p -File -Recurse -Depth 24 -Force -ErrorAction SilentlyContinue)) {
  if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
  $total++
  if ($emitted -lt $cap) {
    $emitted++
    Write-Output ('@@ITEMFILE@@' + (@{ path = $f.FullName; size = [long]$f.Length } | ConvertTo-Json -Compress))
  }
}
Write-Output ('@@DETAIL@@' + (@{ kind = 'files'; total = $total; truncated = ($total -gt $cap) } | ConvertTo-Json -Compress))
`;

module.exports = {
  scan(categories, configuredPaths = {}) {
    const catsJson = psEscapeSingle(JSON.stringify(categories || []));
    const pathsJson = psEscapeSingle(JSON.stringify(configuredPaths || {}));
    const rulesJson = psEscapeSingle(JSON.stringify(loadRules()));
    return SCAN_SCRIPT
      .replace('\u0024{CATEGORIES_PLACEHOLDER}', () => catsJson)
      .replace('\u0024{CONFIGURED_PATHS_PLACEHOLDER}', () => pathsJson)
      .replace('\u0024{RULES_JSON_PLACEHOLDER}', () => rulesJson);
  },
  execute(items, force, toRecycle = false) {
    const itemsJson = psEscapeSingle(JSON.stringify(items || []));
    const rulesJson = psEscapeSingle(JSON.stringify(loadRules()));
    return EXECUTE_SCRIPT
      .replace('\u0024{FORCE_PLACEHOLDER}', () => (force ? '$true' : '$false'))
      .replace('\u0024{RECYCLE_PLACEHOLDER}', () => (toRecycle ? '$true' : '$false'))
      .replace('\u0024{ITEMS_PLACEHOLDER}', () => itemsJson)
      .replace('\u0024{RULES_JSON_PLACEHOLDER}', () => rulesJson);
  },
  // 供渲染层通过 IPC 读取的清理规则原始数据（P1-9 数据化：唯一数据源）
  rules() {
    return loadRules();
  },
  // 在线更新（P2）：数据目录规则所在目录（主进程写入目标）
  dataRulesDir() {
    return DATA_RULES_DIR;
  },
  // 条目明细（P3）：枚举单个条目将删除的文件清单（只读）；resolvedPath 为扫描时已解析的目录
  detail(id, resolvedPath = '') {
    const rulesJson = psEscapeSingle(JSON.stringify(loadRules()));
    return DETAIL_SCRIPT
      .replace('\u0024{DETAIL_ID_PLACEHOLDER}', () => psEscapeSingle(String(id || '')))
      .replace('\u0024{DETAIL_PATH_PLACEHOLDER}', () => psEscapeSingle(String(resolvedPath || '')))
      .replace('\u0024{DETAIL_RULES_JSON_PLACEHOLDER}', () => rulesJson);
  }
};
