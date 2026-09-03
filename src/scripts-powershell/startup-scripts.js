// startup-scripts.js - 启动项管理（扫描 / 启停 / 删除）
// 数据源：
//   1. 注册表 Run / RunOnce（HKCU、HKLM、HKLM 32 位视图）
//   2. 启动文件夹（当前用户 + 所有用户）
//   3. 计划任务（登录/开机触发器，排除 Microsoft 系统任务）
// 可逆启停：
//   - 注册表项：将值（含类型与数据）备份到 disabled.json 后删除；启用时按记录回写
//   - 文件夹项：移动到备份目录；启用时移动回原路径
//   - 计划任务：Disable-ScheduledTask / Enable-ScheduledTask（任务本身保留，无需记录）
// 删除：先备份到 deleted 目录（注册表 reg.exe 全键导出 / 文件夹复制 / 计划任务导出 XML）再删除
// 备份目录：%APPDATA%\TuneForge\startup-backup\

const DIAG = require('../diag');

const SCAN_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

$backupDir = Join-Path $env:APPDATA 'TuneForge\\startup-backup'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$disabledFile = Join-Path $backupDir 'disabled.json'

$results = @()

# ---- 辅助：从命令行提取可执行路径（支持引号包裹与参数）----
function Get-CmdPath([string]$cmd) {
  if ([string]::IsNullOrWhiteSpace($cmd)) { return '' }
  $c = $cmd.Trim()
  if ($c.StartsWith('"')) {
    $idx = $c.IndexOf('"', 1)
    if ($idx -gt 0) { return $c.Substring(1, $idx - 1) }
  }
  $sp = $c.IndexOf(' ')
  if ($sp -gt 0) { return $c.Substring(0, $sp) }
  return $c
}
# ---- 辅助：取文件发布者（CompanyName）----
function Get-Publisher([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return '' }
  try {
    $vi = (Get-Item -LiteralPath $path -ErrorAction SilentlyContinue).VersionInfo
    if ($vi -and -not [string]::IsNullOrWhiteSpace([string]$vi.CompanyName)) { return [string]$vi.CompanyName }
  } catch {}
  return ''
}
# ---- 辅助：解析 .lnk 快捷方式目标路径 ----
$script:wshShell = $null
function Resolve-Lnk([string]$lnkPath) {
  if ([string]::IsNullOrWhiteSpace($lnkPath)) { return '' }
  try {
    if (-not $script:wshShell) { $script:wshShell = New-Object -ComObject WScript.Shell }
    $sc = $script:wshShell.CreateShortcut($lnkPath)
    if ($sc -and -not [string]::IsNullOrWhiteSpace([string]$sc.TargetPath)) { return [string]$sc.TargetPath }
  } catch {}
  return ''
}

# ---------- 注册表 Run / RunOnce（含 32/64 位视图） ----------
$runPaths = @(
  @{ hive = 'HKCU'; path = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; label = '注册表 · 当前用户\\Run' },
  @{ hive = 'HKCU'; path = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'; label = '注册表 · 当前用户\\RunOnce' },
  @{ hive = 'HKCU32'; path = 'HKEY_CURRENT_USER\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; label = '注册表 · 当前用户(32位)\\Run' },
  @{ hive = 'HKCU32'; path = 'HKEY_CURRENT_USER\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\RunOnce'; label = '注册表 · 当前用户(32位)\\RunOnce' },
  @{ hive = 'HKLM'; path = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'; label = '注册表 · 所有用户\\Run' },
  @{ hive = 'HKLM'; path = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce'; label = '注册表 · 所有用户\\RunOnce' },
  @{ hive = 'HKLM32'; path = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; label = '注册表 · 所有用户(32位)\\Run' },
  @{ hive = 'HKLM32'; path = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\RunOnce'; label = '注册表 · 所有用户(32位)\\RunOnce' }
)

foreach ($rp in $runPaths) {
  $regKey = 'Registry::' + $rp.path
  if (-not (Test-Path -LiteralPath $regKey)) { continue }
  $key = Get-Item -LiteralPath $regKey
  foreach ($vp in $key.GetValueNames()) {
    if ([string]::IsNullOrWhiteSpace($vp)) { continue }
    $kind = $key.GetValueKind($vp)
    $data = $key.GetValue($vp)
    if ($kind -eq 'String' -and [string]::IsNullOrWhiteSpace([string]$data)) { continue }
    $id = 'reg|' + $rp.path + '|' + $vp
    $vData = ''
    $vDataB64 = ''
    $vDataArr = @()
    if ($kind -eq 'Binary') { $vDataB64 = [Convert]::ToBase64String([byte[]]$data) }
    elseif ($kind -eq 'MultiString') { $vDataArr = @([string[]]$data) }
    else { $vData = [string]$data }
    $cmdPath = ''
    if ($kind -eq 'String' -or $kind -eq 'ExpandString') {
      $cmdPath = Get-CmdPath ([Environment]::ExpandEnvironmentVariables([string]$data))
    }
    $results += [pscustomobject]@{
      id = $id; name = $vp; command = [string]$data; source = 'registry';
      hive = $rp.hive; regPath = $rp.path; valueName = $vp; valueType = $kind.ToString();
      valueData = $vData; valueDataB64 = $vDataB64; valueDataArray = @($vDataArr);
      filePath = ''; taskPath = ''; taskName = '';
      enabled = $true; location = $rp.label; scope = $rp.hive;
      publisher = (Get-Publisher $cmdPath); resolvedPath = $cmdPath
    }
  }
}

# ---------- 启动文件夹 ----------
$folders = @(
  @{ path = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'; label = '启动文件夹 · 当前用户'; scope = 'HKCU' },
  @{ path = Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs\\StartUp'; label = '启动文件夹 · 所有用户'; scope = 'HKLM' }
)

foreach ($f in $folders) {
  if (-not (Test-Path -LiteralPath $f.path)) { continue }
  Get-ChildItem -LiteralPath $f.path -Force -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -ieq 'desktop.ini') { return }
    $id = 'folder|' + $_.FullName
    $lnkTarget = ''
    if ($_.Extension -ieq '.lnk') { $lnkTarget = Resolve-Lnk $_.FullName }
    $pubPath = if ($lnkTarget) { $lnkTarget } else { $_.FullName }
    $results += [pscustomobject]@{
      id = $id; name = [IO.Path]::GetFileNameWithoutExtension($_.Name); command = $_.FullName; source = 'folder';
      hive = $f.scope; regPath = ''; valueName = ''; valueType = '';
      valueData = ''; valueDataB64 = ''; valueDataArray = @();
      filePath = $_.FullName; taskPath = ''; taskName = '';
      enabled = $true; location = $f.label; scope = $f.scope;
      publisher = (Get-Publisher $pubPath); resolvedPath = $(if ($lnkTarget) { $lnkTarget } else { $_.FullName })
    }
  }
}

# ---------- 计划任务（登录/开机触发器，排除 Microsoft 系统任务） ----------
$allTasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' })
foreach ($t in $allTasks) {
  $triggers = @($t.Triggers)
  $hasLogon = @($triggers | Where-Object { ($_.CimClass.CimClassName -like '*Logon*') -or ($_.CimClass.CimClassName -like '*Boot*') }).Count -gt 0
  if (-not $hasLogon) { continue }
  $actions = @($t.Actions | ForEach-Object { if ($_.Execute) { (($_.Execute + ' ' + $_.Arguments).Trim()) } }) | Where-Object { $_ }
  $command = ($actions -join '  |  ')
  $taskName = [string]$t.TaskName
  $taskPath = [string]$t.TaskPath
  $id = 'task|' + $taskPath + $taskName
  $enabled = ($t.State -ne 'Disabled')
  $results += [pscustomobject]@{
    id = $id; name = $taskName; command = $command; source = 'task';
    hive = ''; regPath = ''; valueName = ''; valueType = '';
    valueData = ''; valueDataB64 = ''; valueDataArray = @();
    filePath = ''; taskPath = $taskPath; taskName = $taskName;
    enabled = $enabled; location = '计划任务' + $taskPath.TrimEnd('\\'); scope = 'HKLM';
    publisher = ''; resolvedPath = ''
  }
}

# ---------- 合并已禁用记录（注册表/文件夹项被移除后仍可回显并启用） ----------
if (Test-Path -LiteralPath $disabledFile) {
  try { $records = @(Get-Content -LiteralPath $disabledFile -Raw -Encoding UTF8 | ConvertFrom-Json) }
  catch { $records = @() }
  foreach ($r in $records) {
    if (-not $r.id) { continue }
    if (@($results | Where-Object { $_.id -eq $r.id }).Count -gt 0) { continue }
    $results += [pscustomobject]@{
      id = $r.id; name = $r.name; command = $r.command; source = $r.source;
      hive = $r.hive; regPath = $r.regPath; valueName = $r.valueName; valueType = $r.valueType;
      valueData = $r.valueData; valueDataB64 = $r.valueDataB64; valueDataArray = @($r.valueDataArray);
      filePath = $r.filePath; taskPath = $r.taskPath; taskName = $r.taskName;
      enabled = $false; location = $r.location; scope = $r.scope;
      publisher = $r.publisher; resolvedPath = $r.resolvedPath
    }
  }
}

if (@($results).Count -eq 0) { '[]' }
else { @($results) | ConvertTo-Json -Depth 8 -Compress }
`;

// ---------- 启停脚本 ----------
// __ENABLE__ 为 true/false；__ITEMS_JSON__ 为条目数组
const TOGGLE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
${DIAG.PS_PREAMBLE}

$backupDir = Join-Path $env:APPDATA 'TuneForge\\startup-backup'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$disabledFile = Join-Path $backupDir 'disabled.json'
$filesDir = Join-Path $backupDir 'files'
New-Item -ItemType Directory -Path $filesDir -Force | Out-Null

$enable = __ENABLE__
$items = '__ITEMS_JSON__' | ConvertFrom-Json
$results = @()
$success = 0
$failed = 0

# 读取已禁用记录
$records = @()
if (Test-Path -LiteralPath $disabledFile) {
  try { $records = @(Get-Content -LiteralPath $disabledFile -Raw -Encoding UTF8 | ConvertFrom-Json) }
  catch { $records = @() }
}
$records = @($records | Where-Object { $_ })

function Save-Records {
  if (@($records).Count -eq 0) {
    Remove-Item -LiteralPath $disabledFile -Force -ErrorAction SilentlyContinue
  } else {
    @($records) | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $disabledFile -Encoding UTF8
  }
}

foreach ($item in @($items)) {
  $id = [string]$item.id
  $name = [string]$item.name
  $source = [string]$item.source
  try {
    if ($source -eq 'registry') {
      $regPath = 'Registry::' + [string]$item.regPath
      $vp = [string]$item.valueName
      if ($enable) {
        # 启用：查找记录回写
        $rec = @($records | Where-Object { $_.id -eq $id }) | Select-Object -First 1
        if (-not $rec) {
          # 无记录：若值已存在则视为已启用
          if ((Test-Path -LiteralPath $regPath) -and ($null -ne (Get-Item -LiteralPath $regPath).GetValue($vp))) {
            $success++; $results += @{ id = $id; name = $name; status = 'ok'; message = '已处于启用状态' }
          } else {
            $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '缺少启用记录' }
          }
          continue
        }
        if (-not (Test-Path -LiteralPath $regPath)) { New-Item -ItemType Directory -Path $regPath -Force | Out-Null }
        $pt = [Microsoft.Win32.RegistryValueKind]::String
        $kindStr = [string]$rec.valueType
        switch ($kindStr) {
          'ExpandString' { $pt = [Microsoft.Win32.RegistryValueKind]::ExpandString }
          'DWord' { $pt = [Microsoft.Win32.RegistryValueKind]::DWord }
          'QWord' { $pt = [Microsoft.Win32.RegistryValueKind]::QWord }
          'Binary' { $pt = [Microsoft.Win32.RegistryValueKind]::Binary }
          'MultiString' { $pt = [Microsoft.Win32.RegistryValueKind]::MultiString }
          'String' { $pt = [Microsoft.Win32.RegistryValueKind]::String }
          default { $pt = [Microsoft.Win32.RegistryValueKind]::String }
        }
        if ($kindStr -eq 'Binary') {
          $bytes = [Convert]::FromBase64String([string]$rec.valueDataB64)
          New-ItemProperty -LiteralPath $regPath -Name $vp -PropertyType $pt -Value $bytes -Force -ErrorAction Stop | Out-Null
        } elseif ($kindStr -eq 'MultiString') {
          New-ItemProperty -LiteralPath $regPath -Name $vp -PropertyType $pt -Value @([string[]]$rec.valueDataArray) -Force -ErrorAction Stop | Out-Null
        } elseif ($kindStr -eq 'DWord' -or $kindStr -eq 'QWord') {
          New-ItemProperty -LiteralPath $regPath -Name $vp -PropertyType $pt -Value ([int64][string]$rec.valueData) -Force -ErrorAction Stop | Out-Null
        } else {
          New-ItemProperty -LiteralPath $regPath -Name $vp -PropertyType $pt -Value ([string]$rec.valueData) -Force -ErrorAction Stop | Out-Null
        }
        # 校验
        $ok = (Test-Path -LiteralPath $regPath) -and ($null -ne (Get-Item -LiteralPath $regPath).GetValue($vp))
        if ($ok) {
          $records = @($records | Where-Object { $_.id -ne $id })
          Save-Records
          $success++; $results += @{ id = $id; name = $name; status = 'ok'; message = '已启用' }
        } else {
          $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '回写未生效（可能需要管理员权限）' }
        }
      } else {
        # 禁用：备份值到记录后删除
        if (-not (Test-Path -LiteralPath $regPath)) { $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '注册表路径不存在' }; continue }
        $key = Get-Item -LiteralPath $regPath
        if ($null -eq $key.GetValue($vp)) { $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '值不存在' }; continue }
        $kind = $key.GetValueKind($vp)
        $data = $key.GetValue($vp)
        $vData = ''; $vDataB64 = ''; $vDataArr = @()
        if ($kind -eq 'Binary') { $vDataB64 = [Convert]::ToBase64String([byte[]]$data) }
        elseif ($kind -eq 'MultiString') { $vDataArr = @([string[]]$data) }
        else { $vData = [string]$data }
        $rec = [pscustomobject]@{
          id = $id; name = $name; command = [string]$data; source = 'registry';
          hive = $item.hive; regPath = $item.regPath; valueName = $vp; valueType = $kind.ToString();
          valueData = $vData; valueDataB64 = $vDataB64; valueDataArray = @($vDataArr);
          filePath = ''; taskPath = ''; taskName = '';
          location = $item.location; scope = $item.scope;
          publisher = $item.publisher; resolvedPath = $item.resolvedPath
        }
        Remove-ItemProperty -LiteralPath $regPath -Name $vp -ErrorAction Stop
        if ($null -eq (Get-Item -LiteralPath $regPath).GetValue($vp)) {
          $records = @($records | Where-Object { $_.id -ne $id }) + @($rec)
          Save-Records
          $success++; $results += @{ id = $id; name = $name; status = 'ok'; message = '已禁用' }
        } else {
          $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '删除未生效（可能需要管理员权限）' }
        }
      }
      continue
    }

    if ($source -eq 'folder') {
      $filePath = [string]$item.filePath
      if ($enable) {
        $rec = @($records | Where-Object { $_.id -eq $id }) | Select-Object -First 1
        if (-not $rec) { $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '缺少启用记录' }; continue }
        $backupPath = [string]$rec.filePath
        $origPath = [string]$rec.valueData  # 记录里存原路径
        if (-not $origPath -or -not (Test-Path -LiteralPath $backupPath)) { $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '备份文件不存在' }; continue }
        $destDir = [IO.Path]::GetDirectoryName($origPath)
        if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
        Move-Item -LiteralPath $backupPath -Destination $origPath -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $origPath) {
          $records = @($records | Where-Object { $_.id -ne $id })
          Save-Records
          $success++; $results += @{ id = $id; name = $name; status = 'ok'; message = '已启用' }
        } else {
          $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '移回未生效' }
        }
      } else {
        if (-not (Test-Path -LiteralPath $filePath)) { $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '文件不存在' }; continue }
        $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
        $safeName = ($name -replace '[^\\w\\-\\u4e00-\\u9fa5]', '_')
        $dest = Join-Path $filesDir ($stamp + '_' + $safeName + [IO.Path]::GetExtension($filePath))
        Move-Item -LiteralPath $filePath -Destination $dest -Force -ErrorAction Stop
        $rec = [pscustomobject]@{
          id = $id; name = $name; command = $filePath; source = 'folder';
          hive = $item.hive; regPath = ''; valueName = ''; valueType = '';
          valueData = $filePath; valueDataB64 = ''; valueDataArray = @();
          filePath = $dest; taskPath = ''; taskName = '';
          location = $item.location; scope = $item.scope;
          publisher = $item.publisher; resolvedPath = $item.resolvedPath
        }
        $records = @($records | Where-Object { $_.id -ne $id }) + @($rec)
        Save-Records
        $success++; $results += @{ id = $id; name = $name; status = 'ok'; message = '已禁用' }
      }
      continue
    }

    if ($source -eq 'task') {
      $taskPath = [string]$item.taskPath
      $taskName = [string]$item.taskName
      if ([string]::IsNullOrWhiteSpace($taskName)) { $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '缺少任务名' }; continue }
      $fullName = $taskPath + $taskName
      $task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
      if (-not $task) { $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '计划任务不存在' }; continue }
      if ($enable) {
        if ($task.State -ne 'Disabled') { $success++; $results += @{ id = $id; name = $name; status = 'ok'; message = '已处于启用状态' }; continue }
        Enable-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop | Out-Null
        $state = (Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath).State
        if ($state -ne 'Disabled') { $success++; $results += @{ id = $id; name = $name; status = 'ok'; message = '已启用' } }
        else { $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '启用未生效（可能需要管理员权限）' } }
      } else {
        if ($task.State -eq 'Disabled') { $success++; $results += @{ id = $id; name = $name; status = 'ok'; message = '已处于禁用状态' }; continue }
        Disable-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop | Out-Null
        $state = (Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath).State
        if ($state -eq 'Disabled') { $success++; $results += @{ id = $id; name = $name; status = 'ok'; message = '已禁用' } }
        else { $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '禁用未生效（可能需要管理员权限）' } }
      }
      continue
    }

    $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '未知来源类型' }
  } catch {
    $failed++
    Write-TFDiag -Stage 'startup.mutate' -Mutation 'rolled_back' -Detail ($id + ' [' + $source + '] -> ' + $_.Exception.Message)
    $results += @{ id = $id; name = $name; status = 'error'; message = $_.Exception.Message }
  }
}

[pscustomobject]@{ success = $success; failed = $failed; results = @($results) } | ConvertTo-Json -Depth 6 -Compress
`;

// ---------- 删除脚本（先备份到 deleted 目录，再删除） ----------
const DELETE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
${DIAG.PS_PREAMBLE}

$backupDir = Join-Path $env:APPDATA 'TuneForge\\startup-backup'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$disabledFile = Join-Path $backupDir 'disabled.json'
$deletedDir = Join-Path $backupDir 'deleted'
New-Item -ItemType Directory -Path $deletedDir -Force | Out-Null

$items = '__ITEMS_JSON__' | ConvertFrom-Json
$results = @()
$success = 0
$failed = 0

$records = @()
if (Test-Path -LiteralPath $disabledFile) {
  try { $records = @(Get-Content -LiteralPath $disabledFile -Raw -Encoding UTF8 | ConvertFrom-Json) }
  catch { $records = @() }
}
$records = @($records | Where-Object { $_ })

foreach ($item in @($items)) {
  $id = [string]$item.id
  $name = [string]$item.name
  $source = [string]$item.source
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  try {
    if ($source -eq 'registry') {
      $stdPath = [string]$item.regPath
      $regPath = 'Registry::' + $stdPath
      $vp = [string]$item.valueName
      if (-not (Test-Path -LiteralPath $regPath)) { $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '注册表路径不存在' }; continue }
      # 备份整个键到 .reg（安全网）
      $safe = ($name -replace '[^\\w\\-\\u4e00-\\u9fa5]', '_')
      $regFile = Join-Path $deletedDir ($stamp + '_reg_' + $safe + '.reg')
      $stdPathEsc = $stdPath -replace 'HKEY_LOCAL_MACHINE', 'HKLM'
      $stdPathEsc = $stdPathEsc -replace 'HKEY_CURRENT_USER', 'HKCU'
      & reg.exe export $stdPathEsc "$regFile" /y | Out-Null
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $regFile)) {
        $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '注册表备份失败，未执行删除' }; continue
      }
      Remove-ItemProperty -LiteralPath $regPath -Name $vp -ErrorAction Stop
      if ($null -eq (Get-Item -LiteralPath $regPath).GetValue($vp)) {
        $records = @($records | Where-Object { $_.id -ne $id })
        if (@($records).Count -eq 0) { Remove-Item -LiteralPath $disabledFile -Force -ErrorAction SilentlyContinue }
        else { @($records) | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $disabledFile -Encoding UTF8 }
        $success++; $results += @{ id = $id; name = $name; status = 'ok'; message = '已删除（已备份注册表键）' }
      } else {
        $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '删除未生效（可能需要管理员权限）' }
      }
      continue
    }

    if ($source -eq 'folder') {
      $filePath = [string]$item.filePath
      # 若为已禁用记录，则从备份目录删除；否则备份到 deleted 再删
      $rec = @($records | Where-Object { $_.id -eq $id }) | Select-Object -First 1
      if ($rec -and $rec.filePath -and (Test-Path -LiteralPath $rec.filePath) -and -not (Test-Path -LiteralPath $filePath)) {
        Remove-Item -LiteralPath $rec.filePath -Force -ErrorAction Stop
        $records = @($records | Where-Object { $_.id -ne $id })
        if (@($records).Count -eq 0) { Remove-Item -LiteralPath $disabledFile -Force -ErrorAction SilentlyContinue }
        else { @($records) | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $disabledFile -Encoding UTF8 }
        $success++; $results += @{ id = $id; name = $name; status = 'ok'; message = '已删除备份文件' }
      } elseif (Test-Path -LiteralPath $filePath) {
        $safe = ($name -replace '[^\\w\\-\\u4e00-\\u9fa5]', '_')
        $dest = Join-Path $deletedDir ($stamp + '_folder_' + $safe + [IO.Path]::GetExtension($filePath))
        Copy-Item -LiteralPath $filePath -Destination $dest -Force -ErrorAction Stop
        Remove-Item -LiteralPath $filePath -Force -ErrorAction Stop
        $success++; $results += @{ id = $id; name = $name; status = 'ok'; message = '已删除（已备份文件）' }
      } else {
        $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '文件不存在' }
      }
      continue
    }

    if ($source -eq 'task') {
      $taskPath = [string]$item.taskPath
      $taskName = [string]$item.taskName
      if ([string]::IsNullOrWhiteSpace($taskName)) { $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '缺少任务名' }; continue }
      $task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
      if (-not $task) { $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '计划任务不存在' }; continue }
      $safe = ($taskName -replace '[^\\w\\-\\u4e00-\\u9fa5]', '_')
      $xmlFile = Join-Path $deletedDir ($stamp + '_task_' + $safe + '.xml')
      Export-ScheduledTask -TaskName $taskName -TaskPath $taskPath | Set-Content -LiteralPath $xmlFile -Encoding UTF8
      if (-not (Test-Path -LiteralPath $xmlFile)) {
        $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '计划任务备份失败，未执行删除' }; continue
      }
      Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
      if (-not (Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue)) {
        $success++; $results += @{ id = $id; name = $name; status = 'ok'; message = '已删除（已导出任务备份）' }
      } else {
        $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '删除未生效（可能需要管理员权限）' }
      }
      continue
    }

    $failed++; $results += @{ id = $id; name = $name; status = 'error'; message = '未知来源类型' }
  } catch {
    $failed++
    Write-TFDiag -Stage 'startup.mutate' -Mutation 'rolled_back' -Detail ($id + ' [' + $source + '] -> ' + $_.Exception.Message)
    $results += @{ id = $id; name = $name; status = 'error'; message = $_.Exception.Message }
  }
}

[pscustomobject]@{ success = $success; failed = $failed; results = @($results) } | ConvertTo-Json -Depth 6 -Compress
`;

// ---------- 添加启动项脚本（写入当前用户 Run 键） ----------
const ADD_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$path = '__PATH__'
$name = '__NAME__'
$runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
if (-not (Test-Path -LiteralPath $runKey)) { New-Item -ItemType Directory -Path $runKey -Force | Out-Null }
# 冲突检查：已存在同名启动项时返回原值，避免静默覆盖
$existing = $null
try { $existing = (Get-ItemProperty -LiteralPath $runKey -Name $name -ErrorAction SilentlyContinue).$name } catch {}
if ($null -ne $existing -and [string]$existing -ne '') {
  'EXISTS:' + [string]$existing
} else {
  New-ItemProperty -LiteralPath $runKey -Name $name -Value ('"' + $path + '"') -PropertyType String -Force | Out-Null
  'OK'
}
`;

module.exports = {
  scan() { return SCAN_SCRIPT; },
  // 添加启动项：将选定程序写入当前用户 Run 键
  add(filePath, name) {
    return ADD_SCRIPT
      .replace('__PATH__', String(filePath || '').replace(/'/g, "''"))
      .replace('__NAME__', String(name || '').replace(/'/g, "''"));
  },
  toggle(items, enable) {
    const json = JSON.stringify(Array.isArray(items) ? items : []).replace(/'/g, "''");
    return TOGGLE_SCRIPT
      .replace('__ENABLE__', enable ? 'true' : 'false')
      .replace('__ITEMS_JSON__', json);
  },
  remove(items) {
    const json = JSON.stringify(Array.isArray(items) ? items : []).replace(/'/g, "''");
    return DELETE_SCRIPT.replace('__ITEMS_JSON__', json);
  }
};
