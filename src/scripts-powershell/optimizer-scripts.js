// 优化电脑 选项目录 + 进度型 PowerShell 生成器
// 来源目录：old\zhenghe（已按功能去重整合，剔除二进制 exe）
// TuneForge.bat (内置性能调优集（2353 行）) 已全量嵌入，按分组分类；
// 脚本中的 wmic 循环改写为 Get-CimInstance / Get-PnpDevice（Win11 27H2 无 wmic），
// 外部工具（nvidiaProfileInspector / OOSU10 / 电源计划 / DevManView）改为下载后静默执行，
// 脚本自身语法 bug（seplatformtick、GpuEnergyDr、Microsoftd、智能引号 MTU、
// DisableWebSearch 反值、HDCP 双反斜杠）在嵌入时已修正。
// 执行模型：每个选项 = steps 数组；runner 生成一个 pwsh 脚本顺序执行，
// 并逐步输出 "@@PROGRESS:n@@" 上报 0-100%；结束时输出 "@@DONE@@"。
// step 支持 4 种动作：
//   reg     -> { label, reg }  .reg 内容，用 reg.exe import 临时文件（保证原样保真）
//   cmd     -> { label, cmd }  交由 cmd.exe /c 执行（bcdedit/ipconfig/netsh/fsutil/reg add）
//   service -> { label, service, disable }  Stop-Service + 可选 Set-Service Disabled
//   pwsh    -> { label, pwsh }  内联 PowerShell 语句（可多行；禁止内含独立成行的 '@）

const DIAG = require('../diag');

// PS 单引号字面量（用于把步骤 label 安全嵌入诊断 Detail 表达式）
function psQuoteForScript(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// 内存 SVCHost 拆分阈值：内存GB -> KB（对齐 zhenghe\内存调整 各档位）
const MEMORY_KB = {
  4: 4194304, 6: 6291456, 8: 8388608, 12: 12582912,
  16: 16777216, 20: 20971520, 24: 25165824, 32: 33554432,
  default: 380000           // 重置为默认值
};

// 生成一段带回车行的干净 .reg 块（统一去掉作者水印/尾注，保证 reg import 可解析）
function regBlock(entries) {
  const sections = Object.keys(entries);
  const parts = ['Windows Registry Editor Version 5.00', ''];
  for (const sec of sections) {
    parts.push(`[${sec}]`);
    const kvs = entries[sec];
    for (const k of Object.keys(kvs)) parts.push(`"${k}"=${kvs[k]}`);
    parts.push('');
  }
  return parts.join('\r\n');
}

// EDGE 策略单键项生成器（原「EDGE浏览器专优」整合项按功能拆分为独立可勾选/执行/还原项）
const EDGE_POLICY_PATH = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge';
function edgePolicyItem(id, title, risk, valueName, regValue, desc) {
  return {
    id, group: '浏览器优化', title, risk, desc,
    steps: [{ label: `Edge 策略 ${valueName}=${regValue}`, reg: regBlock({ [EDGE_POLICY_PATH]: { [valueName]: regValue } }) }],
    restore: [{ label: `还原：删除 ${valueName} 键值（恢复 Edge 默认行为）`, reg: regBlock({ [EDGE_POLICY_PATH]: { [valueName]: '-' } }) }]
  };
}

// ==================== 选项目录 ====================
// risk: low / medium / high；title 在卡片上显示；steps 为执行动作；restore 可选（有源还原）
const OPTIONS = [
  // ---------- 启动与响应 ----------
  {
    id: 'bcd_opt', group: '启动与响应', title: 'BCD 超优化', risk: 'high',
    desc: '合并自「BCD 启动优化」与「BCD 全量启动参数」：关闭平台时钟(useplatformclock/useplatformtick No)+禁用动态时钟(disabledynamictick Yes)、TSC 同步增强、启动体验(无 UI/超时 0/静默/去 Logo/去动画)、虚拟化关闭(hypervisorlaunchtype/VSM/VM，适用于不使用 Hyper-V/WSL2 的环境)、内存映射(firstmegabytepolicy UseAll、avoidlowmemory、nolowmem、allowedinmemorysettings、pae ForceEnable)、DEP OptOut、x2apicpolicy Enable、禁用 ELAM 驱动等 28 项，一站式完成 BCD 启动调优。',
    steps: [
      { label: '关闭平台时钟', cmd: 'bcdedit /set useplatformclock No' },
      { label: '关闭平台 tick', cmd: 'bcdedit /set useplatformtick No' },
      { label: '禁用动态时钟', cmd: 'bcdedit /set disabledynamictick Yes' },
      { label: 'TSC 同步策略增强', cmd: 'bcdedit /set tscsyncpolicy Enhanced' },
      { label: '启动超时 0', cmd: 'bcdedit /timeout 0' },
      { label: 'DEP OptOut', cmd: 'bcdedit /set nx optout' },
      { label: '禁用启动 UI', cmd: 'bcdedit /set bootux disabled' },
      { label: '标准启动菜单策略', cmd: 'bcdedit /set bootmenupolicy standard' },
      { label: '关闭超虚拟化', cmd: 'bcdedit /set hypervisorlaunchtype off' },
      { label: '强制禁用 TPM 启动熵', cmd: 'bcdedit /set tpmbootentropy ForceDisable' },
      { label: '静默启动', cmd: 'bcdedit /set quietboot yes' },
      { label: '禁用启动 Logo', cmd: 'bcdedit /set {globalsettings} custom:16000067 true' },
      { label: '禁用旋转动画', cmd: 'bcdedit /set {globalsettings} custom:16000069 true' },
      { label: '禁用启动消息', cmd: 'bcdedit /set {globalsettings} custom:16000068 true' },
      { label: '关闭 VSM 启动', cmd: 'bcdedit /set vsmlaunchtype Off' },
      { label: '禁用虚拟机设置', cmd: 'bcdedit /set vm No' },
      { label: '首 1MB 内存策略 UseAll', cmd: 'bcdedit /set firstmegabytepolicy UseAll' },
      { label: '避免低内存占用', cmd: 'bcdedit /set avoidlowmemory 0x8000000' },
      { label: '无低内存模式', cmd: 'bcdedit /set nolowmem Yes' },
      { label: '允许内存设置 0x0', cmd: 'bcdedit /set allowedinmemorysettings 0x0' },
      { label: 'x2APIC 启用', cmd: 'bcdedit /set x2apicpolicy Enable' },
      { label: '禁用 ELAM 驱动', cmd: 'bcdedit /set disableelamdrivers Yes' },
      { label: 'PAE 强制启用', cmd: 'bcdedit /set pae ForceEnable' },
      { label: '禁用 UMEx', cmd: 'bcdedit /set noumex Yes' },
      { label: '关闭传统 APIC 模式', cmd: 'bcdedit /set uselegacyapicmode No' },
      { label: '禁用 EMS', cmd: 'bcdedit /set ems No' },
      { label: '扩展输入启用', cmd: 'bcdedit /set extendedinput Yes' },
      { label: '禁用调试', cmd: 'bcdedit /set debug No' }
    ]
  },
  {
    id: 'ssd_opt', group: '启动与响应', title: 'SSD 固态硬盘优化', risk: 'low',
    desc: 'SSD：启用最后访问时间戳、禁用 8.3 短文件名，减少磁盘元数据开销。',
    steps: [
      { label: '启用最后访问时间戳', cmd: 'fsutil behavior set disableLastAccess 0' },
      { label: '禁用 8.3 短文件名', cmd: 'fsutil behavior set disable8dot3 1' }
    ]
  },
  {
    id: 'tf_ntfs', group: '启动与响应', title: 'NTFS 文件系统调优', risk: 'medium',
    desc: 'TuneForge fsutil 五项：memoryusage=2、mftzone=4、disablelastaccess=1、disabledeletenotify=0（开启删除通知/TRIM）、encryptpagingfile=0。',
    steps: [
      { label: 'NTFS 内存占用 2', cmd: 'fsutil behavior set memoryusage 2' },
      { label: 'MFT 区域 4', cmd: 'fsutil behavior set mftzone 4' },
      { label: '禁用最后访问时间', cmd: 'fsutil behavior set disablelastaccess 1' },
      { label: '开启删除通知(TRIM)', cmd: 'fsutil behavior set disabledeletenotify 0' },
      { label: '页面文件不加密', cmd: 'fsutil behavior set encryptpagingfile 0' }
    ]
  },
  {
    id: 'tf_hibern_off', group: '启动与响应', title: '关闭休眠与快速启动', risk: 'medium',
    desc: 'TuneForge：powercfg /h off、HiberbootEnabled=0、HibernateEnabled=0、关闭睡眠可靠性诊断与 SleepStudy，彻底关闭休眠文件与快速启动。',
    steps: [
      { label: '关闭休眠', cmd: 'powercfg /h off' },
      {
        label: '快速启动 / 休眠 / 睡眠诊断注册表', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power': {
            'HiberbootEnabled': 'dword:00000000',
            'HibernateEnabled': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SleepReliability': {
            'SleepReliabilityDetailedDiagnostics': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SleepStudy': {
            'SleepStudyDisabled': 'dword:00000001'
          }
        })
      }
    ]
  },
  {
    id: 'tf_core_misc', group: '启动与响应', title: '核心响应性杂项', risk: 'medium',
    desc: 'TuneForge 核心键集合：Win32PrioritySeparation=38、LargeSystemCache=1、菜单延迟 0、HwSchMode=2（硬件调度）、DistributeTimers=1、禁用 FTH、MoveImages=0、DisablePagingExecutive=1、DpiMapIommuContiguous=1、关闭自动维护、IE DEP 关闭。',
    steps: [
      {
        label: '核心响应性注册表', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\PriorityControl': {
            'Win32PrioritySeparation': 'dword:00000026'
          },
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management': {
            'LargeSystemCache': 'dword:00000001',
            'DisablePagingExecutive': 'dword:00000001',
            'MoveImages': 'dword:00000000',
            'DpiMapIommuContiguous': 'dword:00000001'
          },
          'HKEY_CURRENT_USER\\Control Panel\\Desktop': {
            'MenuShowDelay': '"0"'
          },
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers': {
            'HwSchMode': 'dword:00000002'
          },
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Kernel': {
            'DistributeTimers': 'dword:00000001'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\FTH': {
            'Enabled': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Schedule\\Maintenance': {
            'MaintenanceDisabled': 'dword:00000001'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Internet Explorer\\Main': {
            'DEPOff': 'dword:00000001'
          }
        })
      }
    ]
  },
  {
    id: 'tf_timer_coal', group: '启动与响应', title: '合并计时器与现代待机', risk: 'medium',
    desc: 'TuneForge：7 条路径 CoalescingTimerInterval=0，关闭 PlatformAoAc/ModernSleep/CsEnabled，EnergyEstimation/EventProcessor 关闭，PowerThrottlingOff=1，降低定时器合并带来的延迟。',
    steps: [
      {
        label: 'CoalescingTimerInterval / ModernSleep / PowerThrottling', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\kernel': {
            'CoalescingTimerInterval': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power': {
            'CoalescingTimerInterval': 'dword:00000000',
            'PlatformAoAcOverride': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management': {
            'CoalescingTimerInterval': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Executive': {
            'CoalescingTimerInterval': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Power': {
            'CoalescingTimerInterval': 'dword:00000000',
            'EnergyEstimationEnabled': 'dword:00000000',
            'EventProcessorEnabled': 'dword:00000000',
            'CsEnabled': 'dword:00000000',
            'PowerThrottlingOff': 'dword:00000001'
          },
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Power\\ModernSleep': {
            'CoalescingTimerInterval': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile': {
            'CoalescingTimerInterval': 'dword:00000000'
          }
        })
      }
    ]
  },
  // ---------- 游戏与多媒体 ----------
  {
    id: 'game_dvr', group: '游戏与多媒体', title: '关闭游戏 DVR 录制', risk: 'low',
    desc: '关闭 GameDVR/游戏栏后台录制与全屏优化，减少游戏卡顿、闪退与掉帧。',
    steps: [
      {
        label: 'GameDVR / 全屏优化配置', reg: regBlock({
          'HKEY_CURRENT_USER\\System\\GameConfigStore': {
            'GameDVR_Enabled': 'dword:00000000',
            'GameDVR_FSEBehaviorMode': 'dword:00000002',
            'GameDVR_HonorUserFSEBehaviorMode': 'dword:00000000',
            'GameDVR_DXGIHonorFSEWindowsCompatible': 'dword:00000000',
            'GameDVR_EFSEFeatureFlags': 'dword:00000000',
            'GameDVR_FSEBehavior': 'dword:00000002'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR': {
            'AllowGameDVR': 'dword:0'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\PolicyManager\\default\\ApplicationManagement\\AllowGameDVR': {
            'value': 'dword:0'
          },
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR': {
            'AppCaptureEnabled': 'dword:00000000'
          }
        })
      }
    ]
  },
  {
    id: 'mmcss_optimize', group: '游戏与多媒体', title: 'MMCSS优化', risk: 'medium',
    desc: '合并原「游戏高优先级 (MMCSS Games)」与「MMCSS 系统增强」：Games 任务设为高调度/高 GPU 优先级并打上低延迟标记，SystemProfile 开启 NoLazyMode/AlwaysOn，Reliability 提升时间戳与 IO 优先级，为游戏与影音提供低延迟的多媒体调度（原「启用 Games 低延迟调度标记」同值重复，已并入本项）。',
    steps: [
      {
        label: 'MMCSS Games 任务优先级 + 低延迟标记', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games': {
            'Affinity': 'dword:00000000',
            'Background Only': '"False"',
            'Clock Rate': 'dword:00002710',
            'Scheduling Category': '"High"',
            'SFIO Priority': '"High"',
            'GPU Priority': 'dword:00000008',
            'Priority': 'dword:00000006',
            'Latency Sensitive': '"True"'
          }
        })
      },
      {
        label: 'MMCSS 系统级增强（NoLazyMode/AlwaysOn/Reliability）', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile': {
            'NoLazyMode': 'dword:00000001',
            'AlwaysOn': 'dword:00000001'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Reliability': {
            'TimeStampInterval': 'dword:00000001',
            'IoPriority': 'dword:00000003'
          }
        })
      }
    ],
    restore: [
      {
        label: '恢复 MMCSS 默认（Games 任务回系统默认值，移除系统级增强键值）', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games': {
            'Affinity': 'dword:00000000',
            'Background Only': '"True"',
            'Clock Rate': 'dword:00002710',
            'Scheduling Category': '"Medium"',
            'SFIO Priority': '"Normal"',
            'GPU Priority': 'dword:00000008',
            'Priority': 'dword:00000002',
            'Latency Sensitive': '-'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile': {
            'NoLazyMode': '-',
            'AlwaysOn': '-'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Reliability': {
            'TimeStampInterval': '-',
            'IoPriority': '-'
          }
        })
      }
    ]
  },
  {
    id: 'nara_prio', group: '游戏与多媒体', title: '永劫无间 CPU 高优先级', risk: 'low',
    desc: '为「永劫无间」(NarakaBladepoint.exe) 进程设置高 CPU 优先级类。',
    steps: [
      {
        label: 'Naraka CpuPriorityClass=3', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\NarakaBladepoint.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000003'
          }
        })
      }
    ]
  },
  {
    id: 'disable_uac', group: '游戏与多媒体', title: '禁用 UAC（用户账户控制）', risk: 'high',
    desc: '关闭 UAC 提升提示。会降低系统安全性，请谨慎使用。',
    steps: [
      { label: 'EnableLUA=0', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System': { 'EnableLUA': 'dword:00000000' }
      }) }
    ]
  },
  {
    id: 'tf_gamemode', group: '游戏与多媒体', title: '开启游戏模式', risk: 'low',
    desc: 'TuneForge：AllowAutoGameMode=1、AutoGameModeEnabled=1，让 Windows 游戏模式自动提升游戏进程优先级。',
    steps: [
      {
        label: 'Game Mode 开启', reg: regBlock({
          'HKEY_CURRENT_USER\\Software\\Microsoft\\GameBar': {
            'AllowAutoGameMode': 'dword:00000001',
            'AutoGameModeEnabled': 'dword:00000001'
          }
        })
      }
    ]
  },
  {
    id: 'tf_gamebar', group: '游戏与多媒体', title: '关闭游戏栏后台捕获', risk: 'low',
    desc: 'TuneForge：AppCaptureEnabled=0、PresenceWriter ActivationType=0，关闭后台游戏录制与游戏状态写入器。',
    steps: [
      {
        label: 'AppCapture / PresenceWriter', reg: regBlock({
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR': {
            'AppCaptureEnabled': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\WindowsRuntime\\ActivatableClassId\\Windows.Media.Capture.AppCaptureBroadcastContract\\PresenceWriter': {
            'ActivationType': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\PresenceWriter': {
            'Start': 'dword:00000004'
          }
        })
      }
    ]
  },
  {
    id: 'tf_fso', group: '游戏与多媒体', title: '全屏优化(FSO)行为', risk: 'low',
    desc: 'TuneForge GameConfigStore：GameDVR_DSEBehavior=0、FSEBehaviorMode=0、EFSEFeatureFlags=0、DXGIHonorFSEWindowsCompatible=0、HonorUserFSEBehaviorMode=1（与内置「关闭游戏DVR」取值不同，保持原调优值）。',
    steps: [
      {
        label: 'FSO GameConfigStore', reg: regBlock({
          'HKEY_CURRENT_USER\\System\\GameConfigStore': {
            'GameDVR_DSEBehavior': 'dword:00000000',
            'GameDVR_FSEBehaviorMode': 'dword:00000000',
            'GameDVR_EFSEFeatureFlags': 'dword:00000000',
            'GameDVR_DXGIHonorFSEWindowsCompatible': 'dword:00000000',
            'GameDVR_HonorUserFSEBehaviorMode': 'dword:00000001'
          }
        })
      }
    ]
  },
  {
    id: 'tf_gpu_latency', group: '游戏与多媒体', title: 'GPU 延迟容忍度调优', risk: 'medium',
    desc: 'TuneForge Latency Tolerance：DXGKrnl MonitorLatencyTolerance/MonitorRefreshLatencyTolerance=1，Control\\Power 9 键=1，GraphicsDrivers\\Power 24 键=1（含 DefaultD3TransitionLatency*、DefaultLatencyTolerance*、Miracast 等）。',
    steps: [
      {
        label: 'DXGKrnl / Control Power 延迟键', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\DXGKrnl': {
            'MonitorLatencyTolerance': 'dword:00000001',
            'MonitorRefreshLatencyTolerance': 'dword:00000001'
          },
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Power': {
            'ExitLatency': 'dword:00000001',
            'ExitLatencyCheckEnabled': 'dword:00000001',
            'Latency': 'dword:00000001',
            'LatencyToleranceDefault': 'dword:00000001',
            'LatencyToleranceFSVP': 'dword:00000001',
            'LatencyTolerancePerfOverride': 'dword:00000001',
            'LatencyToleranceScreenOffIR': 'dword:00000001',
            'LatencyToleranceVSyncEnabled': 'dword:00000001',
            'RtlCapabilityCheckLatency': 'dword:00000001'
          }
        })
      },
      { label: 'GraphicsDrivers\\Power 24 键', pwsh: [
        '$p = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers\\Power"',
        'New-Item -Path $p -Force | Out-Null',
        '$names = @("ExitLatency","ExitLatencyCheckEnabled","Latency","LatencyToleranceDefault","LatencyToleranceFSVP","LatencyTolerancePerfOverride","LatencyToleranceScreenOffIR","LatencyToleranceVSyncEnabled","RtlCapabilityCheckLatency","DefaultD3TransitionLatency","DefaultD3TransitionLatencyEnabled","DefaultD3TransitionLatencyHMD","DefaultD3TransitionLatencyHMDEnabled","DefaultD3TransitionLatencyMedia","DefaultD3TransitionLatencyMediaEnabled","DefaultLatencyTolerance","DefaultLatencyToleranceEnabled","DefaultLatencyToleranceHMD","DefaultLatencyToleranceHMDEndabled","DefaultMemoryRefreshLatency","DefaultMemoryRefreshLatencyEnabled","MaxIAverageGraphicsLatencyInOneBucket","MiracastPerfTrackGraphicsLatency","MonitorLatencyTolerance","MonitorRefreshLatencyTolerance","TransitionLatency")',
        'foreach ($n in $names) { New-ItemProperty -Path $p -Name $n -Value 1 -PropertyType DWord -Force | Out-Null }'
      ].join('\n') }
    ]
  },
  {
    id: 'tf_ifeo_perf', group: '游戏与多媒体', title: '进程 CPU/IO 优先级（IFEO PerfOptions）', risk: 'high',
    desc: 'TuneForge：dwm/ntoskrnl/csrss Cpu=4/Io=3，lsass Cpu=1/Io=0/PagePriority=0，SearchIndexer/svchost/TrustedInstaller/wuauclt/audiodg Cpu=1/2，在 SOFTWARE 与 WOW6432Node 两个蜂巢写入 PerfOptions。',
    steps: [
      {
        label: 'IFEO PerfOptions（双蜂巢）', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\dwm.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000004', 'IoPriority': 'dword:00000003'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\ntoskrnl.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000004', 'IoPriority': 'dword:00000003'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\csrss.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000004', 'IoPriority': 'dword:00000003'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\lsass.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000001', 'IoPriority': 'dword:00000000', 'PagePriority': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\SearchIndexer.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000001', 'IoPriority': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\svchost.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000001'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\TrustedInstaller.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000001', 'IoPriority': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\wuauclt.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000001', 'IoPriority': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\MsMpEng.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000001'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\MsMpEngCP.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000001'
          },
          'HKEY_LOCAL_MACHINE\\WOW6432Node\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\dwm.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000004', 'IoPriority': 'dword:00000003'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\ntoskrnl.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000004', 'IoPriority': 'dword:00000003'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\csrss.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000004', 'IoPriority': 'dword:00000003'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\lsass.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000001', 'IoPriority': 'dword:00000000', 'PagePriority': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\SearchIndexer.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000001', 'IoPriority': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\svchost.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000001'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\TrustedInstaller.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000001', 'IoPriority': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\wuauclt.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000001', 'IoPriority': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\audiodg.exe\\PerfOptions': {
            'CpuPriorityClass': 'dword:00000002'
          }
        })
      }
    ]
  },
  {
    id: 'tf_ifeo_wipe', group: '游戏与多媒体', title: '清空 IFEO 调试项', risk: 'high',
    desc: '清除 Image File Execution Options 下的调试劫持值（Debugger/GlobalFlag/UseFilter 等）。已与「进程 CPU/IO 优先级」兼容：保留各程序的 PerfOptions 子项（IFEO 优先级设置）不被误删，仅清除杀软/病毒常用的 Debugger 劫持入口。',
    steps: [
      {
        label: '清除 Debugger 劫持值（保留 PerfOptions）', pwsh: [
          "$root = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options'",
          "Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {",
          "  $sub = $_",
          "  foreach ($v in @('Debugger','GlobalFlag','UseFilter','ModifiedImagePath')) {",
          "    if ($null -ne (Get-ItemProperty -LiteralPath $sub.PSPath -Name $v -ErrorAction SilentlyContinue)) { Remove-ItemProperty -LiteralPath $sub.PSPath -Name $v -ErrorAction SilentlyContinue }",
          "  }",
          "  $hasPerf = Test-Path -LiteralPath (Join-Path $sub.PSPath 'PerfOptions')",
          "  if (-not $hasPerf) {",
          "    $props = Get-ItemProperty -LiteralPath $sub.PSPath -ErrorAction SilentlyContinue",
          "    $vals = @($props.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' }).Count",
          "    $childCount = @(Get-ChildItem -LiteralPath $sub.PSPath -ErrorAction SilentlyContinue).Count",
          "    if ($vals -eq 0 -and $childCount -eq 0) { Remove-Item -LiteralPath $sub.PSPath -Force -ErrorAction SilentlyContinue }",
          "  }",
          "}"
        ].join('\n')
      }
    ]
  },

  // ---------- 系统服务与内存 ----------
  {
    id: 'maps_off', group: '系统服务与内存', title: '禁用下载地图管理器', risk: 'low',
    desc: '禁用 MapsBroker 地图下载服务。',
    steps: [
      { label: 'MapsBroker Start=4', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\MapsBroker': { 'Start': 'dword:00000004' }
      }) }
    ]
  },
  {
    id: 'services_off', group: '系统服务与内存', title: '禁用冗余后台服务', risk: 'high',
    desc: '停止并禁用 Xbox、遥测(DiagTrack)、推送通知、地理位置等后台服务。',
    steps: [
      { label: 'SysMain 超级预读', service: 'SysMain', disable: true },
      { label: 'DiagTrack 遥测', service: 'DiagTrack', disable: true },
      { label: 'Xbox 身份验证', service: 'XblAuthManager', disable: true },
      { label: 'Xbox 游戏存档', service: 'XblGameSave', disable: true },
      { label: 'Xbox 网络服务', service: 'XboxNetApiSvc', disable: true },
      { label: '游戏 DVR 服务', service: 'BcastDVRUserService', disable: true },
      { label: '设备推送', service: 'dmwappushservice', disable: true },
      { label: '推送通知', service: 'WpnService', disable: true },
      { label: '地理位置', service: 'lfsvc', disable: true }
    ]
  },
  {
    id: 'svc_mem_gb', group: '系统服务与内存', title: 'SVCHost 内存拆分阈值', risk: 'medium',
    desc: '调整服务宿主进程拆分阈值，减少服务内存碎片（下拉选择内存大小，可重置）。',
    dynamic: true   // 由渲染层传入 gb 参数
  },
  {
    id: 'mem_compress', group: '系统服务与内存', title: '禁用内存压缩', risk: 'medium',
    desc: '关闭 Windows 内存压缩（Memory Compression），释放 CPU 开销。',
    steps: [
      { label: 'Disable-MMAgent 内存压缩', pwsh: 'Disable-MMAgent -MemoryCompression' }
    ]
  },
  {
    id: 'tf_mmagent', group: '系统服务与内存', title: '关闭内存压缩与页合并', risk: 'medium',
    desc: 'TuneForge：Disable-MMAgent -MemoryCompression 与 -PageCombining，同时关闭内存压缩和页面合并（比内置项多 PageCombining）。',
    steps: [
      { label: '关闭内存压缩', pwsh: 'Disable-MMAgent -MemoryCompression -ErrorAction SilentlyContinue' },
      { label: '关闭页面合并', pwsh: 'Disable-MMAgent -PageCombining -ErrorAction SilentlyContinue' }
    ]
  },
  {
    id: 'tf_svc_bulk', group: '系统服务与内存', title: '禁用 70+ 非必要服务', risk: 'high',
    desc: '批量调整服务启动类型：Windows 应用商店与同步相关服务保持系统默认（不再修改），其余非必要服务全部禁用(Start=4)，并关闭 Edge 预启动/预加载。\n\n禁用(Start=4)服务清单：TapiSrv、FontCache3.0.0.0、WpcMonSvc、SEMgrSvc、PNRPsvc、LanmanWorkstation、WEPHOSTSVC、p2psvc、p2pimsvc、PhoneSvc、Wecsvc、SensorDataService、SensrSvc、perceptionsimulation、StiSvc、WMPNetworkSvc、autotimesvc、edgeupdatem、MicrosoftEdgeElevationService、ALG、QWAVE、IpxlatCfgSvc、icssvc、DusmSvc、MapsBroker、edgeupdate、SensorService、shpamsvc、svsvc、SysMain、MSiSCSI、Netlogon、CscService、ssh-agent、AppReadiness、tzautoupdate、NfsClnt、wisvc、defragsvc、SharedRealitySvc、RetailDemo、lltdsvc、TrkWks、CryptSvc、DiagTrack、diagsvc、DPS、WdiServiceHost、WdiSystemHost、dmwappushsvc、TroubleshootingSvc、DsSvc、FrameServer、FontCache、OSRSS、sedsvc、SENS、TabletInputService、Themes、BcastDVRUserService、CaptureService、diagnosticshub.standardcollector.service、SecurityHealthService。',
    steps: [
      { label: '批量禁用非必要服务（商店/同步保持默认）', pwsh: [
        '$disabled = @("TapiSrv","FontCache3.0.0.0","WpcMonSvc","SEMgrSvc","PNRPsvc","LanmanWorkstation","WEPHOSTSVC","p2psvc","p2pimsvc","PhoneSvc","Wecsvc","SensorDataService","SensrSvc","perceptionsimulation","StiSvc","WMPNetworkSvc","autotimesvc","edgeupdatem","MicrosoftEdgeElevationService","ALG","QWAVE","IpxlatCfgSvc","icssvc","DusmSvc","MapsBroker","edgeupdate","SensorService","shpamsvc","svsvc","SysMain","MSiSCSI","Netlogon","CscService","ssh-agent","AppReadiness","tzautoupdate","NfsClnt","wisvc","defragsvc","SharedRealitySvc","RetailDemo","lltdsvc","TrkWks","CryptSvc","DiagTrack","diagsvc","DPS","WdiServiceHost","WdiSystemHost","dmwappushsvc","TroubleshootingSvc","DsSvc","FrameServer","FontCache","OSRSS","sedsvc","SENS","TabletInputService","Themes","BcastDVRUserService","CaptureService","diagnosticshub.standardcollector.service","SecurityHealthService")',
        'foreach ($n in $disabled) { $p = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$n"; if (Test-Path $p) { New-ItemProperty -Path $p -Name Start -Value 4 -PropertyType DWord -Force | Out-Null; Stop-Service -Name $n -Force -ErrorAction SilentlyContinue } }',
        '$p = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\wuauserv"; if (Test-Path $p) { New-ItemProperty -Path $p -Name Start -Value 3 -PropertyType DWord -Force | Out-Null }',
        '$p = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\lfsvc\\Service\\Configuration"; New-Item -Path $p -Force | Out-Null; New-ItemProperty -Path $p -Name Status -Value 0 -PropertyType DWord -Force | Out-Null',
        'New-Item -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\MicrosoftEdge\\Main" -Force | Out-Null; New-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\MicrosoftEdge\\Main" -Name AllowPrelaunch -Value 0 -PropertyType DWord -Force | Out-Null',
        'New-Item -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\MicrosoftEdge\\TabPreloader" -Force | Out-Null; New-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\MicrosoftEdge\\TabPreloader" -Name AllowTabPreloading -Value 0 -PropertyType DWord -Force | Out-Null'
      ].join('\n') }
    ]
  },
  {
    id: 'tf_drv_disable', group: '系统服务与内存', title: '禁用高风险驱动服务', risk: 'high',
    desc: 'TuneForge DisableDrivers（21 项 Start=4）：acpipagr、AcpiPmi、Beep、CAD、GpuEnergyDrv、CLFS、CSC、luafv、RasAcd/Rasl2tp/RasPppoe/RasSstp、tcpipreg、dam、PEAUTH、QWAVEdrv、cdrom、fileinfo、FileCrypt。可能影响光驱/VPN，高风险（已剔除 IPv6 相关驱动 Tcpip6/wanarpv6，遵守项目硬约束）。',
    steps: [
      { label: '驱动服务 Start=4', pwsh: [
        '$drv = @("acpipagr","AcpiPmi","Beep","CAD","GpuEnergyDrv","CLFS","CSC","luafv","RasAcd","Rasl2tp","RasPppoe","RasSstp","tcpipreg","dam","PEAUTH","QWAVEdrv","cdrom","fileinfo","FileCrypt")',
        'foreach ($n in $drv) { $p = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$n"; if (Test-Path $p) { New-ItemProperty -Path $p -Name Start -Value 4 -PropertyType DWord -Force | Out-Null } }'
      ].join('\n') }
    ]
  },

  // ---------- 安全与隐私 ----------
  {
    id: 'share_off', group: '安全与隐私', title: '关闭默认共享', risk: 'medium',
    desc: '关闭 LanmanServer 的默认管理共享（C$/ADMIN$）与空会话管道。',
    steps: [
      { label: 'LanmanServer 共享参数', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\LanmanServer\\Parameters': {
          'AutoShareWks': 'dword:00000000',
          'AutoShareServer': 'dword:00000000',
          'EnableAuthenticateUserSharing': 'dword:00000000',
          'restrictnullsessaccess': 'dword:00000001',
          'enablesecuritysignature': 'dword:00000000',
          'requiresecuritysignature': 'dword:00000000'
        }
      }) }
    ]
  },
  {
    id: 'telemetry_optimize', group: '安全与隐私', title: '遥测优化', risk: 'medium',
    desc: '合并原「关闭系统遥测」与「停用遥测计划任务/日志」：策略层关闭 AllowTelemetry、广告 ID、传递优化上传与网页内容评估；任务层禁用 30+ 个遥测/兼容性/客户体验计划任务（含 Office、Application Experience、Media Center 等）并将 35 个 AutoLogger 会话 Start=0；服务层停止并禁用 DiagTrack/dmwappushservice/diagnosticshub。策略+任务+日志+服务四层一体掐断遥测采集与上传。',
    steps: [
      { label: '遥测与广告策略', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection': { 'AllowTelemetry': 'dword:00000000' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\DataCollection': { 'AllowTelemetry': 'dword:00000000' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Policies\\DataCollection': { 'AllowTelemetry': 'dword:00000000' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\AdvertisingInfo': { 'DisabledByGroupPolicy': 'dword:00000001' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\DeliveryOptimization\\Config': { 'DownloadMode': 'dword:00000000' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo': { 'Enabled': 'dword:00000000' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\AppHost': { 'EnableWebContentEvaluation': 'dword:00000000' },
        'HKEY_CURRENT_USER\\Control Panel\\International\\User Profile': { 'HttpAcceptLanguageOptOut': 'dword:00000001' }
      }) },
      { label: '禁用遥测计划任务', pwsh: [
        '$tasks = @(',
        '"\\Microsoft\\Windows\\Application Experience\\Microsoft Compatibility Appraiser",',
        '"\\Microsoft\\Windows\\Application Experience\\ProgramDataUpdater",',
        '"\\Microsoft\\Windows\\Application Experience\\StartupAppTask",',
        '"\\Microsoft\\Windows\\Autochk\\Proxy",',
        '"\\Microsoft\\Windows\\Customer Experience Improvement Program\\Consolidator",',
        '"\\Microsoft\\Windows\\Customer Experience Improvement Program\\UsbCeip",',
        '"\\Microsoft\\Windows\\Customer Experience Improvement Program\\KernelCeipTask",',
        '"\\Microsoft\\Windows\\Customer Experience Improvement Program\\HypervisorFlightingTask",',
        '"\\Microsoft\\Windows\\DiskDiagnostic\\Microsoft-Windows-DiskDiagnosticDataCollector",',
        '"\\Microsoft\\Windows\\Feedback\\Siuf\\DmClient",',
        '"\\Microsoft\\Windows\\Feedback\\Siuf\\DmClientOnScenarioDownload",',
        '"\\Microsoft\\Windows\\Maps\\MapsToastTask",',
        '"\\Microsoft\\Windows\\Maps\\MapsUpdateTask",',
        '"\\Microsoft\\Windows\\PI\\Sqm-Tasks",',
        '"\\Microsoft\\Windows\\Power Efficiency Diagnostics\\AnalyzeSystem",',
        '"\\Microsoft\\Windows\\Windows Error Reporting\\QueueReporting",',
        '"\\Microsoft\\Windows\\Media Center\\ActivateWindowsSearch",',
        '"\\Microsoft\\Windows\\Media Center\\ConfigureInternetTimeService",',
        '"\\Microsoft\\Windows\\Media Center\\DispatchRecoveryTasks",',
        '"\\Microsoft\\Windows\\Media Center\\ehDRMInit",',
        '"\\Microsoft\\Windows\\Media Center\\InstallPlayReady",',
        '"\\Microsoft\\Windows\\Media Center\\mcupdate",',
        '"\\Microsoft\\Windows\\Media Center\\MediaCenterRecoveryTask",',
        '"\\Microsoft\\Windows\\Media Center\\ObjectStoreRecoveryTask",',
        '"\\Microsoft\\Windows\\Media Center\\PvrScheduleTask",',
        '"\\Microsoft\\Windows\\Media Center\\RegisterSearch",',
        '"\\Microsoft\\Windows\\Media Center\\ReindexSearchRoot",',
        '"\\Microsoft\\Windows\\Office\\OfficeTelemetryAgentFallBack",',
        '"\\Microsoft\\Windows\\Office\\OfficeTelemetryAgentLogOn",',
        '"\\Microsoft\\Office\\OfficeTelemetryAgentFallBack2016",',
        '"\\Microsoft\\Office\\OfficeTelemetryAgentLogOn2016",',
        '"\\Microsoft\\Windows\\CloudExperienceHost\\CreateObjectTask",',
        '"\\Microsoft\\Windows\\AppxDeploymentClient\\Pre-staged app cleanup",',
        '"\\Microsoft\\Windows\\ApplicationData\\DsSvcCleanup"',
        ')',
        'foreach ($t in $tasks) { schtasks /change /tn $t /disable 2>$null | Out-Null }'
      ].join('\n') },
      { label: 'AutoLogger Start=0', pwsh: [
        '$root = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\WMI\\Autologger"',
        'if (Test-Path $root) { Get-ChildItem $root | ForEach-Object { New-ItemProperty -Path $_.PSPath -Name Start -Value 0 -PropertyType DWord -Force | Out-Null } }'
      ].join('\n') },
      { label: '停止遥测服务', pwsh: [
        'foreach ($s in @("DiagTrack","dmwappushservice","diagnosticshub.standardcollector.service")) { Stop-Service -Name $s -Force -ErrorAction SilentlyContinue; sc.exe config $s start= disabled 2>$null | Out-Null }'
      ].join('\n') }
    ]
  },
  {
    id: 'power_off', group: '安全与隐私', title: '禁用电源节能', risk: 'medium',
    desc: '关闭快速启动、USB/PCIe 省电、核心停放与节流（台式机推荐，笔记本会增加耗电）。',
    steps: [
      { label: '关闭节能/快速启动', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power': { 'HiberbootEnabled': 'dword:00000000' },
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Power': { 'HibernateEnabledDefault': 'dword:00000000' },
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Power\\PowerThrottling': { 'PowerThrottlingOff': 'dword:00000001' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\DriverSearching': { 'SearchOrderConfig': 'dword:00000000' },
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Power\\PowerSettings\\54533251-82be-4824-96c1-47b60b740d00\\943c8cb6-6f93-4227-ad87-e9a3feec08d1': { 'Attributes': 'dword:00000002' }
      }) }
    ]
  },
  {
    id: 'tf_defender', group: '安全与隐私', title: '关闭 Defender 与 SmartScreen', risk: 'high',
    desc: 'TuneForge：禁用 Microsoft Defender 反间谍/实时保护/云上报/SmartScreen/Edge 钓鱼过滤，并停用 Sense、WinDefend、WdNisSvc、SecurityHealthService、wscsvc（高风险，系统将无杀毒防护）。',
    steps: [
      { label: 'Defender 策略与服务', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Reporting': { 'DisableGenericRePorts': 'dword:00000001', 'DisableEnhancedNotifications': 'dword:00000001' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Spynet': { 'DisableBlockAtFirstSeen': 'dword:00000001', 'LocalSettingOverrideSpynetReporting': 'dword:00000000', 'SubmitSamplesConsent': 'dword:00000002' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\SmartScreen': { 'ConfigureAppInstallControlEnabled': 'dword:00000000' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Threats': { 'Threats_ThreatSeverityDefaultAction': 'dword:00000001' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\UX Configuration': { 'Notification_Suppress': 'dword:00000001' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows Defender': { 'DisableAntiSpyware': 'dword:00000001', 'DisableRoutinelyTakingAction': 'dword:00000001', 'ServiceKeepAlive': 'dword:00000000' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection': { 'DisableRealtimeMonitoring': 'dword:00000001', 'DisableBehaviorMonitoring': 'dword:00000001', 'DisableOnAccessProtection': 'dword:00000001', 'DisableScanOnRealtimeEnable': 'dword:00000001' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\System': { 'EnableSmartScreen': 'dword:00000000' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\MicrosoftEdge\\PhishingFilter': { 'EnabledV9': 'dword:00000000' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\MRT': { 'DontReportInfectionInformation': 'dword:00000001' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsErrorReporting\\SecurityCenter': { 'DisableSecurityCenter': 'dword:00000001' },
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Sense': { 'Start': 'dword:00000004' },
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\WdNisSvc': { 'Start': 'dword:00000004' },
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\WinDefend': { 'Start': 'dword:00000004' },
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\SecurityHealthService': { 'Start': 'dword:00000004' },
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\wscsvc': { 'Start': 'dword:00000004' }
      }) },
      { label: 'Defender 威胁默认动作(字符串6)', pwsh: [
        '$base = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Threats\\ThreatSeverityDefaultAction"',
        'New-Item -Path $base -Force | Out-Null',
        'foreach ($k in @("1","2","4","5")) { New-ItemProperty -Path $base -Name $k -Value "6" -PropertyType String -Force | Out-Null }'
      ].join('\n') }
    ]
  },
  {
    id: 'tf_privacy', group: '安全与隐私', title: '系统隐私设置', risk: 'medium',
    desc: 'TuneForge 隐私大项：关闭内容推荐/广告 ID、开始菜单建议、操作中心通知、跨设备同步(CDP)、定制化体验、反馈频次、锁屏建议、错误报告(WER)、实验性体验、TaggedEnergy，并停用 GpuEnergyDrv（麦克风/摄像头权限保留允许）。',
    steps: [
      { label: '隐私注册表键', reg: regBlock({
        'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager': {
          'ContentDeliveryAllowed': 'dword:00000000', 'OemPreInstalledAppsEnabled': 'dword:00000000',
          'PreInstalledAppsEnabled': 'dword:00000000', 'PreInstalledAppsEverEnabled': 'dword:00000000',
          'SilentInstalledAppsEnabled': 'dword:00000000', 'SubscribedContent-310093Enabled': 'dword:00000000',
          'SubscribedContent-338388Enabled': 'dword:00000000', 'SubscribedContent-338389Enabled': 'dword:00000000',
          'SubscribedContent-353698Enabled': 'dword:00000000', 'SystemPaneSuggestionsEnabled': 'dword:00000000',
          'RotatingLockScreenEnabled': 'dword:00000000', 'RotatingLockScreenOverlayEnabled': 'dword:00000000'
        },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\CloudContent': {
          'DisableWindowsConsumerFeatures': 'dword:00000001', 'DisableSoftLanding': 'dword:00000001',
          'DisableWindowsSpotlightFeatures': 'dword:00000001', 'DisableTailoredExperiencesWithDiagnosticData': 'dword:00000001'
        },
        'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': {
          'Start_TrackProgs': 'dword:00000000'
        },
        'HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Microsoft\\Windows\\Explorer': {
          'ShowOrHideMostUsedApps': 'dword:00000000'
        },
        'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer': {
          'NoInstrumentation': 'dword:00000001'
        },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\AdvertisingInfo': {
          'DisabledByGroupPolicy': 'dword:00000001'
        },
        'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo': {
          'Enabled': 'dword:00000000'
        },
        'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Search': {
          'CortanaConsent': 'dword:00000000', 'BingSearchEnabled': 'dword:00000000',
          'DeviceHistoryEnabled': 'dword:00000000', 'HistoryViewEnabled': 'dword:00000000'
        },
        'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\PushNotifications': {
          'ToastEnabled': 'dword:00000000'
        },
        'HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Microsoft\\Windows\\Explorer': {
          'DisableSearchBoxSuggestions': 'dword:00000001'
        },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection': {
          'AllowTelemetry': 'dword:00000000', 'AllowDeviceNameInTelemetry': 'dword:00000000',
          'MaxTelemetryAllowed': 'dword:00000000'
        },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\DataCollection': {
          'AllowTelemetry': 'dword:00000000'
        },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Error Reporting': {
          'Disabled': 'dword:00000001', 'DontSendAdditionalData': 'dword:00000001',
          'LoggingDisabled': 'dword:00000001', 'AutoApproveOSDumps': 'dword:00000000',
          'DontShowUI': 'dword:00000001'
        },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting': {
          'Disabled': 'dword:00000001'
        },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\PreviewBuilds': {
          'AllowBuildPreview': 'dword:00000000'
        },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\System': {
          'EnableExperimentation': 'dword:00000000'
        },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection': {
          'DoNotShowFeedbackNotifications': 'dword:00000001'
        },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Diagnostics\\DiagTrack': {
          'ShowedToastAtLevel': 'dword:00000001'
        },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\PolicyManager\\current\\device\\System\\AllowExperimentation': {
          'value': 'dword:00000000'
        },
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\GpuEnergyDrv': {
          'Start': 'dword:00000004'
        }
      }) },
      { label: 'QuietHours 通知关闭与反馈频率', pwsh: [
        '$qh = "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings"',
        'New-Item -Path $qh -Force | Out-Null',
        'New-ItemProperty -Path $qh -Name NOC_GLOBAL_SETTING_TOASTS_ENABLED -Value 0 -PropertyType DWord -Force | Out-Null',
        '$fb = "HKCU:\\SOFTWARE\\Microsoft\\Siuf\\Rules"',
        'New-Item -Path $fb -Force | Out-Null',
        'New-ItemProperty -Path $fb -Name NumberOfSIUFInPeriod -Value 0 -PropertyType DWord -Force | Out-Null',
        'New-ItemProperty -Path $fb -Name PeriodInNanoSeconds -Value 0 -PropertyType QWord -Force | Out-Null'
      ].join('\n') }
    ]
  },
  // ---------- 系统精简（原「系统清理」已并入） ----------
  // 注：「清理临时文件」已移除，功能由「磁盘清理」覆盖。
  // ---------- 显卡优化 ----------
  {
    id: 'tf_gpu_msi', group: '显卡优化', title: '显卡启用 MSI 中断模式', risk: 'medium',
    desc: 'TuneForge：遍历所有 PCI 显卡（wmic Win32_VideoController 已改写为 Get-CimInstance），在其 Enum 设备参数下开启 MSISupported=1 并将 Affinity Policy 的 DevicePriority=0，降低显卡中断延迟（极少数老驱动可能不兼容）。',
    steps: [
      { label: 'GPU MSI + DevicePriority', pwsh: [
        'Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -like "PCI*" } | ForEach-Object {',
        '  $enum = "HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\" + $_.PNPDeviceID',
        '  $msi = Join-Path $enum "Device Parameters\\Interrupt Management\\MessageSignaledInterruptProperties"',
        '  $aff = Join-Path $enum "Device Parameters\\Interrupt Management\\Affinity Policy"',
        '  New-Item -Path $msi -Force | Out-Null; New-ItemProperty -Path $msi -Name MSISupported -Value 1 -PropertyType DWord -Force | Out-Null',
        '  New-Item -Path $aff -Force | Out-Null; New-ItemProperty -Path $aff -Name DevicePriority -Value 0 -PropertyType DWord -Force | Out-Null',
        '}'
      ].join('\n') }
    ]
  },
  {
    id: 'tf_nvidia_telemetry', group: '显卡优化', title: 'NVIDIA：关闭遥测与自动更新', risk: 'low',
    desc: 'TuneForge：删除开机启动 NvBackend，OptInOrOutPreference=0，FTS EnableRID66610/64640/44231=0，并禁用 7 个 NvTm/NvDriverUpdateCheck/GeForce Experience SelfUpdate 计划任务（仅 NVIDIA 系统有对应项，缺失自动跳过）。',
    steps: [
      { label: 'NVIDIA 遥测注册表', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\NVIDIA Corporation\\NvControlPanel2\\Client': { 'OptInOrOutPreference': 'dword:00000000' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\NVIDIA Corporation\\Global\\FTS': { 'EnableRID66610': 'dword:00000000', 'EnableRID64640': 'dword:00000000', 'EnableRID44231': 'dword:00000000' }
      }) },
      { label: '删除 NvBackend 启动项', pwsh: [
        'Remove-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" -Name NvBackend -Force -ErrorAction SilentlyContinue',
        '$sfx = "_{B2FE1952-0186-46C3-BAEC-A80AA35AC5B8}"',
        'foreach ($t in @("NvTmRep_CrashReport1","NvTmRep_CrashReport2","NvTmRep_CrashReport3","NvTmRep_CrashReport4","NvDriverUpdateCheckDaily","NVIDIA GeForce Experience SelfUpdate","NvTmMon")) { schtasks /change /tn ($t + $sfx) /disable 2>$null | Out-Null }'
      ].join('\n') }
    ]
  },

  // ---------- 键鼠与外设 ----------
  {
    id: 'tf_keys_sticky', group: '键鼠与外设', title: '彻底禁用粘滞/筛选/切换键', risk: 'low',
    desc: 'TuneForge KBM：StickyKeys Flags="506"、Keyboard Response(筛选键) Flags="122"、ToggleKeys Flags="58"，连按 Shift 8 秒等误触发快捷键全部失效。',
    steps: [
      { label: '辅助功能热键 Flags', reg: regBlock({
        'HKEY_CURRENT_USER\\Control Panel\\Accessibility\\StickyKeys': { 'Flags': '506' },
        'HKEY_CURRENT_USER\\Control Panel\\Accessibility\\Keyboard Response': { 'Flags': '122' },
        'HKEY_CURRENT_USER\\Control Panel\\Accessibility\\ToggleKeys': { 'Flags': '58' }
      }) }
    ]
  },
  {
    id: 'tf_usb_msi', group: '键鼠与外设', title: 'USB 控制器启用 MSI 中断', risk: 'medium',
    desc: 'TuneForge：遍历所有 PCI USB 控制器（wmic Win32_USBController 已改写为 Get-CimInstance），开启 MSISupported=1、DevicePriority=0，降低 USB 轮询中断延迟（电竞鼠标/键盘推荐）。',
    steps: [
      { label: 'USB MSI + DevicePriority', pwsh: [
        'Get-CimInstance Win32_USBController | Where-Object { $_.PNPDeviceID -like "PCI*" } | ForEach-Object {',
        '  $enum = "HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\" + $_.PNPDeviceID',
        '  $msi = Join-Path $enum "Device Parameters\\Interrupt Management\\MessageSignaledInterruptProperties"',
        '  $aff = Join-Path $enum "Device Parameters\\Interrupt Management\\Affinity Policy"',
        '  New-Item -Path $msi -Force | Out-Null; New-ItemProperty -Path $msi -Name MSISupported -Value 1 -PropertyType DWord -Force | Out-Null',
        '  New-Item -Path $aff -Force | Out-Null; New-ItemProperty -Path $aff -Name DevicePriority -Value 0 -PropertyType DWord -Force | Out-Null',
        '}'
      ].join('\n') }
    ]
  },
  {
    id: 'tf_usb_power', group: '键鼠与外设', title: '关闭 USB 选择性暂停', risk: 'low',
    desc: 'TuneForge：所有 USB 控制器 Device Parameters 下 AllowIdleIrpInD3/D3ColdSupported/DeviceSelectiveSuspended/EnableSelectiveSuspend/EnhancedPowerManagementEnabled/SelectiveSuspendEnabled/SelectiveSuspendOn 全部=0，Services\\USB DisableSelectiveSuspend=1，杜绝鼠标键盘间歇掉线。',
    steps: [
      { label: 'USB 省电键=0', pwsh: [
        '$keys = @("AllowIdleIrpInD3","D3ColdSupported","DeviceSelectiveSuspended","EnableSelectiveSuspend","EnhancedPowerManagementEnabled","SelectiveSuspendEnabled","SelectiveSuspendOn")',
        'Get-CimInstance Win32_USBController | Where-Object { $_.PNPDeviceID -like "PCI*" } | ForEach-Object {',
        '  $dp = "HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\" + $_.PNPDeviceID + "\\Device Parameters"',
        '  if (Test-Path $dp) { foreach ($n in $keys) { New-ItemProperty -Path $dp -Name $n -Value 0 -PropertyType DWord -Force | Out-Null } }',
        '}',
        'New-Item -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\USB" -Force | Out-Null; New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\USB" -Name DisableSelectiveSuspend -Value 1 -PropertyType DWord -Force | Out-Null'
      ].join('\n') }
    ]
  },
  {
    id: 'mouse_optimize', group: '键鼠与外设', title: '鼠标优化', risk: 'medium',
    desc: '合并原「鼠标：去加速 + 6/11 灵敏度」与「清空平滑鼠标曲线」：MouseSpeed/MouseThreshold1/MouseThreshold2="0" 彻底关闭"提高指针精确度"（鼠标加速），MouseSensitivity="10" 即 6/11 中位灵敏度，SmoothMouseXCurve/YCurve 写入 0 字节清空平滑曲线，指针移动完全线性 1:1，电竞瞄准更精准（少数驱动会重建曲线值，需重启后生效）。',
    steps: [
      { label: '鼠标加速关闭 + 6/11 灵敏度', reg: regBlock({
        'HKEY_CURRENT_USER\\Control Panel\\Mouse': {
          'MouseSpeed': '"0"', 'MouseThreshold1': '"0"', 'MouseThreshold2': '"0"', 'MouseSensitivity': '"10"'
        }
      }) },
      { label: 'SmoothMouse 曲线清零', pwsh: [
        '$zero = New-Object byte[] 40',
        '$m = "HKCU:\\Control Panel\\Mouse"',
        'New-ItemProperty -Path $m -Name SmoothMouseXCurve -Value $zero -PropertyType Binary -Force | Out-Null',
        'New-ItemProperty -Path $m -Name SmoothMouseYCurve -Value $zero -PropertyType Binary -Force | Out-Null'
      ].join('\n') }
    ]
  },
  {
    id: 'tf_keyboard', group: '键鼠与外设', title: '键盘：零延迟 + 队列深度', risk: 'low',
    desc: 'TuneForge：KeyboardDelay="0"、KeyboardSpeed="31"（控制面板里最短重复延迟/最快重复速度），mouclass MouseDataQueueSize=16、kbdclass KeyboardDataQueueSize=16、kernel DebugPollInterval=1000，减少输入排队延迟。',
    steps: [
      { label: '键盘/鼠标类参数', reg: regBlock({
        'HKEY_CURRENT_USER\\Control Panel\\Keyboard': { 'KeyboardDelay': '0', 'KeyboardSpeed': '31' },
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\mouclass\\Parameters': { 'MouseDataQueueSize': 'dword:00000010' },
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\kbdclass\\Parameters': { 'KeyboardDataQueueSize': 'dword:00000010' },
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\kernel': { 'DebugPollInterval': 'dword:000003e8' }
      }) }
    ]
  },
  {
    id: 'tf_dev_disable', group: '键鼠与外设', title: '禁用 24 个冗余板载设备', risk: 'high',
    desc: 'TuneForge DisableDevices（DevManView 已改写为 Disable-PnpDevice，按设备名匹配）：高精度事件定时器(HPET)、GS 波表合成、RRAS 根枚举、Intel ME/MEI/SMBus、SM Bus、Amdlog、AMD PSP、系统扬声器、复合总线枚举、虚拟驱动器枚举、Hyper-V 虚拟化基础结构、NDIS 虚拟网卡枚举、远程桌面重定向总线、UMBus、7 个 WAN Miniport 等（已剔除 IPv6 相关虚拟适配器，遵守项目硬约束）。禁用 HPET/ME 属高风险，可能影响设备管理或虚拟化。',
    steps: [
      { label: '按名称禁用设备', pwsh: [
        '$names = @("High Precision Event Timer","Microsoft GS Wavetable Synth","Microsoft RRAS Root Enumerator","Intel Management Engine","Intel Management Engine Interface","Intel SMBus","SM Bus Controller","Amdlog","AMD PSP","System Speaker","Composite Bus Enumerator","Microsoft Virtual Drive Enumerator","Microsoft Hyper-V Virtualization Infrastructure Driver","NDIS Virtual Network Adapter Enumerator","Remote Desktop Device Redirector Bus","UMBus Root Bus Enumerator","WAN Miniport (IP)","WAN Miniport (IKEv2)","WAN Miniport (L2TP)","WAN Miniport (PPPOE)","WAN Miniport (PPTP)","WAN Miniport (SSTP)","WAN Miniport (Network Monitor)")',
        'foreach ($n in $names) { Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -eq $n -and $_.Status -eq "OK" } | Disable-PnpDevice -Confirm:$false -ErrorAction SilentlyContinue }'
      ].join('\n') }
    ]
  },
  {
    id: 'tf_dev_audio', group: '键鼠与外设', title: '禁用高清音频控制器', risk: 'high',
    desc: 'TuneForge 可选项：禁用 "High Definition Audio Controller"（HDMI/DP 声卡与板载声卡会消失，仅在使用独立 USB 声卡且想彻底禁用板载音频时使用）。',
    steps: [
      { label: '禁用 HD Audio Controller', pwsh: [
        'Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -eq "High Definition Audio Controller" -and $_.Status -eq "OK" } | Disable-PnpDevice -Confirm:$false -ErrorAction SilentlyContinue'
      ].join('\n') }
    ]
  },
  {
    id: 'tf_dev_printer', group: '键鼠与外设', title: '禁用打印队列设备', risk: 'high',
    desc: 'TuneForge 可选项：禁用 "Root Print Queue" 打印队列根设备（无打印机的机器可禁用；有打印机请勿使用）。',
    steps: [
      { label: '禁用 Root Print Queue', pwsh: [
        'Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -eq "Root Print Queue" -and $_.Status -eq "OK" } | Disable-PnpDevice -Confirm:$false -ErrorAction SilentlyContinue'
      ].join('\n') }
    ]
  },
  {
    id: 'tf_pccleaner', group: '系统精简', title: 'PCCleaner 深度清理', risk: 'medium',
    desc: 'TuneForge PCCleaner 完整清单：Windows Temp、Prefetch、%temp%、系统盘 .tmp/._mp/.log/.gid/.chk/.old、回收站、Windows .bak、缩略图 db、CBS/DISM 日志、历史/Cookies/Recent/打印后台缓存（日志文件会一并删除）。',
    steps: [
      { label: 'TuneForge 清理路径清单', pwsh: [
        '$paths = @("C:\\Windows\\Temp","C:\\Windows\\tmp","C:\\Windows\\Prefetch",$env:TEMP,"C:\\Windows\\history","C:\\Windows\\cookies","C:\\Windows\\recent","C:\\Windows\\spool\\printers","C:\\Windows\\Logs\\CBS","C:\\Windows\\Logs\\DISM")',
        'foreach ($p in $paths) { if (Test-Path $p) { Get-ChildItem -Path $p -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue } }',
        '$patterns = @("*.tmp","*._mp","*.log","*.gid","*.chk","*.old","*.bak","ff*.tmp")',
        'foreach ($pat in $patterns) { Get-ChildItem -Path $env:SystemDrive -Filter $pat -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue }',
        'Get-ChildItem "$env:LocalAppData\\Microsoft\\Windows\\Explorer" -Include "*.db" -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue',
        'Clear-RecycleBin -Force -ErrorAction SilentlyContinue'
      ].join('\n') }
    ]
  },
  // ---------- 系统精简 ----------
  {
    id: 'tf_appx', group: '系统精简', title: '移除 25 个内置 UWP 应用', risk: 'high',
    desc: 'TuneForge Debloat：按名称通配移除所有用户下的预装 AppX——3D Builder、Bing 全家桶（资讯/财经/体育/天气）、CommsPhone、Drawboard PDF、Facebook、Getstarted、Messaging、Office Hub、OneNote、人脉、Skype、纸牌合集、Sway、Twitter、闹钟时钟、手机、地图、反馈中心、录音机、邮件日历、Zune（Groove/影视）等。移除后部分应用需从商店重装。',
    steps: [
      { label: '移除预装 AppX 清单', pwsh: [
        '$apps = @("*3DBuilder*","*bing*","*bingfinance*","*bingsports*","*BingWeather*","*CommsPhone*","*Drawboard PDF*","*Facebook*","*Getstarted*","*Microsoft.Messaging*","*MicrosoftOfficeHub*","*Office.OneNote*","*OneNote*","*people*","*SkypeApp*","*solit*","*Sway*","*Twitter*","*WindowsAlarms*","*WindowsPhone*","*WindowsMaps*","*WindowsFeedbackHub*","*WindowsSoundRecorder*","*windowscommunicationsapps*","*zune*")',
        'foreach ($a in $apps) { Get-AppxPackage -AllUsers -Name $a -ErrorAction SilentlyContinue | Remove-AppxPackage -ErrorAction SilentlyContinue }'
      ].join('\n') }
    ]
  },
  {
    id: 'tf_cortana', group: '系统精简', title: '禁用 Cortana 与网页搜索', risk: 'medium',
    desc: 'TuneForge DisableCortana：写入 Windows Search 策略（AllowCortana/AllowCloudSearch/AllowCortanaAboveLock/AllowSearchToUseLocation/ConnectedSearchUseWeb/ConnectedSearchUseWebOverMeteredConnections=0，DisableWebSearch=1——已修正 TuneForge 原版此处反写成 0 的 bug），并卸载 Cortana AppX（Microsoft.549981C3F5F10）。',
    steps: [
      {
        label: 'Cortana / 网页搜索策略', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search': {
            'AllowCortana': 'dword:00000000',
            'AllowCloudSearch': 'dword:00000000',
            'AllowCortanaAboveLock': 'dword:00000000',
            'AllowSearchToUseLocation': 'dword:00000000',
            'ConnectedSearchUseWeb': 'dword:00000000',
            'ConnectedSearchUseWebOverMeteredConnections': 'dword:00000000',
            'DisableWebSearch': 'dword:00000001'
          }
        })
      },
      { label: '卸载 Cortana AppX', pwsh: [
        'Get-AppxPackage -AllUsers -Name "*Microsoft.549981C3F5F10*" -ErrorAction SilentlyContinue | Remove-AppxPackage -ErrorAction SilentlyContinue'
      ].join('\n') }
    ]
  },
  {
    id: 'tf_onedrive', group: '系统精简', title: '彻底卸载 OneDrive', risk: 'high',
    desc: 'TuneForge DisableOneDrive：运行 OneDriveSetup /UNINSTALL，删除 OneDriveTemp、用户/本机/ProgramData 下的 OneDrive 数据目录，清空资源管理器左栏 OneDrive 入口 CLSID 属性（HKCR 与 Wow6432Node 双 hive），并写入禁用文件同步的组策略（DisableFileSync/DisableFileSyncNGSC=1）。',
    steps: [
      { label: '运行 OneDrive 卸载器', pwsh: [
        '$setup = Join-Path $env:SystemRoot "SYSWOW64\\ONEDRIVESETUP.EXE"',
        'if (Test-Path $setup) { Start-Process -FilePath $setup -ArgumentList "/UNINSTALL" -Wait -NoNewWindow }'
      ].join('\n') },
      { label: '删除 OneDrive 数据目录', pwsh: [
        '@("C:\\OneDriveTemp", "$env:USERPROFILE\\OneDrive", "$env:LOCALAPPDATA\\Microsoft\\OneDrive", "$env:PROGRAMDATA\\Microsoft OneDrive") | ForEach-Object { if (Test-Path $_) { Remove-Item $_ -Recurse -Force -ErrorAction SilentlyContinue } }'
      ].join('\n') },
      {
        label: 'OneDrive 入口 / 策略', reg: regBlock({
          'HKEY_CLASSES_ROOT\\CLSID\\{018D5C66-4533-4307-9B53-224DE2ED1FE6}\\ShellFolder': { 'Attributes': 'dword:00000000' },
          'HKEY_CLASSES_ROOT\\Wow6432Node\\CLSID\\{018D5C66-4533-4307-9B53-224DE2ED1FE6}\\ShellFolder': { 'Attributes': 'dword:00000000' },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\OneDrive': {
            'DisableFileSync': 'dword:00000001',
            'DisableFileSyncNGSC': 'dword:00000001',
            'DisableMeteredNetworkFileSync': 'dword:00000000',
            'DisableLibrariesDefaultSaveToOneDrive': 'dword:00000000'
          }
        })
      }
    ]
  },
  {
    id: 'tf_oosu', group: '系统精简', title: 'OOSU 隐私工具静默导入', risk: 'medium',
    desc: 'TuneForge RunOOSU：下载 O&O ShutUp10 便携版到临时目录，并下载 ANCELOOSUIMPORT.cfg 配置到 C 盘，静默导入配置后退出（需要联网下载，配置由 TuneForge 官方仓库提供）。',
    steps: [
      { label: '下载 OOSU 与配置', pwsh: [
        '$oosu = Join-Path $env:TEMP "OOSU10.exe"',
        'Invoke-WebRequest "https://dl5.oo-software.com/files/ooshutup10/OOSU10.exe" -OutFile $oosu -UseBasicParsing',
        'Invoke-WebRequest "https://github.com/ancel1x/Ancels-Performance-Batch/raw/main/bin/ANCELOOSUIMPORT.cfg" -OutFile "C:\\ANCELOOSUIMPORT.cfg" -UseBasicParsing'
      ].join('\n') },
      { label: '静默导入配置', pwsh: [
        '$oosu = Join-Path $env:TEMP "OOSU10.exe"',
        'if (Test-Path $oosu) { Start-Process -FilePath $oosu -ArgumentList "C:\\ANCELOOSUIMPORT.cfg" -Wait }'
      ].join('\n') }
    ]
  },
  // ---------- 音频优化（对齐 TuneForge BuildAudioModule） ----------
  {
    id: 'audio_disable_enhancements', group: '音频优化', title: '关闭音频增强', risk: 'medium',
    desc: '为所有播放设备关闭系统音频增强处理（Enhancements），减少额外音效加工，让游戏与媒体声音更干净稳定。',
    steps: [
      {
        label: '遍历渲染设备关闭增强', pwsh: [
          '$render = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render"',
          'if (Test-Path $render) { Get-ChildItem $render | ForEach-Object { $fx = Join-Path $_.PSPath "FxProperties"; if (Test-Path $fx) { New-ItemProperty -Path $fx -Name "{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},5" -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null } } }'
        ].join('\n')
      }
    ]
  },
  {
    id: 'audio_disable_spatial_sound', group: '音频优化', title: '关闭空间音效', risk: 'medium',
    desc: '关闭 Windows Sonic / Dolby Atmos 等虚拟环绕声，让原始声道信号直达耳机/音箱；需确认空间音效体验变化。',
    steps: [
      {
        label: '关闭空间音效', pwsh: [
          '$render = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render"',
          'if (Test-Path $render) { Get-ChildItem $render | ForEach-Object { $fx = Join-Path $_.PSPath "FxProperties"; if (Test-Path $fx) { New-ItemProperty -Path $fx -Name "{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},7" -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null } } }'
        ].join('\n')
      }
    ]
  },
  {
    id: 'audio_mmcss_priority', group: '音频优化', title: '提高音频任务优先级', risk: 'medium',
    desc: '将 MMCSS Audio 任务 Priority 设为 6、Scheduling Category 设为 Pro Audio，提升音频线程调度优先级；不会启用应用或音频端点的独占模式。',
    steps: [
      {
        label: 'MMCSS Audio Priority=6 / Pro Audio', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Audio': {
            'Priority': 'dword:00000006',
            'Scheduling Category': '"Pro Audio"'
          }
        })
      }
    ]
  },
  {
    id: 'audio_mmcss_schedule', group: '音频优化', title: '调整音频任务调度', risk: 'medium',
    desc: '调整 MMCSS Audio 任务的 Affinity、Scheduling Category 与 SFIO Priority，优化音频线程核心分布与 IO 优先级；Priority 由「提高音频任务优先级」独立管理。',
    steps: [
      {
        label: 'MMCSS Audio Affinity/SFIO', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Audio': {
            'Affinity': 'dword:00000000',
            'SFIO Priority': '"High"',
            'Background Only': '"False"',
            'Clock Rate': 'dword:00002710'
          }
        })
      }
    ]
  },
  {
    id: 'audio_disable_comm_ducking', group: '音频优化', title: '关闭通讯优先压低', risk: 'medium',
    desc: '禁用 Windows 检测到通讯活动时自动压低其他声音的逻辑（Communications Ducking），避免游戏/媒体音量被通话突然压低。',
    steps: [
      {
        label: '关闭通讯压低', pwsh: [
          '$paths = @("HKCU:\\Software\\Microsoft\\Multimedia\\Audio","HKCU:\\Software\\Microsoft\\Multimedia\\Audio\\User")',
          'foreach ($p in $paths) { New-Item -Path $p -Force | Out-Null; New-ItemProperty -Path $p -Name "CommDucking" -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null }',
          '$ap = "HKCU:\\Software\\Microsoft\\Multimedia\\Audio\\Ducking\\Mode"',
          'New-Item -Path $ap -Force | Out-Null; New-ItemProperty -Path $ap -Name "Default" -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null'
        ].join('\n')
      }
    ]
  },
  {
    id: 'audio_disable_service_restart', group: '音频优化', title: '禁用 Windows Audio 延迟启动', risk: 'medium',
    desc: '将 Audiosrv 的 DelayedAutoStart 设为 0，让 Windows 音频服务随系统同步启动；不会更改 AudioEndpointBuilder 或服务故障恢复策略。',
    steps: [
      {
        label: 'Audiosrv DelayedAutoStart=0', pwsh: [
          '$p = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Audiosrv"',
          'if (Test-Path $p) { New-ItemProperty -Path $p -Name DelayedAutoStart -Value 0 -PropertyType DWord -Force | Out-Null }'
        ].join('\n')
      }
    ]
  },
  {
    id: 'audio_disable_voice_activation', group: '音频优化', title: '关闭应用语音激活', risk: 'medium',
    desc: 'AgentActivationEnabled=0，阻止支持的应用使用语音激活服务，减少后台麦克风监听。',
    steps: [
      {
        label: '关闭应用语音激活', pwsh: [
          '$p = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture\\{{0}}"',
          '$base = "HKLM:\\SOFTWARE\\Microsoft\\Speech_OneCore\\Settings"',
          'New-Item -Path $base -Force | Out-Null; New-ItemProperty -Path $base -Name "AgentActivationEnabled" -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null',
          '$p2 = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Speech"',
          'New-Item -Path $p2 -Force | Out-Null; New-ItemProperty -Path $p2 -Name "AgentActivationEnabled" -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null'
        ].join('\n')
      }
    ]
  },
  {
    id: 'audio_disable_voice_activation_last_used', group: '音频优化', title: '关闭语音激活最近使用记录', risk: 'medium',
    desc: 'AgentActivationLastUsed=0，阻止 SpeechOneCore 记住语音激活最近使用状态；依赖语音唤醒或语音助手的应用可能需要重新确认偏好。',
    steps: [
      {
        label: '关闭语音激活最近使用记录', pwsh: [
          '$base = "HKLM:\\SOFTWARE\\Microsoft\\Speech_OneCore\\Settings"',
          'New-Item -Path $base -Force | Out-Null; New-ItemProperty -Path $base -Name "AgentActivationLastUsed" -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null',
          '$p2 = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Speech"',
          'New-Item -Path $p2 -Force | Out-Null; New-ItemProperty -Path $p2 -Name "AgentActivationLastUsed" -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null'
        ].join('\n')
      }
    ]
  },
  {
    id: 'audio_disable_narrator_ducking', group: '音频优化', title: '关闭讲述人压低其他应用音量', risk: 'medium',
    desc: 'DuckAudio=0，关闭讲述人说话时自动降低其他应用音量；依赖讲述人的用户需要手动平衡音量。',
    steps: [
      {
        label: '关闭讲述人压低音量', pwsh: [
          '$p = "HKCU:\\Software\\Microsoft\\Narrator\\NoRoam"',
          'New-Item -Path $p -Force | Out-Null; New-ItemProperty -Path $p -Name "DuckAudio" -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null',
          '$p2 = "HKLM:\\SOFTWARE\\Microsoft\\Narrator\\NoRoam"',
          'New-Item -Path $p2 -Force | Out-Null; New-ItemProperty -Path $p2 -Name "DuckAudio" -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null'
        ].join('\n')
      }
    ]
  },
  // ---------- 桌面体验（对齐 TuneForge BuildExplorerModule） ----------
  {
    id: 'desktop_show_ext', group: '桌面体验', title: '显示文件扩展名', risk: 'medium',
    desc: 'HideFileExt=0，使所有文件始终显示其扩展名，防止伪装成文档的恶意程序。',
    steps: [
      {
        label: '显示文件扩展名', reg: regBlock({
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': {
            'HideFileExt': 'dword:00000000'
          }
        })
      }
    ]
  },
  {
    id: 'desktop_show_hidden', group: '桌面体验', title: '显示隐藏文件和文件夹', risk: 'medium',
    desc: 'Hidden=1，方便排查配置、Mod、日志和游戏数据目录；误删风险上升。',
    steps: [
      {
        label: '显示隐藏文件', reg: regBlock({
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': {
            'Hidden': 'dword:00000001',
            'ShowSuperHidden': 'dword:00000001'
          }
        })
      }
    ]
  },
  {
    id: 'desktop_thumb_delay', group: '桌面体验', title: '移除缩略图悬停延迟', risk: 'medium',
    desc: '缩短任务栏预览/缩略图悬停等待时间，让窗口切换更快；窗口很多时可能更容易误触预览。',
    steps: [
      {
        label: '缩短悬停延迟', reg: regBlock({
          'HKEY_CURRENT_USER\\Control Panel\\Mouse': {
            'MouseHoverTime': '"50"'
          },
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': {
            'TaskbarThumbnailDelay': 'dword:00000032'
          }
        })
      }
    ]
  },
  {
    id: 'desktop_sep_process', group: '桌面体验', title: '独立进程打开文件夹窗口', risk: 'medium',
    desc: 'SeparateProcess=1，单个资源管理器窗口异常时不会拖垮整个桌面和任务栏。',
    steps: [
      {
        label: '独立进程打开文件夹', reg: regBlock({
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': {
            'SeparateProcess': 'dword:00000001'
          }
        })
      }
    ]
  },
  {
    id: 'desktop_taskbar_left', group: '桌面体验', title: '任务栏图标左对齐', risk: 'medium',
    desc: 'TaskbarAl=0，将 Win11 任务栏与开始按钮靠左显示，更接近 Win10 使用习惯。',
    steps: [
      {
        label: '任务栏图标左对齐', reg: regBlock({
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': {
            'TaskbarAl': 'dword:00000000'
          }
        })
      }
    ]
  },
  {
    id: 'desktop_taskbar_show_desktop', group: '桌面体验', title: '启用任务栏角落显示桌面', risk: 'medium',
    desc: 'TaskbarSd=1，点击任务栏最右侧角落可显示桌面，适合频繁切换窗口的用户。',
    steps: [
      {
        label: '启用角落显示桌面', reg: regBlock({
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': {
            'TaskbarSd': 'dword:00000001'
          }
        })
      }
    ]
  },
  {
    id: 'desktop_taskbar_multi', group: '桌面体验', title: '在所有显示器显示任务栏', risk: 'medium',
    desc: 'MMTaskbarEnabled=1，多屏游戏/直播/办公时每个屏幕都能直接访问任务栏。',
    steps: [
      {
        label: '所有显示器显示任务栏', reg: regBlock({
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': {
            'MMTaskbarEnabled': 'dword:00000001',
            'MMTaskbarShowAllIcons': 'dword:00000001'
          }
        })
      }
    ]
  },
  {
    id: 'desktop_low_disk_off', group: '桌面体验', title: '低磁盘空间提醒排查', risk: 'medium',
    desc: 'NoLowDiskSpaceChecks=1，关闭系统低磁盘空间提醒弹窗；请确认不依赖 Windows 低磁盘提醒后再关闭。',
    steps: [
      {
        label: '关闭低磁盘提醒', reg: regBlock({
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer': {
            'NoLowDiskSpaceChecks': 'dword:00000001'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer': {
            'NoLowDiskSpaceChecks': 'dword:00000001'
          }
        })
      }
    ]
  },
  {
    id: 'explorer_foreground_speed', group: '桌面体验', title: '提高前台程序显示速度', risk: 'low',
    desc: 'ForegroundLockTimeout=0，允许前台程序立即获得焦点并优先刷新显示，减少点击窗口后界面延迟响应的等待。',
    steps: [
      {
        label: 'ForegroundLockTimeout=0', reg: regBlock({
          'HKEY_CURRENT_USER\\Control Panel\\Desktop': { 'ForegroundLockTimeout': 'dword:00000000' }
        })
      }
    ]
  },
  {
    id: 'explorer_autorestart', group: '桌面体验', title: '资源管理器崩溃时自动重启', risk: 'low',
    desc: 'AutoRestartShell=1，explorer.exe 意外退出后由系统自动拉起，桌面与任务栏无需手动重启（HKCU 为参考项目原路径，同时写入实际生效的 HKLM Winlogon）。',
    steps: [
      {
        label: 'AutoRestartShell=1（HKCU + HKLM）', reg: regBlock({
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon': { 'AutoRestartShell': 'dword:00000001' },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon': { 'AutoRestartShell': 'dword:00000001' }
        })
      }
    ]
  },
  {
    id: 'explorer_refresh_policy', group: '桌面体验', title: '优化文件列表刷新策略', risk: 'low',
    desc: 'NoSimpleNetIDList=1，禁用简化的网络标识列表，让资源管理器按完整信息刷新文件列表，减少新建/重命名后不即时显示的问题。',
    steps: [
      {
        label: 'NoSimpleNetIDList=1', reg: regBlock({
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer': { 'NoSimpleNetIDList': 'dword:00000001' }
        })
      }
    ]
  },
  {
    id: 'always_unload_dll', group: '桌面体验', title: '总是从内存中卸载无用的 DLL', risk: 'medium',
    desc: 'AlwaysUnloadDLL=1，资源管理器关闭引用后立即从内存卸载 DLL，降低常驻内存占用；该键值为传统优化项，现代 Windows 上部分组件不再读取。',
    steps: [
      {
        label: 'AlwaysUnloadDLL="1"', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer': { 'AlwaysUnloadDLL': '"1"' }
        })
      }
    ]
  },
  {
    id: 'clear_recent_docs_on_exit', group: '桌面体验', title: '退出时清除最近打开的文件历史', risk: 'low',
    desc: 'ClearRecentDocsOnExit=1，注销/关机时自动清空"最近打开的文件"记录，保护使用隐私；开始菜单的最近文件列表将不再保留。',
    steps: [
      {
        label: 'ClearRecentDocsOnExit=1', reg: regBlock({
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer': { 'ClearRecentDocsOnExit': 'dword:00000001' }
        })
      }
    ]
  },
  // ---------- 任务调度（对齐 TuneForge BuildTasksModule） ----------
  {
    id: 'tasks_disable_ceip', group: '任务调度', title: 'CEIP Consolidator 任务排查', risk: 'medium',
    desc: '停用 \\Microsoft\\Windows\\Customer Experience Improvement Program\\Consolidator 计划任务；需确认客户体验数据、诊断反馈取舍。',
    steps: [
      { label: '停用 Consolidator 任务', pwsh: 'Disable-ScheduledTask -TaskPath "\\Microsoft\\Windows\\Customer Experience Improvement Program\\" -TaskName "Consolidator" -ErrorAction SilentlyContinue' }
    ],
    restore: [
      { label: '启用 Consolidator 任务', pwsh: 'Enable-ScheduledTask -TaskPath "\\Microsoft\\Windows\\Customer Experience Improvement Program\\" -TaskName "Consolidator" -ErrorAction SilentlyContinue' }
    ]
  },
  {
    id: 'tasks_disable_usb_ceip', group: '任务调度', title: 'USB CEIP 任务排查', risk: 'medium',
    desc: '停用 \\Microsoft\\Windows\\Customer Experience Improvement Program\\UsbCeip 计划任务；需确认 USB 设备体验数据取舍。',
    steps: [
      { label: '停用 UsbCeip 任务', pwsh: 'Disable-ScheduledTask -TaskPath "\\Microsoft\\Windows\\Customer Experience Improvement Program\\" -TaskName "UsbCeip" -ErrorAction SilentlyContinue' }
    ],
    restore: [
      { label: '启用 UsbCeip 任务', pwsh: 'Enable-ScheduledTask -TaskPath "\\Microsoft\\Windows\\Customer Experience Improvement Program\\" -TaskName "UsbCeip" -ErrorAction SilentlyContinue' }
    ]
  },
  {
    id: 'tasks_disable_disk_diag', group: '任务调度', title: '磁盘诊断数据采集任务排查', risk: 'medium',
    desc: '停用 \\Microsoft\\Windows\\DiskDiagnostic\\DiskDiagnosticDataCollector 计划任务；需确认磁盘健康诊断、可靠性数据取舍。',
    steps: [
      { label: '停用磁盘诊断采集', pwsh: 'Disable-ScheduledTask -TaskPath "\\Microsoft\\Windows\\DiskDiagnostic\\" -TaskName "DiskDiagnosticDataCollector" -ErrorAction SilentlyContinue' }
    ],
    restore: [
      { label: '启用磁盘诊断采集', pwsh: 'Enable-ScheduledTask -TaskPath "\\Microsoft\\Windows\\DiskDiagnostic\\" -TaskName "DiskDiagnosticDataCollector" -ErrorAction SilentlyContinue' }
    ]
  },
  {
    id: 'tasks_disable_defrag', group: '任务调度', title: '计划碎片整理触发排查', risk: 'medium',
    desc: '停用 \\Microsoft\\Windows\\Defrag\\ScheduledDefrag 计划任务；可能影响 HDD 整理或 SSD/TRIM 维护节奏，需保留恢复路径。',
    steps: [
      { label: '停用计划碎片整理', pwsh: 'Disable-ScheduledTask -TaskPath "\\Microsoft\\Windows\\Defrag\\" -TaskName "ScheduledDefrag" -ErrorAction SilentlyContinue' }
    ],
    restore: [
      { label: '启用计划碎片整理', pwsh: 'Enable-ScheduledTask -TaskPath "\\Microsoft\\Windows\\Defrag\\" -TaskName "ScheduledDefrag" -ErrorAction SilentlyContinue' }
    ]
  },
  {
    id: 'tasks_disable_silent_cleanup', group: '任务调度', title: 'SilentCleanup 触发排查', risk: 'medium',
    desc: '停用 \\Microsoft\\Windows\\DiskCleanup\\SilentCleanup 计划任务；关闭后可减少空闲时突然触发的磁盘和后台活动，需保留恢复路径。',
    steps: [
      { label: '停用 SilentCleanup', pwsh: 'Disable-ScheduledTask -TaskPath "\\Microsoft\\Windows\\DiskCleanup\\" -TaskName "SilentCleanup" -ErrorAction SilentlyContinue' }
    ],
    restore: [
      { label: '启用 SilentCleanup', pwsh: 'Enable-ScheduledTask -TaskPath "\\Microsoft\\Windows\\DiskCleanup\\" -TaskName "SilentCleanup" -ErrorAction SilentlyContinue' }
    ]
  },
  {
    id: 'tasks_disable_winbackup', group: '任务调度', title: 'Windows Backup 监视排查', risk: 'medium',
    desc: '停用 \\Microsoft\\Windows\\WindowsBackup\\AutomaticBackup 计划任务；需确认不依赖系统备份提醒或旧备份工作流。',
    steps: [
      { label: '停用 Windows Backup 监视', pwsh: 'Disable-ScheduledTask -TaskPath "\\Microsoft\\Windows\\WindowsBackup\\" -TaskName "AutomaticBackup" -ErrorAction SilentlyContinue' }
    ],
    restore: [
      { label: '启用 Windows Backup 监视', pwsh: 'Enable-ScheduledTask -TaskPath "\\Microsoft\\Windows\\WindowsBackup\\" -TaskName "AutomaticBackup" -ErrorAction SilentlyContinue' }
    ]
  },
  {
    id: 'tasks_disable_settingsync', group: '任务调度', title: 'SettingSync 后台同步任务排查', risk: 'medium',
    desc: '停用 \\Microsoft\\Windows\\SettingSync\\BackgroundUploadTask 计划任务；需确认不依赖设置同步、跨设备偏好或账户恢复。',
    steps: [
      { label: '停用 SettingSync 后台同步', pwsh: 'Disable-ScheduledTask -TaskPath "\\Microsoft\\Windows\\SettingSync\\" -TaskName "BackgroundUploadTask" -ErrorAction SilentlyContinue' }
    ],
    restore: [
      { label: '启用 SettingSync 后台同步', pwsh: 'Enable-ScheduledTask -TaskPath "\\Microsoft\\Windows\\SettingSync\\" -TaskName "BackgroundUploadTask" -ErrorAction SilentlyContinue' }
    ]
  },
  {
    id: 'tasks_disable_office_telemetry', group: '任务调度', title: 'Office Telemetry 登录任务排查', risk: 'medium',
    desc: '停用 \\Microsoft\\Office\\OfficeTelemetryAgentLogOn 计划任务；需确认 Office 登录、诊断、遥测或企业策略不依赖它。',
    steps: [
      { label: '停用 Office Telemetry 登录', pwsh: 'Disable-ScheduledTask -TaskPath "\\Microsoft\\Office\\" -TaskName "OfficeTelemetryAgentLogOn" -ErrorAction SilentlyContinue' }
    ],
    restore: [
      { label: '启用 Office Telemetry 登录', pwsh: 'Enable-ScheduledTask -TaskPath "\\Microsoft\\Office\\" -TaskName "OfficeTelemetryAgentLogOn" -ErrorAction SilentlyContinue' }
    ]
  },
  {
    id: 'tasks_stubborn_strategy', group: '任务调度', title: '顽固软件策略专杀', risk: 'medium',
    desc: '将 MuMu 模拟器 / 网易 UU 远程 / 微软电脑管家 等后台常驻服务的启动类型改为「手动」并立即停止，同时停止 WPS 云文档服务、删除 WPS 更新计划任务并关闭其自动升级，从源头阻止顽固软件后台自启与残留保活。',
    steps: [
      { label: '停止并改为手动（Edrservice / GameViewerService / MuMuRemoteService / PCManager Service Store）', pwsh: [
        "$services = @('Edrservice', 'GameViewerService', 'MuMuRemoteService', 'PCManager Service Store')",
        "foreach ($svc in $services) {",
        "  $s = Get-Service -Name $svc -ErrorAction SilentlyContinue",
        "  if (-not $s) { continue }",
        "  if ($s.Status -eq 'Running') { Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue }",
        "  Set-Service -Name $svc -StartupType Manual -ErrorAction SilentlyContinue",
        "}"
      ].join('\n') },
      { label: '停止 WPS 云文档服务（保持 Disabled）', pwsh: [
        "$wc = Get-Service -Name 'wpscloudsvr' -ErrorAction SilentlyContinue",
        "if ($wc -and $wc.Status -eq 'Running') { Stop-Service -Name 'wpscloudsvr' -Force -ErrorAction SilentlyContinue }"
      ].join('\n') },
      { label: '删除 WPS 更新计划任务并关闭自动升级', pwsh: [
        "foreach ($taskName in @('WpsUpdateTask_CHENG', 'WpsUpdateLogonTask_CHENG')) {",
        "  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue }",
        "}",
        "$wpsKey = 'HKCU:\\Software\\Kingsoft\\Office\\6.0\\Common\\updateinfo'",
        "if (Test-Path $wpsKey) { Set-ItemProperty -Path $wpsKey -Name 'UpdateMode' -Value 'close' -ErrorAction SilentlyContinue }"
      ].join('\n') }
    ]
  },
  // ---------- 外设调优新增（对齐 TuneForge BuildPeripheralModule） ----------
  {
    id: 'peripheral_inactive_scroll', group: '外设调优', title: '关闭非活动窗口滚动', risk: 'medium',
    desc: 'MouseWheelRouting=0，滚动仅作用于当前活动窗口，避免误滚动到背景窗口；多窗口用户慎用。',
    steps: [
      { label: 'MouseWheelRouting=0', reg: regBlock({
        'HKEY_CURRENT_USER\\Control Panel\\Desktop': {
          'MouseWheelRouting': 'dword:00000000'
        }
      }) }
    ]
  },
  {
    id: 'peripheral_winkey_off', group: '外设调优', title: '禁用 Win 键误触', risk: 'medium',
    desc: '写入 Scancode Map 屏蔽左右 Win 键，避免游戏中误触 Windows 键切出；会禁用 Win+快捷键。',
    steps: [
      { label: 'Scancode Map 屏蔽 Win 键', pwsh: [
        '$p = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Keyboard Layout"',
        '$map = [byte[]](0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x00,0x00,0x5b,0xe0,0x00,0x00,0x5c,0xe0,0x00,0x00,0x00,0x00)',
        'New-Item -Path $p -Force | Out-Null',
        'New-ItemProperty -Path $p -Name "Scancode Map" -Value $map -PropertyType Binary -Force | Out-Null'
      ].join('\n') }
    ],
    restore: [
      { label: '还原 Scancode Map', pwsh: 'Remove-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Keyboard Layout" -Name "Scancode Map" -ErrorAction SilentlyContinue' }
    ]
  },
  {
    id: 'peripheral_mouse_trails', group: '外设调优', title: '关闭硬件鼠标轨迹', risk: 'medium',
    desc: 'MouseTrails=0，关闭鼠标拖尾效果，让指针显示更干净，减少视觉干扰。',
    steps: [
      { label: 'MouseTrails=0', reg: regBlock({
        'HKEY_CURRENT_USER\\Control Panel\\Mouse': {
          'MouseTrails': '"0"'
        }
      }) }
    ]
  },
  {
    id: 'peripheral_snap_to', group: '外设调优', title: '禁用 SnapTo（自动跳到默认按钮）', risk: 'medium',
    desc: 'SnapToDefaultButton=0，禁止鼠标自动跳到对话框默认按钮，避免误操作。',
    steps: [
      { label: 'SnapToDefaultButton=0', reg: regBlock({
        'HKEY_CURRENT_USER\\Control Panel\\Mouse': {
          'SnapToDefaultButton': '"0"'
        }
      }) }
    ]
  },
  // ---------- 隐私防护新增（对齐 TuneForge BuildPrivacyModule；相机/麦克风/联系人按需排除） ----------
  {
    id: 'privacy_advertising_id', group: '隐私防护', title: '广告 ID 个性化排查', risk: 'medium',
    desc: 'AdvertisingInfo Enabled=0 并重置 AdvertisingInfo Id，关闭广告个性化；需确认是否依赖个性化广告或应用推荐体验。',
    steps: [
      {
        label: '关闭广告 ID', reg: regBlock({
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo': {
            'Enabled': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\AdvertisingInfo': {
            'DisabledByGroupPolicy': 'dword:00000001'
          }
        })
      }
    ]
  },
  {
    id: 'privacy_wer_off', group: '隐私防护', title: 'Windows Error Reporting 策略排查', risk: 'medium',
    desc: 'WER Disabled=1，关闭 Windows 错误报告收集；需确认崩溃诊断、故障反馈和企业问题分析取舍。',
    steps: [
      {
        label: '关闭 WER', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting': {
            'Disabled': 'dword:00000001'
          },
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Windows Error Reporting': {
            'Disabled': 'dword:00000001'
          }
        })
      }
    ]
  },
  {
    id: 'privacy_compat_telemetry', group: '隐私防护', title: '兼容性遥测排查', risk: 'medium',
    desc: 'DisableUAR=1，关闭兼容性评估数据回传；需确认应用兼容性诊断、升级评估和企业策略取舍。',
    steps: [
      { label: 'DisableUAR=1', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System': {
          'EnableUAR': 'dword:00000000'
        }
      }) }
    ]
  },
  {
    id: 'privacy_settingsync_off', group: '隐私防护', title: '设置/应用同步排查', risk: 'medium',
    desc: 'DisableSettingSync=1，关闭设置和应用同步，减少风险并受账号状态和组织策略影响；需复查跨设备偏好、账户恢复或新设备迁移取舍。',
    steps: [
      {
        label: '关闭设置同步', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\SettingSync': {
            'DisableSettingSync': 'dword:00000001',
            'DisableSettingSyncUserOverride': 'dword:00000001'
          },
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\SettingSync': {
            'DisableSettingSync': 'dword:00000001'
          }
        })
      }
    ]
  },
  {
    id: 'privacy_cloud_content', group: '隐私防护', title: '云推荐内容排查', risk: 'medium',
    desc: '关闭 Spotlight、消费者体验和部分推荐内容策略，减少风险并受账号状态和组织策略影响；需复查锁屏聚焦、推荐内容和个性化体验变化。',
    steps: [
      {
        label: '关闭云推荐内容', reg: regBlock({
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager': {
            'SystemPaneSuggestionsEnabled': 'dword:00000000',
            'SubscribedContent-338389Enabled': 'dword:00000000',
            'SubscribedContent-310093Enabled': 'dword:00000000',
            'SubscribedContent-338388Enabled': 'dword:00000000',
            'RotatingLockScreenEnabled': 'dword:00000000',
            'RotatingLockScreenOverlayEnabled': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\CloudContent': {
            'DisableWindowsConsumerFeatures': 'dword:00000001'
          }
        })
      }
    ]
  },
  {
    id: 'privacy_permissions_tune', group: '隐私防护', title: '各类权限精调', risk: 'medium',
    desc: '按 TuneForge 缺失项合并精调 20+ 项权限与数据收集开关：应用访问（文件系统/文档/日历/联系人/位置拒绝）、活动收集、应用启动跟踪、写作习惯、键入文本、输入个性化、键入见解、OOBE 隐私体验、通讯录收集、自动连接热点、.NET/PowerShell 遥测环境变量（机器级）、启用剪贴板历史、停用 SMS 路由器服务（原「网站语言跟踪」「Bing 搜索」「定向广告」「兼容性遥测」「页面预测」「设置应用建议」「赞助商应用」「搜索历史」已被现有优化项覆盖，不再重复写入）。',
    steps: [
      { label: '应用访问权限（ConsentStore=Deny）', reg: regBlock({
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\documentsLibrary': { 'Value': '"Deny"' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\documents': { 'Value': '"Deny"' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\appointments': { 'Value': '"Deny"' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\contacts': { 'Value': '"Deny"' }
      }) },
      { label: '位置服务拒绝', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location': { 'Value': '"Deny"' }
      }) },
      { label: '启动跟踪 / 活动收集 / 启用剪贴板历史', reg: regBlock({
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': { 'Start_TrackEnabled': 'dword:00000000' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\System': {
          'EnableActivityFeed': 'dword:00000000',
          'AllowClipboardHistory': 'dword:00000001'
        }
      }) },
      { label: '输入与写作习惯收集', reg: regBlock({
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\WritingTips': { 'Enabled': 'dword:00000000' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Input\\TIPC': { 'Enabled': 'dword:00000000' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\InputPersonalization': {
          'RestrictImplicitTextCollection': 'dword:00000001',
          'RestrictImplicitInkCollection': 'dword:00000001'
        },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Input\\Settings': { 'InsightsEnabled': 'dword:00000000' }
      }) },
      { label: 'OOBE 隐私体验与通讯录收集', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\OOBE': { 'DisablePrivacyExperience': 'dword:00000001' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\ContactData': { 'ContactDataCollectionEnabled': 'dword:00000000' }
      }) },
      { label: '禁止自动连接开放热点', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\WcmSvc\\wifinetworkmanager\\config': { 'AutoConnectAllowedOEM': 'dword:00000000' }
      }) },
      { label: '.NET / PowerShell 遥测环境变量（机器级）', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment': {
          'DOTNET_CLI_TELEMETRY_OPTOUT': '"1"',
          'POWERSHELL_TELEMETRY_OPTOUT': '"1"'
        }
      }) },
      { label: '停用 SMS 路由器服务', service: 'MessagingService', disable: true }
    ]
  },
  // ==================== 系统服务（对齐 TuneForge BuildServicesModule 独立策略）====================
  {
    id: 'svc_connected_devices_manual', group: '系统服务', title: '跨设备平台服务设为手动', risk: 'medium',
    desc: 'CDPSvc / CDPUserSvc Start=3，让跨设备、手机连接和附近共享相关服务按需启动；不承诺固定资源收益，需要这些体验时可恢复原启动类型。',
    steps: [
      {
        label: 'CDPSvc / CDPUserSvc 设为手动', pwsh: [
          '$svcs = @("CDPSvc","CDPUserSvc")',
          'foreach ($n in $svcs) { $p = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$n"; if (Test-Path $p) { New-ItemProperty -Path $p -Name Start -Value 3 -PropertyType DWord -Force | Out-Null } }'
        ].join('\n')
      }
    ],
    restore: [
      {
        label: '恢复为自动(2)', pwsh: [
          '$svcs = @("CDPSvc","CDPUserSvc")',
          'foreach ($n in $svcs) { $p = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$n"; if (Test-Path $p) { New-ItemProperty -Path $p -Name Start -Value 2 -PropertyType DWord -Force | Out-Null } }'
        ].join('\n')
      }
    ]
  },
  {
    id: 'svc_fax_disable', group: '系统服务', title: 'Fax 服务使用排查', risk: 'medium',
    desc: 'Fax 服务 Start=4 并停止；仅在确认不用传真、扫描传真或旧设备工作流时启用，实际占用变化需按本机服务状态复查。',
    steps: [
      { label: 'Fax Start=4', pwsh: '$p = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Fax"; if (Test-Path $p) { New-ItemProperty -Path $p -Name Start -Value 4 -PropertyType DWord -Force | Out-Null; Stop-Service -Name Fax -Force -ErrorAction SilentlyContinue }' }
    ]
  },
  {
    id: 'svc_remote_registry_disable', group: '系统服务', title: 'RemoteRegistry 远程管理排查', risk: 'medium',
    desc: 'RemoteRegistry 服务 Start=4 并停止；仅在确认不依赖远程注册表管理、资产盘点、运维工具或企业策略时请求关闭，并保留恢复路径。',
    steps: [
      { label: 'RemoteRegistry Start=4', pwsh: '$p = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\RemoteRegistry"; if (Test-Path $p) { New-ItemProperty -Path $p -Name Start -Value 4 -PropertyType DWord -Force | Out-Null; Stop-Service -Name RemoteRegistry -Force -ErrorAction SilentlyContinue }' }
    ]
  },
  {
    id: 'svc_remote_connectivity_manual', group: '系统服务', title: '远程连接服务设为手动', risk: 'medium',
    desc: 'RasMan / RasAuto / RDP 相关服务 Start=3；需确认不依赖 VPN、拨号、远程接入或自动连接远程资源，并保留恢复路径。',
    steps: [
      {
        label: '远程连接相关服务设为手动', pwsh: [
          '$svcs = @("RasMan","RasAuto","RemoteAccess","TermService","UmRdpService","SessionEnv")',
          'foreach ($n in $svcs) { $p = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$n"; if (Test-Path $p) { New-ItemProperty -Path $p -Name Start -Value 3 -PropertyType DWord -Force | Out-Null } }'
        ].join('\n')
      }
    ]
  },
  {
    id: 'svc_bluetooth_disable', group: '系统服务', title: '蓝牙后台服务使用排查', risk: 'medium',
    desc: 'bthserv 服务 Start=4 并停止；仅在确认不用蓝牙耳机、手柄、鼠标、键盘、手机互联或配对流程时请求关闭；需按设备和驱动复测。',
    steps: [
      { label: 'bthserv Start=4', pwsh: '$p = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\bthserv"; if (Test-Path $p) { New-ItemProperty -Path $p -Name Start -Value 4 -PropertyType DWord -Force | Out-Null; Stop-Service -Name bthserv -Force -ErrorAction SilentlyContinue }' }
    ]
  },
  // ==================== 系统调校补齐（对齐 TuneForge BuildSystemModule）====================
  {
    id: 'power_aspm_off', group: '系统调校', title: '禁用 PCI-E ASPM 节能', risk: 'medium',
    desc: '电源方案与设备级关闭 PCIe 链路节能(ASPM)，可能减少显卡、硬盘或网卡从低功耗状态唤醒时的卡顿。',
    steps: [
      {
        label: '电源方案关闭 ASPM', pwsh: [
          'powercfg /setacvalueindex SCHEME_CURRENT SUB_PCIEXPRESS ASPM 0',
          'powercfg /setdcvalueindex SCHEME_CURRENT SUB_PCIEXPRESS ASPM 0',
          'powercfg /setactive SCHEME_CURRENT'
        ].join('\n')
      },
      {
        label: '设备级 ASPM 关闭', pwsh: [
          '$root = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}"',
          'if (Test-Path $root) { Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object { New-ItemProperty -Path $_.PSPath -Name "EnableASPM" -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null } }'
        ].join('\n')
      }
    ]
  },
  {
    id: 'storage_8dot3_off', group: '系统调校', title: '禁用 NTFS 8.3 短文件名', risk: 'medium',
    desc: '关闭 8.3 短文件名生成（fsutil 8dot3name set 1），减少短文件名维护开销；旧安装器、脚本或驱动兼容性需确认。',
    steps: [
      { label: 'fsutil 禁用 8.3', cmd: 'fsutil behavior set disable8dot3 1' }
    ],
    restore: [
      { label: '恢复 8.3（默认0）', cmd: 'fsutil behavior set disable8dot3 0' }
    ]
  },
  // 注：「清空待机列表（StandbyList）」已移除，功能由「内存清理」覆盖。
  // ==================== 性能调优补齐（对齐 TuneForge BuildPerformanceModule）====================
  {
    id: 'perf_uwp_background_off', group: '性能调优', title: 'UWP 后台运行排查', risk: 'medium',
    desc: 'GlobalUserDisabled=1，请求限制通用应用后台运行；需确认通知、同步和后台刷新需求，不承诺固定资源收益。',
    steps: [
      { label: '后台应用全局禁用', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications': {
          'GlobalUserDisabled': 'dword:00000001'
        },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\AppPrivacy': {
          'LetAppsRunInBackground': 'dword:00000002'
        }
      }) }
    ]
  },
  {
    id: 'perf_store_auto_update_off', group: '性能调优', title: '商店应用自动更新排查', risk: 'medium',
    desc: 'AutoDownload=2，请求改为手动检查 Microsoft Store 应用更新；需复查是否影响更新、下载、安装和本机带宽/I/O。',
    steps: [
      { label: 'WindowsStore AutoDownload=2', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\WindowsStore': {
          'AutoDownload': 'dword:00000002'
        },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Store': {
          'AutoDownload': 'dword:00000002'
        }
      }) }
    ]
  },
  {
    id: 'perf_windows_update_off', group: '性能调优', title: 'Windows 自动更新策略排查', risk: 'medium',
    desc: 'NoAutoUpdate=1，请求改为手动控制补丁检查；需确认安全更新维护、下载触发和重启提醒影响。',
    steps: [
      { label: 'WindowsUpdate NoAutoUpdate=1', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU': {
          'NoAutoUpdate': 'dword:00000001'
        }
      }) }
    ]
  },
  {
    id: 'perf_notifications_off', group: '性能调优', title: '关闭 Windows 全局通知横幅', risk: 'medium',
    desc: 'ToastEnabled=0，减少通知横幅打断，降低操作干扰；可能错过安全、会议、聊天和系统提醒。',
    steps: [
      { label: 'Explorer ToastEnabled=0', reg: regBlock({
        'HKEY_CURRENT_USER\\Software\\Policies\\Microsoft\\Windows\\Explorer': {
          'ToastEnabled': 'dword:00000000'
        }
      }) }
    ]
  },
  {
    id: 'perf_vbs_off', group: '性能调优', title: '关闭 VBS / 内存完整性', risk: 'high',
    desc: '关闭 VBS/HVCI 设备保护（EnableVirtualizationBasedSecurity=0、HypervisorEnforcedCodeIntegrity=0），会降低系统安全防护，仅适合定位安全隔离是否影响特定游戏或软件表现；需重启生效。',
    steps: [
      {
        label: '关闭 VBS/HVCI', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard': {
            'EnableVirtualizationBasedSecurity': 'dword:00000000'
          },
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity': {
            'Enabled': 'dword:00000000'
          }
        })
      }
    ]
  },
  {
    id: 'perf_shutdown_fast', group: '性能调优', title: '加快关机速度', risk: 'low',
    desc: 'WaitToKillAppTimeout=2000（毫秒），缩短系统等待应用自行退出的超时时间，让关机/注销更快；个别未保存工作的应用可能被更快结束。',
    steps: [
      {
        label: 'WaitToKillAppTimeout=2000', reg: regBlock({
          'HKEY_CURRENT_USER\\Control Panel\\Desktop': { 'WaitToKillAppTimeout': '"2000"' }
        })
      }
    ]
  },
  {
    id: 'perf_service_shutdown_fast', group: '性能调优', title: '缩短服务关闭等待时间', risk: 'low',
    desc: 'WaitToKillServiceTimeout=2000（毫秒），缩短关机时等待服务停止的超时；个别服务可能来不及保存状态，多数场景可安全应用。',
    steps: [
      {
        label: 'WaitToKillServiceTimeout=2000', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control': { 'WaitToKillServiceTimeout': '"2000"' }
        })
      }
    ]
  },
  {
    id: 'perf_remote_assist_off', group: '性能调优', title: '关闭远程协助', risk: 'low',
    desc: 'fAllowToGetHelp=0，禁用 Windows 远程协助的受邀协助入口，减少攻击面与后台监听；使用"请求远程协助"功能时需还原。',
    steps: [
      {
        label: 'fAllowToGetHelp=0', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Remote Assistance': { 'fAllowToGetHelp': 'dword:00000000' }
        })
      }
    ]
  },
  {
    id: 'perf_prefetcher_fast', group: '性能调优', title: '加快预读能力改善速度', risk: 'low',
    desc: 'EnablePrefetcher=3，同时启用应用与启动预读，改善程序启动与文件访问速度；SSD 上收益有限且 Prefetch 已被清理模块清理时可能短暂回退。',
    steps: [
      {
        label: 'EnablePrefetcher=3', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters': { 'EnablePrefetcher': 'dword:00000003' }
        })
      }
    ]
  },
  {
    id: 'perf_crash_autoreboot', group: '性能调优', title: '蓝屏时自动重启', risk: 'low',
    desc: 'AutoReboot=1，系统蓝屏后自动重启而非停留在选择界面，适合无人值守场景；排查蓝屏时建议临时关闭以读取完整停机码。',
    steps: [
      {
        label: 'AutoReboot=1', reg: regBlock({
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CrashControl': { 'AutoReboot': 'dword:00000001' }
        })
      }
    ]
  },
  {
    id: 'perf_exploit_protection_off', group: '性能调优', title: '关闭 Exploit Protection（乱序内存）', risk: 'high',
    desc: '写入内核 MitigationOptions 二进制值（22,22,22,00,00,02,00,00,00,02,00,00,00,00,00,00，与 TuneForge「关闭Exploit Protection（乱序内存）」一致），关闭一系列漏洞利用缓解（含 SEHOP/强制 ASLR 等），可小幅提升部分应用的内存分配性能，但显著降低漏洞利用防护（高风险，需确认后执行）。',
    steps: [
      {
        label: 'MitigationOptions (Binary)', pwsh: [
          '$k = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\kernel"',
          'New-ItemProperty -Path $k -Name MitigationOptions -Value ([byte[]](0x22,0x22,0x22,0x00,0x00,0x02,0x00,0x00,0x00,0x02,0x00,0x00,0x00,0x00,0x00,0x00)) -PropertyType Binary -Force | Out-Null'
        ].join('\n') }
    ],
    restore: [
      {
        label: '删除 MitigationOptions（恢复系统默认缓解策略）', pwsh: [
          '$k = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\kernel"',
          'Remove-ItemProperty -Path $k -Name MitigationOptions -ErrorAction SilentlyContinue'
        ].join('\n') }
    ]
  },
  // ---------- 浏览器优化（EDGE 专优拆分为 16 个独立项） ----------
  edgePolicyItem('edge_hide_firstrun', '禁用首次运行体验', 'low', 'HideFirstRunExperience', 'dword:00000001',
    '不显示 Edge 首次运行欢迎页与数据导入向导，新装或新配置文件直接可用。'),
  edgePolicyItem('edge_bg_mode_off', '禁用关闭后后台运行', 'low', 'BackgroundModeEnabled', 'dword:00000000',
    'Edge 关闭所有窗口后不再驻留后台运行扩展与进程，释放内存与后台占用。'),
  edgePolicyItem('edge_startup_boost_off', '禁用启动增强', 'low', 'StartupBoostEnabled', 'dword:00000000',
    '关闭系统启动时后台预加载 Edge 的"启动增强"，开机进程更少、速度更纯粹。'),
  edgePolicyItem('edge_intrusive_ads_off', '阻止侵入式广告', 'medium', 'AdsSettingForIntrusiveAdsSites', 'dword:00000002',
    '在所有网站上阻止侵入式广告，减少恶意弹窗与误导下载按钮的干扰。'),
  edgePolicyItem('edge_ntp_quicklinks_off', '隐藏新标签页快速链接', 'low', 'NewTabPageQuickLinksEnabled', 'dword:00000000',
    '从新标签页隐藏默认的热门站点快速链接，页面更干净。'),
  edgePolicyItem('edge_sidebar_off', '禁用 Edge 边栏', 'low', 'HubsSidebarEnabled', 'dword:00000000',
    '隐藏浏览器右侧边栏（Copilot、发现、搜索入口），减少误触与视觉干扰。'),
  edgePolicyItem('edge_unsupported_os_warn_off', '禁用旧系统通知警告', 'low', 'SuppressUnsupportedOSWarning', 'dword:00000001',
    '关闭"此版本的 Windows 即将停止支持"的 Edge 通知横幅。'),
  edgePolicyItem('edge_metrics_off', '禁用诊断数据上报', 'medium', 'MetricsReportingEnabled', 'dword:00000000',
    '不向微软发送任何浏览器诊断数据，收敛浏览器侧的隐私外发通道。'),
  edgePolicyItem('edge_tab_perf_detector_off', '禁用标签页性能检测器', 'low', 'TabPerformanceDetectorEnabled', 'dword:00000000',
    '关闭标签页性能问题检测，不再弹出"此页面正在拖慢浏览器"提示。'),
  edgePolicyItem('edge_ntp_content_off', '禁用新标签页资讯内容', 'low', 'NewTabPageContentEnabled', 'dword:00000000',
    '新标签页不再展示微软资讯信息流，仅保留搜索框与常用项。'),
  edgePolicyItem('edge_personalization_off', '禁用个性化广告报告', 'medium', 'PersonalizationReportingEnabled', 'dword:00000000',
    '不向微软发送浏览历史用于个性化广告、新闻与体验推荐。'),
  edgePolicyItem('edge_insecure_download_warn_off', '禁用不安全下载警告', 'medium', 'InsecureContentWarningForDownloadsEnabled', 'dword:00000000',
    '关闭对不安全（HTTP）下载的警告拦截，仅建议明确了解风险的熟练用户使用。'),
  edgePolicyItem('edge_rewards_hide', '隐藏 Microsoft Rewards', 'low', 'ShowMicrosoftRewards', 'dword:00000000',
    '隐藏 Edge 中的 Microsoft Rewards 积分入口与提醒。'),
  {
    id: 'edge_sxs_service_off', group: '浏览器优化', title: '禁用 SxsService 服务', risk: 'medium',
    desc: '关闭 EdgeUpdate 客户端组件 SxsService（Edge 并行版本相关服务），减少后台组件活动；不影响浏览器本体与常规更新。',
    steps: [{ label: 'EdgeUpdate ClientState SxsService=0', reg: regBlock({
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\EdgeUpdate\\ClientState': { 'SxsService': 'dword:00000000' }
    }) }],
    restore: [{ label: '还原：删除 SxsService 键值（恢复默认状态）', reg: regBlock({
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\EdgeUpdate\\ClientState': { 'SxsService': '-' }
    }) }]
  },
  {
    id: 'edge_update_task_disable', group: '浏览器优化', title: '停用 Edge Update 计划任务', risk: 'medium',
    desc: '停用 MicrosoftEdgeUpdateTaskMachineCore 计划任务，停止 Edge 的自动更新检查；停用后请定期手动更新浏览器以获取安全补丁。',
    steps: [{ label: '停用 Edge Update Machine Core', pwsh: 'Get-ScheduledTask -TaskName "MicrosoftEdgeUpdateTaskMachineCore" -ErrorAction SilentlyContinue | Disable-ScheduledTask -ErrorAction SilentlyContinue' }],
    restore: [{ label: '重新启用 Edge Update Machine Core', pwsh: 'Get-ScheduledTask -TaskName "MicrosoftEdgeUpdateTaskMachineCore" -ErrorAction SilentlyContinue | Enable-ScheduledTask -ErrorAction SilentlyContinue' }]
  },
  edgePolicyItem('edge_game_assistant_overlay_off', '禁用 Edge 游戏助手覆盖层', 'low', 'HubsSidebarEnabled', 'dword:00000000',
    '游戏专项：关闭 Edge 游戏助手游戏内覆盖层。与「禁用 Edge 边栏」共用 HubsSidebarEnabled 策略键值，执行时写入 HubsSidebarEnabled=0，还原时删除该键值。'),

  // ==================== 优化总表补全（对照 old\优化总表.md 差异评估采纳项） ====================

  // Windows AI 全组（总表 81-89，9 项）
  {
    id: 'tf_ai_off', group: '性能调优', title: '关闭 Windows AI 组件', risk: 'low',
    desc: '按策略关闭 Windows AI 全家桶：Copilot（组策略+任务栏按钮+键盘键）、Recall 数据分析与快照（DisableAIDataAnalysis）、Click to Do、AI Agent 连接器/远程连接器/工作区、AI 设置代理（AgentRuntime 服务）。全部可一键还原。',
    steps: [
      { label: 'AI 策略键（Copilot/Recall/ClickToDo/Agent）', reg: regBlock({
        'HKEY_CURRENT_USER\\Software\\Policies\\Microsoft\\Windows\\WindowsCopilot': { 'TurnOffWindowsCopilot': 'dword:00000001' },
        'HKEY_CURRENT_USER\\Software\\Policies\\Microsoft\\Windows\\WindowsAI': {
          'DisableAIDataAnalysis': 'dword:00000001',
          'DisableClickToDo': 'dword:00000001',
          'DisableAgentConnectors': 'dword:00000001',
          'DisableRemoteAgentConnectors': 'dword:00000001',
          'DisableAgentWorkspaces': 'dword:00000001',
          'DisableSettingsAgents': 'dword:00000001'
        },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsAI': {
          'DisableAIDataAnalysis': 'dword:00000001',
          'DisableClickToDo': 'dword:00000001'
        },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': { 'ShowCopilotButton': 'dword:00000000' }
      }) },
      { label: '停止 AI 运行时服务（AgentRuntime）', pwsh: [
        'foreach ($n in @("AgentRuntimeService","AgentActivationRuntimeService")) { Stop-Service -Name $n -Force -ErrorAction SilentlyContinue; sc.exe config $n start= disabled 2>$null | Out-Null }'
      ].join('\n') }
    ],
    restore: [
      { label: '还原：删除 AI 策略键', reg: regBlock({
        'HKEY_CURRENT_USER\\Software\\Policies\\Microsoft\\Windows\\WindowsCopilot': { 'TurnOffWindowsCopilot': '-' },
        'HKEY_CURRENT_USER\\Software\\Policies\\Microsoft\\Windows\\WindowsAI': {
          'DisableAIDataAnalysis': '-', 'DisableClickToDo': '-', 'DisableAgentConnectors': '-',
          'DisableRemoteAgentConnectors': '-', 'DisableAgentWorkspaces': '-', 'DisableSettingsAgents': '-'
        },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsAI': { 'DisableAIDataAnalysis': '-', 'DisableClickToDo': '-' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': { 'ShowCopilotButton': '-' }
      }) },
      { label: '还原：AI 运行时服务恢复手动启动', pwsh: [
        'foreach ($n in @("AgentRuntimeService","AgentActivationRuntimeService")) { $p = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$n"; if (Test-Path $p) { New-ItemProperty -Path $p -Name Start -Value 3 -PropertyType DWord -Force | Out-Null } }'
      ].join('\n') }
    ]
  },

  // 系统响应杂项（总表 34/38/41/42，4 项）
  {
    id: 'tf_perf_misc', group: '性能调优', title: '系统响应微调合集', risk: 'low',
    desc: '开机启动延迟归零（StartupDelayInMSec=0）、禁用窗口摇晃（拖动标题栏摇晃不再最小化其它窗口）、禁用失效快捷方式链接解析（不再全盘/联网查找目标）、关闭运行对话框与资源管理器自动建议。',
    steps: [
      { label: '启动延迟归零 + 禁用窗口摇晃 + 禁用链接解析', reg: regBlock({
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Serialize': { 'StartupDelayInMSec': 'dword:00000000' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': { 'DisallowShaking': 'dword:00000001' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer': { 'DisableSearchLinkTracking': 'dword:00000001' }
      }) },
      { label: '关闭自动建议（AutoSuggest）', reg: regBlock({
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\AutoComplete': { 'AutoSuggest': '"NO"' }
      }) }
    ],
    restore: [
      { label: '还原：删除对应键值（恢复默认行为）', reg: regBlock({
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Serialize': { 'StartupDelayInMSec': '-' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': { 'DisallowShaking': '-' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer': { 'DisableSearchLinkTracking': '-' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\AutoComplete': { 'AutoSuggest': '"YES"' }
      }) }
    ]
  },

  // 隐私补漏（总表 56/57/65/72/74/102，6 项 + AITEnable）
  {
    id: 'tf_privacy_extra', group: '隐私防护', title: '第三方遥测与许可遥测关闭', risk: 'low',
    desc: 'Chrome 指标上报与反馈收集（企业策略）、Firefox 遥测与默认浏览器代理（企业策略）、Visual Studio 各版本 SQM 遥测、Windows 许可遥测（NoGenTicket）、任务栏新闻和兴趣信息流、步骤记录器（DisableUAR）、应用兼容性遥测（AITEnable）。',
    steps: [
      { label: 'Chrome / Firefox 企业策略遥测关闭', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome': { 'MetricsReportingEnabled': 'dword:00000000', 'FeedbackSurveysEnabled': 'dword:00000000' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Mozilla\\Firefox': { 'DisableTelemetry': 'dword:00000001', 'DefaultBrowserSettingEnabled': 'dword:00000000' }
      }) },
      { label: 'Visual Studio SQM / 许可遥测 / 新闻兴趣 / 步骤记录器', reg: regBlock({
        'HKEY_CURRENT_USER\\Software\\Microsoft\\VSCommon\\15.0\\SQM': { 'OptIn': 'dword:00000000' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\VSCommon\\16.0\\SQM': { 'OptIn': 'dword:00000000' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\VSCommon\\17.0\\SQM': { 'OptIn': 'dword:00000000' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\CurrentVersion\\Software Protection Platform': { 'NoGenTicket': 'dword:00000001' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Feeds': { 'EnableFeeds': 'dword:00000000' },
        'HKEY_CURRENT_USER\\Software\\Policies\\Microsoft\\Windows\\Steps Recorder': { 'DisableUAR': 'dword:00000001' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\AppCompat': { 'AITEnable': 'dword:00000000' }
      }) }
    ],
    restore: [
      { label: '还原：删除对应策略键值', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome': { 'MetricsReportingEnabled': '-', 'FeedbackSurveysEnabled': '-' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Mozilla\\Firefox': { 'DisableTelemetry': '-', 'DefaultBrowserSettingEnabled': '-' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\VSCommon\\15.0\\SQM': { 'OptIn': '-' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\VSCommon\\16.0\\SQM': { 'OptIn': '-' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\VSCommon\\17.0\\SQM': { 'OptIn': '-' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\CurrentVersion\\Software Protection Platform': { 'NoGenTicket': '-' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Feeds': { 'EnableFeeds': '-' },
        'HKEY_CURRENT_USER\\Software\\Policies\\Microsoft\\Windows\\Steps Recorder': { 'DisableUAR': '-' },
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\AppCompat': { 'AITEnable': '-' }
      }) }
    ]
  },

  // 服务精简补漏（总表 90/92/93/94/95，5 项）
  {
    id: 'tf_svc_extra5', group: '系统服务', title: '传感器与存储感知等服务精简', risk: 'medium',
    desc: '禁用传感器服务（SensrSvc/SensorDataService）、UCPD 用户选择保护驱动、存储感知（StorSvc，改用手动清理更可控）、应用兼容性助手（PcaSvc）、性能改进建议（WDI 诊断场景）。打印机/扫码仪等外设依赖传感器服务时请勿禁用。',
    steps: [
      { label: '禁用传感器 / UCPD / 存储感知 / PCA 服务', pwsh: [
        'foreach ($n in @("SensrSvc","SensorDataService","UCPD","StorSvc","PcaSvc")) { Stop-Service -Name $n -Force -ErrorAction SilentlyContinue; sc.exe config $n start= disabled 2>$null | Out-Null }'
      ].join('\n') },
      { label: '关闭性能改进建议（WDI 场景）', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\WDI': { 'ScenarioExecutionEnabled': 'dword:00000000' }
      }) }
    ],
    restore: [
      { label: '还原：服务恢复手动/自动启动', pwsh: [
        '$map = @{ SensrSvc = 3; SensorDataService = 3; UCPD = 2; StorSvc = 2; PcaSvc = 2 }; foreach ($n in $map.Keys) { $p = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$n"; if (Test-Path $p) { New-ItemProperty -Path $p -Name Start -Value $map[$n] -PropertyType DWord -Force | Out-Null } }'
      ].join('\n') },
      { label: '还原：删除 WDI 策略键值', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\WDI': { 'ScenarioExecutionEnabled': '-' }
      }) }
    ]
  },

  // 应用与界面：复制/移动上下文菜单（总表 114；116 搜索 WebView2 已由 tf_cortana 覆盖）
  {
    id: 'tf_ctx_copymove', group: '桌面体验', title: '右键菜单添加复制/移动到文件夹', risk: 'low',
    desc: '为所有文件与文件夹的右键菜单添加「复制到文件夹…」与「移动到文件夹…」经典对话框入口，无需剪切粘贴即可搬运文件；还原即移除菜单项。',
    steps: [
      { label: '注册 CopyTo / MoveTo 上下文菜单处理器', reg: regBlock({
        'HKEY_CLASSES_ROOT\\AllFilesystemObjects\\shellex\\ContextMenuHandlers\\CopyTo': { '@': '"{f3d06e7c-1e45-4a26-847e-f9fcdee59be0}"' },
        'HKEY_CLASSES_ROOT\\AllFilesystemObjects\\shellex\\ContextMenuHandlers\\MoveTo': { '@': '"{c2fbb631-2971-11d1-a18c-00c04fd75d13}"' }
      }) }
    ],
    restore: [
      { label: '还原：移除 CopyTo / MoveTo 菜单项', reg: regBlock({
        'HKEY_CLASSES_ROOT\\AllFilesystemObjects\\shellex\\ContextMenuHandlers\\CopyTo': { '@': '-' },
        'HKEY_CLASSES_ROOT\\AllFilesystemObjects\\shellex\\ContextMenuHandlers\\MoveTo': { '@': '-' }
      }) }
    ]
  },

  // 磁盘与文件系统补漏（总表 108/109/110，3 项）
  {
    id: 'tf_disk_extra3', group: '系统调校', title: 'NTFS 加密与保留存储精简', risk: 'low',
    desc: '禁用 NTFS 文件系统级加密（NtfsDisableEncryption，不影响 BitLocker/BitLocker To Go）、开始菜单搜索仅限索引位置（Start_SearchFiles=0，减少全盘扫描）、禁用更新保留存储（DISM 释放约 7 GB 保留空间）。',
    steps: [
      { label: '禁用 NTFS 加密 + 搜索仅限索引位置', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem': { 'NtfsDisableEncryption': 'dword:00000001' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': { 'Start_SearchFiles': 'dword:00000000' }
      }) },
      { label: '禁用更新保留存储（DISM）', cmd: 'DISM /Online /Set-ReservedStorageState /State:Disabled /Quiet' }
    ],
    restore: [
      { label: '还原：恢复 NTFS 加密与搜索范围', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem': { 'NtfsDisableEncryption': 'dword:00000000' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': { 'Start_SearchFiles': 'dword:00000002' }
      }) },
      { label: '还原：重新启用更新保留存储', cmd: 'DISM /Online /Set-ReservedStorageState /State:Enabled /Quiet' }
    ]
  },

  // 应用与界面（总表 117，商店自动更新与推广内容）
  {
    id: 'tf_store_autoupdate', group: '桌面体验', title: '禁用商店自动更新与推广内容', risk: 'medium',
    desc: '关闭 Microsoft Store 应用自动下载更新（AutoDownloadSetting=2），并关闭「消费者特性」推荐与推广弹窗（ContentDeliveryAllowed、SilentInstalledAppsEnabled 等）；应用更新需手动打开商店检查。',
    steps: [
      { label: '商店自动更新关闭 + 推广内容屏蔽', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\WindowsStore': { 'AutoDownloadSetting': 'dword:00000002' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager': {
          'ContentDeliveryAllowed': 'dword:00000000',
          'OemPreInstalledAppsEnabled': 'dword:00000000',
          'PreInstalledAppsEnabled': 'dword:00000000',
          'SilentInstalledAppsEnabled': 'dword:00000000',
          'SubscribedContent-310093Enabled': 'dword:00000000',
          'SubscribedContent-338388Enabled': 'dword:00000000',
          'SystemPaneSuggestionsEnabled': 'dword:00000000'
        }
      }) }
    ],
    restore: [
      { label: '还原：恢复商店自动更新与默认推荐', reg: regBlock({
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\WindowsStore': { 'AutoDownloadSetting': '-' },
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager': {
          'ContentDeliveryAllowed': '-',
          'OemPreInstalledAppsEnabled': '-',
          'PreInstalledAppsEnabled': '-',
          'SilentInstalledAppsEnabled': '-',
          'SubscribedContent-310093Enabled': '-',
          'SubscribedContent-338388Enabled': '-',
          'SystemPaneSuggestionsEnabled': '-'
        }
      }) }
    ]
  }
];

// ==================== 内存 SVCHost 拆分阈值 ====================
function memorySteps(gb) {
  const kb = MEMORY_KB[gb] != null ? MEMORY_KB[gb] : MEMORY_KB[8];
  const gbName = (gb === 'default') ? '重置为默认值' : (gb + 'GB');
  return [{
    label: `SVCHost 拆分阈值 ${gbName}`,
    cmd: `reg add "HKLM\\SYSTEM\\ControlSet001\\Control" /v SvcHostSplitThresholdInKB /t REG_DWORD /d ${kb} /f`
  }];
}

// ==================== 脚本生成器 ====================
function buildScript(steps) {
  const total = steps.length;
  const L = [];
  L.push("$ErrorActionPreference = 'SilentlyContinue'");
  L.push("$ProgressPreference = 'SilentlyContinue'");
  L.push('$failedSteps = 0');
  L.push(DIAG.PS_PREAMBLE.trim());
  steps.forEach((s, i) => {
    const pct = Math.round(((i + 1) / total) * 100);
    const label = (s.label || '第 ' + (i + 1) + ' 步').replace(/\r?\n/g, ' ');
    const labelPs = psQuoteForScript(label);
    L.push(`# step ${i + 1}: ${label}`);
    if (s.reg) {
      L.push('$___rf = Join-Path $env:TEMP ("wcopt_" + [guid]::NewGuid().ToString("N") + ".reg")');
      L.push("$___rc = @'");
      L.push(s.reg);
      L.push("'@");
      L.push('Set-Content -Path $___rf -Value $___rc -Encoding ASCII');
      L.push('& reg.exe import $___rf *> $null');
      L.push(`if ($LASTEXITCODE -ne 0) { $failedSteps++; Write-TFDiag -Stage 'optimizer.reg' -Mutation 'rolled_back' -Detail ('step ' + (${i} + 1) + ' [' + ${labelPs} + '] reg import exit=' + $LASTEXITCODE) }`);
      L.push('Remove-Item $___rf -Force -ErrorAction SilentlyContinue');
    } else if (s.cmd) {
      const safe = s.cmd.replace(/'/g, "''");
      L.push(`$___cmd='${safe}'`);
      L.push('& $env:ComSpec /c $___cmd *> $null');
      L.push(`if ($LASTEXITCODE -ne 0) { $failedSteps++; Write-TFDiag -Stage 'optimizer.cmd' -Mutation 'partial' -Detail ('step ' + (${i} + 1) + ' [' + ${labelPs} + '] exit=' + $LASTEXITCODE) }`);
    } else if (s.service) {
      L.push(`Stop-Service -Name '${s.service}' -Force -ErrorAction SilentlyContinue`);
      if (s.disable) L.push(`Set-Service -Name '${s.service}' -StartupType Disabled -ErrorAction SilentlyContinue`);
      L.push(`if (-not (Get-Service -Name '${s.service}' -ErrorAction SilentlyContinue)) { $failedSteps++; Write-TFDiag -Stage 'optimizer.service' -Mutation 'rolled_back' -Detail ('step ' + (${i} + 1) + ' [' + ${labelPs} + '] 服务不存在: ${s.service}') }`);
    } else if (s.pwsh) {
      L.push(s.pwsh);
    }
    L.push(`Write-Output "@@PROGRESS:${pct}@@"`);
  });
  L.push('Write-Output ("@@FAILED:" + $failedSteps + "@@")');
  L.push('Write-Output "@@DONE@@"');
  return L.join('\n');
}

// ==================== 各优化项优点 / 缺点（简洁短句，供展开详情展示） ====================
const PROS_CONS = {
  'net_response': { pros: '关闭网络节流与多媒体系统响应降级，网络吞吐更稳、系统反馈更快。', cons: '改动多媒体系统响应性可能略增后台调度与功耗，个别在线视频场景表现略有变化。' },
  'tf_net_reset': { pros: '一次性重置 IP/TCP/Winsock/防火墙等 11 项网络栈，能修复多数异常网络与延迟问题。', cons: '会清空自定义防火墙规则并断开现有连接，可能需要重连网络与重配软件。' },
  'tf_net_tcp': { pros: '调整 TCP 窗口与延迟确认等参数，提升高延迟或高吞吐场景下的传输效率。', cons: '非标准参数在个别运营商或网络环境下可能引起不稳定或兼容性问题。' },
  'tf_net_tcpip': { pros: '写入更适合低延迟的 Tcpip 注册表参数，减少小包传输的额外等待。', cons: '参数与系统默认不同，极端网络条件下可能影响连接稳定性。' },
  'tf_net_lanman': { pros: '优化 SMB 会话相关参数，局域网文件共享与访问响应更快。', cons: '改动 LanmanServer 参数在共享服务高负载时可能影响兼容性。' },
  'tf_net_nic': { pros: '批量关闭网卡节能并开启低延迟相关属性，降低网络唤醒与传输抖动。', cons: '关闭节能会让网卡功耗略升，老旧网卡可能不支持部分高级属性。' },
  'tf_net_weakhost': { pros: '开启 WeakHost 收发可改善多网卡下的本地访问与回流场景。', cons: '轻微降低网络隔离安全性，仅建议在明确需要时启用。' },
  'bcd_opt': { pros: '禁用系统合成计时器等启动项，可缩短启动与唤醒延迟。', cons: '属于启动配置修改，失误可能影响启动，需管理员权限。' },
  'ssd_opt': { pros: '关闭磁盘索引并启用 TRIM 等，利于 SSD 寿命与随机读写性能。', cons: '关闭索引后文件搜索变慢，个别选项需要管理员权限方可生效。' },
  'tf_bcd_full': { pros: '一次性写入禁用动态时钟、关闭整页交换等全套启动参数，降低启动延迟。', cons: 'BCD 修改风险高，参数不当可能导致无法启动，务必事先备份。' },
  'tf_microcode_del': { pros: '删除 CPU 微码更新 DLL，减少启动与运行时的一处校验开销。', cons: '移除微码补丁会重新暴露已知 CPU 漏洞与稳定性修复，安全风险较大。' },
  'tf_ntfs': { pros: '关闭 8.3 短名与末次访问时间戳、增大内存使用，可提升文件系统吞吐。', cons: '8.3 名称关闭会让个别老软件找不到文件，NTFS 改动一般不可逆。' },
  'tf_hibern_off': { pros: '彻底关闭休眠与快速启动，可释放磁盘空间并减少关机/启动异常。', cons: '失去快速启动带来的开机加速，且无法再使用休眠功能。' },
  'tf_core_misc': { pros: '调整系统响应与前台优先级等杂项，桌面操作整体更跟手。', cons: '多个小改动叠加，个别后台任务的响应优先级可能被削弱。' },
  'tf_timer_coal': { pros: '关闭计时器合并与部分现代待机，可降低输入与网络延迟噪声。', cons: '增加 CPU 唤醒次数与功耗，笔记本续航可能下降。' },
  'tf_restore_point': { pros: '创建系统还原点，为后续高风险优化提供回退保障。', cons: '占用少量磁盘空间，本身不带来性能收益。' },
  'game_dvr': { pros: '关闭游戏 DVR 后台录制，减少游戏内掉帧与录制延迟。', cons: '无法再使用 Xbox 游戏录制与回放功能。' },
  'mmcss_optimize': { pros: '合并游戏高优先级与系统级增强：游戏调度优先级、GPU 优先级与低延迟标记一体化，画面更稳、输入延迟更低。', cons: '非标准调度参数在个别音频设备上可能不稳定，且可能抢占音频与后台资源。' },
  'mmcss_svc': { pros: '禁用 MMCSS 服务后多媒体调度开销减少。', cons: '音频/视频应用的 QoS 调度失效，可能引起爆音或音画不稳。' },
  'nara_prio': { pros: '为永劫无间等游戏进程设置高 CPU 优先级，降低游戏卡顿。', cons: '仅对特定游戏进程有效，固定高优先级可能挤占其他程序。' },
  'disable_uac': { pros: '关闭 UAC 可消除频繁弹窗，减少提权流程干扰。', cons: '显著降低系统安全性，恶意程序更易获得高权限。' },
  'tf_gamemode': { pros: '开启游戏模式，系统优先保障游戏所需的 CPU/GPU 资源。', cons: '后台任务（更新/同步）可能被推迟，影响日常使用。' },
  'tf_gamebar': { pros: '关闭游戏栏后台捕获与 PresenceWriter，减少叠加层与遥测开销。', cons: '无法使用 Win+G 游戏栏的录屏与性能面板。' },
  'tf_fso': { pros: '关闭全屏优化破坏，可消除部分游戏全屏切换卡顿与输入延迟。', cons: '个别游戏依赖全屏优化特性，关闭后可能出现异常。' },
  'tf_gpu_latency': { pros: '下调 GPU 预渲染帧数与延迟容忍度，能降低输入到画面的延迟。', cons: '设置过低可能引起帧率波动或卡顿，需按显卡性能取舍。' },
  'tf_resource_policy': { pros: '解除系统资源策略限制，释放被节流的 CPU/内存额度。', cons: '绕开系统配额保护，失控进程可能占满系统资源。' },
  'tf_ifeo_perf': { pros: '为进程写入 IFEO CPU/IO 优先级，常驻程序与游戏更跟手。', cons: 'IFEO 针对特定进程，路径或名称变更后失效，全局生效存在风险。' },
  'tf_ifeo_wipe': { pros: '清空 IFEO 调试项，排除被劫持或调试器附加的隐患。', cons: '可能一并删除系统或游戏反作弊所需的兼容性条目。' },
  'prefetch_off': { pros: '关闭预读减少磁盘后台 IO，机械盘老机可能更流畅省资源。', cons: '应用冷启动变慢，固态硬盘上收益有限。' },
  'maps_off': { pros: '禁用下载地图管理器服务，节省内存并减少后台更新。', cons: '离线地图与系统更新相关功能可能受影响。' },
  'services_off': { pros: '一次性停用多组冗余后台服务，降低内存占用与后台 IO。', cons: '可能影响依赖这些服务的外设或系统功能，需选择性使用。' },
  'svc_mem_gb': { pros: '按内存档位调整 SVCHost 拆分阈值，减少服务进程内存碎片。', cons: '阈值与内存不匹配时反而增加进程切换开销。' },
  'mem_compress': { pros: '禁用内存压缩可减少 CPU 压缩/解压开销。', cons: '内存压力大时更易写入页面文件，低内存机器可能变卡。' },
  'tf_mmagent': { pros: '关闭内存压缩与页合并，进一步压低 CPU 后台开销。', cons: '物理内存不足时稳定性下降，可能出现更高硬盘写入。' },
  'tf_svc_bulk': { pros: '批量禁用 70+ 非必要服务，显著释放内存并减少后台活动。', cons: '高度激进，可能破坏打印机、蓝牙、商店等功能，风险较高。' },
  'tf_drv_disable': { pros: '禁用高风险驱动服务，减少内核攻击面与运行时开销。', cons: '可能影响硬件识别或安全软件，需要谨慎选择。' },
  'spectre_off': { pros: '关闭幽灵/熔断缓解，可明显提升 CPU 密集与游戏性能。', cons: '重新暴露 Spectre/Meltdown 类漏洞，系统安全性下降。' },
  'share_off': { pros: '关闭默认管理共享与弱会话，降低局域网被入侵的风险。', cons: '无法再使用 \\\\主机\\C$ 之类管理共享，远程管理不便。' },
  'telemetry_optimize': { pros: '策略+任务+日志+服务四层一体关闭遥测，最大限度减少后台上传与隐私泄露。', cons: '影响诊断反馈与部分个性化/商店功能，系统诊断与日志复盘能力下降。' },
  'power_off': { pros: '禁用部分电源节能，CPU 与设备响应更积极。', cons: '功耗与发热上升，笔记本续航缩短。' },
  'keys_off': { pros: '屏蔽粘滞键等热键，避免误触弹窗干扰。', cons: '确有需要的辅助功能将被一并禁用。' },
  'tf_defender': { pros: '彻底关闭 Defender 与 SmartScreen，减少实时扫描的 CPU/磁盘占用。', cons: '失去实时防病毒保护，系统安全风险显著上升。' },
  'tf_mitigations': { pros: '关闭全部进程与内核缓解，最大化释放性能。', cons: '安全代价极高，易受漏洞利用攻击，不建议日常启用。' },
  'tf_privacy': { pros: '批量关闭内容推送、遥测、反馈等隐私项，界面更干净。', cons: '个性化内容与部分开始菜单建议会消失。' },
  'tf_gpu_msi': { pros: '为独立显卡启用 MSI 中断，可降低图形中断延迟。', cons: '少数老显卡或驱动在 MSI 模式下可能不稳定。' },
  'tf_nvidia_tweaks': { pros: 'NVIDIA 低延迟、TDR 与驱动微调，游戏响应更佳。', cons: '对驱动与显卡兼容性要求高，个别型号可能出现异常。' },
  'tf_nvidia_telemetry': { pros: '关闭 NVIDIA 遥测与自动更新，减少后台联网活动。', cons: '无法自动获取驱动更新，需要手动维护。' },
  'tf_amd_tweaks': { pros: 'AMD 低延迟/省电相关开关调优，游戏与日常响应提升。', cons: '与驱动版本强相关，部分参数可能被忽略或导致异常。' },
  'tf_keys_sticky': { pros: '彻底禁用粘滞/筛选/切换键，杜绝误触弹窗。', cons: '依赖这些辅助功能的用户将无法使用。' },
  'tf_usb_msi': { pros: 'USB 控制器启用 MSI 中断，改善键鼠输入响应。', cons: '个别老旧 USB 设备在 MSI 模式下可能不稳定。' },
  'tf_usb_power': { pros: '关闭 USB 选择性暂停，避免外设休眠唤醒延迟。', cons: 'USB 设备持续供电，笔记本轻微增加耗电。' },
  'mouse_optimize': { pros: '去加速 + 6/11 灵敏度 + 平滑曲线清零一体完成，指针移动完全线性，定位更精准一致。', cons: '习惯带加速手感的用户需要重新适应，少数驱动会重建曲线值，需重启后生效。' },
  'tf_keyboard': { pros: '键盘零延迟并加大数据队列，输入响应更快、更少丢键。', cons: '加大队列在极端情况下可能引入轻微输入滞后。' },
  'tf_dev_disable': { pros: '禁用 HPET/ME 等冗余设备，减少中断与延迟。', cons: '可能影响设备管理、虚拟化或系统稳定性，风险较高。' },
  'tf_dev_audio': { pros: '禁用板载/HDMI 声卡控制器，消除多余音频设备。', cons: '板载与 HDMI 音频将不可用，仅适用独立 USB 声卡用户。' },
  'tf_dev_printer': { pros: '禁用打印队列根设备，无打印需求者减少后台开销。', cons: '之后无法打印，需要打印时须重新启用该设备。' },
  'tf_pccleaner': { pros: '深度清理 Temp/Prefetch/日志/CBS/DISM 等，释放空间更彻底。', cons: '会删除 CBS/DISM 日志影响故障排查，误删系统盘 .log/.bak 存在风险。' },
  'tf_appx': { pros: '移除 25 个预装 UWP 应用，释放磁盘并减少后台活动。', cons: '部分应用移除后需从商店重装，个别系统集成可能异常。' },
  'tf_cortana': { pros: '禁用 Cortana 与网页搜索，减少后台联网与隐私追踪。', cons: '失去 Cortana 语音助手与任务栏网页搜索能力。' },
  'tf_onedrive': { pros: '彻底卸载 OneDrive 并清理数据目录，释放空间、减少同步。', cons: '云端文件不再自动同步，恢复需重新安装并登录。' },
  'tf_oosu': { pros: '静默导入 OOSU 隐私配置，批量关闭大量隐私与遥测开关。', cons: '需联网下载，配置覆盖范围广，可能改变部分系统默认行为。' },
  'explorer_foreground_speed': { pros: '前台程序立即获得焦点与刷新优先级，点击窗口后界面响应更跟手。', cons: '极少数依赖焦点抢占提示的后台弹窗可能更频繁地抢到前台。' },
  'explorer_autorestart': { pros: 'explorer.exe 崩溃后自动拉起，桌面与任务栏无需手动重启。', cons: '崩溃发生时重启过程会有短暂桌面黑屏闪烁。' },
  'explorer_refresh_policy': { pros: '按完整信息刷新文件列表，新建/重命名后图标即时显示。', cons: '禁用简化标识列表在个别网络环境下可能略微增加刷新开销。' },
  'always_unload_dll': { pros: '无引用的 DLL 立即卸载，降低资源管理器常驻内存。', cons: '传统优化项，现代 Windows 部分组件不再读取，收益有限。' },
  'clear_recent_docs_on_exit': { pros: '注销/关机自动清空最近文件记录，保护使用隐私。', cons: '开始菜单最近文件列表不再保留，快速回访文件不便。' },
  'perf_shutdown_fast': { pros: '缩短等待应用退出的超时，关机/注销明显更快。', cons: '个别未保存工作的应用可能被更快结束，建议先保存再关机。' },
  'perf_service_shutdown_fast': { pros: '缩短服务停止超时，关机不再卡在"正在关闭"。', cons: '个别服务可能来不及保存状态，数据库类服务需注意。' },
  'perf_remote_assist_off': { pros: '禁用远程协助入口，减少攻击面与后台监听。', cons: '无法再使用"请求远程协助"功能。' },
  'perf_prefetcher_fast': { pros: '启用应用与启动预读，程序启动与文件访问更快。', cons: 'SSD 上收益有限，Prefetch 被清理后需重新积累。' },
  'perf_crash_autoreboot': { pros: '蓝屏后自动重启，无人值守场景恢复更快。', cons: '排查蓝屏时看不到完整停机码，建议排查期临时关闭。' },
  'perf_exploit_protection_off': { pros: '关闭内核缓解（乱序内存等），部分应用内存分配性能小幅提升。', cons: '显著降低漏洞利用防护，系统更容易受提权/ROP 类攻击。' },
  'edge_hide_firstrun': { pros: '跳过首次运行欢迎与导入向导，新环境开箱即用。', cons: '无法通过向导自动导入其他浏览器的收藏与设置，需手动导入。' },
  'edge_bg_mode_off': { pros: '关闭 Edge 后进程全部退出，释放内存与后台占用。', cons: '依赖 Edge 后台通知的网页推送（如网页版邮件）将不再及时送达。' },
  'edge_startup_boost_off': { pros: '开机不再预启动 Edge，减少后台进程与开机资源占用。', cons: '首次点击 Edge 启动会略微变慢。' },
  'edge_intrusive_ads_off': { pros: '全站拦截侵入式广告，减少误导弹窗与虚假下载按钮。', cons: '个别依赖广告收入的站点可能提示关闭拦截或内容异常。' },
  'edge_ntp_quicklinks_off': { pros: '新标签页更干净，不显示默认推送的热门站点。', cons: '常用站点需手动收藏或输入地址访问。' },
  'edge_sidebar_off': { pros: '去掉右侧边栏（Copilot/发现等），界面清爽、减少误触。', cons: '需要使用侧边栏搜索或 Copilot 入口时需重新开启。' },
  'edge_unsupported_os_warn_off': { pros: '不再弹出旧系统停止支持的通知横幅。', cons: '可能错过重要的安全更新提醒。' },
  'edge_metrics_off': { pros: '浏览器诊断数据零上报，隐私外发通道彻底关闭。', cons: '微软无法收集自动诊断信息，远程协助排查浏览器问题的依据减少。' },
  'edge_tab_perf_detector_off': { pros: '不再弹出标签页性能检测提示，减少打扰。', cons: '个别页面真有性能问题时缺少系统级提醒。' },
  'edge_ntp_content_off': { pros: '新标签页无资讯信息流，加载更快、注意力更集中。', cons: '喜欢在标签页浏览新闻的用户需要主动访问资讯站点。' },
  'edge_personalization_off': { pros: '浏览历史不用于个性化广告与推荐，隐私更好。', cons: '推荐内容不再贴合个人兴趣。' },
  'edge_insecure_download_warn_off': { pros: 'HTTP 下载不再被警告拦截，熟练用户操作更顺畅。', cons: '不安全下载缺少提醒，可能误下被篡改的文件。' },
  'edge_rewards_hide': { pros: '隐藏 Rewards 积分入口，界面更简洁。', cons: '使用 Microsoft Rewards 攒积分的用户需要重新开启。' },
  'edge_sxs_service_off': { pros: '关闭 EdgeUpdate 的 SxsService 后台组件，减少后台活动。', cons: '依赖该组件的 Edge 并行版本功能不可用（多数用户无感知）。' },
  'edge_update_task_disable': { pros: '停止 Edge 自动更新检查，消除后台更新占用。', cons: '浏览器安全补丁不再自动安装，必须定期手动更新。' },
  'edge_game_assistant_overlay_off': { pros: '游戏中不再被 Edge 游戏助手覆盖层干扰。', cons: '与「禁用 Edge 边栏」共用同一策略键，两者只能一起生效/还原。' },
  'privacy_permissions_tune': { pros: '一次精调 20+ 项应用权限与数据收集开关，输入习惯、活动历史、通讯录等不再被收集。', cons: '应用可能失去文档/日历/联系人访问权限，剪贴板历史被启用，个别权限需手动在设置中恢复。' },
  'tasks_stubborn_strategy': { pros: '将 MuMu/UU 远程/微软电脑管家等顽固软件后台服务改为手动并停止，删除 WPS 更新计划任务并关闭自动升级，从源头杜绝其后台自启与残留保活。', cons: '为一次性策略专杀，不提供自动还原；相关软件需使用时须手动打开并自行管理服务。' },
  'tf_ai_off': { pros: '策略级关闭 Copilot/Recall/Click to Do/AI Agent 全家桶并禁用 AgentRuntime 服务，释放后台内存与 CPU，隐私零上传。', cons: '无法使用 Windows 内置 AI 功能（Copilot、Recall 等），系统更新后部分策略可能被重置需重新执行。' },
  'tf_perf_misc': { pros: '启动延迟归零、禁用窗口摇晃与失效快捷方式全盘解析，桌面响应更跟手。', cons: '个别依赖 Aero Shake 的使用习惯失效；禁用链接解析后指向网络位置的失效快捷方式打开更慢。' },
  'tf_privacy_extra': { pros: '补漏关闭 Chrome/Firefox/VS 遥测、许可验证上报、新闻兴趣流与步骤记录器，第三方数据外发通道进一步收窄。', cons: '浏览器与 VS 的官方反馈/体验改进计划退出，个别企业环境可能检测策略与预期不符。' },
  'tf_svc_extra5': { pros: '停用传感器、UCPD、存储感知、PCA 等非必要服务，减少后台进程与定时唤醒。', cons: '亮度自动调节等传感器功能失效，打印机兼容性助手不再提示，外设依赖相关服务时需还原。' },
  'tf_ctx_copymove': { pros: '右键菜单直达「复制/移动到文件夹」对话框，搬运文件免剪贴粘贴。', cons: '右键菜单新增两项条目，菜单略长；个别精简系统该 CLSID 处理器可能缺失而无效果。' },
  'tf_disk_extra3': { pros: '禁用 NTFS 目录加密、搜索仅限索引位置并释放约 7GB 更新保留存储，磁盘空间与扫描开销双降。', cons: 'EFS 文件加密不可用（BitLocker 不受影响），索引范围外的文件搜索变慢，保留存储还原需 DISM 联网。' },
  'tf_store_autoupdate': { pros: '商店应用不再自动下载更新，消除后台偷跑流量与磁盘 IO，推广弹窗一并关闭。', cons: '应用须手动到商店检查更新，长期不更新可能错过安全补丁与新功能。' }
};

// 将优点/缺点注入到选项目录（不改动上方 OPTIONS 结构）
OPTIONS.forEach(o => {
  const pc = PROS_CONS[o.id];
  o.pros = pc && pc.pros ? pc.pros : '';
  o.cons = pc && pc.cons ? pc.cons : '';
});

// ==================== 还原推理（安全兜底） ====================
// 对注册表优化项推理还原操作：
//  - 有显式 restore 的项直接标记可恢复；
//  - steps 仅含 reg 块的项，可推理出「删除全部对应键值」的还原操作
//    （策略键与系统杂项键删除后即恢复系统默认行为）；
//  - 含 cmd / pwsh / service 步骤的项无法可靠推理出还原值，标记为不可恢复
//    （前端「立即恢复」按钮将置灰，点击仅展示简介）。
function invertRegBlock(block) {
  // 将 .reg 文本中的每条 "键"=值 改写为 "键"=-（删除），保留段落结构
  return String(block).replace(/^"([^"]+)"=(.+)$/gm, (m, k) => `"${k}"=-`);
}
OPTIONS.forEach(o => {
  const steps = o.steps || [];
  const regSteps = steps.filter(s => s && s.reg);
  const hasNonReg = steps.some(s => s && !s.reg);
  if (Array.isArray(o.restore) && o.restore.length) {
    o.restoreAvailable = true;
    return;
  }
  if (regSteps.length && !hasNonReg) {
    o.restore = regSteps.map(s => ({
      label: '推理还原：删除上述注册表键值（恢复系统默认行为）',
      reg: invertRegBlock(s.reg)
    }));
    o.restoreInferred = true;
    o.restoreAvailable = true;
  } else {
    o.restoreAvailable = false;
  }
});

module.exports = { OPTIONS, MEMORY_KB, memorySteps, buildScript };
