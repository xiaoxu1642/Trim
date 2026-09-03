// overview-scripts.js - 系统概览实时指标采集（仅读取本机信息，不访问网络）
// CPU：PerfFormattedData 瞬时占用；内存：Win32_OperatingSystem 可见内存
// 磁盘：Win32_LogicalDisk 固定盘（DriveType=3）；开机时长：(当前时间 - LastBootUpTime)
const OVERVIEW_METRICS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

$os = Get-CimInstance Win32_OperatingSystem
$cpu = if ($os) { (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'") } else { $null }
$cpuLoad = 0.0
if ($cpu -and $null -ne $cpu.PercentProcessorTime) {
  $cpuLoad = [Math]::Round([double]$cpu.PercentProcessorTime, 1)
  if ($cpuLoad -lt 0) { $cpuLoad = 0 }
  if ($cpuLoad -gt 100) { $cpuLoad = 100 }
}

# 内存（KB）
$memTotalKB = 0.0
$memFreeKB = 0.0
if ($os) {
  $memTotalKB = [double]$os.TotalVisibleMemorySize
  $memFreeKB = [double]$os.FreePhysicalMemory
}
$memUsedKB = $memTotalKB - $memFreeKB
$memPercent = if ($memTotalKB -gt 0) { [Math]::Round($memUsedKB * 100.0 / $memTotalKB, 1) } else { 0 }
if ($memPercent -lt 0) { $memPercent = 0 }; if ($memPercent -gt 100) { $memPercent = 100 }

# 磁盘（固定盘）
$disks = @()
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3' | ForEach-Object {
  $total = [double]$_.Size
  $free = [double]$_.FreeSpace
  $used = $total - $free
  $percent = if ($total -gt 0) { [Math]::Round($used * 100.0 / $total, 1) } else { 0 }
  if ($percent -lt 0) { $percent = 0 }; if ($percent -gt 100) { $percent = 100 }
  $disks += @{
    name = [string]$_.DeviceID
    label = [string]$_.VolumeName
    total = $total
    free = $free
    used = $used
    percent = $percent
  }
}

# 开机时长
$uptimeText = '--'
if ($os -and $os.LastBootUpTime) {
  $span = (Get-Date) - $os.LastBootUpTime
  $days = [Math]::Floor($span.TotalDays)
  $hours = $span.Hours
  $mins = $span.Minutes
  if ($days -gt 0) { $uptimeText = "$days 天 $hours 小时 $mins 分钟" }
  elseif ($hours -gt 0) { $uptimeText = "$hours 小时 $mins 分钟" }
  else { $uptimeText = "$mins 分钟" }
}

$processCount = @(Get-Process -ErrorAction SilentlyContinue).Count

@{
  success = $true
  cpu = $cpuLoad
  memory = @{ total = $memTotalKB * 1KB; free = $memFreeKB * 1KB; used = $memUsedKB * 1KB; percent = $memPercent }
  disks = $disks
  uptime = $uptimeText
  processes = $processCount
  system = @{
    caption = [string]$os.Caption
    version = [string]$os.Version
    build = [string]$os.BuildNumber
    computerName = [string]$env:COMPUTERNAME
    userName = [string]$env:USERNAME
  }
} | ConvertTo-Json -Compress -Depth 6
`;

module.exports = { metrics() { return OVERVIEW_METRICS_SCRIPT; } };
