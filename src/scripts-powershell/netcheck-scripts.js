// netcheck-scripts.js - 网络检测（v3.0）
// 6 项只读检测（网卡/IP/DHCP/DNS/代理/连通性），单脚本一次采集，输出单个 JSON。
// 判定阈值集中在本文件常量区；检测不出时如实标 unknown（不伪造结论，对齐系统体检惯例）。
// 修复动作：固定命令模板 + 检测时主进程自采的接口参数（不接受渲染层传任何字符串）。
// 约束（照 test-features 断言）：PS 片段禁反引号、禁模板字符串 ${、注释不带反斜杠。

const DIAG = require('../main/diag');

// ==================== 判定阈值 ====================
const THRESHOLDS = {
  PING_COUNT: 2,                 // 网关 ping 次数
  PING_TIMEOUT_MS: 1500,         // 单次 ping 超时
  TCP_PROBE_TIMEOUT_MS: 2500,    // 443/80 探测超时
  DNS_DOMAIN: 'www.baidu.com',   // 公网解析探测域名
  TCP_TARGETS: [                 // 出口 TCP 探测（任一通过即视为外网可达）
    { host: '223.5.5.5', port: 443 },
    { host: 'www.baidu.com', port: 443 }
  ],
  GATEWAY_FALLBACK_PORTS: [445, 80] // ICMP 被防火墙拦截时的网关 TCP 二次确认端口
};

const HEADER = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
`;

function status() {
  const tcpTargets = JSON.stringify(THRESHOLDS.TCP_TARGETS);
  return HEADER + DIAG.PS_PREAMBLE + `
$tcpTargets = ConvertFrom-Json ('${tcpTargets.replace(/'/g, "''")}')
# ---------- 1. 网络硬件配置 ----------
$adapters = Get-NetAdapter -ErrorAction SilentlyContinue |
  Where-Object { $_.Virtual -ne $true }
$upList = @($adapters | Where-Object { $_.Status -eq 'Up' })
$badList = @($adapters | Where-Object { $_.Status -ne 'Up' })
$disabledList = @($adapters | Where-Object { $_.Status -eq 'Disabled' })

$adapterItem = @{ id = 'adapter'; status = 'unknown'; evidence = @(); detail = '' }
if ($upList.Count -gt 0) {
  foreach ($a in $upList) {
    # LinkSpeed 本身就是格式化字符串（如 1 Gbps），不要再做数值转换（方法异常会中断本项赋值）
    $adapterItem.evidence += ('网卡 ' + $a.Name + '：Up，' + $a.LinkSpeed)
  }
  if ($disabledList.Count -gt 0) {
    # 只有「已禁用」的网卡提供一键启用；媒体断开（如 WLAN 未连接）属正常状态，仅列出
    $adapterItem.status = 'warn'
    foreach ($a in $badList) { $adapterItem.evidence += ('网卡 ' + $a.Name + '：' + $a.Status) }
    $adapterItem.detail = '存在被禁用的网卡'
    $disabledNames = @($disabledList | ForEach-Object { $_.Name }) -join ','
    $adapterItem.repair = @{ id = 'enable-adapter'; name = $disabledNames }
  } else {
    $adapterItem.status = 'ok'
  }
} elseif ($badList.Count -gt 0) {
  $adapterItem.status = 'fail'
  foreach ($a in $badList) { $adapterItem.evidence += ('网卡 ' + $a.Name + '：' + $a.Status) }
  $adapterItem.detail = '没有可用网卡'
  if ($disabledList.Count -gt 0) {
    $disabledNames = @($disabledList | ForEach-Object { $_.Name }) -join ','
    $adapterItem.repair = @{ id = 'enable-adapter'; name = $disabledNames }
  }
} else {
  $adapterItem.status = 'unknown'
  $adapterItem.detail = '未枚举到物理网卡'
}

# ---------- 2. 网络连接配置 ----------
$ipItem = @{ id = 'ipconfig'; status = 'unknown'; evidence = @(); detail = '' }
$ipcfgs = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.NetAdapter.Status -eq 'Up' })
$hasApipa = $false
$hasGateway = $false
$hasValidIp = $false
foreach ($c in $ipcfgs) {
  foreach ($ip in @($c.IPv4Address)) {
    $addr = [string]$ip.IPAddress
    if (-not $addr) { continue }
    $iface = '网卡 ' + $c.InterfaceAlias + '：' + $addr
    if ($addr.StartsWith('169.254.')) {
      $hasApipa = $true
      $ipItem.evidence += ($iface + '（APIPA，未从 DHCP 取到地址）')
    } else {
      $hasValidIp = $true
      $ipItem.evidence += $iface
    }
  }
  foreach ($gw in @($c.IPv4DefaultGateway)) {
    if ($gw -and $gw.NextHop) {
      $hasGateway = $true
      $ipItem.evidence += ('默认网关 ' + $gw.NextHop + '（' + $c.InterfaceAlias + '）')
    }
  }
}
if ($hasApipa) {
  $ipItem.status = 'fail'
  $ipItem.detail = '网卡持有 169.254 自动私有地址，DHCP 未取到有效地址'
} elseif ($hasValidIp -and $hasGateway) {
  $ipItem.status = 'ok'
} elseif ($hasValidIp) {
  $ipItem.status = 'warn'
  $ipItem.detail = '有 IPv4 地址但没有默认网关（可能为孤立网络或静态配置）'
} else {
  $ipItem.detail = '未取到有效 IPv4 配置'
}

# ---------- 3. DHCP 服务 ----------
$dhcpItem = @{ id = 'dhcp'; status = 'unknown'; evidence = @(); detail = '' }
$dhcpSvc = Get-Service -Name Dhcp -ErrorAction SilentlyContinue
if ($dhcpSvc) {
  $dhcpItem.evidence += ('Dhcp 服务：' + $dhcpSvc.Status + '，启动类型 ' + $dhcpSvc.StartType)
  if ($dhcpSvc.Status -eq 'Running') {
    $dhcpItem.status = 'ok'
  } else {
    $dhcpItem.status = 'fail'
    $dhcpItem.detail = 'DHCP 服务未运行（静态 IP 为合法配置，仅提示）'
    $dhcpItem.repair = @{ id = 'start-dhcp' }
  }
} else {
  $dhcpItem.detail = '未找到 Dhcp 服务'
}

# ---------- 4. DNS 服务与配置 ----------
$dnsItem = @{ id = 'dns'; status = 'unknown'; evidence = @(); detail = '' }
$dnsSvc = Get-Service -Name Dnscache -ErrorAction SilentlyContinue
$dnsServers = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.ServerAddresses -and $_.ServerAddresses.Count -gt 0 })
if ($dnsSvc) { $dnsItem.evidence += ('Dnscache 服务：' + $dnsSvc.Status + '，启动类型 ' + $dnsSvc.StartType) }
foreach ($s in $dnsServers) {
  $dnsItem.evidence += ('DNS ' + $s.InterfaceAlias + '：' + ($s.ServerAddresses -join ', '))
}
$dnsSvcStopped = ($dnsSvc -and $dnsSvc.Status -ne 'Running')
$dnsNone = ($dnsServers.Count -eq 0)
if ($dnsSvcStopped -or $dnsNone) {
  $dnsItem.status = 'fail'
  if ($dnsSvcStopped) {
    $dnsItem.detail = 'DNS Client 服务未运行'
    $dnsItem.repair = @{ id = 'start-dnscache' }
  } else {
    $dnsItem.detail = '所有网卡均未配置 DNS 服务器'
    # 重置目标接口：取检测时活动网卡（有默认网关优先）的接口索引，由主进程快照固定下来
    $activeIdx = $null
    foreach ($c in $ipcfgs) {
      if (@($c.IPv4DefaultGateway).Count -gt 0) { $activeIdx = [int]$c.InterfaceIdentifier; break }
    }
    if (-not $activeIdx -and $ipcfgs.Count -gt 0) { $activeIdx = [int]$ipcfgs[0].InterfaceIdentifier }
    if ($activeIdx) { $dnsItem.repair = @{ id = 'reset-dns'; interfaceIndex = $activeIdx } }
  }
} elseif ($dnsSvc) {
  $dnsItem.status = 'ok'
}

# ---------- 5. Web 代理设置 ----------
$proxyItem = @{ id = 'proxy'; status = 'unknown'; evidence = @(); detail = '' }
$uReg = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue
$pEnable = ($uReg -and $uReg.ProxyEnable -eq 1)
$pServer = if ($uReg) { [string]$uReg.ProxyServer } else { '' }
$pGpo = $false
$polDefs = Get-ItemProperty -Path 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue
if ($polDefs -and $polDefs.ProxyEnable -eq 1) { $pGpo = $true }

# WinHTTP 代理
$winhttp = & netsh.exe winhttp show proxy 2>$null | Out-String
$winhttpHasProxy = ($winhttp -match 'proxy|代理服务器') -and -not ($winhttp -match '直接访问|DIRECT')
$winhttpServer = ''
$m = [regex]::Match($winhttp, '(\d{1,3}(?:\.\d{1,3}){3}:\d{2,5})')
if ($m.Success) { $winhttpServer = $m.Groups[1].Value }

# 掩码显示：中间两段打码，避免完整代理地址出现在 UI 与日志（日志同口径）
function Mask-Proxy([string]$s) {
  if (-not $s) { return '' }
  return ($s -replace '(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}', '$1.*.*')
}

if ($pGpo) {
  $proxyItem.status = 'warn'
  $proxyItem.evidence += '检测到组策略下发的代理（由组织管理）'
  $proxyItem.detail = '代理由组策略下发，本工具不提供修复入口'
} elseif ($pEnable -and $pServer) {
  $proxyItem.evidence += ('用户代理已启用：' + (Mask-Proxy $pServer))
  $portMatch = [regex]::Match($pServer, ':(\d{2,5})')
  $listening = $false
  if ($portMatch.Success) {
    $port = [int]$portMatch.Groups[1].Value
    $listen = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listen.Count -gt 0) { $listening = $true }
  }
  if ($pServer.Contains('127.0.0.1') -and -not $listening) {
    $proxyItem.status = 'warn'
    $proxyItem.detail = '代理指向本机但无进程监听该端口（残留代理，典型「能连但打不开网页」根因）'
    $proxyItem.repair = @{ id = 'disable-user-proxy' }
  } else {
    $proxyItem.status = 'ok'
    $proxyItem.detail = '检测到用户自配代理（属合法配置，不做改动）'
  }
} else {
  $proxyItem.evidence += '用户代理（WinINET）：未启用'
}
if ($winhttpHasProxy -and $winhttpServer) {
  $proxyItem.evidence += ('系统代理（WinHTTP）：' + (Mask-Proxy $winhttpServer))
  if ($proxyItem.status -eq 'ok') { $proxyItem.status = 'warn' }
  $proxyItem.detail = 'WinHTTP 层配置了代理，可能影响系统服务联网'
  $proxyItem.repair = @{ id = 'reset-winhttp' }
}
if ($proxyItem.status -eq 'unknown') {
  $proxyItem.status = 'ok'
  if (-not $proxyItem.detail) { $proxyItem.detail = '未检测到代理' }
}

# ---------- 6. 连通性 ----------
$netItem = @{ id = 'connectivity'; status = 'unknown'; evidence = @(); detail = '' }
$gwIp = $null
foreach ($c in $ipcfgs) {
  foreach ($gw in @($c.IPv4DefaultGateway)) {
    if ($gw -and $gw.NextHop) { $gwIp = [string]$gw.NextHop; break }
  }
  if ($gwIp) { break }
}
$gwOk = $false
if ($gwIp) {
  $ping = Test-Connection -ComputerName $gwIp -Count ${THRESHOLDS.PING_COUNT} -Quiet -ErrorAction SilentlyContinue
  if ($ping) {
    $gwOk = $true
    $netItem.evidence += ('网关 ' + $gwIp + '：ping 通')
  } else {
    # ICMP 被防火墙拦截时补 TCP 探测二次确认，仍失败才判异常，证据行如实注明
    foreach ($p in ${THRESHOLDS.GATEWAY_FALLBACK_PORTS}) {
      $c1 = New-Object System.Net.Sockets.TcpClient
      try {
        $ar = $c1.BeginConnect($gwIp, $p, $null, $null)
        if ($ar.AsyncWaitHandle.WaitOne(${THRESHOLDS.TCP_PROBE_TIMEOUT_MS})) { $c1.EndConnect($ar); $gwOk = $true }
      } catch { } finally { try { $c1.Close() } catch { } }
      if ($gwOk) {
        $netItem.evidence += ('网关 ' + $gwIp + '：ICMP 不通但 TCP ' + $p + ' 可达（ping 被防火墙拦截）')
        break
      }
    }
    if (-not $gwOk) { $netItem.evidence += ('网关 ' + $gwIp + '：不可达') }
  }
} else {
  $netItem.evidence += '无默认网关，跳过网关探测'
}

$netOk = $false
foreach ($t in $tcpTargets) {
  $c2 = New-Object System.Net.Sockets.TcpClient
  try {
    $ar2 = $c2.BeginConnect($t.host, $t.port, $null, $null)
    if ($ar2.AsyncWaitHandle.WaitOne(${THRESHOLDS.TCP_PROBE_TIMEOUT_MS})) {
      $c2.EndConnect($ar2)
      $netOk = $true
      $netItem.evidence += ('外网 ' + $t.host + ':' + $t.port + '：可达')
      break
    }
  } catch { } finally { try { $c2.Close() } catch { } }
}
if (-not $netOk) {
  try {
    $ips = [System.Net.Dns]::GetHostAddresses('${THRESHOLDS.DNS_DOMAIN}')
    if ($ips -and $ips.Count -gt 0) {
      $netOk = $true
      $netItem.evidence += ('DNS 解析 ${THRESHOLDS.DNS_DOMAIN} 成功')
    }
  } catch {
    $netItem.evidence += ('外网探测不可达（TCP 443 与 DNS 解析均失败）')
  }
}

if ($gwOk -and $netOk) {
  $netItem.status = 'ok'
} elseif ($gwOk) {
  $netItem.status = 'warn'
  $netItem.detail = '网关可达但外网不通（出口/运营商问题，本机无修复项）'
} else {
  $netItem.status = 'fail'
  $netItem.detail = '网关不可达（本地链路问题）'
}

$items = @($adapterItem, $ipItem, $dhcpItem, $dnsItem, $proxyItem, $netItem)
$out = @{ items = $items; collectedAt = (Get-Date -Format 'o') }
Write-Output ($out | ConvertTo-Json -Compress -Depth 6)
`;
}

// ==================== 一键修复（白名单动作 id → 固定命令模板） ====================
// name / interfaceIndex 两个变量位只接受主进程检测快照里的值，渲染层仅传 actionId
function repair(actionId, param) {
  let body = '';
  if (actionId === 'enable-adapter') {
    const name = String((param && param.name) || '').replace(/'/g, "''");
    if (!name) throw new Error('缺少网卡名（应来自检测快照）');
    body = `
Write-Output '正在启用被禁用的网卡…'
$names = '${name}'.Split(',').Where({ $_ -and $_.Trim() })
Enable-NetAdapter -Name $names -Confirm:$false -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$ok = @(Get-NetAdapter -Name $names -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' }).Count -gt 0
if ($ok) { Write-Output (@{ ok = $true; message = '网卡已启用' } | ConvertTo-Json -Compress) }
else { Write-Output (@{ ok = $false; message = '网卡已执行启用命令但当前未处于 Up 状态' } | ConvertTo-Json -Compress) }
`;
  } else if (actionId === 'start-dhcp') {
    body = `
Write-Output '正在启动 DHCP 服务并设为自动…'
Set-Service -Name Dhcp -StartupType Automatic -ErrorAction Stop
Start-Service -Name Dhcp -ErrorAction Stop
$st = (Get-Service -Name Dhcp -ErrorAction SilentlyContinue).Status
if ($st -eq 'Running') { Write-Output (@{ ok = $true; message = 'DHCP 服务已启动' } | ConvertTo-Json -Compress) }
else { Write-Output (@{ ok = $false; message = 'DHCP 服务未处于运行态' } | ConvertTo-Json -Compress) }
`;
  } else if (actionId === 'start-dnscache') {
    body = `
Write-Output '正在启动 DNS Client 服务…'
$svc = Get-Service -Name Dnscache -ErrorAction SilentlyContinue
if ($svc -and $svc.StartType -eq 'Disabled') {
  Set-Service -Name Dnscache -StartupType Automatic -ErrorAction SilentlyContinue
}
Start-Service -Name Dnscache -ErrorAction Stop
$st = (Get-Service -Name Dnscache -ErrorAction SilentlyContinue).Status
if ($st -eq 'Running') { Write-Output (@{ ok = $true; message = 'DNS Client 服务已启动' } | ConvertTo-Json -Compress) }
else { Write-Output (@{ ok = $false; message = 'Dnscache 服务未处于运行态（部分系统限制该服务启动类型）' } | ConvertTo-Json -Compress) }
`;
  } else if (actionId === 'reset-dns') {
    const ifIdx = parseInt(param && param.interfaceIndex, 10);
    if (!Number.isFinite(ifIdx) || ifIdx <= 0) throw new Error('缺少接口索引（应来自检测快照）');
    body = `
Write-Output '正在把 DNS 服务器重置为自动获取…'
Set-DnsClientServerAddress -InterfaceIndex ${ifIdx} -ResetServerAddresses -ErrorAction Stop
Write-Output (@{ ok = $true; message = 'DNS 已重置为自动获取' } | ConvertTo-Json -Compress)
`;
  } else if (actionId === 'disable-user-proxy') {
    body = `
Write-Output '正在关闭残留的用户代理…'
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyEnable -Value 0 -Type DWord -Force -ErrorAction Stop
$check = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue).ProxyEnable
if ($check -eq 0) { Write-Output (@{ ok = $true; message = '残留用户代理已关闭' } | ConvertTo-Json -Compress) }
else { Write-Output (@{ ok = $false; message = 'ProxyEnable 未能写为 0' } | ConvertTo-Json -Compress) }
& ipconfig.exe /flushdns 2>$null | Out-Null
`;
  } else if (actionId === 'reset-winhttp') {
    body = `
Write-Output '正在重置 WinHTTP 代理…'
$out = & netsh.exe winhttp reset proxy 2>&1 | Out-String
Write-Output ($out.Trim())
Write-Output (@{ ok = $true; message = 'WinHTTP 代理已重置（部分服务需重启后生效）' } | ConvertTo-Json -Compress)
`;
  } else {
    throw new Error('未知的修复动作: ' + String(actionId));
  }
  return HEADER + DIAG.PS_PREAMBLE + body;
}

// 深度联动入口（联动系统维护修复组）：给检测结论页提供「进一步修复」跳转建议
const MAINTENANCE_LINKS = [
  { id: 'dns', label: '刷新 DNS 缓存', hint: '网页打不开/解析异常时先试' },
  { id: 'netstack', label: '重置网络栈 (Winsock/IP)', hint: '多项异常并存时的兜底重置，需重连网络' }
];

module.exports = { THRESHOLDS, status, repair, MAINTENANCE_LINKS };
