// defaultapps-scripts.js - 默认应用接管（v3.0）
// 三条路径的 PowerShell 片段源（数据即白名单：渲染层只传受支持的 key/progId，
// 命令原文全部在本文件生成，渲染层不可注入任何字符串）。
//   A 引导：纯渲染层 ms-settings:defaultapps（不经本文件）
//   B 策略 XML：DefaultAssociationsConfiguration（官方机制，免重启，需管理员写 HKLM 策略键）
//   C 专家模式：临时禁 UCPD + 类级关联写入（删 UserChoice + 写 HKCU\Software\Classes 类级默认
//     ProgId，零哈希）。机制依据：哈希校验只作用于 UserChoice 键；UserChoice 删除后
//     Explorer 回退到类级默认。已知边界：http/https 属系统强保护，类级关联可能不生效
//     （页面如实标注）；.pdf/.html 等文件类型可靠。
// 约束（照 test-features 断言）：PS 片段禁反引号、禁模板字符串 ${、注释不带反斜杠。

const DIAG = require('../main/diag');

// 受支持的接管目标（key 白名单：超出此集合的请求一律拒绝）
const TARGETS = [
  { key: 'http', kind: 'protocol', label: 'HTTP 协议', hint: '网页链接打开方式' },
  { key: 'https', kind: 'protocol', label: 'HTTPS 协议', hint: '安全网页链接打开方式' },
  { key: '.html', kind: 'extension', label: '.html 文件', hint: '本地 HTML 文件打开方式' },
  { key: '.pdf', kind: 'extension', label: '.pdf 文件', hint: 'PDF 文档打开方式' }
];

// UserChoice 注册表路径（与 PS 侧拼装保持同源）
function userChoicePath(key, kind) {
  if (kind === 'protocol') {
    return 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\' + key + '\\UserChoice';
  }
  return 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\' + key + '\\UserChoice';
}

// 渲染层传入项校验：key 必须在 TARGETS 内；progId 限注册表 ProgId 字符集
function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > TARGETS.length) {
    throw new Error('接管项列表不合法');
  }
  const known = new Map(TARGETS.map(t => [t.key, t]));
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') throw new Error('接管项格式不合法');
    const t = known.get(e.key);
    if (!t) throw new Error('不支持的接管目标: ' + String(e.key));
    if (typeof e.progId !== 'string' || e.progId.length < 1 || e.progId.length > 160) {
      throw new Error('ProgId 不合法: ' + String(e.progId));
    }
    if (!/^[\w.\-\\ ]+$/.test(e.progId)) throw new Error('ProgId 含非法字符: ' + e.progId);
    out.push({ key: t.key, kind: t.kind, progId: e.progId });
  }
  return out;
}

// ==================== 公共 header（诊断四元组 + UTF-8 输出） ====================
const HEADER = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
`;

// PS 片段内联 JSON 载荷：单引号包裹，内部单引号按 PS 规则翻倍
function psPayload(obj) {
  return JSON.stringify(obj).replace(/'/g, "''");
}

// ==================== 状态查询（只读） ====================
function status() {
  return HEADER + DIAG.PS_PREAMBLE + `
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$targets = @()
$defs = @(
  @{ key = 'http'; kind = 'protocol' },
  @{ key = 'https'; kind = 'protocol' },
  @{ key = '.html'; kind = 'extension' },
  @{ key = '.pdf'; kind = 'extension' }
)
foreach ($d in $defs) {
  $p = ''
  if ($d.kind -eq 'protocol') {
    $p = 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\' + $d.key + '\\UserChoice'
  } else {
    $p = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\' + $d.key + '\\UserChoice'
  }
  $progId = $null
  $item = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue
  if ($item) { $progId = $item.ProgId }
  # 类级默认（专家模式类级关联写入生效的位置；UserChoice 缺失时它才是实际生效的关联）
  $clsDefault = $null
  $clsItem = Get-Item -Path ('HKCU:\\Software\\Classes\\' + $d.key) -ErrorAction SilentlyContinue
  if ($clsItem) {
    $v = $clsItem.GetValue('')
    if ($v) { $clsDefault = [string]$v }
  }
  $targets += @{ key = $d.key; kind = $d.kind; progId = $progId; classDefault = $clsDefault }
}

$ucpdStart = $null
$svc = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\UCPD' -Name Start -ErrorAction SilentlyContinue
if ($svc) { $ucpdStart = [int]$svc.Start }
$taskState = $null
$task = Get-ScheduledTask -TaskPath '\\Microsoft\\Windows\\AppxDeploymentClient\\' -TaskName 'UCPD velocity' -ErrorAction SilentlyContinue
if ($task) { $taskState = [string]$task.State }

$policyPath = $null
$pol = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System' -Name DefaultAssociationsConfiguration -ErrorAction SilentlyContinue
if ($pol) { $policyPath = [string]$pol.DefaultAssociationsConfiguration }

$out = @{ isAdmin = $isAdmin; ucpdStart = $ucpdStart; ucpdTaskState = $taskState; policyPath = $policyPath; targets = $targets }
Write-Output ($out | ConvertTo-Json -Compress -Depth 4)
`;
}

// ==================== ProgId 枚举（只读） ====================
function listPrograms() {
  return HEADER + DIAG.PS_PREAMBLE + `
# 浏览器：StartMenuInternet 客户端自带 http ProgId 与显示名（最可靠的浏览器枚举源）
$browse = @{}
$roots = @('HKLM:\\SOFTWARE\\Clients\\StartMenuInternet', 'HKCU:\\SOFTWARE\\Clients\\StartMenuInternet')
foreach ($root in $roots) {
  $clients = Get-ChildItem -Path $root -ErrorAction SilentlyContinue
  foreach ($c in $clients) {
    $name = (Get-ItemProperty -Path $c.PSPath -ErrorAction SilentlyContinue).'(default)'
    if (-not $name) { $name = $c.PSChildName }
    $urlAssoc = Get-ItemProperty -Path ($c.PSPath + '\\Capabilities\\URLAssociations') -ErrorAction SilentlyContinue
    if ($urlAssoc -and $urlAssoc.http) {
      $httpProg = [string]$urlAssoc.http
      $cur = $browse[$httpProg]
      if (-not $cur) {
        $covers = @('http')
        if ($urlAssoc.https) { $covers = @('http', 'https') }
        $browse[$httpProg] = @{ progId = $httpProg; name = [string]$name; covers = $covers }
      }
    }
  }
}

# FriendlyTypeName / 间接字符串解析（失败回退 ProgId 原文）
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class IndirectString {
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  private static extern int SHLoadIndirectString(string pszSource, StringBuilder pszOut, int cchOut, IntPtr ppvReserved);
  public static string Load(string source) {
    StringBuilder sb = new StringBuilder(512);
    int hr = SHLoadIndirectString(source, sb, 512, IntPtr.Zero);
    if (hr == 0) { return sb.ToString(); }
    return source;
  }
}
"@

function Resolve-Name([string]$progId, [string]$raw) {
  if ($raw -and $raw -ne '') {
    if ($raw.StartsWith('@')) {
      try { return [IndirectString]::Load($raw) } catch { return $progId }
    }
    return $raw
  }
  return $progId
}

# 扩展名候选：OpenWithProgids 全量 + 有效性校验（shell open command 存在）
function Get-ExtCandidates([string]$ext) {
  $ids = @()
  foreach ($root in @('HKLM:\\SOFTWARE\\Classes', 'HKCU:\\SOFTWARE\\Classes')) {
    $owp = Get-Item -Path (Join-Path $root ($ext + '\\OpenWithProgids')) -ErrorAction SilentlyContinue
    if ($owp) {
      foreach ($p in $owp.Property) { if ($p -and ($ids -notcontains $p)) { $ids += $p } }
    }
  }
  $out = @()
  foreach ($id in $ids) {
    $valid = $false
    $rawName = $null
    foreach ($root in @('HKLM:\\SOFTWARE\\Classes', 'HKCU:\\SOFTWARE\\Classes')) {
      $base = Join-Path $root $id
      if (Test-Path (Join-Path $base 'shell\\open\\command')) { $valid = $true }
      if (-not $rawName) {
        $it = Get-ItemProperty -Path $base -ErrorAction SilentlyContinue
        if ($it -and $it.FriendlyTypeName) { $rawName = [string]$it.FriendlyTypeName }
      }
    }
    if ($valid) { $out += @{ progId = $id; name = (Resolve-Name $id $rawName) } }
  }
  return ,$out
}

$pdfList = Get-ExtCandidates '.pdf'
$htmlList = Get-ExtCandidates '.html'

$out = @{
  protocol = @($browse.Values | ForEach-Object { $_ })
  extensionPdf = $pdfList
  extensionHtml = $htmlList
}
Write-Output ($out | ConvertTo-Json -Compress -Depth 5)
`;
}

// ==================== B 路径：策略 XML（写 HKLM 策略键，需管理员） ====================
function applyXml(xmlPath) {
  // xmlPath 由主进程生成（数据目录内），不来自渲染层
  const safe = String(xmlPath).replace(/'/g, "''");
  return HEADER + DIAG.PS_PREAMBLE + `
$key = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System'
$xml = '${safe}'
New-Item -Path $key -Force -ErrorAction SilentlyContinue | Out-Null
Set-ItemProperty -Path $key -Name DefaultAssociationsConfiguration -Value $xml -Type String -Force -ErrorAction Stop
$check = (Get-ItemProperty -Path $key -Name DefaultAssociationsConfiguration -ErrorAction SilentlyContinue).DefaultAssociationsConfiguration
if ($check -eq $xml) {
  Write-Output (@{ ok = $true; applied = $check } | ConvertTo-Json -Compress)
} else {
  Write-Output (@{ ok = $false; message = '策略键写入后校验不一致' } | ConvertTo-Json -Compress)
}
`;
}

function removeXmlPolicy() {
  return HEADER + DIAG.PS_PREAMBLE + `
$key = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System'
Remove-ItemProperty -Path $key -Name DefaultAssociationsConfiguration -Force -ErrorAction SilentlyContinue
Write-Output (@{ ok = $true } | ConvertTo-Json -Compress)
`;
}

// ==================== C 路径：UCPD 驱动与 velocity 任务 ====================
function setUcpd(disable, originalStart) {
  // originalStart：主进程状态机记录的原 Start 值（2=自动 3=手动），恢复用；禁用恒 4
  const start = disable ? 4 : (Number(originalStart) === 3 ? 3 : 2);
  const op = disable ? 'Disable' : 'Enable';
  return HEADER + DIAG.PS_PREAMBLE + `
# UCPD（用户选择保护驱动）+ velocity 计划任务必须同时处理：任务会在登录时把驱动 Start 复位并重启服务
sc.exe config UCPD start= ${start} | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Output (@{ ok = $false; message = 'sc.exe 配置 UCPD 失败，可能需要管理员权限' } | ConvertTo-Json -Compress)
  exit 0
}
schtasks /Change /${op} /TN '\\Microsoft\\Windows\\AppxDeploymentClient\\UCPD velocity' | Out-Null
$read = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\UCPD' -Name Start -ErrorAction SilentlyContinue).Start
Write-Output (@{ ok = ($read -eq ${start}); start = [int]$read } | ConvertTo-Json -Compress)
`;
}

// ==================== C 路径：类级关联写入（零哈希） ====================
// 前提：UCPD 已禁用（主进程 fail-closed 校验 Start==4 后才会调用），否则删除 UserChoice
// 会被内核过滤驱动拦截。写入后 Explorer 在 UserChoice 缺失时回退到类级默认 ProgId。
function writeClass(entries) {
  const payload = psPayload(entries);
  return HEADER + DIAG.PS_PREAMBLE + `
$entries = ConvertFrom-Json ('${payload}')

$results = @()
foreach ($e in $entries) {
  $key = [string]$e.key
  $kind = [string]$e.kind
  $progId = [string]$e.progId
  $ucPath = ''
  if ($kind -eq 'protocol') {
    $ucPath = 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\' + $key + '\\UserChoice'
  } else {
    $ucPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\' + $key + '\\UserChoice'
  }
  $clsKey = 'HKEY_CURRENT_USER\\Software\\Classes\\' + $key

  try {
    # 1) 删除 UserChoice（UCPD 禁用期间才可能成功）；普通删除被拦截时用 reg.exe 兜底
    if (Test-Path $ucPath) {
      Remove-Item -Path $ucPath -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path $ucPath) {
        $plain = $ucPath -replace '^HKCU:\\\\', 'HKCU\\\\'
        reg.exe delete $plain /f 2>$null | Out-Null
      }
    }
    if (Test-Path $ucPath) {
      $results += @{ key = $key; ok = $false; message = 'UserChoice 删除失败（UCPD 保护可能仍生效，请确认已重启）' }
      continue
    }

    # 2) 写类级默认 ProgId（(default) 空名即默认值；协议补 URL Protocol 空串标记）
    [Microsoft.Win32.Registry]::SetValue($clsKey, '', $progId, [Microsoft.Win32.RegistryValueKind]::String)
    if ($kind -eq 'protocol') {
      [Microsoft.Win32.Registry]::SetValue($clsKey, 'URL Protocol', '', [Microsoft.Win32.RegistryValueKind]::String)
    }

    # 3) OpenWithProgids 挂上该 ProgId（保证「打开方式」列表完整）+ 抑制「保持使用此应用」提示
    [Microsoft.Win32.Registry]::SetValue($clsKey + '\\OpenWithProgids', $progId, ([byte[]]@()), [Microsoft.Win32.RegistryValueKind]::None) | Out-Null
    Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ApplicationAssociationToasts' -Name ($progId + '_' + $key) -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue
  } catch {
    $results += @{ key = $key; ok = $false; message = ('写入失败: ' + $_.Exception.Message) }
    continue
  }

  $clsRead = Get-Item -Path ('HKCU:\\Software\\Classes\\' + $key) -ErrorAction SilentlyContinue
  $back = if ($clsRead) { [string]$clsRead.GetValue('') } else { '' }
  $ucGone = -not (Test-Path $ucPath)
  $results += @{ key = $key; ok = (($back -eq $progId) -and $ucGone); classDefault = $back }
}

# 通知 shell 刷新关联缓存
try {
  Add-Type -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);' -Namespace WinAPI -Name Shell
  [WinAPI.Shell]::SHChangeNotify(0x8000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
} catch { }

Write-Output ($results | ConvertTo-Json -Compress -Depth 4)
`;
}

module.exports = { TARGETS, status, listPrograms, applyXml, removeXmlPolicy, setUcpd, writeClass, validateEntries };
