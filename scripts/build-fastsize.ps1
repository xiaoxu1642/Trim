# build-fastsize.ps1 - 编译 TrimFastSize.dll（扫描加速辅助 DLL）
# 用法：pwsh scripts/build-fastsize.ps1
# 注意：必须先删后编——Add-Type -OutputAssembly 在目标 DLL 已存在时可能不覆盖
#       （实测 mtime 停在旧值，会误测到旧实现），故本脚本强制删除旧产物。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cs = Join-Path $PSScriptRoot 'TrimFastSize.cs'
$dll = Join-Path $PSScriptRoot 'TrimFastSize.dll'

if (-not (Test-Path -LiteralPath $cs)) { throw "源码不存在: $cs" }
if (Test-Path -LiteralPath $dll) { Remove-Item -LiteralPath $dll -Force }

Add-Type -TypeDefinition (Get-Content -Raw $cs) -OutputAssembly $dll -ErrorAction Stop

$size = (Get-Item -LiteralPath $dll).Length
Write-Output "OK: $dll ($size bytes)"
