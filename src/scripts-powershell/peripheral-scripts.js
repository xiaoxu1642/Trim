// 外设优化（更多调优项）注册表读写脚本
// 三组调优：
//   Win32PrioritySeparation  @ HKLM\SYSTEM\CurrentControlSet\Control\PriorityControl           （默认 2）
//   KeyboardDataQueueSize    @ HKLM\SYSTEM\CurrentControlSet\Services\kbdclass\Parameters      （默认 100）
//   MouseDataQueueSize       @ HKLM\SYSTEM\CurrentControlSet\Services\mouclass\Parameters      （默认 100）
// 注意：键鼠队列大小需重启电脑后生效。

const QUERY_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Get-TFDword([string]$p, [string]$n) {
  try { [int](Get-ItemPropertyValue -LiteralPath $p -Name $n -ErrorAction Stop) } catch { -1 }
}
[pscustomobject]@{
  win32 = Get-TFDword 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\PriorityControl' 'Win32PrioritySeparation'
  keyboard = Get-TFDword 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\kbdclass\\Parameters' 'KeyboardDataQueueSize'
  mouse = Get-TFDword 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\mouclass\\Parameters' 'MouseDataQueueSize'
} | ConvertTo-Json -Compress
`;

const APPLY_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$options = '__OPTIONS_JSON__' | ConvertFrom-Json
$targets = @(
  @{ Path = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\PriorityControl'; Name = 'Win32PrioritySeparation'; Value = [int]$options.win32 },
  @{ Path = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\kbdclass\\Parameters'; Name = 'KeyboardDataQueueSize'; Value = [int]$options.keyboard },
  @{ Path = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\mouclass\\Parameters'; Name = 'MouseDataQueueSize'; Value = [int]$options.mouse }
)
foreach ($t in $targets) {
  if ($t.Value -lt 0) { continue }
  if (-not (Test-Path $t.Path)) { New-Item -Path $t.Path -Force | Out-Null }
  Set-ItemProperty -Path $t.Path -Name $t.Name -Value $t.Value -Type DWord
  Write-Output ('SET ' + $t.Name + '=' + $t.Value)
}
Write-Output 'PERIPHERAL-APPLY-OK'
`;

module.exports = {
  query() { return QUERY_SCRIPT; },
  apply(options) {
    const json = JSON.stringify(options || {});
    return APPLY_SCRIPT.replace('__OPTIONS_JSON__', json.replace(/'/g, "''"));
  }
};
