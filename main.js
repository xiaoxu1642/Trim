// main.js - Electron 主进程
// 负责窗口创建、管理员权限提升、IPC 通信、PowerShell 调用
const { app, BrowserWindow, ipcMain, shell, dialog, screen, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync, exec } = require('child_process');
const { promisify } = require('util');
const net = require('net');

const execAsync = promisify(exec);

// ==================== 内存占用优化 ====================
// 1. 限制 Chromium 磁盘缓存为 32MB（应用资源全部来自本地文件，无需大 HTTP 缓存）。
// 2. 向渲染进程暴露 gc()（--expose-gc），渲染层在窗口隐藏/最小化时主动回收堆内存。
app.commandLine.appendSwitch('disk-cache-size', '33554432');
app.commandLine.appendSwitch('js-flags', '--expose-gc');

// P1-11：失败诊断四元组（failure_stage/mutation_state/diagnostic_digest/native_error_code）
const DIAG = require('./src/main/diag');
const SECURITY = require('./src/main/security');
const RULES_SIG = require('./src/main/rules-signature');
// v2.2 第 2 批（D18）：受保护路径判定的唯一来源。cleanup-scripts.js 以
// require('../main/ps-protect-path') 加载同一文件（同绝对路径→同 require 缓存），
// 因此这里 configureProtectedRoots 补全的清单会被 PS 侧注入逻辑直接读到。
const PROTECT_PATH = require('./src/main/ps-protect-path');
// 批次：自动更新接入（electron-updater + GitHub Releases，仅打包后生效）
const UPDATER = require('./src/main/updater');

// ==================== 防止多开 ====================
// 必须在任何重初始化逻辑（数据迁移、窗口创建、IPC 注册）之前请求单实例锁：
// 第二实例越早退出越好，避免无谓地执行模块级代码与磁盘 IO。
const ELEVATED_RELAUNCH_FLAG = '--elevated-relaunch';
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  if (process.argv.includes(ELEVATED_RELAUNCH_FLAG)) {
    // B5：本进程是提权重启的新实例。旧实例要等收到 second-instance 信号（证明新实例
    // 确实活着）才会退出释放锁，因此这里轮询重试拿锁；拿到锁后模块顶层代码照常执行、
    // 窗口正常创建。超时仍拿不到才放弃退出。
    const retryDeadline = Date.now() + 15000;
    const retryTimer = setInterval(() => {
      if (app.requestSingleInstanceLock()) {
        clearInterval(retryTimer);
        writeLog('info', '提权重启的新实例已取得单实例锁，继续启动');
      } else if (Date.now() > retryDeadline) {
        clearInterval(retryTimer);
        writeLog('error', '提权重启的新实例等待单实例锁超时，退出');
        app.quit();
      }
    }, 250);
  } else {
    app.quit();
  }
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ==================== 全局状态 ====================
let mainWindow = null;
// 审查 2-3：清理快照按发送方（webContents.id）分桶，消除全局单例的竞态窗口——
// 并发扫描不再互相抹除快照；扫描期间的 execute 校验到空快照会 fail-safe 拒绝
const cleanupSnapshots = new Map(); // webContentsId -> Map(item.id -> item)
// v2.2 第3批（D13）：扫描流式回传的可删文件清单（@@PLANFILE@@）进快照的防呆上限——
// 单条目 10 万行、全扫描 100 万行，超限即停止收集（正常内置/自定义规则远达不到）。
const PLAN_CAP_PER_ITEM = 100000;
const PLAN_CAP_TOTAL = 1000000;
let lastContextmenuSnapshot = new Map();
let lastStartupSnapshot = new Map();
let lastProcessSnapshot = new Map();
// finder 删除只允许操作最近一次 Rust 扫描返回的路径，避免渲染层构造任意删除目标。
let lastFinderSnapshot = new Map();

const MAIN_WINDOW_MIN_WIDTH = 1294;
const MAIN_WINDOW_MIN_HEIGHT = 870;
const TITLEBAR_OVERLAY = Object.freeze({
  // 原生按钮覆盖层背景必须与 body.theme-light .titlebar 实际渲染色（#f7f8fb）严格一致，
  // 否则右上角 min/max/close 会形成独立浅灰条，与标题栏出现竖线分界。
  // 历史值 #F3F3F3 被 main.css 7152 行的 #f7f8fb 覆盖后未同步。
  color: '#f7f8fb',
  symbolColor: '#1A1A1A',
  height: 36
});

// IPC 是信任边界：只有应用自己加载的本地页面可以请求系统副作用。
function isTrustedRenderer(event) {
  try {
    const raw = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    if (!raw.startsWith('file://')) return false;
    const filePath = decodeURIComponent(new URL(raw).pathname).replace(/^\/+([A-Za-z]:)/, '$1').replace(/\//g, '\\');
    return isPathUnderRoot(filePath, __dirname);
  } catch (_) {
    return false;
  }
}

function rejectUntrustedRenderer(event) {
  return isTrustedRenderer(event) ? null : { success: false, message: '请求来源不受信任' };
}

// 审查 1-5：模型 API 地址 SSRF 防护——models:save/test 会携带密钥向任意 URL 发请求，
// 必须拒绝环回/私有/链路本地网段，防止被攻陷的渲染层探测内网或把密钥外带到内网收集端。
// 判定只覆盖 IP 字面量与 localhost 主机名；域名解析到内网 IP 的 rebinding 不在此防线内。
// 若将来需要支持本地模型端点（如 Ollama），在此处显式加白名单，不要直接删掉整个校验。
function isPrivateApiUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    const host = (u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true;
    if (net.isIPv4(host)) {
      const o = host.split('.').map(Number);
      if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true;
      if (o[0] === 169 && o[1] === 254) return true;              // 链路本地
      if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;  // 172.16/12
      if (o[0] === 192 && o[1] === 168) return true;              // 192.168/16
      if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT 100.64/10
      return false;
    }
    if (net.isIPv6(host)) {
      if (host === '::' || host === '::1') return true;
      if (/^f[cd]/.test(host)) return true;    // fc00::/7 唯一本地
      if (/^fe[89ab]/.test(host)) return true; // fe80::/10 链路本地
      return false;
    }
    return false;
  } catch (_) {
    return true; // 解析失败按私有处理（fail-safe）
  }
}

// 审查 1-5：settings:load 返回密钥的统一掩码。渲染层表单回显掩码，主进程在 save/test
// 侧识别掩码视为「未修改」保留已存真值——明文密钥不再常驻渲染层。
const API_KEY_MASK = '••••••••';

// 审查 1-3（全量）：统一 IPC 包装器——除显式只读白名单外，所有通道一律校验请求来源，
// 「忘记校验」在结构上不再可能。白名单只收确定只读、无子进程副作用、无敏感面的通道；
// 有疑问的通道一律不进白名单（多一层校验对可信窗口无感，方向安全）。新增通道默认经包装器。
// 审查v4-L9：来源校验由本包装器统一把关，各 handler 内不再重复调用 rejectUntrustedRenderer。
const SIDE_EFFECT_FREE = new Set([
  'app:get-info', 'app:get-theme', 'app:read-usage',           // 应用信息/主题/使用统计查询
  'appearance:get-material', 'appearance:bg-list',             // 材质与背景图列表查询
  'bench-history:list',                                        // 测速历史列表
  'cleanup:rules',                                             // 清理规则查询（渲染层展示）
  'elevate:status',                                            // 提权状态查询
  'fonts:list', 'intro:load', 'log:read',                      // 字体列表/本地简介库/日志读取
  'maintenance:tasks',                                         // 维护任务清单
  'memory:info', 'memory:processes',                           // 内存信息/进程列表
  'optimizer:list', 'overview:hardware', 'overview:metrics',   // 优化项清单/硬件信息/指标查询
  'overview:checkup',                                          // 系统体检（v2.6.0 只读诊断）
  'updater:get-mirror',                                        // 更新镜像偏好读取（v2.6.0）
  'paths:load', 'realtime:adapters', 'realtime:report-list'    // 路径配置/网络适配器/测速报告列表
]);

function handleSafe(channel, fn) {
  return ipcMain.handle(channel, async (event, ...args) => {
    if (!SIDE_EFFECT_FREE.has(channel)) {
      const denied = rejectUntrustedRenderer(event);
      if (denied) return denied;
    }
    return fn(event, ...args);
  });
}

function onSafe(channel, fn) {
  return ipcMain.on(channel, (event, ...args) => {
    if (!SIDE_EFFECT_FREE.has(channel)) {
      const denied = rejectUntrustedRenderer(event);
      if (denied) return; // on 通道无返回值，拒绝即不执行 handler
    }
    return fn(event, ...args);
  });
}

function isAllowedLocalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'file:') return false;
    const filePath = decodeURIComponent(parsed.pathname).replace(/^\/+([A-Za-z]:)/, '$1').replace(/\//g, '\\');
    return isPathUnderRoot(filePath, path.join(__dirname, 'src'));
  } catch (_) {
    return false;
  }
}

function secureWindowNavigation(win) {
  if (!win || win.isDestroyed()) return;
  const guardNavigation = (event, targetUrl) => {
    if (!isAllowedLocalUrl(targetUrl)) event.preventDefault();
  };
  win.webContents.on('will-navigate', guardNavigation);
  win.webContents.on('will-redirect', guardNavigation);
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol === 'https:') shell.openExternal(parsed.toString());
    } catch (_) {}
    return { action: 'deny' };
  });
}

function snapshotById(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item && typeof item.id === 'string' && item.id.length <= 160) map.set(item.id, item);
  }
  return map;
}

function validateSnapshotItems(items, snapshot) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 500) return null;
  const result = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') return null;
    const known = snapshot.get(item.id);
    if (!known) return null;
    // 只取扫描结果中的字段，禁止调用方修改 path/risk/source 等副作用参数。
    if (item.path && known.path && path.resolve(String(item.path)) !== path.resolve(String(known.path))) return null;
    result.push({ ...known });
  }
  return result;
}

// 本应用 spawn 的子进程注册表（PID 白名单）。退出时由 before-quit 一并清理，
// 仅杀「本应用 spawn 且已登记」的进程，绝不按进程名无差别杀戮（如 taskkill /im node.exe）。
const backendProcs = new Map(); // pid -> { pid, kind, cmdline }
const isDev = !app.isPackaged;
const APP_NAME = 'Trim';
// v2.6.0（P2-9）：便携模式——程序目录存在 Trim.portable 标记文件时，数据目录改用
// <程序目录>\data。userData 必须在 app ready 之前 setPath 才能对全部 Electron 子系统生效；
// 开发环境恒为标准模式，避免误把仓库根目录当便携盘。
const IS_PORTABLE = (() => {
  try {
    if (!app.isPackaged) return false;
    return fs.existsSync(path.join(path.dirname(app.getPath('exe')), 'Trim.portable'));
  } catch (_) { return false; }
})();
if (IS_PORTABLE) {
  try { app.setPath('userData', path.join(path.dirname(app.getPath('exe')), 'data')); } catch (_) {}
}

// 应用数据根目录（统一品牌为 Trim）。旧版本曾使用 "CleanTool" 目录，
// 启动时做一次性迁移，避免用户已有的配置 / 日志 / 缓存 / 备份数据丢失。
// C1：优先 userData（productName=Trim 时即 %APPDATA%\Trim，兼容 USERPROFILE 重定向
// 与 portable 形态）；dev 模式 userData 指向 Electron 默认目录，回退硬编码以共享
// 安装版数据。LEGACY_DATA_DIR 仅保留给 CleanTool→Trim 的旧数据迁移兜底。
// v2.6.0（P2-9）：便携模式下 userData 基名是 "data" 而非 "trim"，必须在此显式返回
// 程序目录 data 子目录，否则会静默回落到 %APPDATA%\Trim 导致便携失效。
const PORTABLE_DATA_DIR = IS_PORTABLE ? path.join(path.dirname(app.getPath('exe')), 'data') : null;
const APP_DATA_DIR = (() => {
  if (PORTABLE_DATA_DIR) return PORTABLE_DATA_DIR;
  try {
    if (app.isPackaged) {
      const ud = app.getPath('userData');
      if (ud && path.basename(ud).toLowerCase() === 'trim') return ud;
    }
  } catch (e) { /* userData 不可用时走硬编码兜底 */ }
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Trim');
})();
const LEGACY_DATA_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'CleanTool');
const LOG_DIR = path.join(APP_DATA_DIR, 'logs');

// 启动时迁移旧版本（CleanTool）数据目录到 Trim。仅当新目录不存在时才复制，
// 避免覆盖；迁移失败不阻塞启动（记录日志即可）。
function migrateLegacyData() {
  try {
    if (!fs.existsSync(LEGACY_DATA_DIR)) return;
    if (fs.existsSync(APP_DATA_DIR)) return;
    fs.mkdirSync(APP_DATA_DIR, { recursive: true });
    fs.cpSync(LEGACY_DATA_DIR, APP_DATA_DIR, { recursive: true });
    // 审查v4-L10：迁移是用户可感知事件，改走 writeLog 落「操作日志」页（原仅 console 不可见；
    // 调用点在 whenReady 内，此时日志系统已就绪）
    writeLog('info', `已从 ${LEGACY_DATA_DIR} 迁移既有数据到 ${APP_DATA_DIR}`);
  } catch (e) {
    writeLog('error', `迁移旧数据目录失败: ${e.message}`);
  }
}

// 统一 Windows 通知、任务栏分组、跳转列表的应用标识（与 package.json 的 appId 一致）
app.setAppUserModelId('com.xiaoxu.trim');

// 将最终客户区尺寸发送给渲染层。最大化/还原时 Windows 可能先更新
// 原生窗口状态、稍后才提交 WebContents 尺寸，因此渲染层需要在下一帧再回流。
function notifyRendererResize() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  const bounds = mainWindow.getContentBounds();
  mainWindow.webContents.send('window:resized', {
    width: bounds.width,
    height: bounds.height,
    maximized: mainWindow.isMaximized()
  });
}

// ==================== Win11 27H2 窗口原生层修复 ====================
// 27H2 (Build 29648) 实测两类异常：
//   1) 最大化后 WebContents 客户区不扩展（innerWidth/innerHeight 停留在旧尺寸，
//      右侧/底部大片空白，canvas 图表等渲染层内容随之失效）
//   2) DWM 圆角偏好未生效（窗口四角呈直角，而窗口样式 WS_CAPTION|WS_THICKFRAME 完好）
// 修复：最大化时校验客户区与显示器工作区，不一致则强制 setContentBounds 并触发重绘；
//       圆角通过 DWMWA_WINDOW_CORNER_PREFERENCE(33)=DWMWCP_ROUND(2) 显式声明。
let cornersDeclared = false; // 审查 1-7：Add-Type 编译缓存，进程内只编译一次（避免每次最大化/还原都重复编译 C#）
function forceRoundCorners() {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const buf = mainWindow.getNativeWindowHandle();
    const hwnd = process.arch === 'x64' ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0);
    // C# 签名内含双引号 —— 走 writeTempScript 临时文件执行后引号天然安全（审查 1-7：弃用
    // powershell 5.1 字符串拼接 exec，统一走已封装的 pwsh7 运行时 + 超时兜底）
    const sig = '[DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);';
    const b64 = Buffer.from(sig, 'utf8').toString('base64');
    const declare = cornersDeclared ? '' : '$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\'' + b64 + '\')); Add-Type -MemberDefinition $s -Name D -Namespace W32; ';
    cornersDeclared = true;
    const ps = declare + '[void][W32.D]::DwmSetWindowAttribute([IntPtr]' + hwnd + ', 33, [ref]2, 4)';
    runPowerShell(ps, { timeout: 8000 }).catch(() => {}); // 圆角为视觉增强，失败不阻塞
  } catch (e) { /* 圆角为视觉增强，失败不阻塞 */ }
}

function ensureMaximizedClientBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isMaximized()) {
    writeLog('info', `[窗口修复] ensure 跳过：maximized=${mainWindow ? mainWindow.isMaximized() : 'no-win'}`);
    return;
  }
  try {
    const wa = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
    const cb = mainWindow.getContentBounds();
    writeLog('info', `[窗口修复] maximized 客户区=${cb.width}x${cb.height}@${cb.x},${cb.y} 工作区=${wa.width}x${wa.height}@${wa.x},${wa.y}`);
    if (cb.x !== wa.x || cb.y !== wa.y || cb.width !== wa.width || cb.height !== wa.height) {
      mainWindow.setContentBounds(wa);
      setTimeout(() => {
        try {
          const cb2 = mainWindow.getContentBounds();
          writeLog('info', `[窗口修复] setContentBounds 后客户区=${cb2.width}x${cb2.height}`);
        } catch (e) {}
      }, 120);
    }
    if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.invalidate();
    }
  } catch (e) { writeLog('error', `[窗口修复] 异常: ${e.message}`); }
}

// ==================== 管理员权限检测 ====================
// net session 探测在域环境/离线/网络异常时可能耗时数秒，同步执行会冻结主进程
// 事件循环（连带全部渲染进程卡顿）。改为异步探测 + 进程内缓存：同一进程生命周期
// 内权限不会变化，检测一次即可；启动关键路径（ready-to-show）只做异步回填。
let adminStatusCache = null; // null=未检测完成 / true / false
let adminDetecting = null;
function isAdmin() {
  if (adminStatusCache !== null) return Promise.resolve(adminStatusCache);
  if (!adminDetecting) {
    adminDetecting = execAsync('net session', { windowsHide: true, timeout: 10000 })
      .then(() => { adminStatusCache = true; return true; })
      .catch(() => { adminStatusCache = false; return false; })
      .finally(() => { adminDetecting = null; });
  }
  return adminDetecting;
}

// ==================== 日志系统 ====================
function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch (e) {
    console.error('创建日志目录失败:', e);
  }
}

// B9：日志改为内存缓冲 + 批量异步落盘。高频扫描/批量清理场景下逐条 appendFileSync
// 会把同步 I/O 叠加到主进程事件循环上；日志对实时性不敏感，setImmediate 合并落盘即可。
// 退出前由 flushLogSync() 强制刷盘，防止尾部日志丢失。
const logQueue = [];
let logFlushScheduled = false;

function groupLogBatch(batch) {
  const byFile = new Map();
  for (const entry of batch) {
    if (!byFile.has(entry.file)) byFile.set(entry.file, []);
    byFile.get(entry.file).push(entry.line);
  }
  return byFile;
}

function flushLogQueue() {
  logFlushScheduled = false;
  if (!logQueue.length) return;
  const byFile = groupLogBatch(logQueue.splice(0));
  for (const [file, lines] of byFile) {
    fs.promises.appendFile(file, lines.join(''), 'utf8').catch(e => {
      console.error('写入日志失败:', e.message || e);
    });
  }
}

// 同步兜底：仅在应用退出等无法等待异步完成的时机调用
function flushLogSync() {
  if (!logQueue.length) return;
  const byFile = groupLogBatch(logQueue.splice(0));
  for (const [file, lines] of byFile) {
    try {
      fs.appendFileSync(file, lines.join(''), 'utf8');
    } catch (e) {
      console.error('写入日志失败:', e);
    }
  }
}

function writeLog(level, message) {
  ensureLogDir();
  const ts = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  const line = `[${ts}] [${level.toUpperCase()}] ${message}\n`;
  const logFile = path.join(LOG_DIR, `app-${new Date().toISOString().slice(0, 10)}.log`);
  logQueue.push({ file: logFile, line });
  if (!logFlushScheduled) {
    logFlushScheduled = true;
    setImmediate(flushLogQueue);
  }
  return line;
}

// ==================== PowerShell 7 执行 ====================
let powerShell7Path = null;
// 审查v4-M7：探测失败负缓存——损坏/卡死的 pwsh 候选会拖满 5s 超时且失败不写缓存，
// 之后每次 pwsh 类 IPC 都重复整套同步探测并冻结主进程事件循环；60s 内直接复用失败结论
const PWSH_PROBE_FAIL_TTL_MS = 60000;
let pwshProbeFailedAt = 0;
let pwshProbeError = null;

function isPowerShell7Executable(executable) {
  try {
    const result = spawnSync(
      executable,
      ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    );
    return result.status === 0 && Number(result.stdout.trim()) >= 7;
  } catch (e) {
    return false;
  }
}

function resolvePowerShell7Path() {
  if (powerShell7Path) return powerShell7Path;
  // 审查v4-M7：命中负缓存直接快速失败，不再对损坏候选反复 spawnSync 阻塞事件循环
  if (pwshProbeError && Date.now() - pwshProbeFailedAt < PWSH_PROBE_FAIL_TTL_MS) {
    throw pwshProbeError;
  }

  const candidates = [
    process.env.PWSH7_PATH,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe') : null
  ].filter(Boolean);

  const whereResult = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true });
  if (whereResult.status === 0) {
    candidates.push(
      ...whereResult.stdout
        .split(/\r?\n/)
        .map(item => item.trim())
        .filter(candidate => candidate)
    );
  }

  // C3：WindowsApps 里的 pwsh.exe 可能是 0 字节应用执行别名存根，未装 PowerShell 7
  // 时执行它会拉起 Microsoft Store。排到最后，且仅当文件非 0 字节（真实安装）才探测。
  const winAppsStub = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe')
    : null;
  if (winAppsStub) {
    try {
      if (fs.statSync(winAppsStub).size > 0) candidates.push(winAppsStub);
    } catch (e) { /* 不存在则跳过 */ }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && isPowerShell7Executable(candidate)) {
      powerShell7Path = candidate;
      pwshProbeError = null; // 审查v4-M7：探测成功即解除负缓存
      return powerShell7Path;
    }
  }

  const error = new Error('未找到 PowerShell 7（pwsh.exe），请先安装 PowerShell 7 后重试。');
  error.code = 'PWSH7_NOT_FOUND';
  pwshProbeFailedAt = Date.now(); // 审查v4-M7：失败结论入负缓存
  pwshProbeError = error;
  throw error;
}

// 登记本应用 spawn 的子进程（PID 白名单），退出时由 before-quit 统一清理
function registerBackendChild(child, executable, args) {
  if (!child || !child.pid) return;
  backendProcs.set(child.pid, {
    pid: child.pid,
    kind: 'powershell',
    cmdline: `${executable} ${(Array.isArray(args) ? args : []).join(' ')}`
  });
  child.on('close', () => backendProcs.delete(child.pid));
  child.on('error', () => backendProcs.delete(child.pid));
}

// P1-11：从 stdout 中提取 @@DIAG@@ 诊断行，四元组写入操作日志，返回清洗后的 stdout
function extractDiagLines(stdout, op) {
  if (!stdout || stdout.indexOf(DIAG.DIAG_PREFIX) === -1) return stdout;
  const kept = [];
  for (const line of stdout.split(/\r?\n/)) {
    const d = DIAG.parseDiagLine(line);
    if (d) {
      writeLog('error', DIAG.formatDiag(op || 'powershell', d));
    } else {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

// B4：runPowerShell / runPowerShellFile 共用的子进程封装。
// 超时/kill/clearTimeout 逻辑统一在此实现（原先只有 File 变体有），pwsh 卡死时
// 调用方（如 elevate:request）不会再出现 Promise 永不 settle、IPC 永久挂起。
// options: { timeout(ms), diagOp, onStdout(chunk), 以及透传给 spawn 的其它选项 }
function runPwshChild(args, options) {
  return new Promise((resolve, reject) => {
    let executable;
    try {
      executable = resolvePowerShell7Path();
    } catch (err) {
      writeLog('error', err.message);
      reject(err);
      return;
    }
    const { timeout, diagOp, onStdout, ...spawnOptions } = options;
    const child = spawn(executable, args, {
      windowsHide: true,
      ...spawnOptions
    });
    registerBackendChild(child, executable, args);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => {
      const chunk = d.toString('utf8');
      stdout += chunk;
      if (typeof onStdout === 'function') {
        try { onStdout(chunk); } catch (e) {}
      }
    });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });

    let timeoutHandle = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(result);
    };
    child.on('error', err => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      writeLog('error', `PowerShell 7 启动失败: ${err.message}`);
      reject(err);
    });
    child.on('close', code => {
      const cleanStdout = extractDiagLines(stdout, diagOp);
      if (code !== 0 && stderr && stderr.trim()) {
        writeLog('warn', `PowerShell 7 退出码 ${code}: ${stderr}`);
      }
      // 即使有错误也返回结果，由调用方判断
      finish({ stdout: cleanStdout, stderr, code, timedOut: false });
    });
    if (Number.isFinite(timeout) && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        try { child.kill(); } catch (e) {}
        finish({ stdout, stderr: `${stderr}\nPowerShell 7 执行超时`, code: -1, timedOut: true });
      }, timeout);
    }
  });
}

function runPowerShell(script, options = {}) {
  return runPwshChild([
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', script
  ], options);
}

// 将脚本写入临时文件再执行（避免命令行长度限制）
function runPowerShellFile(scriptPath, options = {}) {
  return runPwshChild([
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath
  ], options);
}

// 临时脚本目录：位于 %APPDATA%\Trim\tmp\（当前用户 ACL 保护，同机其他标准用户
// 不可写）。不用 %TEMP%：那是系统级全局可写目录，而本应用经 UAC 提权后脚本会
// 以管理员身份执行——低权限用户可预写/替换脚本或放置目录联接，构成 TOCTOU
// 本地提权窗口（见审查报告 A1）。
function getTempScriptDir() {
  const dir = path.join(APP_DATA_DIR, 'tmp');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// 写入临时 PowerShell 脚本
function writeTempScript(content, suffix = '.ps1') {
  const tempDir = getTempScriptDir();
  // 拒绝符号链接/联接点：目录若被替换为链接，脚本内容可能被导向任意位置
  const dirStat = fs.lstatSync(tempDir);
  if (dirStat.isSymbolicLink()) {
    throw new Error('临时脚本目录已被替换（符号链接/联接点），已拒绝写入');
  }
  const filePath = path.join(tempDir, `script_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${suffix}`);
  // PowerShell 5.1 默认按系统 ANSI 编码读取无 BOM 脚本，中文注释会乱码导致解析失败；
  // PowerShell 7 亦兼容 UTF-8 BOM，故为 .ps1 写入带 BOM 的 UTF-8。
  // mode 0o600：仅所有者可读写（Windows 上 ACL 继承自用户目录，此处为跨平台双保险）。
  if (suffix.toLowerCase() === '.ps1') {
    fs.writeFileSync(filePath, Buffer.from('\uFEFF' + content, 'utf8'), { mode: 0o600 });
  } else {
    fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  }
  return filePath;
}

// 清理临时脚本（含旧版本遗留在全局可写 %TEMP%\Trim 下的历史残留）
function cleanupTempScripts() {
  const now = Date.now();
  const sweep = (dir) => {
    try {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const fp = path.join(dir, f);
        try {
          // 审查 1-6：lstatSync 不跟随符号链接——与 writeTempScript 的目录检查一致，
          // 避免解析到链接目标的元数据；非常规文件（链接/设备）直接跳过
          const stat = fs.lstatSync(fp);
          if (!stat.isFile()) continue;
          // 删除超过 1 小时的临时文件
          if (now - stat.mtimeMs > 3600 * 1000) {
            fs.unlinkSync(fp);
          }
        } catch (e) {}
      }
    } catch (e) {
      writeLog('error', `清理临时脚本失败: ${e.message}`);
    }
  };
  sweep(getTempScriptDir());
  sweep(path.join(os.tmpdir(), 'Trim'));
}

// ==================== Windows 11 特性检测 ====================
// 获取 Windows 版本号（用于判断 Mica 支持级别）
function getWindowsBuild() {
  const release = os.release(); // e.g. "10.0.22621" or "10.0.28000"
  const parts = release.split('.');
  return parseInt(parts[2] || '0', 10);
}

// Windows 11 22H2 (22621)+ 支持原生 Mica
// Windows 11 25H2/26H1 (28000+) 支持所有 SystemBackdrop
function getFluentSupportLevel() {
  const build = getWindowsBuild();
  if (build >= 22621) return 'full';      // Mica + Acrylic + DWM
  if (build >= 22000) return 'partial';   // 基础 Mica
  return 'none';                           // Win10，不支持
}

// ==================== 窗口材质（主窗 / 子窗共享逻辑） ====================
// 材质名 → Electron backgroundMaterial 原生值。细亚克力与亚克力共用原生 acrylic，
// 「更透亮」的差异化由渲染层 data-material 着色透明度分级实现（main.css 材质 2.0 段）。
// none = 无材质（普通不透明窗口，DWM 不参与）。
const MATERIAL_NATIVE_MAP = {
  'mica': 'mica', 'mica-alt': 'tabbed', 'acrylic': 'acrylic', 'thin-acrylic': 'acrylic', 'none': 'none'
};
// 读取持久化的合法材质（非法值回退 mica，与设置页默认一致）
function getSavedMaterial() {
  const m = loadAppearance().material;
  return MATERIAL_NATIVE_MAP[m] ? m : 'mica';
}
function nativeMaterialFor(material) {
  return MATERIAL_NATIVE_MAP[material] || 'mica';
}
// 子窗口构造参数的原生材质片段：Win10 / 「无材质」时不设置（普通不透明窗口）。
// backgroundColor 保留不透明兜底——窗口在首帧之后才 show，不会盖住材质。
function childWindowMaterialOption() {
  if (getFluentSupportLevel() === 'none') return {};
  // 材质总开关关闭（窗口界面升级3）：与「无材质」一致，不设原生材质
  if (loadAppearance().materialEnabled === false) return {};
  const saved = getSavedMaterial();
  if (saved === 'none') return {};
  return { backgroundMaterial: nativeMaterialFor(saved) };
}

// ==================== 窗口状态持久化 ====================
// 关闭时保存 bounds + 最大化状态到 appearance.json（%APPDATA%\Trim），启动时恢复。
// 最大化时记录 getNormalBounds()（还原位），恢复时直接最大化。
function loadWindowState() {
  const st = loadAppearance().windowState;
  return (st && typeof st === 'object') ? st : null;
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const maximized = mainWindow.isMaximized();
    const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    const ap = loadAppearance();
    ap.windowState = {
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized
    };
    saveAppearance(ap);
  } catch (e) { /* 持久化失败不阻塞关闭 */ }
}

// 校验恢复的 bounds 是否落在任一显示器的可见范围内（容忍 20px 边缘），
// 防止显示器拓扑变化后窗口恢复到屏幕外不可见位置。
function sanitizeWindowState(state) {
  if (!state || !Number.isFinite(state.x) || !Number.isFinite(state.y) ||
      !Number.isFinite(state.width) || !Number.isFinite(state.height)) return null;
  try {
    const visible = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return state.x + state.width > a.x + 20 &&
             state.y + state.height > a.y + 20 &&
             state.x < a.x + a.width - 20 &&
             state.y < a.y + a.height - 20;
    });
    return visible ? state : null;
  } catch (e) { return null; }
}

// ==================== 窗口创建 ====================
const mainWindowCreatedAt = Date.now();
function createWindow() {
  const fluentLevel = getFluentSupportLevel();
  const useMica = fluentLevel === 'full' || fluentLevel === 'partial';
  const savedWindowState = sanitizeWindowState(loadWindowState());

  const windowOptions = {
    width: MAIN_WINDOW_MIN_WIDTH,
    height: MAIN_WINDOW_MIN_HEIGHT,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    // 显式声明可调整大小与可最大化：titleBarStyle:'hidden' + titleBarOverlay
    // 在 Electron 33/Win11 下若不显式声明，最大化按钮可能不被原生 overlay 渲染
    // （仅最小化和关闭出现）。显式置 true 确保三按钮齐全。
    resizable: true,
    maximizable: true,
    // 客户区=窗口（contentSize 渲染）：最小 1294×870 即内容区/客户区尺寸（2.0 起
    // 基线调整，规范见 readme「窗口尺寸」），不含标题栏与边框，
    // 仅可放大或最大化、不可缩小到该尺寸以下。
    useContentSize: true,
    title: APP_NAME,
    show: false,
    autoHideMenuBar: true,
    // 标题栏图标统一来自工作目录 ico 文件夹，避免预览/运行时资源不一致。
    icon: path.join(__dirname, 'src', 'assets', 'ico', 'Trim.ico'),
    // 透明窗口会让空白区域命中后面的应用，导致点击时出现重影和失焦。
    transparent: false,
    // titleBarOverlay 依赖原生窗口框架管理客户区。frame:false 会使原生
    // 控制按钮和 renderer 在最大化后仍停留在旧尺寸，造成画面与命中区错位。
    frame: true,
    titleBarStyle: 'hidden',
    // 标题栏是独立的系统窗口表面，不继承应用主题、强调色、材质或背景图。
    // 这样原生最小化/最大化/关闭按钮与左侧标题区域始终使用同一底色。
    titleBarOverlay: TITLEBAR_OVERLAY,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 启动黑闪修复：窗口隐藏等待首帧握手期间，禁用后台节流以保证
      // requestAnimationFrame/定时器正常走帧，首帧通知能及时发出
      backgroundThrottling: false
    }
  };

  // 恢复上次关闭时的窗口尺寸与位置（窗口状态持久化）
  if (savedWindowState) {
    windowOptions.width = savedWindowState.width;
    windowOptions.height = savedWindowState.height;
    windowOptions.x = savedWindowState.x;
    windowOptions.y = savedWindowState.y;
  }

  if (useMica) {
    // Windows 11: 原生背景材质（Electron 30+），材质由设置页「窗口材质」选择
    // Mica=柔和云母 / Mica Alt(tabbed)=层次云母 / acrylic=磨砂玻璃（细亚克力共用 acrylic，
    // 视觉更透亮的差异化由渲染层 data-material 透明度分级完成）；none=无材质。
    const saved = getSavedMaterial();
    if (saved !== 'none') {
      windowOptions.backgroundMaterial = nativeMaterialFor(saved);
      // 首帧使用不透明浅色底色，避免透明客户区在 DWM 提交前出现黑闪。
      // Mica 仍作为可损失的视觉增强，页面本身始终提供不透明 CSS 兜底。
      windowOptions.backgroundColor = '#F5F6F8';
    } else {
      windowOptions.backgroundColor = '#f3f3f3';
    }
  } else {
    // Windows 10 回退：普通不透明背景
    windowOptions.backgroundColor = '#f3f3f3';
  }

  mainWindow = new BrowserWindow(windowOptions);
  secureWindowNavigation(mainWindow);
  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.setFocusable(true);
  // Electron 33 + Win11 29648 实测：构造参数 maximizable:true 不会反映到原生
  // WS_MAXIMIZEBOX 样式（isMaximizable()=false，原生 overlay 缺最大化按钮），
  // 必须在创建后显式调用一次才能恢复三按钮。
  mainWindow.setMaximizable(true);

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // 启动黑闪修复：不再在 ready-to-show（仅首帧底色，UI 尚未提交）就显示窗口，
  // 而是等渲染层 DOMContentLoaded 后连排两个 rAF 发来的 app:first-paint 再显示，
  // 保证窗口出现的瞬间就是完整 UI；最大化与 DWM 圆角也前移到 show 之前完成，
  // 避免 show 后二次改窗（可见的尺寸跳变/边框重绘）。
  let mainWindowShown = false;
  const showMainWindowWhenReady = (cause) => {
    if (mainWindowShown) return;
    mainWindowShown = true;
    writeLog('info', `主窗口显示（触发: ${cause}，距创建 ${Date.now() - mainWindowCreatedAt}ms）`);
    if (savedWindowState && savedWindowState.maximized) {
      mainWindow.maximize();
      // maximize 后补发尺寸通知，确保 win-maximized 底色类正确同步
      //（此时渲染层必然已加载，无需再挂 did-finish-load）
      setTimeout(notifyRendererResize, 120);
      setTimeout(notifyRendererResize, 400);
    }
    // Win11 27H2：显式声明 DWM 圆角，避免直角边框
    forceRoundCorners();
    mainWindow.show();
    // 日志精简：仅记录打开/开关/执行/错误——应用启动合并为一条。
    // 管理员检测为异步（不阻塞首帧显示），完成后回填日志并预热缓存。
    isAdmin().then(v => writeLog('info', `应用启动（管理员: ${v ? '是' : '否'}）`));
  };
  mainWindow.once('ready-to-show', () => {
    // 兜底：渲染层首帧通知 3s 内未到达（渲染异常/脚本失败）也照常显示窗口
    setTimeout(() => showMainWindowWhenReady('ready-to-show 3s 兜底'), 3000);
  });
  // 创建级兜底：ready-to-show 本身也未触发时（页面卡死）最终仍显示窗口
  setTimeout(() => showMainWindowWhenReady('创建后 8s 兜底'), 8000);
  mainWindowOnFirstPaint = () => showMainWindowWhenReady('渲染层首帧握手');

  // ==================== 主题 ====================
  // v2.1（2026-09-10 需求变更）：应用固定浅色，删除系统主题跟随广播。
  // 标题栏保持独立的固定浅色表面，不跟随系统主题或强调色，避免原生窗口按钮区域出现色块冲突。

  // 最大化状态同步（用于标题栏按钮图标切换）
  // Win11 27H2 实测结论（2026-09-03 多轮验证）：
  //   a) 最大化/还原会扰动 DWM 材质层，材质失效后窗口透出纯黑；运行中调用
  //      setBackgroundMaterial（none→mica 重设、同值重设、±1px 尺寸抖动）均无法
  //      令 DWM 重建 backdrop，反而可能破坏 DirectComposition 交换链，把黑屏
  //      拖成永久 —— 因此最大化/还原路径不做任何原生材质操作。
  //   b) 可读性由渲染层兜底：body.electron-mica 带 88% 不透明 base 安全网底色
  //      （main.css），材质失效时界面照常可读；body.win-maximized 在最大化
  //      期间 100% 不透明自绘客户区。DWM 材质降级为可损失的视觉增强。
  //   c) 最大化后 WebContents 客户区可能不扩展 —— 由 ensureMaximizedClientBounds 校正。
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized', true);
    // Win11 27H2：客户区可能不随最大化扩展，分两档延迟校验并强制对齐工作区
    setTimeout(ensureMaximizedClientBounds, 60);
    setTimeout(ensureMaximizedClientBounds, 300);
    notifyRendererResize();
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized', false);
    // 底色兜底已由渲染层 CSS 完成（body.electron-mica 88% base），
    // 这里只负责圆角与尺寸同步，不做材质操作（见上方结论 a）。
    forceRoundCorners();
    notifyRendererResize();
  });

  // 内存占用优化：窗口最小化/隐藏后立即清空网络缓存并通知渲染层 GC
  const trimMainWindowMemory = () => {
    try { mainWindow?.webContents.session.clearCache(); } catch (e) {}
    try { mainWindow?.webContents.send('memory:trim'); } catch (e) {}
  };
  mainWindow.on('minimize', trimMainWindowMemory);
  mainWindow.on('hide', trimMainWindowMemory);
  mainWindow.on('resize', notifyRendererResize);

  // C2：窗口状态持久化不再挂在 close 上（与优雅关闭的 close 拦截双写，且取消
  // 关闭时也会写入）；统一在确认真正退出的 performFinalClose / before-quit 中保存
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 注册优雅关闭钩子（拦截关闭 → 感谢Toast → 逐步关闭服务 → 真正退出）
  registerShutdownHook();

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ==================== IPC 处理 ====================
// 应用信息
handleSafe('app:get-info', async () => {
  return {
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    osVersion: os.release(),
    osBuild: getWindowsBuild(),
    fluentSupport: getFluentSupportLevel(),
    micaEnabled: getFluentSupportLevel() !== 'none',
    materialEnabled: loadAppearance().materialEnabled !== false,
    isAdmin: await isAdmin(),
    username: os.userInfo().username,
    homedir: os.homedir(),
    powerShell: 'PowerShell 7',
    // v2.6.0（P2-9）：数据目录形态（设置页「系统信息」展示）
    portable: IS_PORTABLE,
    dataDir: APP_DATA_DIR
  };
});

// 批次：外部链接（HTTPS only）—— secureWindowNavigation 阻止了渲染层任何 href 导航，
// 所以需要这个 IPC 作为受控出口：只允许 https 协议，防 file: / javascript: / data: 等注入。
handleSafe('app:open-external', async (_, url) => {
  if (typeof url !== 'string' || !url.trim()) return { ok: false, reason: 'empty' };
  let parsed;
  try { parsed = new URL(url.trim()); } catch (_) { return { ok: false, reason: 'invalid-url' }; }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'scheme', protocol: parsed.protocol };
  await shell.openExternal(parsed.toString());
  return { ok: true };
});

// 批次：自动更新接入——手动检查 / 下载 / 取消 / 安装（均经 handleSafe 校验来源）
// 这些通道有副作用（网络下载、退出安装），不得加入 SIDE_EFFECT_FREE 只读白名单。
handleSafe('updater:check', async () => UPDATER.safeCheck(false));
handleSafe('updater:download', async () => UPDATER.startDownload());
handleSafe('updater:cancel-download', () => UPDATER.cancelDownload());
handleSafe('updater:install', () => {
  // v2.7.0：安装更新会触发窗口 close——提前进入关闭态，避免关闭钩子 preventDefault 卡住安装替换
  isShuttingDown = true;
  return UPDATER.installUpdate();
});
// v2.6.0（P2-8）：更新镜像偏好（保存走写盘副作用，不进只读白名单；读取放白名单）
handleSafe('updater:set-mirror', async (_, { mirror } = {}) => UPDATER.setMirror(typeof mirror === 'string' ? mirror : 'auto'));
handleSafe('updater:get-mirror', async () => UPDATER.getMirror());

// 系统主题
handleSafe('app:get-theme', () => {
  // v2.1：应用固定浅色
  return 'light';
});

// 读取使用说明（数据源统一为根目录 readme.md：用户文档与应用内弹窗同源，2026-09 目录梳理）
handleSafe('app:read-usage', () => {
  const mdPath = path.join(__dirname, 'readme.md');
  try {
    if (!fs.existsSync(mdPath)) return { success: false, message: '使用说明文件不存在' };
    const content = fs.readFileSync(mdPath, 'utf8');
    return { success: true, content };
  } catch (e) {
    writeLog('error', `读取使用说明失败: ${e.message}`);
    return { success: false, message: e.message };
  }
});

onSafe('window:minimize', () => mainWindow?.minimize());
onSafe('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
onSafe('window:close', () => mainWindow?.close());

// 启动黑闪修复：渲染层首帧握手。各窗口的 preload 都可能上报，只认主窗口的
// 首个通知；回调在 createWindow 里赋值（showMainWindowWhenReady）。
let mainWindowOnFirstPaint = null;
onSafe('app:first-paint', (event) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (event.sender !== mainWindow.webContents) return;
  if (typeof mainWindowOnFirstPaint === 'function') mainWindowOnFirstPaint();
});

// 兼容旧渲染层调用：无论应用主题为何，标题栏覆盖层都保持固定系统色。
handleSafe('window:update-overlay', () => {
  try {
    mainWindow?.setTitleBarOverlay(TITLEBAR_OVERLAY);
    return true;
  } catch (e) {
    return false;
  }
});

// 日志
handleSafe('log:write', (event, { level, message }) => {
  return writeLog(level, message);
});

handleSafe('log:read', async (event, { date } = {}) => {
  try {
    const requestedDate = date || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) return '读取日志失败: 日期格式无效';
    const logFile = path.join(LOG_DIR, `app-${requestedDate}.log`);
    if (!isPathUnderRoot(logFile, LOG_DIR)) return '读取日志失败: 路径无效';
    if (!fs.existsSync(logFile)) return '';
    // 内存优化：只读取日志末尾（最大 512KB），避免大日志整文件载入内存
    const MAX_BYTES = 512 * 1024;
    const stat = fs.statSync(logFile);
    if (stat.size <= MAX_BYTES) {
      return fs.readFileSync(logFile, 'utf8');
    }
    const fd = fs.openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(MAX_BYTES);
      fs.readSync(fd, buf, 0, MAX_BYTES, stat.size - MAX_BYTES);
      let text = buf.toString('utf8');
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1); // 丢弃被截断的半行
      return text;
    } finally { fs.closeSync(fd); }
  } catch (e) {
    return `读取日志失败: ${e.message}`;
  }
});

handleSafe('log:export', async () => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出日志',
      defaultPath: `Trim-log-${Date.now()}.txt`,
      filters: [{ name: '文本文件', extensions: ['txt', 'log'] }]
    });
    if (result.canceled || !result.filePath) return { success: false, message: '已取消' };
    const logFile = path.join(LOG_DIR, `app-${new Date().toISOString().slice(0, 10)}.log`);
    if (fs.existsSync(logFile)) {
      fs.copyFileSync(logFile, result.filePath);
      return { success: true, path: result.filePath };
    }
    return { success: false, message: '日志不存在' };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// ==================== 清理模块 IPC ====================
const CLEANUP_SCRIPT = require('./src/scripts-powershell/cleanup-scripts');

// v2.1 扫描加速：解析 TrimFastSize.dll 绝对路径注入清理脚本（仿 resolveFinderExe 先例）。
// 打包后位于 resources/fastsize/，开发期位于 scripts/；缺失返回 null → 脚本自动降级回原实现。
function resolveFastSizeDll() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'fastsize', 'TrimFastSize.dll') : null,
    path.join(__dirname, 'scripts', 'TrimFastSize.dll')
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}
CLEANUP_SCRIPT.setFastSizeDll(resolveFastSizeDll());

// P1-9：向渲染层暴露清理规则唯一数据源（src/data/cleanup-rules.json）
handleSafe('cleanup:rules', () => {
  try {
    return { success: true, data: CLEANUP_SCRIPT.rules() };
  } catch (e) {
    writeLog('warn', `读取清理规则失败: ${e.message}`);
    return { success: false, message: '清理规则读取失败' };
  }
});

handleSafe('cleanup:scan', async (event, { categories }) => {
  if (!Array.isArray(categories) || categories.length < 1 || categories.length > 200 || categories.some(c => typeof c !== 'string' || c.length > 160)) {
    return { success: false, message: '清理分类参数无效', data: [] };
  }
  cleanupSnapshots.set(event.sender.id, new Map()); // 审查 2-3：先置空桶，扫描成功后填充
  // 窗口销毁后回收桶，防 Map 泄漏
  const snapSender = event.sender;
  if (!snapSender.listenerCount('destroyed')) {
    snapSender.once('destroyed', () => cleanupSnapshots.delete(snapSender.id));
  }
  // 清理扫描读取已保存的路径绑定，让自动发现结果在后续扫描中持续生效。
  const script = CLEANUP_SCRIPT.scan(categories, loadPathsConfig());
  const scriptPath = writeTempScript(script);
  const sender = event.sender;
  const total = Array.isArray(categories) ? categories.length : 0;
  const data = [];
  let scanBuf = '';
  // v2.2 第3批（D13）：@@PLANFILE@@ 流式行按 id 聚合——fileKeys 条目扫描即产「可删文件
  // 清单」，明细与执行只消费这份清单（不再第二、三次重枚举）。
  const planBuf = new Map();
  const planTruncated = new Set();
  let planTotalRows = 0;
  try {
    writeLog('info', `开始扫描: ${categories.join(', ')}`);
    const { stderr, code } = await runPowerShellFile(scriptPath, {
      timeout: 300000,
      diagOp: 'cleanup.scan',
      onStdout: (chunk) => {
        // P1-12：按行解析 @@ITEM@@ 流式结果，逐项增量推送渲染层（真实进度）
        scanBuf += chunk;
        let nl;
        while ((nl = scanBuf.indexOf('\n')) >= 0) {
          const line = scanBuf.slice(0, nl).replace(/\r$/, '');
          scanBuf = scanBuf.slice(nl + 1);
          if (line.startsWith('@@PLANFILE@@')) {
            // 计划文件行只进主进程快照（渲染层不消费），受总量防呆上限约束
            if (planTotalRows >= PLAN_CAP_TOTAL) continue;
            try {
              const pf = JSON.parse(line.slice(12));
              if (pf && typeof pf.id === 'string' && pf.id.length <= 160 && typeof pf.path === 'string' && pf.path.length <= 2000) {
                let arr = planBuf.get(pf.id);
                if (!arr) { arr = []; planBuf.set(pf.id, arr); }
                if (arr.length < PLAN_CAP_PER_ITEM) { arr.push({ path: pf.path, size: Number(pf.size) || 0 }); planTotalRows++; }
                else if (!planTruncated.has(pf.id)) { planTruncated.add(pf.id); writeLog('warn', `可删文件清单超过 ${PLAN_CAP_PER_ITEM} 条上限: ${pf.id}`); }
              }
            } catch (e) {}
            continue;
          }
          if (!line.startsWith('@@ITEM@@')) continue;
          try {
            const item = JSON.parse(line.slice(8));
            if (!item || !item.id) continue;
            data.push(item);
            if (sender && !sender.isDestroyed()) {
              sender.send('cleanup:scan-progress', { done: data.length, total, item });
            }
          } catch (e) {}
        }
      }
    });
    if (code !== 0) {
      writeLog('error', `扫描失败: ${stderr}`);
      return { success: false, message: stderr || '扫描失败', data: [] };
    }
    // 把可删文件清单并进条目（无清单的条目补空数组，执行/明细侧统一按数组消费）
    for (const item of data) {
      const pf = planBuf.get(item.id);
      item.files = pf || [];
      if (planTruncated.has(item.id)) item.filesTruncated = true;
    }
    writeLog('info', `扫描完成: ${data.length} 项, 计划文件 ${planTotalRows} 条`);
    cleanupSnapshots.set(event.sender.id, snapshotById(data)); // 审查 2-3：写入本窗口快照
    return { success: true, data };
  } catch (e) {
    writeLog('error', `扫描异常: ${e.message}`);
    return { success: false, message: e.message, data };
  } finally {
    scanBuf = '';
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

handleSafe('cleanup:execute', async (event, { items, force, toRecycle, autoRebuild }) => {
  const safeItems = validateSnapshotItems(items, cleanupSnapshots.get(event.sender.id) || new Map()); // 审查 2-3：取本窗口快照
  if (!safeItems) return { success: false, message: '清理项不是最近一次扫描结果，已拒绝执行' };
  // v2.7.0：在途删除任务计数——关闭按钮触发后台静默退出时会等它归零再 quit，
  // 保证清理结果统计完整落盘（窗口此刻已隐藏，用户无感）
  activeCleanupRuns++;
  // v2.2 第2批（D18）：在生成脚本前把保护清单补全（含 Electron known folder），
  // execute() 会把同一份清单注入 PS，两侧判定才会完全一致。
  ensureProtectedConfigured();
  const script = CLEANUP_SCRIPT.execute(safeItems, !!force, !!toRecycle, !!autoRebuild);
  const scriptPath = writeTempScript(script);
  const sender = event.sender;
  // P3 回收站模式：PS 输出 @@RECYCLE@@ 目标行，实际移入回收站由主进程 shell.trashItem 完成
  const recycleEntries = [];
  // 审查 4-4：回收站失败项留存，供渲染层红色确认后永久删除重试。
  // 审查v4 附带修复：原 const 声明在下方 if 块内，而 if 块外（trashFailures 回写行）
  // 也引用了它——任何一次 cleanup:execute 走到该行都会 ReferenceError，清理必失败
  const trashFailures = [];
  const cleanLines = [];
  let buf = '';
  const onStdout = (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('@@RECYCLE@@')) {
        try {
          const entry = JSON.parse(line.slice(11));
          if (entry && typeof entry.path === 'string' && entry.path) recycleEntries.push(entry);
        } catch (e) {}
        continue;
      }
      cleanLines.push(line);
    }
  };
  try {
    writeLog('info', `开始清理: ${safeItems.length} 项, force=${!!force}, toRecycle=${!!toRecycle}, autoRebuild=${!!autoRebuild}`);
    flushLogSync(); // 审查v4-L3：危险操作执行前强制刷盘，清理过程崩溃不丢诊断日志
    const { stdout, stderr, code } = await runPowerShellFile(scriptPath, { diagOp: 'cleanup.execute', timeout: 600000, onStdout });
    if (code !== 0) {
      writeLog('error', `清理失败: ${stderr}`);
      return { success: false, message: stderr || '清理失败' };
    }
    let data;
    try {
      const cleanStdout = cleanLines.join('\n').trim() || stdout.trim();
      data = JSON.parse(cleanStdout);
    } catch (e) {
      return { success: false, message: '解析结果失败', raw: stdout };
    }
    // P3：回收站模式——逐目标 shell.trashItem，改写 recycle 状态为 ok/partial/error
    if (toRecycle && recycleEntries.length > 0) {
      const perItem = new Map();
      for (const entry of recycleEntries) {
        // 审查 1-4：entry.path 来自脚本 stdout 解析，信任级别低于快照校验项，与 finder:delete 对齐拒绝受保护路径
        if (isProtectedDeletePath(entry.path)) {
          const st0 = perItem.get(entry.id) || { freed: 0, ok: 0, fail: 0 };
          st0.fail++;
          perItem.set(entry.id, st0);
          writeLog('warn', `拒绝移入回收站（受保护路径）: ${entry.path}`);
          continue;
        }
        const st = perItem.get(entry.id) || { freed: 0, ok: 0, fail: 0 };
        try {
          await shell.trashItem(entry.path);
          st.freed += Number(entry.size) || 0;
          st.ok++;
          // 目录条目可选自动重建（与直接删除模式的 optAutoRebuild 语义一致）
          if (entry.isDir && autoRebuild) {
            try { fs.mkdirSync(entry.path, { recursive: true }); } catch (e2) {}
          }
        } catch (e) {
          st.fail++;
          trashFailures.push({ id: entry.id, path: entry.path, size: Number(entry.size) || 0, isDir: !!entry.isDir });
          writeLog('warn', `移入回收站失败: ${entry.path} -> ${e.message}`);
        }
        perItem.set(entry.id, st);
      }
      if (trashFailures.length) lastTrashFailures = trashFailures;
      for (const d of data.details || []) {
        if (d.status !== 'recycle') continue;
        const st = perItem.get(d.id);
        if (!st) { d.status = 'ok'; d.freed = 0; d.message = '无可清理目标'; continue; }
        d.freed = st.freed;
        if (st.fail === 0) { d.status = 'ok'; d.message = `已移入回收站（${st.ok} 项）`; }
        else if (st.ok > 0) { d.status = 'partial'; d.message = `已移入回收站 ${st.ok} 项，${st.fail} 项失败（被占用）`; }
        else { d.status = 'error'; d.freed = 0; d.message = '移入回收站失败（可能被占用）'; }
      }
      // 按改写后的明细重算统计
      data.totalFreed = (data.details || []).reduce((s, d) => s + (Number(d.freed) || 0), 0);
      data.success = (data.details || []).filter(d => d.status === 'ok').length;
      data.failed = (data.details || []).filter(d => d.status === 'error' || d.status === 'partial').length;
      data.skipped = (data.details || []).filter(d => d.status === 'skip').length;
    }
    data.trashFailures = trashFailures || []; // 审查 4-4：渲染层据此弹「改为永久删除」引导
    try {
      // v2.2 第1批（D6）：日志口径与明细对齐。旧实现只写「释放 N 字节」，
      // 而 N 在修复前是按删除前全量 size 冒领的虚数值，事后无法与 UI 明细核对；
      // 现在 freed 来自实测差值，同时补记 成功/失败/跳过/部分成功/残留，便于复盘。
      const dts = data.details || [];
      const nPartial = dts.filter(d => d.status === 'partial').length;
      const nResidual = dts.reduce((s, d) => s + (Number(d.residual) > 0 ? 1 : 0), 0);
      writeLog('info', `清理完成: 实测释放 ${Number(data.totalFreed) || 0} 字节, 成功 ${data.success || 0}, 失败 ${data.failed || 0}, 跳过 ${data.skipped || 0}, 部分成功 ${nPartial}, 有残留 ${nResidual} 项`);
      return { success: Number(data.failed || 0) === 0, data };
    } catch (e) {
      return { success: false, message: '解析结果失败', raw: stdout };
    }
  } catch (e) {
    writeLog('error', `清理异常: ${e.message}`);
    return { success: false, message: e.message };
  } finally {
    activeCleanupRuns--; // v2.7.0：在途删除任务计数归位（后台静默退出等它归零）
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// 审查 4-4：回收站失败项的永久删除重试——只处理最近一次 cleanup:execute 留存的失败项
//（主进程白名单，渲染层不能指定任意路径），渲染层需先弹红色确认（modal.js confirmDanger）再调用。
let lastTrashFailures = [];
handleSafe('cleanup:retry-failed-delete', async (event) => {
  const targets = lastTrashFailures;
  lastTrashFailures = []; // 取走即清空：重试只处理最近一批，且同一批不会被二次重删
  if (!targets.length) return { success: false, message: '没有待重试的失败项' };
  writeLog('warn', `开始永久删除回收站失败项: ${targets.length} 项`);
  flushLogSync(); // 审查v4-L3：危险操作执行前强制刷盘
  let freed = 0, ok = 0, failed = 0;
  const details = [];
  for (const t of targets) {
    try {
      if (!fs.existsSync(t.path)) { details.push({ path: t.path, status: 'skip', freed: 0, message: '文件不存在' }); continue; }
      if (isProtectedDeletePath(t.path)) { failed++; details.push({ path: t.path, status: 'error', freed: 0, message: '受保护路径，已拒绝' }); continue; }
      const stat = fs.lstatSync(t.path);
      const size = stat.size;
      fs.rmSync(t.path, { recursive: !!t.isDir, force: true });
      freed += size;
      ok++;
      details.push({ path: t.path, status: 'ok', freed: size });
      writeLog('warn', `回收站失败项经用户确认后永久删除: ${t.path}`);
    } catch (e) {
      failed++;
      details.push({ path: t.path, status: 'error', freed: 0, message: e.message });
    }
  }
  return { success: failed === 0, data: { totalFreed: freed, ok, failed, details } };
});

// 在规则库中按 id 定位条目（groups→subGroups→items 与 groups→items 并存，需通用遍历）
function findCleanupRuleById(id) {
  const rules = CLEANUP_SCRIPT.rules();
  for (const g of (rules.groups || [])) {
    if (g.subGroups) {
      for (const sg of g.subGroups) {
        for (const it of (sg.items || [])) if (it && it.id === id) return it;
      }
    }
    for (const it of (g.items || [])) if (it && it.id === id) return it;
  }
  return null;
}

// P3 条目明细：枚举单个条目将删除的文件清单（只读，供「明细」弹窗展示）
handleSafe('cleanup:item-detail', async (event, { id, path: itemPath }) => {
  if (typeof id !== 'string' || id.length < 1 || id.length > 160) return { success: false, message: '参数无效' };
  // v2.2 第3批（D13）：fileKeys 条目明细直接读扫描快照里的可删文件清单——明细与执行
  // 同源（计划即明细），不再为展示做第二次 PS 枚举。无快照/清单时回退原 DETAIL_SCRIPT。
  const known = (cleanupSnapshots.get(event.sender.id) || new Map()).get(id);
  const rule = findCleanupRuleById(id);
  if (rule && rule.fileKeys && Array.isArray(rule.fileKeys) && rule.fileKeys.length > 0 && known && Array.isArray(known.files)) {
    const cap = 600; // 与 DETAIL_SCRIPT 的明细上限一致
    return {
      success: true,
      data: {
        kind: 'files',
        total: known.files.length,
        truncated: known.files.length > cap,
        files: known.files.slice(0, cap).map(f => ({ path: f.path, size: f.size }))
      }
    };
  }
  let safePath = '';
  if (typeof itemPath === 'string' && itemPath.length > 0 && itemPath.length <= 600) safePath = itemPath;
  const script = CLEANUP_SCRIPT.detail(id, safePath);
  const scriptPath = writeTempScript(script);
  const files = [];
  let meta = null;
  let buf = '';
  try {
    const { stderr, code } = await runPowerShellFile(scriptPath, {
      diagOp: 'cleanup.detail',
      timeout: 120000,
      onStdout: (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          try {
            if (line.startsWith('@@ITEMFILE@@')) {
              const f = JSON.parse(line.slice(12));
              if (f && typeof f.path === 'string') files.push(f);
            } else if (line.startsWith('@@DETAIL@@')) {
              meta = JSON.parse(line.slice(10));
            }
          } catch (e) {}
        }
      }
    });
    if (code !== 0) return { success: false, message: stderr || '明细枚举失败' };
    return { success: true, data: { kind: (meta && meta.kind) || 'files', total: (meta && meta.total) != null ? meta.total : files.length, truncated: !!(meta && meta.truncated), files } };
  } catch (e) {
    writeLog('error', `条目明细枚举失败: ${e.message}`);
    return { success: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// ==================== 清理规则库在线更新（P2） ====================
// 发布源按序回退：GitHub raw → jsDelivr → gh-proxy。默认指向本仓库 main 分支的
// 规则文件；迁移仓库 / 更改规则文件路径时同步修改这里。
// 私有仓库的匿名 HTTP 源会 404——两种解决方式：
//   ① 把仓库设为 public（默认 URL 立即可用）；
//   ② 在 %APPDATA%\Trim\cleanup\update-source.json 配置可访问源与请求头：
//      { "urls": ["https://..."], "headers": { "Authorization": "Bearer <token>" } }
// 另有 git 回退：应用目录在 git 仓库内（开发机）且本机已存有该仓库凭据时，
// 经 `git fetch` 深拉远程 main 并 `git show` 取文件（只 fetch，不动工作树）。
const RULES_UPDATE_URLS = [
  'https://raw.githubusercontent.com/xiaoxu1642/TuneForge/main/src/data/cleanup-rules.json',
  'https://cdn.jsdelivr.net/gh/xiaoxu1642/TuneForge@main/src/data/cleanup-rules.json',
  'https://gh-proxy.com/https://raw.githubusercontent.com/xiaoxu1642/TuneForge/main/src/data/cleanup-rules.json'
];
const RULES_MIN_SIZE = 4096;          // 内容下限（当前规则约 20KB，低于 4KB 视为异常）
const RULES_MAX_SIZE = 2 * 1024 * 1024; // 内容上限（审查 1-1）：先拦超大响应再解析，防 OOM
const RULES_DOWNLOAD_TIMEOUT = 15000; // 单源超时（毫秒）

// 审查 1-1：流式读取响应体并限量，防止超大响应整体进内存
async function readBodyLimited(resp, maxBytes) {
  const reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
  if (!reader) return resp.text(); // 无流式能力时退回（Content-Length 已前置拦截）
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) {}
      throw new Error('响应体超过尺寸上限');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// 读取可选的更新源覆盖配置（数据目录优先，支持自定义 URL 列表与请求头）
function loadRulesUpdateOverride() {
  try {
    const file = path.join(CLEANUP_SCRIPT.dataRulesDir(), 'update-source.json');
    if (!fs.existsSync(file)) return null;
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cfg || typeof cfg !== 'object') return null;
    const urls = Array.isArray(cfg.urls) ? cfg.urls.filter(u => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 10) : [];
    const headers = {};
    if (cfg.headers && typeof cfg.headers === 'object') {
      for (const [k, v] of Object.entries(cfg.headers)) {
        if (typeof k === 'string' && k.length <= 128 && typeof v === 'string' && v.length <= 1024) headers[k] = v;
      }
    }
    return { urls, headers };
  } catch (e) {
    writeLog('warn', `读取更新源覆盖配置失败: ${e.message}`);
    return null;
  }
}

// git 回退（开发机）：经本机凭据深拉远程 main，取规则文件内容；不可用返回 null
function gitFetchRulesFile() {
  return new Promise((resolve) => {
    const repoDir = __dirname; // dev 模式应用根 = 仓库根；打包后无 .git 自然跳过
    if (!fs.existsSync(path.join(repoDir, '.git'))) { resolve(null); return; }
    exec('git fetch --depth=1 origin main', { cwd: repoDir, timeout: 60000, windowsHide: true }, (fetchErr) => {
      if (fetchErr) { resolve(null); return; }
      exec('git show FETCH_HEAD:src/data/cleanup-rules.json', { cwd: repoDir, timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (showErr, stdout) => {
        resolve(showErr ? null : String(stdout));
      });
    });
  });
}

handleSafe('cleanup:update-rules', async (event) => {
  const currentVersion = Number(CLEANUP_SCRIPT.rules()?.rulesVersion) || 0;
  const override = loadRulesUpdateOverride();
  const sources = [
    ...(override?.urls || []),
    ...RULES_UPDATE_URLS.map(url => ({ url, headers: override?.headers || {} }))
  ].slice(0, 16);
  const seen = new Set();
  const attempts = [];
  let lastError = '';
  // 内容校验链（审查 1-1）：尺寸 → 验签 → JSON 结构 → 条目形状 → 版本防降级。
  // 验签用内置公钥（rules-signature.js），任何源（含 gh-proxy / update-source.json 自定义源）
  // 都只是传输通道，内容必须自证可信——签名未通过直接拒绝，不再依赖「源可信」假设。
  const validate = (text) => {
    if (!text || text.length < RULES_MIN_SIZE) return { error: '内容过小，疑似异常响应' };
    if (text.length > RULES_MAX_SIZE) return { error: '内容过大，疑似异常响应' };
    const sig = RULES_SIG.verifyRulesSignature(text);
    if (!sig.ok) return { error: sig.reason };
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return { error: 'JSON 解析失败' }; }
    if (!parsed || !Array.isArray(parsed.groups) || parsed.groups.length < 1) return { error: '缺少 groups 结构' };
    const sample = (parsed.groups || []).flatMap(g => (g.items || []).concat((g.subGroups || []).flatMap(sg => sg.items || [])));
    if (!sample.length || !sample.every(it => it && typeof it.id === 'string' && typeof it.name === 'string')) return { error: '条目缺少 id/name 字段' };
    const version = Number(parsed.rulesVersion) || 0;
    if (version < currentVersion) return { error: `下载版本(${version})低于当前版本(${currentVersion})，已拒绝（防降级）` };
    return { version, text };
  };
  const writeValidated = (result) => {
    const dir = CLEANUP_SCRIPT.dataRulesDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'rules.json');
    const tmp = target + '.downloading';
    fs.writeFileSync(tmp, result.text, 'utf8');
    fs.renameSync(tmp, target);
    writeLog('info', `清理规则库已更新: rulesVersion=${result.version}`);
    return { success: true, rulesVersion: result.version };
  };

  for (const src of sources) {
    const url = typeof src === 'string' ? src : src.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const headers = (typeof src === 'object' && src.headers) || {};
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), RULES_DOWNLOAD_TIMEOUT);
      let resp;
      try {
        resp = await fetch(url, { signal: ac.signal, headers });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) { lastError = `HTTP ${resp.status}`; continue; }
      const declared = Number(resp.headers.get('content-length') || 0);
      if (declared > RULES_MAX_SIZE) { lastError = '响应体超过尺寸上限'; continue; }
      const text = await readBodyLimited(resp, RULES_MAX_SIZE);
      const checked = validate(text);
      if (checked.error) { lastError = checked.error; continue; }
      const done = writeValidated(checked);
      return { ...done, source: url };
    } catch (e) {
      lastError = e.name === 'AbortError' ? '下载超时' : e.message;
    }
  }

  // git 回退：HTTP 全部失败时，开发机经本机凭据拉取远程（私有仓库也可用）
  const gitText = await gitFetchRulesFile();
  if (gitText) {
    const checked = validate(gitText);
    if (checked.error) {
      lastError = checked.error + '（本机 git 已取到远程规则）';
    } else {
      const done = writeValidated(checked);
      attempts.push('git');
      return { ...done, source: 'git:origin/main' };
    }
  }

  const revertible = (lastError || '').includes('版本') || (lastError || '').includes('防降级');
  const hint = fs.existsSync(path.join(__dirname, '.git'))
    ? (revertible ? '（远程规则版本未更新或低于本地，请先在源仓库发布新规则）' : '（已尝试本机 git 回退仍失败，请检查网络或远程分支）')
    : '（HTTP 发布源不可达；私有仓库请先公开仓库，或在数据目录 update-source.json 配置可访问源）';
  writeLog('warn', `清理规则库更新失败: ${lastError}`);
  return { success: false, message: '所有发布源均不可用或校验未通过：' + lastError + hint };
});

// ==================== 磁盘清理 · Rust 原生查找器 IPC ====================
// 复用 native-scanner（finder.exe）实现 重复/大文件/空文件空目录/AppData 四类扫描，
// 输出行协议 @@PROGRESS:n@@ 与 @@ITEM@@{json}，由主进程流式转发布尔进度并收拢结果。
// 展开路径中的 %VAR% 环境变量（如 %USERPROFILE%、%USERNAME%）
function expandEnvPath(p) {
  return String(p).replace(/%([^%]+)%/g, (m, name) => process.env[name] || m);
}

// 重复文件查找内置目录：缺哪个跳哪个，全部缺失时报错（前端 toast）
// 审查 7-6：只保留标准用户目录，不内置开发者本机的个人路径
const FINDER_DEFAULT_DUP_DIRS = [
  '%USERPROFILE%\\Downloads',
  '%USERPROFILE%\\Desktop',
  '%USERPROFILE%\\Documents',
  '%USERPROFILE%\\Pictures'
];

function resolveExistingDirs(plist) {
  const found = [];
  const missing = [];
  for (const p of plist) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) found.push(p);
      else missing.push(p);
    } catch (e) {
      missing.push(p);
    }
  }
  return { found, missing };
}

function resolveFinderExe() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'finder', 'finder.exe') : null,
    path.join(__dirname, 'native-scanner', 'target', 'release', 'finder.exe'),
    path.join(__dirname, 'resources', 'finder', 'finder.exe')
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

function runRustScanner(scanType, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const exe = resolveFinderExe();
    if (!exe) return reject(new Error('未找到原生扫描器 finder.exe'));
    const child = spawn(exe, [scanType, ...args], { windowsHide: true });
    registerBackendChild(child, exe, [scanType, ...args]);
    // 审查 3-2：对齐 runPwshChild 的超时兜底——finder.exe 遇到无响应网络盘/死锁时
    // 不再出现 Promise 永不 settle、IPC 永久挂起（B4 同款取向）
    let settled = false, timer = null;
    const finish = (fn, v) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(v); };
    let stderr = '';
    let buf = '';
    const items = [];
    child.stdout.on('data', d => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('@@PROGRESS:')) {
          const m = /@@PROGRESS:(\d+)@@/.exec(line);
          if (m && typeof opts.onProgress === 'function') {
            try { opts.onProgress(parseInt(m[1], 10)); } catch (e) {}
          }
        } else if (line.startsWith('@@SCANNED:')) {
          // 心跳行（P0 批次）：已枚举文件数，供前端实时反馈，未知前缀不破坏解析
          const m = /@@SCANNED:(\d+)@@/.exec(line);
          if (m && typeof opts.onScanned === 'function') {
            try { opts.onScanned(parseInt(m[1], 10)); } catch (e) {}
          }
        } else if (line.startsWith('@@ITEM@@')) {
          try { items.push(JSON.parse(line.slice(8))); } catch (e) {}
        }
      }
    });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => finish(reject, err));
    child.on('close', code => {
      if (code !== 0) return finish(reject, new Error(stderr || `原生扫描器退出码 ${code}`));
      finish(resolve, items);
    });
    const ms = Number(opts.timeoutMs) || 300000; // 默认 5 分钟：超大目录扫描的宽松上限
    timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      writeLog('warn', `原生扫描器超时已终止: ${scanType}`);
      finish(reject, new Error(`扫描超时（超过 ${Math.round(ms / 1000)} 秒），请缩小扫描范围后重试`));
    }, ms);
  });
}

const FINDER_SCAN_TYPES = ['duplicates', 'bigfiles', 'empty', 'appdata'];

handleSafe('finder:scan', async (event, { scanType, paths, minSize, count, minSizeMb }) => {
  if (!FINDER_SCAN_TYPES.includes(scanType)) return { success: false, message: '未知扫描类型' };
  const sender = event.sender;
  const args = [];
  let plist = (Array.isArray(paths) ? paths : [])
    .map(p => String(p).trim())
    .filter(p => p && p.length <= 400)
    .map(expandEnvPath)
    .slice(0, 50);
  if (scanType === 'duplicates') {
    if (plist.length === 0) {
      // 输入为「默认」占位：解析内置目录，缺哪个跳哪个，全部缺失则报错
      const resolved = resolveExistingDirs(FINDER_DEFAULT_DUP_DIRS.map(expandEnvPath));
      if (resolved.missing.length) {
        writeLog('info', `finder 默认目录缺失跳过: ${resolved.missing.join(', ')}`);
      }
      if (!resolved.found.length) {
        writeLog('warn', 'finder 默认扫描目录均不存在');
        return { success: false, message: '默认扫描目录均不存在（Downloads/Desktop/Documents/Pictures/C:\\yule），请在「扫描目录」中手动填写' };
      }
      plist = resolved.found;
    } else {
      // 自填目录同样跳过不存在的，全部无效时报错
      const checked = resolveExistingDirs(plist);
      if (checked.missing.length) {
        writeLog('info', `finder 指定目录缺失跳过: ${checked.missing.join(', ')}`);
      }
      if (!checked.found.length) {
        return { success: false, message: '指定的扫描目录均不存在，请检查路径' };
      }
      plist = checked.found;
    }
    args.push('--min-size', String(Math.max(0, Number(minSize) || 0)));
  } else if (scanType === 'bigfiles') {
    if (plist.length === 0) return { success: false, message: '至少需要一个扫描目录' };
    args.push('--count', String(Math.max(1, Number(count) || 50)));
  } else if (scanType === 'appdata') {
    args.push('--min-size-mb', String(Math.max(1, Number(minSizeMb) || 10)));
  } else if (scanType === 'empty') {
    if (plist.length === 0) return { success: false, message: '至少需要一个扫描目录' };
  }
  for (const p of plist) args.push(p);
  try {
    writeLog('info', `finder ${scanType} 开始扫描: ${plist.join(', ') || '(AppData)'}`);
    const items = await runRustScanner(scanType, args, {
      onProgress: n => {
        if (sender && !sender.isDestroyed()) sender.send('finder:progress', { scanType, progress: n });
      },
      onScanned: n => {
        if (sender && !sender.isDestroyed()) sender.send('finder:progress', { scanType, scanned: n });
      }
    });
    lastFinderSnapshot = new Map();
    for (const item of items) {
      if (item && typeof item.path === 'string') {
        lastFinderSnapshot.set(path.resolve(item.path).toLowerCase(), {
          path: item.path,
          kind: item.type === 'emptyfolder' || item.type === 'appdata' ? 'dir' : 'file'
        });
      }
    }
    writeLog('info', `finder ${scanType} 完成: ${items.length} 项`);
    return { success: true, data: items };
  } catch (e) {
    writeLog('error', `finder ${scanType} 失败: ${e.message}`);
    return { success: false, message: e.message };
  }
});

// 保护路径：拒绝删除系统关键目录与磁盘根。
// v2.2 第 2 批（D18）：判定逻辑整体迁至共享模块 src/main/ps-protect-path.js（JS/PS 同源，
// PS 侧由 EXECUTE 脚本注入同一份清单），此处只保留「主进程才知道的补全项」与旧调用点。
// 旧实现在此硬编码 6 个 SystemDrive 子树根，有两处硬伤（详见模块头注释）：
//   1) 目录名写死 windows / program files，系统装在其他盘或多语言安装即静默不设防；
//   2) 一律按子树拒（目标在根之下即拒），导致 Documents\WeChat\x\tmp 这类
//      「用户内容根内部的清理目标」被误拒——实测内置 48 条规则里 16 条在回收站模式下删不掉。
// 现清单语义：subtree（整棵拒）/ exact（仅根本身与其祖先拒）/ anyDrive（任意盘同名目录拒）。
let _protectConfigured = false;
function ensureProtectedConfigured() {
  if (_protectConfigured) return;
  _protectConfigured = true;
  const extra = { extraSubtree: [APP_DATA_DIR], extraExact: [] };
  // Electron known folder 只有主进程拿得到（known folder 可能被组策略/OneDrive 重定向，
  // 不能由共享模块的纯环境变量推导替代）；取不到就退回模块内置的 USERPROFILE 推导值。
  for (const k of ['desktop', 'documents', 'downloads']) {
    try {
      const v = app.getPath(k);
      if (v) extra.extraExact.push(v);
    } catch (e) {
      writeLog('warn', `known folder ${k} 取用失败，保护清单回退环境变量推导: ${e.message}`);
    }
  }
  try {
    PROTECT_PATH.configureProtectedRoots(extra);
  } catch (e) {
    writeLog('warn', `保护清单补全失败，使用默认清单: ${e.message}`);
  }
}

function isProtectedDeletePath(p) {
  ensureProtectedConfigured();
  return PROTECT_PATH.isPathProtected(p);
}

// 文件清理删除清单：记录每次删除批次（路径/大小/类型/时间/是否进回收站），
// 误删可在此追溯并在回收站还原。大文件不做内容复制，仅落清单（见审查报告 A3）。
const FILECLEAN_BACKUP_DIR = path.join(APP_DATA_DIR, 'fileclean-backup');
const FILECLEAN_MANIFEST_KEEP = 50; // 只保留最近 50 个批次清单，避免目录无限膨胀

// 统一删除出口（审查 1-2）：删除类操作一律先尝试移入回收站（可逆），仅当明确允许永久删除
// 且回收站失败（被禁用/已满/目标被锁）时才降级 unlinkSync。调用方按返回的 recycled 回写清单标记。
// v2.2 第 2 批（D18）：受保护路径判定下沉到这里。此前只在 finder:delete / retry-failed-delete
// 两个调用点各判一次，而「统一出口」的意义就是没有旁路——新增调用点忘判就是漏口。
// 复用调用方已有的 protected 标记字段（ok=false）即可，无需改动上层统计逻辑。
async function trashOrUnlink(target, { allowPermanent = true } = {}) {
  if (isProtectedDeletePath(target)) {
    writeLog('warn', `受保护路径，拒绝删除: ${target}`);
    return { ok: false, recycled: false, protected: true, message: '受保护路径，已拒绝' };
  }
  try {
    await shell.trashItem(target);
    return { ok: true, recycled: true };
  } catch (e) {
    if (!allowPermanent) return { ok: false, recycled: false, message: e.message };
    try {
      fs.unlinkSync(target);
      return { ok: true, recycled: false };
    } catch (e2) {
      return { ok: false, recycled: false, message: e2.message };
    }
  }
}

function saveDeleteManifest(batchId, entries) {
  try {
    if (!entries.length) return '';
    fs.mkdirSync(FILECLEAN_BACKUP_DIR, { recursive: true });
    const manifestPath = path.join(FILECLEAN_BACKUP_DIR, `deleted-${batchId}.json`);
    // 审查v4-L2：清单是误删追溯的唯一凭据，与其他 JSON 落盘统一走原子写（fsync+rename），
    // 避免崩溃瞬间留下半行 JSON 使整批清单不可读
    SECURITY.atomicWriteJson(manifestPath, {
      batchId,
      deletedAt: new Date().toISOString(),
      count: entries.length,
      items: entries
    });
    const files = fs.readdirSync(FILECLEAN_BACKUP_DIR)
      .filter(f => f.startsWith('deleted-') && f.endsWith('.json'))
      .sort();
    while (files.length > FILECLEAN_MANIFEST_KEEP) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(FILECLEAN_BACKUP_DIR, oldest)); } catch (e) {}
    }
    return manifestPath;
  } catch (e) {
    writeLog('error', `写入删除清单失败: ${e.message}`);
    return '';
  }
}

handleSafe('finder:delete', async (event, { items }) => {
  const requested = (Array.isArray(items) ? items : []).filter(it => it && typeof it.path === 'string').slice(0, 500);
  const safe = requested.map(it => {
    const known = lastFinderSnapshot.get(path.resolve(it.path).toLowerCase());
    return known ? { path: known.path, kind: known.kind } : null;
  });
  if (safe.some(it => !it)) return { success: false, message: '删除目标已过期，请重新扫描后再试' };
  const validSafe = safe.filter(Boolean);
  if (!validSafe.length) return { success: false, message: '没有可删除的项' };
  const protectedHits = validSafe.filter(it => isProtectedDeletePath(it.path));
  if (protectedHits.length) return { success: false, message: `包含受保护的系统路径，已拒绝：${protectedHits[0].path}` };
  const args = [];
  for (const it of validSafe) {
    const kind = it.kind === 'dir' ? 'dir' : 'file';
    args.push(kind, String(it.path));
  }
  try {
    writeLog('info', `finder 删除(原生): ${validSafe.length} 项`);
    flushLogSync(); // 审查v4-L3：危险操作执行前强制刷盘
    const results = await runRustScanner('delete', args);
    const details = (Array.isArray(results) ? results : []).filter(r => r && r.type === 'delresult');
    let totalFreed = 0, success = 0, failed = 0, recycled = 0;
    for (const d of details) {
      totalFreed += Number(d.freed) || 0;
      if (d.status === 'ok') {
        success++;
        if (d.mode === 'recycled') recycled++;
      } else {
        failed++;
      }
    }
    const skipped = Math.max(0, validSafe.length - success - failed);
    // 删除清单：成功删除的项落盘到 %APPDATA%\Trim\fileclean-backup\（误删可追溯）
    const batchId = new Date().toISOString().replace(/[:.]/g, '-');
    const manifestEntries = details
      .filter(d => d.status === 'ok')
      .map(d => ({
        path: String(d.path || '').replace(/\//g, '\\'),
        kind: d.kind === 'dir' ? 'dir' : 'file',
        size: Number(d.freed) || 0,
        recycled: d.mode === 'recycled'
      }));
    const manifestPath = saveDeleteManifest(batchId, manifestEntries);
    writeLog('info', `finder 删除完成: 成功 ${success}（回收站 ${recycled}）失败 ${failed} 释放 ${totalFreed} 字节${manifestPath ? ` 清单 ${path.basename(manifestPath)}` : ''}`);
    return { success: failed === 0, data: { totalFreed, success, failed, skipped, recycled, details, manifestPath } };
  } catch (e) {
    writeLog('error', `finder 删除异常: ${e.message}`);
    return { success: false, message: e.message };
  }
});

// 读取删除清单（最近批次在前，最多返回 200 条）
handleSafe('finder:delete-manifest', (event) => {
  try {
    if (!fs.existsSync(FILECLEAN_BACKUP_DIR)) {
      return { success: true, data: { items: [], dir: FILECLEAN_BACKUP_DIR } };
    }
    const files = fs.readdirSync(FILECLEAN_BACKUP_DIR)
      .filter(f => f.startsWith('deleted-') && f.endsWith('.json'))
      .sort()
      .reverse();
    const items = [];
    for (const f of files) {
      if (items.length >= 200) break;
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(FILECLEAN_BACKUP_DIR, f), 'utf8'));
        for (const it of (Array.isArray(obj.items) ? obj.items : [])) {
          if (items.length >= 200) break;
          items.push({
            path: it && it.path || '',
            kind: it && it.kind || 'file',
            size: Number(it && it.size) || 0,
            recycled: !!(it && it.recycled),
            deletedAt: obj.deletedAt || ''
          });
        }
      } catch (e) {}
    }
    return { success: true, data: { items, dir: FILECLEAN_BACKUP_DIR } };
  } catch (e) {
    writeLog('error', `读取删除清单失败: ${e.message}`);
    return { success: false, message: e.message };
  }
});

// 打开删除清单所在目录（已进回收站的文件可在系统回收站中还原）
handleSafe('finder:open-backup-dir', async (event) => {
  try {
    fs.mkdirSync(FILECLEAN_BACKUP_DIR, { recursive: true });
    const err = await shell.openPath(FILECLEAN_BACKUP_DIR);
    return { success: !err, message: err || '' };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// ==================== 右键菜单管理 IPC ====================
const CONTEXTMENU_SCRIPT = require('./src/scripts-powershell/contextmenu-scripts');

handleSafe('contextmenu:scan', async (event) => {
  lastContextmenuSnapshot = new Map();
  const script = CONTEXTMENU_SCRIPT.scan();
  const scriptPath = writeTempScript(script);
  try {
    writeLog('info', '扫描右键菜单');
    const { stdout, stderr, code, timedOut } = await runPowerShellFile(scriptPath, { timeout: 60000 });
    if (timedOut) {
      return { success: false, message: '扫描超时（超过 60 秒），请稍后重试或关闭其他占用注册表的程序' };
    }
    if (code !== 0) {
      writeLog('error', `右键菜单扫描失败: ${stderr || '未知错误'}`);
      return { success: false, message: stderr || '扫描失败' };
    }
    try {
      const raw = stdout.trim();
      const data = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(data)) throw new Error('结果不是数组');
      writeLog('info', `扫描右键菜单完成: ${data.length} 项`);
      const normalized = data.map((item, index) => ({ ...item, id: String(item.id || item.regPath || index) }));
      lastContextmenuSnapshot = snapshotById(normalized);
      return { success: true, data: normalized };
    } catch (e) {
      return { success: false, message: '解析失败' };
    }
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

handleSafe('contextmenu:backup', async (event, { items, clsids } = {}) => {
  // 兼容旧版调用方：新版传完整 items，旧版若只传 clsids 则无法导出路径，直接返回明确错误
  const backupItems = Array.isArray(items) ? items : (Array.isArray(clsids) ? clsids : []);
  const safeBackupItems = validateSnapshotItems(backupItems, lastContextmenuSnapshot);
  if (!safeBackupItems) return { success: false, message: '备份项不是最近一次扫描结果，已拒绝执行' };
  if (!backupItems.length) return { success: false, message: '没有可备份的右键菜单项' };
  if (safeBackupItems.some(item => !item || typeof item !== 'object' || !item.regPath)) {
    return { success: false, message: '备份项缺少注册表/文件路径，已停止删除' };
  }
  const script = CONTEXTMENU_SCRIPT.backup(safeBackupItems);
  const scriptPath = writeTempScript(script);
  try {
    writeLog('info', `备份右键菜单: ${safeBackupItems.length} 项`);
    const { stdout, code } = await runPowerShellFile(scriptPath, { timeout: 60000 });
    if (code === 0) {
      try {
        const data = JSON.parse(stdout.trim());
        if (!data || !data.backupDir || Number(data.count || 0) < 1) return { success: false, message: '备份未生成有效文件' };
        return { success: true, data };
      } catch (e) {
        return { success: false, message: '解析备份结果失败' };
      }
    }
    return { success: false, message: '备份失败' };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

handleSafe('contextmenu:remove', async (event, { items, clsids } = {}) => {
  const removeItems = Array.isArray(items) ? items : (Array.isArray(clsids) ? clsids : []);
  const safeRemoveItems = validateSnapshotItems(removeItems, lastContextmenuSnapshot);
  if (!safeRemoveItems) return { success: false, message: '删除项不是最近一次扫描结果，已拒绝执行' };
  if (!safeRemoveItems.length) return { success: false, message: '没有可删除的右键菜单项' };
  const script = CONTEXTMENU_SCRIPT.remove(safeRemoveItems);
  const scriptPath = writeTempScript(script);
  try {
    writeLog('warn', `删除右键菜单: ${safeRemoveItems.length} 项`);
    const { stdout, code } = await runPowerShellFile(scriptPath, { timeout: 60000, diagOp: 'contextmenu.remove' });
    if (code === 0) {
      try {
        const data = JSON.parse(stdout.trim());
        return { success: data.failed === 0, data };
      } catch (e) {
        return { success: false, message: '解析删除结果失败' };
      }
    }
    return { success: false, message: '删除失败' };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// 启停切换右键菜单项（勾选=启用，取消=禁用；禁用为可逆操作，不做备份）
handleSafe('contextmenu:toggle', async (event, { items } = {}) => {
  const safeItems = validateSnapshotItems(items, lastContextmenuSnapshot);
  if (!safeItems) return { success: false, message: '切换项不是最近一次扫描结果，已拒绝执行' };
  const toggleItems = safeItems
    .filter(it => it && typeof it === 'object' && it.regPath && it.source)
    .map(it => ({
      name: it.name || '', regPath: it.regPath, source: it.source, enabled: !!it.enabled
    }));
  if (!toggleItems.length) return { success: false, message: '没有可切换的菜单项' };
  const script = CONTEXTMENU_SCRIPT.toggle(toggleItems);
  const scriptPath = writeTempScript(script);
  try {
    writeLog('info', `切换右键菜单启停: ${toggleItems.length} 项`);
    const { stdout, code, timedOut } = await runPowerShellFile(scriptPath, { timeout: 60000 });
    if (timedOut) return { success: false, message: '切换超时，请稍后重试' };
    if (code !== 0) return { success: false, message: '切换失败' };
    const data = JSON.parse(stdout.trim());
    if (data.failed > 0) {
      const firstErr = (data.results || []).find(r => r.status === 'error');
      writeLog('warn', `启停切换部分失败: ${data.failed} 项`);
      return { success: false, message: (firstErr && firstErr.message) || '部分项切换失败（可能需要管理员权限）', data };
    }
    return { success: true, data };
  } catch (e) {
    return { success: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

handleSafe('contextmenu:restore', async (event) => {
  const script = CONTEXTMENU_SCRIPT.restore();
  const scriptPath = writeTempScript(script);
  try {
    writeLog('warn', '恢复右键菜单备份');
    const { stdout, code } = await runPowerShellFile(scriptPath, { timeout: 60000 });
    if (code === 0) {
      try {
        const data = JSON.parse(stdout.trim());
        return { success: !!(data && data.success && (Number(data.imported || 0) + Number(data.restored || 0) > 0)), data };
      } catch (e) {
        return { success: false, message: '解析恢复结果失败' };
      }
    }
    return { success: false, message: '恢复失败' };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// 提取右键菜单项程序图标（CLSID → InprocServer32 DLL → PNG base64）
handleSafe('contextmenu:icons', async (event, { items } = {}) => {
  const iconItems = (Array.isArray(items) ? items : [])
    .filter(it => it && it.clsid && String(it.clsid).trim().startsWith('{'))
    .map(it => ({ clsid: String(it.clsid).trim() }));
  if (!iconItems.length) return { success: true, data: {} };
    const script = CONTEXTMENU_SCRIPT.icons(iconItems);
    const scriptPath = writeTempScript(script);
    try {
      const { stdout, code } = await runPowerShellFile(scriptPath, { timeout: 30000 });
    if (code === 0) {
      const raw = stdout.trim();
      const data = raw ? JSON.parse(raw) : {};
      return { success: true, data: (data && typeof data === 'object') ? data : {} };
    }
    return { success: true, data: {} };
  } catch (e) {
    return { success: true, data: {} };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// 在注册表编辑器中定位到指定注册表项（LastKey 方案；启动失败自动 UAC 提权）
handleSafe('contextmenu:open-in-regedit', async (event, { regPath } = {}) => {
  let p = String(regPath || '').trim().replace(/\\+$/, '');
  if (!p) return { success: false, message: '无效的注册表路径' };
  // 根键别名 → 完整名称（regedit LastKey 需要完整根键名）
  const alias = {
    HKCR: 'HKEY_CLASSES_ROOT', HKCU: 'HKEY_CURRENT_USER', HKLM: 'HKEY_LOCAL_MACHINE',
    HKU: 'HKEY_USERS', HKCC: 'HKEY_CURRENT_CONFIG'
  };
  const m = p.match(/^([^\\]+)(\\[\s\S]*)?$/);
  if (m && alias[m[1].toUpperCase()]) {
    p = alias[m[1].toUpperCase()] + (m[2] || '');
  }
  const escaped = p.replace(/'/g, "''");
  const script = `\$ErrorActionPreference = 'SilentlyContinue'
\$key = '${escaped}'
# 若 regedit 已在运行：优雅关闭其主窗口（等价点击关闭按钮），不强制结束进程，
# 避免用户正在查看的其它注册表键被强制中断。
\$running = Get-Process regedit -ErrorAction SilentlyContinue
if (\$running) {
  foreach (\$p in \$running) { try { \$null = \$p.CloseMainWindow() } catch {} }
  Start-Sleep -Milliseconds 500
}
try {
  if (-not (Test-Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Applets\\Regedit')) {
    New-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Applets\\Regedit' -Force | Out-Null
  }
  Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Applets\\Regedit' -Name 'LastKey' -Value \$key -ErrorAction Stop
} catch {}
Start-Sleep -Milliseconds 200
\$elevated = \$false
try {
  Start-Process regedit -ErrorAction Stop
} catch {
  try {
    Start-Process regedit -Verb RunAs -ErrorAction Stop
    \$elevated = \$true
  } catch {
    Write-Output 'FAIL'
    exit 1
  }
}
if (\$elevated) { Write-Output 'OK-ELEVATED' } else { Write-Output 'OK' }
`;
  const scriptPath = writeTempScript(script);
  try {
    writeLog('info', `在注册表编辑器中定位: ${p}`);
    const { stdout, code } = await runPowerShellFile(scriptPath, { timeout: 30000 });
    const out = String(stdout || '').trim();
    if (code === 0 && out.includes('OK')) {
      return { success: true, elevated: out.includes('ELEVATED') };
    }
    return { success: false, message: '打开注册表编辑器失败' };
  } catch (e) {
    return { success: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// ==================== 优化电脑 IPC ====================
// 每个选项循序渐进执行，并把 "@@PROGRESS:n@@" 以流式进度推送到渲染层
const OPTIMIZER = require('./src/scripts-powershell/optimizer-scripts');
// v2.6.0（P0-1）：优化项「已应用状态」记账——先记账后执行（fail-closed），还原成功才销账
const OPT_STATE = require('./src/main/optimization-state');

// 步骤类型分类（供记账 kinds 字段）：reg=注册表 / service=服务启停 / cmd=bcdedit、fsutil、powercfg 等命令
function classifyStepKinds(steps) {
  const kinds = new Set();
  for (const s of steps || []) {
    if (!s) continue;
    if (typeof s.reg === 'string') kinds.add('reg');
    if (s.service) kinds.add('service');
    if (s.cmd || s.pwsh) kinds.add('cmd');
  }
  return [...kinds];
}

handleSafe('optimizer:run', async (event, { optionId, params = {} } = {}) => {
  const opt = OPTIMIZER.OPTIONS.find(o => o.id === optionId);
  if (!opt) return { success: false, message: '未知的优化选项' };

  // 内存 SVCHost 阈值：由下拉参数动态生成执行步骤（动态选项）
  let steps;
  if (opt.dynamic) {
    if (optionId === 'svc_mem_gb') {
      steps = OPTIMIZER.memorySteps(params.gb);
    } else {
      steps = [];
    }
  } else {
    steps = params.restore && opt.restore ? opt.restore : opt.steps;
  }
  if (!steps || !steps.length) return { success: false, message: '选项无可执行步骤' };

  // v2.6.0（P0-1）：执行前先记账（fail-closed 不变式①）——状态文件写不进去就不改系统。
  // kinds 覆盖 reg / service / cmd（bcdedit、fsutil、powercfg 等此前无任何持久化痕迹的步骤）。
  const isRestoreRun = !!(params.restore && opt.restore);
  if (!isRestoreRun && OPT_STATE.ready()) {
    if (!OPT_STATE.recordPending(optionId, { title: opt.title, kinds: classifyStepKinds(steps) })) {
      writeLog('error', `优化状态记账失败，已按 fail-closed 中止执行: ${opt.title}`);
      return { success: false, message: '优化状态记录写入失败，已中止执行（避免产生无法追溯的系统更改）' };
    }
  }

  const script = OPTIMIZER.buildScript(steps);
  const scriptPath = writeTempScript(script);
  const sender = event.sender;
  let current = 0;
  try {
    writeLog('info', `优化电脑执行: ${opt.title} ${params.restore ? '(还原)' : ''}`);
    let output = '';
    const { stdout, code } = await runPowerShellFile(scriptPath, {
      timeout: 120000,
      diagOp: 'optimizer.apply',
      onStdout(chunk) {
        output += chunk;
        // 逐段解析进度标记，推送实时百分比
        const re = /@@PROGRESS:(\d+)@@/g;
        let m;
        while ((m = re.exec(chunk)) !== null) {
          const n = Math.min(100, Math.max(0, parseInt(m[1], 10) || 0));
          if (n !== current && sender && !sender.isDestroyed()) {
            current = n;
            sender.send('optimizer:progress', { optionId, percent: n });
          }
        }
      }
    });
    const failedMatch = /@@FAILED:(\d+)@@/.exec(String(stdout || output));
    const failedSteps = failedMatch ? Number(failedMatch[1]) : 0;
    const ok = code === 0 && String(stdout || output).includes('@@DONE@@') && failedSteps === 0;
    if (!ok) writeLog('warn', `优化电脑命令退出码 ${code}: ${opt.title}`);

    // v2.6.0（P0-1/P0-2）：记账收尾与执行后回读验证
    if (OPT_STATE.ready()) {
      if (isRestoreRun) {
        // 还原成功才销账；失败保留记录等下次重试（不变式②）
        if (ok) {
          OPT_STATE.remove(optionId);
          // v2.7.0：及时回写检测结果（还原成功 = 当前未生效；动态修正交由启动扫描）
          OPT_STATE.setDetectedEntry(optionId, false);
        }
      } else if (ok) {
        const verify = await verifyOptionApplied(optionId, opt, params);
        if (verify === 'partial') writeLog('warn', `执行后回读校验不符（可能被组策略/安全软件覆盖）: ${opt.title}`);
        OPT_STATE.markApplied(optionId, verify);
        // v2.7.0：执行成功及时回写检测结果（pass=已生效；partial=读回不符视为未生效；unknown 交启动扫描）
        if (verify !== 'unknown') OPT_STATE.setDetectedEntry(optionId, verify === 'pass');
        return { success: ok, message: ok ? '完成' : '部分步骤可能失败', verify };
      } else {
        // 执行失败：转正为 applied+unknown（前序步骤可能已部分生效），
        // 后续由启动扫描对可检测项核对真实状态，还原入口始终可用
        OPT_STATE.markApplied(optionId, 'unknown');
      }
    }
    return { success: ok, message: ok ? '完成' : '部分步骤可能失败' };
  } catch (e) {
    writeLog('error', `优化电脑执行异常: ${e.message}`);
    // 异常路径同样保留记账记录（前序步骤可能已生效），由启动扫描核对
    if (!isRestoreRun && OPT_STATE.ready()) { try { OPT_STATE.markApplied(optionId, 'unknown'); } catch (_) {} }
    return { success: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

handleSafe('optimizer:list', async () => {
  // 供渲染层按需要拉取目录（通常由内置 JS 目录直接渲染，这里保底）
  return { success: true, data: OPTIMIZER.OPTIONS };
});

// ==================== 安全托底：注册表优化项「已优化」批量检测 ====================
// 解析 .reg 值字符串 → {type, data}（dword:十六进制 → 十进制字符串；"xxx" → 字符串）
function parseRegExpected(v) {
  if (typeof v !== 'string') return null;
  if (v.startsWith('dword:')) {
    const n = parseInt(v.slice(6), 16);
    return Number.isFinite(n) ? { type: 'dword', data: String(n) } : null;
  }
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return { type: 'string', data: v.slice(1, -1) };
  return { type: 'string', data: v };
}

// .reg 根键 → PowerShell 驱动器前缀
const REG_ROOT_MAP = {
  HKEY_LOCAL_MACHINE: 'HKLM:',
  HKEY_CURRENT_USER: 'HKCU:',
  HKEY_CLASSES_ROOT: 'HKCR:',
  HKEY_USERS: 'HKU:',
  HKEY_CURRENT_CONFIG: 'HKCC:'
};

// v2.6.0（P0-2）：检测逻辑抽为内部函数，供 IPC 与「执行后回读验证」共用。
// 返回 { id: boolean } 映射——true = 该项全部期望键值/服务状态均已生效。
async function checkOptimizedInternal(ids) {
  const list = Array.isArray(ids) ? ids : (ids ? [ids] : []);
  // 收集每个 id 的全部期望状态（reg 键值 + 服务禁用状态）
  const byId = new Map(); // id -> [{ kind: 'reg'|'svc', ... }]
  for (const id of list) {
    const opt = OPTIMIZER.OPTIONS.find(o => o.id === id);
    if (!opt) continue;
    const checks = [];
    for (const s of (opt.steps || [])) {
      if (!s) continue;
      // reg 块：逐键值解析期望值
      if (typeof s.reg === 'string') {
        const block = s.reg;
        const secRe = /^\[([^\]\r\n]+)\]\r?\n([\s\S]*?)(?=\r?\n\[|$)/gm;
        let m;
        while ((m = secRe.exec(block)) !== null) {
          const root = m[1].trim().split('\\')[0];
          const psPath = (REG_ROOT_MAP[root] || '') + m[1].trim().slice(root.length);
          if (!psPath) continue;
          const lineRe = /"([^"]+)"=([^\r\n]+)/g;
          let lm;
          while ((lm = lineRe.exec(m[2])) !== null) {
            const raw = lm[2].trim();
            if (raw === '-') continue; // 还原占位（删除）不参与检测
            const parsed = parseRegExpected(raw);
            if (!parsed) continue;
            checks.push({ kind: 'reg', psPath, key: lm[1], type: parsed.type, data: parsed.data });
          }
        }
      }
      // 服务步骤：检测启动类型是否已为"禁用"
      if (s.service && s.disable) {
        checks.push({ kind: 'svc', name: s.service });
      }
    }
    if (checks.length) byId.set(id, checks);
  }
  if (!byId.size) return {};

  // 生成一个只读 PowerShell 脚本一次性检测全部项（避免并发拉起大量进程）
  const esc = (s) => String(s).replace(/'/g, "''");
  const L = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'function Test-One([string]$p, [string]$k, [bool]$isDword, [string]$d) {',
    '  $ip = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue',
    '  if (-not $ip) { return $false }',
    '  $v = $ip.$k',
    '  if ($null -eq $v) { return $false }',
    '  if ($isDword) { try { return ([int]$v -eq [int]$d) } catch { return $false } }',
    '  return ("$v" -eq $d)',
    '}',
    'function Test-Svc([string]$n) {',
    '  $s = Get-Service -Name $n -ErrorAction SilentlyContinue',
    '  return ($s -and $s.StartType -eq "Disabled")',
    '}',
    '$r = @{}'
  ];
  let gi = 0;
  const groupOf = new Map(); // id -> group var
  for (const [id, checks] of byId) {
    const gv = `$g_${gi++}`;
    groupOf.set(id, gv);
    L.push(`${gv} = $true`);
    for (const c of checks) {
      if (c.kind === 'svc') {
        L.push(`${gv} = ${gv} -and (Test-Svc '${esc(c.name)}')`);
      } else {
        L.push(`${gv} = ${gv} -and (Test-One '${esc(c.psPath)}' '${esc(c.key)}' ${c.type === 'dword' ? '$true' : '$false'} '${esc(c.data)}')`);
      }
    }
  }
  for (const [id, gv] of groupOf) {
    L.push(`$r['${esc(id)}'] = (${gv} -eq $true)`);
  }
  L.push('$r | ConvertTo-Json -Compress');
  const scriptPath = writeTempScript(L.join('\n'));
  try {
    const { stdout } = await runPowerShellFile(scriptPath, { timeout: 120000 });
    let parsed = {};
    try { parsed = JSON.parse(stdout.trim() || '{}'); } catch (e) { parsed = {}; }
    // 统一布尔类型（ConvertTo-Json 单条时可能非对象）
    const results = {};
    for (const id of groupOf.keys()) {
      const v = typeof parsed === 'object' && parsed !== null ? parsed[id] : false;
      results[id] = v === true;
    }
    return results;
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
}

handleSafe('optimizer:check-optimized', async (event, { ids } = {}) => {
  try {
    const results = await checkOptimizedInternal(ids);
    return { success: true, results };
  } catch (e) {
    writeLog('error', `安全托底检测异常: ${e.message}`);
    return { success: false, results: {}, message: e.message };
  }
});

// v2.6.0（P0-2）：执行后回读验证——成功 ≠ 生效，可能被组策略/安全软件即时覆盖。
// 返回 'pass'（读回一致）/ 'partial'（已执行但读回不符）/ 'unknown'（无可检测手段）。
async function verifyOptionApplied(optionId, opt, params) {
  try {
    if (optionId === 'svc_mem_gb') {
      // 动态项：读当前阈值比对目标档位
      const target = params && params.gb != null ? String(params.gb) : null;
      if (target == null) return 'unknown';
      const cur = await svcMemCurrentInternal();
      if (!cur.success) return 'unknown';
      return cur.gb != null && String(cur.gb) === target ? 'pass' : 'partial';
    }
    const checkable = (opt.steps || []).some(s => s && (typeof s.reg === 'string' || (s.service && s.disable)));
    if (!checkable) return 'unknown'; // cmd 类步骤（bcdedit 等）无逐键比对手段，不伪造结论
    const results = await checkOptimizedInternal([optionId]);
    return results[optionId] === true ? 'pass' : 'partial';
  } catch (e) {
    writeLog('warn', `回读验证异常（按 unknown 处理）: ${optionId}: ${e.message}`);
    return 'unknown';
  }
}

// v2.7.0（任务2）：优化项「已优化」检测结果持久化——应用首次启动即后台全量扫描并写入
// optimization-state.json 的 detected 段（安装版 %APPDATA%\Trim，便携版程序目录\data），
// 此后每次执行/还原及时回写单条，常态化留痕，不再只存在渲染层内存里。
// 只扫可检测项（reg/svc 步骤）+ 动态项；cmd 类（bcdedit 等）无检测手段，不伪造结论。
async function refreshOptimizerDetectCache() {
  if (!OPT_STATE.ready()) return;
  try {
    const checkIds = [];
    for (const o of OPTIMIZER.OPTIONS) {
      if (o.dynamic) continue;
      if ((o.steps || []).some(s => s && (typeof s.reg === 'string' || (s.service && s.disable)))) {
        checkIds.push(o.id);
      }
    }
    const detected = OPT_STATE.getDetectedAll();
    const results = await checkOptimizedInternal(checkIds);
    const now = new Date().toISOString();
    for (const id of checkIds) {
      if (typeof results[id] !== 'boolean') continue; // 检测脚本未返回（异常）时保留旧值
      detected[id] = { optimized: results[id], at: now };
    }
    // 动态项：按当前阈值档位是否命中判定（default 档位视为未优化态）
    const svc = await svcMemCurrentInternal();
    if (svc.success) {
      detected.svc_mem_gb = { optimized: svc.gb != null && svc.gb !== 'default', at: now };
    }
    OPT_STATE.replaceDetected(detected);
    const optimizedCount = Object.values(detected).filter(d => d && d.optimized === true).length;
    writeLog('info', `优化项已优化扫描完成并持久化: 可检测 ${checkIds.length + 1} 项，当前已生效 ${optimizedCount} 项`);
  } catch (e) {
    writeLog('warn', `优化项已优化扫描失败（保留既有记录）: ${e.message}`);
  }
}

// v2.6.0（P0-1）：启动扫描 + 状态总览——对记账条目核对真实状态并标出 stale。
// stale 判定：
//   · status=pending（执行中断/崩溃遗留）→ 一律 stale（含无法检测的 cmd 类）；
//   · status=applied 且可逐键检测 → 检测结果为 false 即 stale；
//   · status=applied 且不可检测（cmd 类）→ 不标 stale（无手段，不伪造结论）。
// 动态项（svc_mem_gb）不参与 stale 判定：灰态由注册表实时档位单独决定。
handleSafe('optimizer:state-overview', async () => {
  try {
    if (!OPT_STATE.ready()) return { success: true, items: [], staleIds: [], migration: lastMigrationSummary };
    const raw = OPT_STATE.all();
    const items = [];
    const pendingIds = [];
    const checkIds = [];
    for (const [id, rec] of Object.entries(raw)) {
      const opt = OPTIMIZER.OPTIONS.find(o => o.id === id);
      if (opt && opt.dynamic) {
        // 动态项遗留的 pending 记录无法可靠核对，直接清理避免误报
        if (rec.status === 'pending') OPT_STATE.remove(id);
        continue;
      }
      items.push({
        id,
        title: (opt && opt.title) || rec.title || id,
        appliedAt: rec.appliedAt,
        kinds: rec.kinds || [],
        status: rec.status,
        lastVerify: rec.lastVerify,
        checkable: !!(opt && (opt.steps || []).some(s => s && (typeof s.reg === 'string' || (s.service && s.disable))))
      });
      if (rec.status === 'pending') pendingIds.push(id);
      else if (items[items.length - 1].checkable) checkIds.push(id);
    }
    const staleIds = [...pendingIds];
    if (checkIds.length) {
      const results = await checkOptimizedInternal(checkIds);
      for (const id of checkIds) {
        if (results[id] === false) staleIds.push(id);
      }
    }
    return { success: true, items, staleIds, migration: lastMigrationSummary, detected: OPT_STATE.getDetectedAll() };
  } catch (e) {
    writeLog('error', `优化状态总览异常: ${e.message}`);
    return { success: false, items: [], staleIds: [], message: e.message, migration: lastMigrationSummary };
  }
});

// 读取当前 SVCHost 拆分阈值（SvcHostSplitThresholdInKB）并映射为档位
// 返回 { success, gb, kb }：gb 为命中 MEMORY_KB 的档位（'default' 或数字），null=注册表无值（系统默认）
// v2.6.0（P0-2）：抽为内部函数供 IPC 与动态项回读验证共用
async function svcMemCurrentInternal() {
  const L = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$v = (Get-ItemProperty -Path "HKLM:\\SYSTEM\\ControlSet001\\Control" -Name SvcHostSplitThresholdInKB -ErrorAction SilentlyContinue).SvcHostSplitThresholdInKB',
    'if ($null -eq $v) { Write-Output "NONE" } else { Write-Output ("KB|" + [long]$v) }'
  ];
  const scriptPath = writeTempScript(L.join('\n'));
  try {
    const { stdout } = await runPowerShellFile(scriptPath, { timeout: 60000 });
    const line = (stdout || '').split(/\r?\n/).find(s => s.startsWith('KB|') || s.trim() === 'NONE') || 'NONE';
    if (!line.startsWith('KB|')) return { success: true, gb: null, kb: null };
    const kb = parseInt(line.slice(3), 10);
    if (!Number.isFinite(kb)) return { success: true, gb: null, kb: null };
    for (const [gb, val] of Object.entries(OPTIMIZER.MEMORY_KB || {})) {
      if (val === kb) return { success: true, gb: gb === 'default' ? 'default' : Number(gb), kb };
    }
    return { success: true, gb: null, kb };
  } catch (e) {
    writeLog('error', `读取 SVCHost 阈值异常: ${e.message}`);
    return { success: false, gb: null, kb: null, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
}

handleSafe('optimizer:svc-mem-current', async () => svcMemCurrentInternal());

// ==================== 优化项注册表备份与还原 ====================
// 所有含注册表操作的优化项，在用户执行前先记录目标键值的当前真实值；
// 「还原」时优先按记录值回写（执行前不存在的键值 → 删除），
// 无备份记录时才回退到优化项预置的还原脚本。
const OPT_BACKUP_FILE = path.join(APP_DATA_DIR, 'optimizer-backups.json');
// v2.6.0（P0-3）：启动时退役优化项迁移的结果（供 optimizer:state-overview 回报渲染层一次性提示）
let lastMigrationSummary = { restored: [], failed: [] };

function loadOptBackups() {
  try {
    const m = JSON.parse(fs.readFileSync(OPT_BACKUP_FILE, 'utf8'));
    return (m && typeof m === 'object') ? m : {};
  } catch (e) {
    quarantineFile(OPT_BACKUP_FILE, e); // 审查 4-1：与 loadAppearance 一致，损坏先隔离再降级
    return {};
  }
}

function saveOptBackups(map) {
  try {
    fs.mkdirSync(APP_DATA_DIR, { recursive: true });
    SECURITY.atomicWriteJson(OPT_BACKUP_FILE, map);
    return true;
  } catch (e) {
    writeLog('error', `写入优化备份失败: ${e.message}`);
    return false;
  }
}

// 解析 .reg 块 → 目标键值列表 [{ root, sub, key }]（与 check-optimized 的解析规则一致）
function parseRegTargets(regBlock) {
  const out = [];
  const secRe = /^\[([^\]\r\n]+)\]\r?\n([\s\S]*?)(?=\r?\n\[|$)/gm;
  let m;
  while ((m = secRe.exec(regBlock)) !== null) {
    const full = m[1].trim();
    const root = full.split('\\')[0];
    const sub = full.slice(root.length + 1);
    const lineRe = /"([^"]+)"=([^\r\n]+)/g;
    let lm;
    while ((lm = lineRe.exec(m[2])) !== null) {
      if (lm[2].trim().startsWith('-')) continue; // 还原占位（删除）不参与备份
      out.push({ root, sub, key: lm[1] });
    }
  }
  return out;
}

// .reg 根键 → [Microsoft.Win32.Registry] 静态类属性名
const OPT_HIVE_MAP = {
  HKEY_LOCAL_MACHINE: 'LocalMachine',
  HKEY_CURRENT_USER: 'CurrentUser',
  HKEY_CLASSES_ROOT: 'ClassesRoot',
  HKEY_USERS: 'Users',
  HKEY_CURRENT_CONFIG: 'CurrentConfig'
};

// .reg 根键 → reg.exe 缩写
const OPT_REGEXE_MAP = {
  HKEY_LOCAL_MACHINE: 'HKLM',
  HKEY_CURRENT_USER: 'HKCU',
  HKEY_CLASSES_ROOT: 'HKCR',
  HKEY_USERS: 'HKU',
  HKEY_CURRENT_CONFIG: 'HKCC'
};

// 执行前备份：读取目标键值当前状态并存档（optionId → values）
handleSafe('optimizer:backup-reg', async (event, { optionId, steps } = {}) => {
  try {
    if (!optionId || !OPTIMIZER.OPTIONS.some(option => option.id === optionId)) return { success: false, message: '未知的优化选项' };
    // dynamic 项（svc_mem_gb）的注册表目标由档位脚本运行时生成，这里直接声明
    let targets = [];
    if (optionId === 'svc_mem_gb') {
      targets = [{ root: 'HKEY_LOCAL_MACHINE', sub: 'SYSTEM\\ControlSet001\\Control', key: 'SvcHostSplitThresholdInKB' }];
    } else {
      const option = OPTIMIZER.OPTIONS.find(candidate => candidate.id === optionId);
      for (const s of ((option && option.steps) || [])) {
        if (s && typeof s.reg === 'string') targets.push(...parseRegTargets(s.reg));
      }
    }
    const seen = new Set();
    const uniq = targets.filter(t => {
      const k = `${t.root}\\${t.sub}::${t.key}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (!uniq.length) return { success: true, count: 0 };

    const esc = (s) => String(s).replace(/'/g, "''");
    const L = [
      '$ErrorActionPreference = "SilentlyContinue"',
      'function Read-One([string]$hive, [string]$sub, [string]$name) {',
      '  $r = @{ hive = $hive; sub = $sub; key = $name; exists = $false }',
      '  try {',
      '    $rk = [Microsoft.Win32.Registry]::$hive.OpenSubKey($sub, $false)',
      '    if ($rk) {',
      '      $v = $rk.GetValue($name)',
      '      if ($null -ne $v) {',
      '        $r.exists = $true',
      '        $kind = $rk.GetValueKind($name)',
      "        if ($kind -eq 'DWord') { $r.type = 'REG_DWORD'; $r.data = [string]([int]$v) }",
      "        elseif ($kind -eq 'QWord') { $r.type = 'REG_QWORD'; $r.data = [string]([long]$v) }",
      "        elseif ($kind -eq 'Binary') { $r.type = 'REG_BINARY'; $r.data = ([byte[]]$v | ForEach-Object { $_.ToString('x2') }) -join '' }",
      "        else { $r.type = 'REG_SZ'; $r.data = [string]$v }",
      '      }',
      '      $rk.Close()',
      '    }',
      '  } catch {}',
      '  return $r',
      '}'
    ];
    for (const t of uniq) {
      const hive = OPT_HIVE_MAP[t.root] || 'LocalMachine';
      L.push(`$out += Read-One '${esc(hive)}' '${esc(t.sub)}' '${esc(t.key)}'`);
    }
    L.push('$out | ConvertTo-Json -Compress -Depth 5');
    const scriptPath = writeTempScript(L.join('\n'));
    let values;
    try {
      const { stdout, code } = await runPowerShellFile(scriptPath, { timeout: 60000 });
      if (code !== 0) throw new Error('读取当前注册表值失败');
      let parsed;
      try { parsed = JSON.parse(stdout.trim() || '[]'); } catch (e) { parsed = null; }
      if (parsed === null) throw new Error('解析注册表备份结果失败');
      values = Array.isArray(parsed) ? parsed : [parsed];
    } finally {
      try { fs.unlinkSync(scriptPath); } catch (e) {}
    }
    const map = loadOptBackups();
    map[optionId] = { at: new Date().toISOString(), values };
    if (!saveOptBackups(map)) return { success: false, message: '注册表备份文件写入失败' };
    writeLog('info', `优化项注册表备份完成: ${optionId}（${values.length} 项）`);
    return { success: true, count: values.length };
  } catch (e) {
    writeLog('error', `优化项注册表备份异常: ${e.message}`);
    return { success: false, message: e.message };
  }
});

// v2.6.0（P0-3）：按备份条目回写注册表原值（restore-reg 与退役迁移共用的还原实现）。
// entry: { values: [{ hive, sub, key, exists, type, data }] }；返回 { ok, reason? }
async function restoreBackupValues(entry) {
  if (!entry || !Array.isArray(entry.values) || entry.values.length === 0) {
    return { ok: false, reason: '备份记录为空' };
  }
  const L = ['$ErrorActionPreference = "SilentlyContinue"', '$failed = 0'];
  // PowerShell 双引号字符串的转义符是反引号，`"` 直接闭合字符串；
  // 嵌入双引号必须用 "" 成对转义（实测 \" 会把值截断并错位出多余参数）。
  const quoteEsc = (s) => String(s).replace(/"/g, '""');
  for (const v of entry.values) {
    const prefix = OPT_REGEXE_MAP[v.hive] || 'HKLM';
    const full = `${prefix}\\${v.sub}`;
    const keyEsc = quoteEsc(v.key);
    if (v.exists) {
      let typeArg = '/t REG_SZ';
      let dataArg = quoteEsc(v.data == null ? '' : v.data);
      if (v.type === 'REG_DWORD' || v.type === 'REG_QWORD') {
        typeArg = `/t ${v.type}`;
      } else if (v.type === 'REG_BINARY') {
        typeArg = '/t REG_BINARY';
        dataArg = String(v.data || '').replace(/(..)/g, '$1,').replace(/,$/, '');
      }
      L.push(`reg add "${full}" /v "${keyEsc}" ${typeArg} /d "${dataArg}" /f | Out-Null; if ($LASTEXITCODE -ne 0) { $failed++ }`);
    } else {
      L.push(`reg delete "${full}" /v "${keyEsc}" /f 2>$null | Out-Null; if ($LASTEXITCODE -ne 0) { reg query "${full}" /v "${keyEsc}" 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $failed++ } }`);
    }
  }
  L.push('Write-Output ("RESTORE_DONE:" + $failed)');
  const scriptPath = writeTempScript(L.join('\n'));
  try {
    const { stdout, code } = await runPowerShellFile(scriptPath, { timeout: 120000 });
    if (code !== 0 || !(stdout || '').includes('RESTORE_DONE:0')) {
      return { ok: false, reason: '还原脚本执行失败' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
}

// 按备份还原：将执行前记录的键值回写（不存在的 → 删除）；成功后清除该备份与已应用记账
handleSafe('optimizer:restore-reg', async (event, { optionId } = {}) => {
  try {
    if (!optionId || !OPTIMIZER.OPTIONS.some(option => option.id === optionId)) return { success: false, message: '未知的优化选项' };
    const map = loadOptBackups();
    const entry = map[optionId];
    if (!entry || !Array.isArray(entry.values) || entry.values.length === 0) {
      return { success: false, missing: true, message: '无备份记录' };
    }
    const restored = entry.values.length;
    const r = await restoreBackupValues(entry);
    if (!r.ok) throw new Error(r.reason || '还原脚本执行失败');
    delete map[optionId];
    if (!saveOptBackups(map)) return { success: false, message: '还原完成但备份记录清理失败' };
    // v2.6.0（P0-1）：还原成功 → 同步销账（不变式：还原成功才清记录）
    if (OPT_STATE.ready()) {
      OPT_STATE.remove(optionId);
      // v2.7.0：及时回写检测结果（还原成功 = 当前未生效）
      OPT_STATE.setDetectedEntry(optionId, false);
    }
    writeLog('info', `优化项注册表已按备份还原: ${optionId}（${restored} 项）`);
    return { success: true, restored };
  } catch (e) {
    writeLog('error', `优化项注册表还原异常: ${e.message}`);
    return { success: false, message: e.message };
  }
});

// 解析 WMI DMTF 时间串（yyyymmddHHMMSS.mmmmmm±UUU，UUU 为与 UTC 的分钟偏移）。
// 返回 ISO 字符串；无法解析返回 null。
// 不使用 [System.Management.ManagementDateTimeConverter]：该类型属于 System.Management
// 程序集，PowerShell 7 默认不加载，执行会抛异常（见审查报告 B3）。
function parseDmtfDateTime(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+\-])(\d{3})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, , sign, off] = m;
  const offsetMinutes = Number(off) * (sign === '-' ? -1 : 1);
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - offsetMinutes * 60000;
  const t = new Date(utcMs);
  return isNaN(t.getTime()) ? null : t.toISOString();
}

// 查询最近一次系统还原点（返回最近创建时间 ISO，无还原点返回 exists=false）。
// PS 脚本直接输出原始 DMTF 串由 Node 侧解析；查询失败通过 RPERROR| 显式上报，
// 不与「确无还原点」混为一谈——查询失败应放行并记日志，而非恒误报骚扰用户。
handleSafe('optimizer:check-restore', async () => {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    '  $rp = Get-ComputerRestorePoint | Sort-Object CreationTime -Descending | Select-Object -First 1',
    '  if ($rp) { Write-Output ("RPEXISTS|" + $rp.CreationTime) } else { Write-Output "RPNONE" }',
    '} catch {',
    '  Write-Output ("RPERROR|" + $_.Exception.Message)',
    '}'
  ].join('\n');
  const scriptPath = writeTempScript(script);
  try {
    const { stdout } = await runPowerShellFile(scriptPath, { timeout: 30000 });
    const line = (stdout || '').split(/\r?\n/).map(s => s.trim())
      .find(l => l.startsWith('RPEXISTS|') || l === 'RPNONE' || l.startsWith('RPERROR|'));
    if (line && line.startsWith('RPEXISTS|')) {
      const created = parseDmtfDateTime(line.slice('RPEXISTS|'.length));
      if (!created) {
        writeLog('warn', `还原点时间解析失败: ${line.slice('RPEXISTS|'.length)}`);
        return { success: false, exists: false, message: '还原点时间解析失败' };
      }
      return { success: true, exists: true, created };
    }
    if (line && line.startsWith('RPERROR|')) {
      writeLog('warn', `还原点查询失败: ${line.slice('RPERROR|'.length)}`);
      return { success: false, exists: false, message: line.slice('RPERROR|'.length) };
    }
    // 无可辨识输出：视为查询失败而非「无还原点」
    writeLog('warn', '还原点查询无有效输出');
    return { success: false, exists: false, message: '查询无有效输出' };
  } catch (e) {
    writeLog('error', `检查还原点异常: ${e.message}`);
    return { success: false, exists: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// 创建系统还原点（复用 tf_restore_point 的脚本）
handleSafe('optimizer:create-restore', async (event) => {
  const opt = OPTIMIZER.OPTIONS.find(o => o.id === 'tf_restore_point');
  const steps = opt && opt.steps ? opt.steps : [];
  if (!steps.length) return { success: false, message: '缺少还原点脚本' };
  const scriptPath = writeTempScript(OPTIMIZER.buildScript(steps));
  try {
    const { code } = await runPowerShellFile(scriptPath, { timeout: 120000 });
    return { success: code === 0, message: code === 0 ? '已创建系统还原点' : '系统还原点创建失败，请手动创建' };
  } catch (e) {
    writeLog('error', `创建还原点异常: ${e.message}`);
    return { success: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// 列出所有系统还原点 + 各卷系统保护状态（供"系统还原点管理"页面）。
// created 输出原始 DMTF 串由 Node 侧 parseDmtfDateTime 解析（PS7 不加载
// System.Management 程序集，见 optimizer:check-restore 处说明）。
handleSafe('optimizer:list-restore', async () => {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$out = @{}',
    '$rps = @(Get-ComputerRestorePoint)',
    '$out.restorePoints = @($rps | Sort-Object CreationTime -Descending | ForEach-Object {',
    '  [pscustomobject]@{',
    '    seq = $_.SequenceNumber;',
    '    desc = $_.Description;',
    '    created = $_.CreationTime;',
    '    type = $_.RestorePointType',
    '  }',
    '})',
    // 全局禁用标志（DisableSR=1 表示全局关闭系统保护）
    '$globalDisable = 0',
    '$srKey = Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore" -ErrorAction SilentlyContinue',
    'if ($srKey -and $null -ne $srKey.DisableSR) { $globalDisable = [int]$srKey.DisableSR }',
    '$out.globalDisabled = ($globalDisable -eq 1)',
    // 各卷保护状态：Win32_ShadowStorage 存在卷影存储即视为该卷保护开启（locale 无关）
    '$vols = @{}',
    'Get-CimInstance Win32_Volume -ErrorAction SilentlyContinue | ForEach-Object { $vols[$_.DeviceID] = $_.DriveLetter }',
    '$out.protection = @(Get-CimInstance Win32_ShadowStorage -ErrorAction SilentlyContinue | ForEach-Object {',
    '  $dev = $_.Volume.DeviceID',
    '  $dl = $vols[$dev]',
    '  if (-not $dl) { return }',
    '  [pscustomobject]@{ drive = $dl; allocated = [double]$_.AllocatedSpace }',
    '})',
    '$out | ConvertTo-Json -Depth 4 -Compress'
  ].join('\n');
  const scriptPath = writeTempScript(script);
  try {
    const { stdout } = await runPowerShellFile(scriptPath, { timeout: 30000 });
    let data = null;
    try { data = JSON.parse((stdout || '').trim()); } catch (e) { data = null; }
    if (!data) return { success: false, message: '无法解析还原点数据' };
    if (Array.isArray(data.restorePoints)) {
      for (const rp of data.restorePoints) {
        rp.created = parseDmtfDateTime(rp && rp.created) || '';
      }
    }
    return { success: true, data };
  } catch (e) {
    writeLog('error', `列出还原点异常: ${e.message}`);
    return { success: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// ==================== 启动项管理 IPC ====================
const STARTUP = require('./src/scripts-powershell/startup-scripts');

// 扫描启动项（注册表 Run/RunOnce、启动文件夹、登录/开机计划任务）
handleSafe('startup:scan', async (event) => {
  lastStartupSnapshot = new Map();
  const scriptPath = writeTempScript(STARTUP.scan());
  try {
    const { stdout } = await runPowerShellFile(scriptPath, { timeout: 45000 });
    let data = null;
    try { data = JSON.parse((stdout || '').trim()); } catch (e) { data = null; }
    if (!Array.isArray(data)) {
      writeLog('warn', '启动项扫描解析失败');
      return { success: false, message: '无法解析启动项数据' };
    }
    const normalized = data.map((item, index) => ({ ...item, id: String(item.id || item.regPath || item.filePath || item.taskName || index) }));
    lastStartupSnapshot = snapshotById(normalized);
    return { success: true, data: normalized };
  } catch (e) {
    writeLog('error', `启动项扫描异常: ${e.message}`);
    return { success: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// 启停启动项（enable=true 启用 / false 禁用；注册表与文件夹项可逆，计划任务 Disable/Enable）
handleSafe('startup:toggle', async (event, { items = [], enable = true } = {}) => {
  const safeItems = validateSnapshotItems(items, lastStartupSnapshot);
  if (!safeItems) return { success: false, message: '启动项不是最近一次扫描结果，已拒绝执行' };
  if (!Array.isArray(items) || !items.length) return { success: false, message: '缺少启动项' };
  const scriptPath = writeTempScript(STARTUP.toggle(safeItems, !!enable));
  try {
    writeLog('info', `启动项${enable ? '启用' : '禁用'} ${safeItems.length} 项`);
    const { stdout } = await runPowerShellFile(scriptPath, { timeout: 60000, diagOp: 'startup.toggle' });
    let data = null;
    try { data = JSON.parse((stdout || '').trim()); } catch (e) { data = null; }
    if (!data) return { success: false, message: '无法解析执行结果' };
    return { success: data.failed === 0, ...data };
  } catch (e) {
    writeLog('error', `启动项启停异常: ${e.message}`);
    return { success: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// 删除启动项（先备份到 %APPDATA%\Trim\startup-backup\deleted 再删除）
handleSafe('startup:delete', async (event, { items = [] } = {}) => {
  const safeItems = validateSnapshotItems(items, lastStartupSnapshot);
  if (!safeItems) return { success: false, message: '启动项不是最近一次扫描结果，已拒绝执行' };
  if (!Array.isArray(items) || !items.length) return { success: false, message: '缺少启动项' };
  const scriptPath = writeTempScript(STARTUP.remove(safeItems));
  try {
    writeLog('info', `启动项删除 ${safeItems.length} 项`);
    const { stdout } = await runPowerShellFile(scriptPath, { timeout: 60000, diagOp: 'startup.delete' });
    let data = null;
    try { data = JSON.parse((stdout || '').trim()); } catch (e) { data = null; }
    if (!data) return { success: false, message: '无法解析执行结果' };
    return { success: data.failed === 0, ...data };
  } catch (e) {
    writeLog('error', `启动项删除异常: ${e.message}`);
    return { success: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// 打开启动项所在位置（shell.showItemInFolder）
handleSafe('startup:openlocation', async (event, { path: targetPath = '' } = {}) => {
  if (!targetPath) return { success: false, message: '缺少路径' };
  try {
    shell.showItemInFolder(targetPath);
    return { success: true };
  } catch (e) {
    writeLog('error', `打开所在位置异常: ${e.message}`);
    return { success: false, message: e.message };
  }
});

// 添加启动项（文件选择对话框 → 写入当前用户 Run 键）
handleSafe('startup:add', async (event, _payload = {}) => {
  // B12：与同族 startup:toggle/delete 对齐，补齐渲染进程来源校验（高风险持久化写操作）
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: '选择要添加为开机启动的程序',
      properties: ['openFile'],
      filters: [
        { name: '程序文件', extensions: ['exe', 'lnk', 'bat', 'cmd', 'com'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
    const filePath = result.filePaths[0];
    const name = path.basename(filePath);
    const scriptPath = writeTempScript(STARTUP.add(filePath, name));
    try {
      const { stderr, code } = await runPowerShellFile(scriptPath, { timeout: 20000 });
      if (code !== 0) return { success: false, message: stderr || '写入注册表失败' };
      writeLog('info', `添加启动项: ${filePath}`);
      return { success: true, path: filePath, name };
    } finally {
      try { fs.unlinkSync(scriptPath); } catch (e) {}
    }
  } catch (e) {
    writeLog('error', `添加启动项异常: ${e.message}`);
    return { success: false, message: e.message };
  }
});

// ==================== 外观设置（背景图片导入 / 删除 / 列表 / 窗口材质） ====================
// appearance.json：窗口材质等外观配置持久化（沿用 APP_DATA_DIR，保证与既有数据同位置）
const APPEARANCE_FILE = path.join(APP_DATA_DIR, 'appearance.json');
// 审查 4-1：配置文件损坏时先隔离保留现场（重命名 .corrupt-<ts>），再降级返回空对象——
// 防止「下一次保存直接覆盖损坏文件」，事后可分析断电/磁盘错误根因
function quarantineFile(file, err) {
  try {
    if (!fs.existsSync(file)) return;
    const bak = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, bak);
    writeLog('error', `配置文件损坏已隔离: ${path.basename(file)} -> ${path.basename(bak)} (${err.message})`);
  } catch (_) {}
}
function loadAppearance() {
  try {
    const v = JSON.parse(fs.readFileSync(APPEARANCE_FILE, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    quarantineFile(APPEARANCE_FILE, e);
    return {};
  }
}
function saveAppearance(v) {
  try { SECURITY.atomicWriteJson(APPEARANCE_FILE, v); } catch (e) { writeLog('error', `保存外观配置失败: ${e.message}`); }
}

// 批次：雾化度语义反转 —— appearance.json 内旧 bgOpacity 存的是「图片不透明度」（100=纯图），
// 一次性换算为「雾化强度」语义（0=纯图，100=全雾），与渲染层 pathbinding 的 localStorage
// 迁移同款换算，保持两侧镜像一致；bgOpacityFog 标记防重复迁移
(function migrateBgOpacityFog() {
  const ap = loadAppearance();
  if (ap.bgOpacity == null || ap.bgOpacityFog === true) return;
  ap.bgOpacity = 100 - ap.bgOpacity;
  ap.bgOpacityFog = true;
  saveAppearance(ap);
  writeLog('info', 'appearance.json 雾化度语义已迁移（旧图片不透明度 → 雾化强度）');
})();

handleSafe('appearance:get-material', async () => {
  const ap = loadAppearance();
  return { material: ap.material || 'mica', materialEnabled: ap.materialEnabled !== false };
});

// 把原生材质应用到全部存活窗口；单窗失败不影响其余窗口与持久化
//（Win11 27H2 运行中重设可能不生效，重启后由构造参数保证最终一致）
function applyNativeMaterialAll(native) {
  if (native === 'none') return false;
  let nativeApplied = false;
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w.isDestroyed()) return;
    try {
      if (typeof w.setBackgroundMaterial === 'function') {
        w.setBackgroundMaterial(native);
        nativeApplied = true;
      }
    } catch (e) {
      // Win10/旧版 Electron 可能没有可用的 DWM backdrop；CSS 回退仍会生效。
      writeLog('warn', `原生窗口材质不可用（${w.getTitle()}），使用 CSS 回退: ${e.message}`);
    }
  });
  return nativeApplied;
}
// 广播「生效材质」字符串（总开关关闭时为 'none'），主窗 pathbinding 与子窗 window-material 统一跟随
function broadcastMaterialChanged(effective) {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w.isDestroyed()) return;
    try { w.webContents.send('appearance:material-changed', effective); } catch (e) {}
  });
}

handleSafe('appearance:set-material', async (event, { material } = {}) => {
  const allowed = ['mica', 'mica-alt', 'acrylic', 'thin-acrylic', 'none'];
  if (!allowed.includes(material)) return { success: false, message: '未知的材质' };
  try {
    const ap = loadAppearance();
    ap.material = material;
    saveAppearance(ap);
    // 总开关关闭时所选材质只做记忆，生效材质按「无材质」处理（窗口界面升级3）
    const enabled = ap.materialEnabled !== false;
    const effective = enabled ? material : 'none';
    const nativeApplied = applyNativeMaterialAll(nativeMaterialFor(effective));
    broadcastMaterialChanged(effective);
    writeLog('info', `窗口材质切换: ${material}（总开关${enabled ? '开' : '关'}，生效 ${effective}）`);
    return { success: true, nativeApplied };
  } catch (e) {
    writeLog('error', `窗口材质切换失败: ${e.message}`);
    return { success: false, message: e.message };
  }
});

// 材质总开关（窗口界面升级3）：关闭 = 生效材质置 none（各窗口即时不透明），所选材质保留记忆
handleSafe('appearance:set-material-enabled', async (event, { enabled } = {}) => {
  try {
    const on = !!enabled;
    const ap = loadAppearance();
    ap.materialEnabled = on;
    saveAppearance(ap);
    const effective = on ? (ap.material || 'mica') : 'none';
    const nativeApplied = applyNativeMaterialAll(nativeMaterialFor(effective));
    broadcastMaterialChanged(effective);
    writeLog('info', `窗口材质总开关: ${on ? '开启' : '关闭'}（生效材质 ${effective}）`);
    return { success: true, material: effective, materialEnabled: on, nativeApplied };
  } catch (e) {
    writeLog('error', `窗口材质总开关切换失败: ${e.message}`);
    return { success: false, message: e.message };
  }
});

// 导入的背景图统一复制到 userData/backgrounds 持久保存；删除按文件名移除。
handleSafe('appearance:bg-import', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { success: false, canceled: true };
    }
    const src = result.filePaths[0];
    const bgDir = path.join(app.getPath('userData'), 'backgrounds');
    if (!fs.existsSync(bgDir)) fs.mkdirSync(bgDir, { recursive: true });
    const ext = path.extname(src) || '.png';
    const dest = path.join(bgDir, `bg_${Date.now()}${ext}`);
    fs.copyFileSync(src, dest);
    writeLog('info', `导入背景图片: ${path.basename(dest)}`);
    return { success: true, data: { path: dest, name: path.basename(dest) } };
  } catch (e) {
    writeLog('error', `导入背景图片失败: ${e.message}`);
    return { success: false, message: e.message };
  }
});

handleSafe('appearance:bg-delete', async (event, { file } = {}) => {
  try {
    const bgDir = path.join(app.getPath('userData'), 'backgrounds');
    const target = path.resolve(String(file || ''));
    if (!isPathUnderRoot(target, bgDir) || path.dirname(target).toLowerCase() !== path.resolve(bgDir).toLowerCase()) return { success: false, message: '路径无效' };
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

handleSafe('appearance:bg-list', async () => {
  try {
    const bgDir = path.join(app.getPath('userData'), 'backgrounds');
    if (!fs.existsSync(bgDir)) return { success: true, data: [] };
    const files = fs.readdirSync(bgDir)
      .filter(f => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f))
      .map(f => ({ path: path.join(bgDir, f), name: f }))
      .sort((a, b) => b.name.localeCompare(a.name));
    return { success: true, data: files };
  } catch (e) {
    return { success: false, data: [], message: e.message };
  }
});

handleSafe('appearance:bg-open-dir', async () => {
  const bgDir = path.join(app.getPath('userData'), 'backgrounds');
  try {
    if (!fs.existsSync(bgDir)) fs.mkdirSync(bgDir, { recursive: true });
    shell.openPath(bgDir);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// ==================== AI 简介配置与获取 IPC ====================
// 隐私约束：上传数据仅包含菜单名称与厂商名称，严禁包含注册表路径等本机敏感信息
const crypto = require('crypto');
const url = require('url');
const SETTINGS_FILE = path.join(APP_DATA_DIR, 'settings.json');
const AI_CACHE_DIR = path.join(APP_DATA_DIR, 'cache');
const AI_CACHE_FILE = path.join(AI_CACHE_DIR, 'menuDescriptions.json');
const AI_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天
const AI_DEFAULT_ENDPOINTS = {
  // 百度千帆（智能搜索生成高性能版）：web_summary，instruction 必填，model 为枚举(thinking/auto_thinking/non_thinking)
  baidu_pro: 'https://qianfan.baidubce.com/v2/ai_search/web_summary',
  metaso: 'https://metaso.cn/api/v1/chat/completions',
  zhihu: 'https://developer.zhihu.com/v1/chat/completions'
};
const AI_DEFAULT_METASO_KEY = ''; // 秘塔密钥默认留空，用户自行填写并保存校验
const AI_DEFAULT_PROMPT = '请简要说明以下右键菜单项的功能，控制在100字以内，仅输出最终回答，不要思考过程、解释与额外话术。';
// 各引擎默认参数（百度千帆 / 秘塔 / 知乎直答）
const AI_DEFAULT_MODELS = {
  baidu_pro: { url: 'https://qianfan.baidubce.com/v2/ai_search/web_summary', key: '', model: 'thinking', timeout: 30 },
  metaso: { url: 'https://metaso.cn/api/v1/chat/completions', key: AI_DEFAULT_METASO_KEY, model: 'fast_thinking', timeout: 30 },
  zhihu: { url: 'https://developer.zhihu.com/v1/chat/completions', key: '', model: 'zhida-fast-1p5', timeout: 30 }
};
// 引擎降级顺序（旧版遗留字段的兼容顺序，仅用于读取历史配置）
const AI_ENGINE_ORDER = ['baidu', 'metaso', 'zhihu'];

// 旧版平铺字段解析（settings:load / settings:save 兼容历史配置时使用）
function metasoUrl(s) {
  return String(s.metasoApiUrl || (s.aiEngine === 'metaso' && s.aiApiUrl) || AI_DEFAULT_ENDPOINTS.metaso).trim();
}
function baiduUrl(s) {
  return String(s.baiduApiUrl || (s.aiEngine === 'baidu' && s.aiApiUrl) || AI_DEFAULT_ENDPOINTS.baidu_pro).trim();
}
function metasoKey(s) {
  return String(s.metasoApiKey || s.aiApiKey || AI_DEFAULT_METASO_KEY).trim();
}
function baiduKey(s) {
  return String(s.baiduApiKey || '').trim();
}

// ==================== 大模型管理（设置 → 大模型管理） ====================
// 各模型项各自独立保存「启用AI简介 / API 接口地址 / Access Key-API Key / 模型名称 / 超时时间」，
// 配置真源为 settings.json 的 models 字段（旧版平铺字段在读取时平滑迁移，不影响已有配置）。
const AI_MODEL_KEYS = ['baidu_pro', 'zhihu', 'metaso', 'custom'];
const AI_MODELS = {
  baidu_pro: {
    label: '百度千帆', kind: 'baidu_web_summary', builtin: true,
    apiUrl: 'https://qianfan.baidubce.com/v2/ai_search/web_summary',
    apiKey: '', model: 'thinking', prompt: '', timeout: 30, enabled: false, verified: false
  },
  zhihu: {
    label: '知乎直答', kind: 'openai', builtin: true,
    apiUrl: 'https://developer.zhihu.com/v1/chat/completions',
    apiKey: '', model: 'zhida-fast-1p5', prompt: '', timeout: 30, enabled: false, verified: false
  },
  metaso: {
    label: '秘塔 AI', kind: 'openai', builtin: true,
    apiUrl: 'https://metaso.cn/api/v1/chat/completions',
    apiKey: AI_DEFAULT_METASO_KEY, model: 'fast_thinking', prompt: '', timeout: 30, enabled: false, verified: false
  },
  custom: {
    // 自定义模型：仅支持 OpenAI 兼容的 chat/completions 协议
    label: '自定义模型', kind: 'openai', builtin: false,
    apiUrl: '', apiKey: '', model: '', prompt: '', timeout: 30,
    enabled: false, verified: false, customName: ''
  }
};

// 各模块的 AI 简介相互独立：各自记录所选模型与提示词，互不联动
const AI_SCOPES = ['optimizer', 'startup', 'contextmenu', 'memoryclean'];
const AI_SCOPE_META = {
  optimizer: {
    label: '电脑优化中心',
    prompt: '请用简体中文简要介绍下面这个 Windows 系统优化项的作用、适用场景与需要注意的风险，控制在120字以内，只输出最终结论，不要思考过程与额外话术。'
  },
  startup: {
    label: '启动项管理',
    prompt: '请用简体中文简要介绍下面这个 Windows 开机启动项所属软件的功能与厂商，并说明禁用它之后对日常使用有什么影响，控制在120字以内，只输出最终结论，不要思考过程与额外话术。'
  },
  contextmenu: {
    label: '右键管理',
    prompt: '请用简体中文简要介绍下面这个 Windows 右键菜单项的功能与所属公司，并说明是否建议保留，控制在120字以内，只输出最终结论，不要思考过程与额外话术。'
  },
  memoryclean: {
    label: '内存清理',
    prompt: '请用简体中文简要介绍下面这个 Windows 内存清理操作的作用、原理与需要注意的风险，控制在120字以内，只输出最终结论，不要思考过程与额外话术。'
  }
};
// 保存自定义模型（以及任一模型）时自动发送的连通性确认消息
const AI_VERIFY_PROMPT = 'api是什么，用三十个字简略回答';

// 读取模型配置（含旧版平铺字段的一次性迁移）
function loadModelsConfig() {
  const s = loadAiSettings();
  const models = {};
  for (const key of AI_MODEL_KEYS) {
    models[key] = { ...AI_MODELS[key], ...((s.models && s.models[key]) || {}) };
  }
  if (!s.models || typeof s.models !== 'object') {
    if (s.baiduApiUrl || s.baiduApiKey || s.baiduModel) {
      models.baidu_pro = { ...models.baidu_pro, apiUrl: s.baiduApiUrl || models.baidu_pro.apiUrl, apiKey: s.baiduApiKey || '', model: s.baiduModel || models.baidu_pro.model, prompt: s.baiduPrompt || '', timeout: clampTimeout(s.baiduTimeout, 30) };
    }
    if (s.metasoApiUrl || s.metasoApiKey || s.metasoModel) {
      models.metaso = { ...models.metaso, apiUrl: s.metasoApiUrl || models.metaso.apiUrl, apiKey: s.metasoApiKey || models.metaso.apiKey, model: s.metasoModel || models.metaso.model, prompt: s.metasoPrompt || '', timeout: clampTimeout(s.metasoTimeout, 30) };
    }
    if (s.zhihuApiUrl || s.zhihuApiKey || s.zhihuAccessSecret || s.zhihuModel) {
      models.zhihu = { ...models.zhihu, apiUrl: s.zhihuApiUrl || models.zhihu.apiUrl, apiKey: s.zhihuApiKey || s.zhihuAccessSecret || '', model: s.zhihuModel || models.zhihu.model, prompt: s.zhihuPrompt || '', timeout: clampTimeout(s.zhihuTimeout, 30) };
    }
  }
  return models;
}

// AI 简介全局模型（统筹全局）：「设置-功能入口-大模型管理」中设置的生效模型，
// 软件内所有模块（电脑优化中心 / 启动项管理 / 右键管理 / 内存清理）的 AI 简介统一使用。
const GLOBAL_ENGINE_KEY = 'global';
function loadScopeEngines() {
  const s = loadAiSettings();
  const scopes = {};
  for (const scope of AI_SCOPES) {
    const raw = (s.aiScopes && s.aiScopes[scope]) || '';
    scopes[scope] = AI_MODEL_KEYS.includes(raw) ? raw : 'metaso';
  }
  // 全局槽位：优先读取 global，其次回落到旧版 per-scope 配置（兼容升级）
  const rawGlobal = (s.aiScopes && s.aiScopes[GLOBAL_ENGINE_KEY]) || '';
  scopes[GLOBAL_ENGINE_KEY] = AI_MODEL_KEYS.includes(rawGlobal)
    ? rawGlobal
    : (AI_MODEL_KEYS.includes(s.aiScopes && s.aiScopes.optimizer) ? s.aiScopes.optimizer : 'metaso');
  return scopes;
}

// 模型展示名：自定义模型优先使用用户填写的展示名称，其次使用用户填写的模型名称
function modelDisplayName(key, cfg) {
  const conf = cfg || {};
  if (key === 'custom') {
    return String(conf.customName || conf.model || '').trim() || AI_MODELS.custom.label;
  }
  return (AI_MODELS[key] && AI_MODELS[key].label) || key;
}

// OpenAI 兼容地址归一：自定义模型仅支持 chat/completions 协议
function normalizeChatCompletionsUrl(raw) {
  const url = String(raw || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/v\d+$/i.test(url)) return url + '/chat/completions';
  return url + '/v1/chat/completions';
}

// 统一的模型调用入口：按模型种类分发（百度千帆高性能版走 AI 搜索摘要，其余走 OpenAI 兼容 chat/completions）
async function callModelDescription(key, cfg, name, company, scopePrompt) {
  const prompt = buildPrompt(String(cfg.prompt || '').trim() || scopePrompt, name, company);
  // 百度千帆·高性能版：web_summary，instruction 必填
  if (key === 'baidu_pro') {
    return callBaiduWebSummary({
      url: cfg.apiUrl, key: cfg.apiKey,
      instruction: prompt,
      query: `名称：${name}，所属：${company}`,
      timeoutMs: clampTimeout(cfg.timeout, 30) * 1000
    });
  }
  // 知乎直答：OpenAI 兼容 /v1/chat/completions，需要 X-Request-Timestamp 头
  const extraHeaders = key === 'zhihu'
    ? { 'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)) }
    : undefined;
  return callOpenAICompat({
    url: cfg.apiUrl, key: cfg.apiKey, model: cfg.model, prompt,
    timeoutMs: clampTimeout(cfg.timeout, 30) * 1000, extraHeaders
  });
}

// 超时时间约束在 5~120 秒
function clampTimeout(v, def = 30) {
  const n = Number(v);
  if (!isFinite(n) || n < 5) return Math.min(Math.max(def, 5), 120);
  if (n > 120) return 120;
  return Math.round(n);
}

// 组装 Prompt：模板含 {menu}/{company} 占位符则替换，否则追加菜单名与厂商名
function buildPrompt(template, name, company) {
  const p = String(template || AI_DEFAULT_PROMPT);
  if (p.includes('{menu}') || p.includes('{company}')) {
    return p.replace(/\{menu\}/g, name).replace(/\{company\}/g, company);
  }
  return `${p}\n菜单名称：${name}，所属软件：${company}`;
}

// 通用 OpenAI 兼容 chat/completions 请求（秘塔与知乎直答共用）
// extraHeaders：知乎直答要求携带 X-Request-Timestamp（秒级 Unix 时间戳）
async function callOpenAICompat({ url, key, model, prompt, timeoutMs, extraHeaders }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
    if (key) headers['Authorization'] = `Bearer ${key}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return content ? String(content).trim() : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 百度千帆·高性能版「智能搜索生成高性能版」接口（v2 ai_search/web_summary）
// 鉴权：Authorization: Bearer <API Key>（V2 应用密钥，格式 bce-v3/ALTAK-xxx）
// 请求体：messages(搜索查询) + instruction(人设指令，必填)，可选 model(thinking/auto_thinking/non_thinking)、resource_type_filter 等。
// 说明：后端无法保证返回结构始终为 OpenAI 兼容 format，因此做多路径回退解析。
async function callBaiduWebSummary({ url, key, model, instruction, query, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const target = String(url || '').trim() || AI_DEFAULT_MODELS.baidu_pro.url;
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = `Bearer ${key}`;
    const body = { messages: [{ role: 'user', content: query }], stream: false };
    if (instruction) body.instruction = instruction;
    if (model) body.model = String(model).trim();
    const resp = await fetch(target, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    if (!resp.ok) {
      writeLog('warn', `百度千帆高性能版返回 ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      return null;
    }
    const data = await resp.json();
    if (!data) return null;
    // 多路径解析：优先 OpenAI 兼容 choices；再尝试 result/answer/text；最后兜底
    if (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
      return String(data.choices[0].message.content).trim();
    }
    for (const keyName of ['result', 'answer', 'content', 'text', 'summary', 'reply', 'output']) {
      if (data[keyName] && typeof data[keyName] === 'string' && data[keyName].trim()) {
        return String(data[keyName]).trim();
      }
    }
    return null;
  } catch (e) {
    writeLog('error', `百度千帆高性能版调用异常: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function loadAiSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
       if (s && typeof s === 'object') return SECURITY.decryptSettings(s, safeStorage);
    }
  } catch (e) {}
  return {};
}

function saveAiSettings(settings) {
  try {
    SECURITY.atomicWriteJson(SETTINGS_FILE, SECURITY.encryptSettings(settings, safeStorage));
    return true;
  } catch (e) {
    writeLog('error', `保存设置失败: ${e.message}`);
    return false;
  }
}

function loadAiCache() {
  try {
    if (fs.existsSync(AI_CACHE_FILE)) {
      const c = JSON.parse(fs.readFileSync(AI_CACHE_FILE, 'utf8'));
      if (c && typeof c === 'object') return c;
    }
  } catch (e) {}
  return {};
}

function saveAiCache(cache) {
  try {
    if (!fs.existsSync(AI_CACHE_DIR)) fs.mkdirSync(AI_CACHE_DIR, { recursive: true });
    SECURITY.atomicWriteJson(AI_CACHE_FILE, cache);
  } catch (e) {
    writeLog('error', `写入简介缓存失败: ${e.message}`);
  }
}

function aiCacheKey(name, company, engine) {
  // 缓存按引擎区分独立缓存：cacheKey = MD5(菜单名称 + 厂商名称 + 引擎)
  return crypto.createHash('md5').update(`${String(name || '')}|${String(company || '')}|${String(engine || 'metaso')}`).digest('hex');
}

// ==================== 百度千帆日调用计数（超过限额自动降级秘塔） ====================
const BAIDU_USAGE_FILE = path.join(AI_CACHE_DIR, 'baiduDailyUsage.json');
const BAIDU_DAILY_LIMIT = 100;

function todayKey() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function loadBaiduUsage() {
  try {
    if (fs.existsSync(BAIDU_USAGE_FILE)) {
      const u = JSON.parse(fs.readFileSync(BAIDU_USAGE_FILE, 'utf8'));
      if (u && typeof u === 'object') return u;
    }
  } catch (e) {}
  return { date: todayKey(), count: 0 };
}

function saveBaiduUsage(u) {
  try {
    if (!fs.existsSync(AI_CACHE_DIR)) fs.mkdirSync(AI_CACHE_DIR, { recursive: true });
    SECURITY.atomicWriteJson(BAIDU_USAGE_FILE, u);
  } catch (e) {}
}

// 当日百度调用次数（跨日自动清零）
function getBaiduDailyCount() {
  const u = loadBaiduUsage();
  return u.date === todayKey() ? (Number(u.count) || 0) : 0;
}

function incrementBaiduDailyCount() {
  const u = loadBaiduUsage();
  if (u.date !== todayKey()) { u.date = todayKey(); u.count = 0; }
  u.count = (Number(u.count) || 0) + 1;
  saveBaiduUsage(u);
  return u.count;
}

// ==================== 统一弹窗通道 ====================
// 全部应用内弹窗（路径绑定 / 大模型管理 / 字体选择 / 模型选择 / AI简介等）
// 打开与关闭都经此 IPC 记录日志；弹窗 DOM 由渲染进程统一服务 modal.js 构建，
// 保证所有弹窗视觉风格一致（与「设置 → 安装路径绑定 → 去设置」弹窗相同）。
handleSafe('modal:open', (event, info = {}) => {
  const id = String(info.id || info.title || 'modal').slice(0, 40);
  writeLog('info', '打开弹窗: ' + id);
  return { success: true };
});
handleSafe('modal:close', (event, info = {}) => {
  const id = String(info.id || info.title || 'modal').slice(0, 40);
  writeLog('info', '关闭弹窗: ' + id);
  return { success: true };
});

handleSafe('settings:load', (event) => {
  // 审查 1-5：本通道返回模型配置（含密钥掩码），仍属敏感面，拒绝非信任来源
  const s = loadAiSettings();
  const engine = AI_ENGINE_ORDER.includes(s.aiEngine) ? s.aiEngine : AI_ENGINE_ORDER[0];
  const resp = {
    success: true,
    data: {
      aiDescEnabled: !!s.aiDescEnabled,
      aiEngine: engine,
      aiApiUrl: engine === 'baidu' ? baiduUrl(s) : metasoUrl(s),
      aiApiKey: s.aiApiKey ? API_KEY_MASK : '',
      baiduApiUrl: s.baiduApiUrl || '',
      metasoApiUrl: s.metasoApiUrl || '',
      // 百度千帆模型配置
      baiduApiKey: baiduKey(s) ? API_KEY_MASK : '',
      baiduModel: s.baiduModel || AI_DEFAULT_MODELS.baidu_pro.model,
      baiduPrompt: s.baiduPrompt || AI_DEFAULT_PROMPT,
      baiduTimeout: clampTimeout(s.baiduTimeout, 30),
      // 秘塔模型配置
      metasoApiKey: metasoKey(s) ? API_KEY_MASK : '',
      metasoModel: s.metasoModel || AI_DEFAULT_MODELS.metaso.model,
      metasoPrompt: s.metasoPrompt || AI_DEFAULT_PROMPT,
      metasoTimeout: clampTimeout(s.metasoTimeout, 30),
      // 知乎直答配置（兼容旧版遗留字段 zhihuAccessSecret）
      zhihuApiUrl: s.zhihuApiUrl || AI_DEFAULT_MODELS.zhihu.url,
      zhihuApiKey: String(s.zhihuApiKey || s.zhihuAccessSecret || '') ? API_KEY_MASK : '',
      zhihuModel: s.zhihuModel || AI_DEFAULT_MODELS.zhihu.model,
      zhihuPrompt: s.zhihuPrompt || AI_DEFAULT_PROMPT,
      zhihuTimeout: clampTimeout(s.zhihuTimeout, 30)
    }
  };
  // 大模型管理：四个模型项 + 三大模块各自选择的模型（新增配置，与旧字段并存）
  const models = loadModelsConfig();
  // 密钥掩码化（审查 1-5）：_keyPresent 供渲染层判断是否已配置，掩码值在 save/test 侧穿透还原
  for (const mk of Object.keys(models)) {
    models[mk] = { ...models[mk], apiKey: models[mk].apiKey ? API_KEY_MASK : '', _keyPresent: !!models[mk].apiKey };
  }
  resp.data.models = models;
  resp.data.aiScopes = loadScopeEngines();
  resp.data.modelList = AI_MODEL_KEYS.map((key, index) => ({
    key,
    label: AI_MODELS[key].label,
    displayName: modelDisplayName(key, models[key]),
    kind: AI_MODELS[key].kind,
    builtin: !!AI_MODELS[key].builtin,
    enabled: !!models[key].enabled,
    verified: !!models[key].verified,
    order: index
  }));
  // 出厂默认值（供「恢复默认」使用，不含密钥）
  resp.data.modelDefaults = AI_MODEL_KEYS.reduce((acc, key) => {
    acc[key] = {
      apiUrl: AI_MODELS[key].apiUrl,
      apiKey: '',
      model: AI_MODELS[key].model,
      prompt: AI_MODELS[key].prompt,
      timeout: AI_MODELS[key].timeout,
      enabled: false,
      customName: ''
    };
    return acc;
  }, {});
  return resp;
});

// 保存单个模型项的配置（设置 → 大模型管理）
handleSafe('models:save', async (event, { key, config, scope } = {}) => {
  if (!AI_MODEL_KEYS.includes(key)) return { success: false, message: '未知的模型项' };
  const cfg = config || {};
  const rawUrl = String(cfg.apiUrl || '').trim() || AI_MODELS[key].apiUrl;
  if (!/^https?:\/\//i.test(rawUrl)) {
    return { success: false, message: 'API 接口地址格式无效，请以 http(s):// 开头' };
  }
  const timeout = clampTimeout(cfg.timeout, 30);
  const current = loadAiSettings();
  const models = loadModelsConfig();
  // 百度千帆走专用 web_summary 接口（不归一化）；其余（知乎 / 秘塔 / 自定义模型）统一归一为 OpenAI 兼容的 chat/completions
  const apiUrl = key === 'baidu_pro' ? rawUrl : normalizeChatCompletionsUrl(rawUrl);
  if (isPrivateApiUrl(apiUrl)) return { success: false, message: 'API 接口地址不允许指向本机或内网网段' };
  models[key] = {
    ...models[key],
    apiUrl,
    // 掩码穿透（审查 1-5）：渲染层回传掩码 = 用户未修改密钥，保留已存真值；空串仍表示清除
    apiKey: (cfg.apiKey !== undefined && String(cfg.apiKey).trim() !== API_KEY_MASK) ? String(cfg.apiKey).trim() : models[key].apiKey,
    model: cfg.model !== undefined ? String(cfg.model).trim() : models[key].model,
    prompt: cfg.prompt !== undefined ? String(cfg.prompt).trim() : models[key].prompt,
    customName: cfg.customName !== undefined ? String(cfg.customName).trim() : (models[key].customName || ''),
    timeout,
    enabled: cfg.enabled !== undefined ? !!cfg.enabled : models[key].enabled
  };
  if (key === 'custom' && !models[key].model) {
    return { success: false, message: '自定义模型需要填写模型名称' };
  }
  // 密钥留空时（默认空态）：不允许启用该模型，跳过连通性校验（无凭据必然失败）
  // 用户只有在「设置 - 大模型管理」填入密钥并保存、校验通过后，该模型才被真正启用
  if (!String(models[key].apiKey || '').trim()) {
    models[key].verified = false;
    models[key].enabled = false;
    delete models[key].verifiedAt;
    const next = { ...current, models, aiScopes: loadScopeEngines() };
    if (AI_SCOPES.includes(scope)) next.aiScopes[scope] = key;
    const saved = saveAiSettings(next);
    writeLog('info', `保存模型配置[无密钥]: ${modelDisplayName(key, models[key])}，已保存但未启用（密钥为空）${AI_SCOPES.includes(scope) ? `，来源模块：${AI_SCOPE_META[scope].label}` : ''}`);
    return {
      success: saved,
      message: saved ? '' : '写入配置文件失败',
      data: { verified: false, reply: '', emptyKey: true }
    };
  }
  // 保存即校验：向该模型发送一条确认消息「api是什么，用三十个字简略回答」，
  // 只有模型返回内容才确认新增成功（自定义模型成功后才会进入三处模型选择列表）
  const verifyResp = await callModelText(key, models[key], AI_VERIFY_PROMPT);
  const ok = !!(verifyResp && String(verifyResp).trim());
  models[key].verified = ok;
  models[key].enabled = ok && models[key].enabled;
  if (ok) models[key].verifiedAt = new Date().toISOString();
  else delete models[key].verifiedAt;

  const next = { ...current, models, aiScopes: loadScopeEngines() };
  if (AI_SCOPES.includes(scope)) next.aiScopes[scope] = key;
  const saved = saveAiSettings(next);
  const scopeText = AI_SCOPES.includes(scope) ? `（来源模块：${AI_SCOPE_META[scope].label}）` : '';
  writeLog('info', `保存模型配置: ${modelDisplayName(key, models[key])}，连通性校验${ok ? '成功' : '失败'}${scopeText}`);
  return {
    success: saved,
    message: saved ? '' : '写入配置文件失败',
    data: { verified: ok, reply: ok ? String(verifyResp).trim().slice(0, 200) : '' }
  };
});

// 连通性确认消息：百度千帆·高性能版走 web_summary，其余走 OpenAI 兼容 chat/completions
async function callModelText(key, cfg, message) {
  if (key === 'baidu_pro') {
    return callBaiduWebSummary({
      url: cfg.apiUrl, key: cfg.apiKey, model: cfg.model,
      instruction: '请严格按用户要求回答，不要输出思考过程。',
      query: message,
      timeoutMs: clampTimeout(cfg.timeout, 30) * 1000
    });
  }
  const extraHeaders = key === 'zhihu'
    ? { 'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)) }
    : undefined;
  return callOpenAICompat({
    url: cfg.apiUrl, key: cfg.apiKey, model: cfg.model, prompt: message,
    timeoutMs: clampTimeout(cfg.timeout, 30) * 1000, extraHeaders
  });
}

// 设置 AI 简介模型（统筹全局：所有模块的 AI 简介统一使用该配置）
handleSafe('models:set-scope', (event, { key } = {}) => {
  if (!AI_MODEL_KEYS.includes(key)) return { success: false, message: '未知的模型项' };
  const selected = loadModelsConfig()[key];
  if (!selected || !selected.enabled || !selected.verified) return { success: false, message: '只能选择已验证且已启用的模型' };
  const current = loadAiSettings();
  const scopes = loadScopeEngines();
  scopes[GLOBAL_ENGINE_KEY] = key;
  const ok = saveAiSettings({ ...current, aiScopes: scopes });
  writeLog('info', `切换 AI 简介全局模型: ${modelDisplayName(key, loadModelsConfig()[key])}`);
  return { success: ok, message: ok ? '' : '写入配置文件失败' };
});

// 单独测试某个模型的连通性（不落盘）
handleSafe('models:test', async (event, { key, config } = {}) => {
  if (!AI_MODEL_KEYS.includes(key)) return { success: false, message: '未知的模型项' };
  const base = loadModelsConfig()[key];
  const cfg = {
    ...base,
    apiUrl: key === 'baidu_pro'
      ? String((config && config.apiUrl) || base.apiUrl).trim()
      : normalizeChatCompletionsUrl(String((config && config.apiUrl) || base.apiUrl).trim()),
    apiKey: (config && config.apiKey !== undefined && String(config.apiKey).trim() !== API_KEY_MASK) ? String(config.apiKey).trim() : base.apiKey,
    model: (config && config.model !== undefined) ? String(config.model).trim() : base.model,
    timeout: clampTimeout((config && config.timeout) !== undefined ? config.timeout : base.timeout, 30)
  };
  if (!/^https?:\/\//i.test(cfg.apiUrl)) return { success: false, message: 'API 接口地址格式无效，请以 http(s):// 开头' };
  if (isPrivateApiUrl(cfg.apiUrl)) return { success: false, message: 'API 接口地址不允许指向本机或内网网段' };
  const start = Date.now();
  const reply = await callModelText(key, cfg, AI_VERIFY_PROMPT);
  const latencyMs = Date.now() - start;
  if (reply && String(reply).trim()) {
    return { success: true, message: '连接成功', latencyMs, data: { reply: String(reply).trim().slice(0, 200) } };
  }
  return { success: false, message: '连接失败：未获得有效响应（请检查地址、密钥与模型名称）', latencyMs };
});

// 本地内置简介库（离线）：电脑优化中心 / 启动项管理 / 右键管理 各条目简介，
// 与联网 AI 简介严格区分——本地简介随应用分发，不联网、不上传任何本机信息。
const ITEM_INTRO_FILE = path.join(__dirname, 'src', 'data', 'item-intro.json');
handleSafe('intro:load', () => {
  try {
    const raw = fs.readFileSync(ITEM_INTRO_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { success: true, data };
  } catch (e) {
    writeLog('warn', `读取本地简介库失败: ${e.message}`);
    return { success: false, message: '本地简介库读取失败' };
  }
});

handleSafe('settings:save', (event, { settings } = {}) => {
  if (!settings || typeof settings !== 'object') return { success: false, message: '无效配置' };
  const current = loadAiSettings();
  const engine = AI_ENGINE_ORDER.includes(settings.aiEngine) ? settings.aiEngine : AI_ENGINE_ORDER[0];
  // 仅当字段显式提供时才覆盖，避免清空未提交的引擎配置
  const str = (k) => (settings[k] !== undefined && settings[k] !== null) ? String(settings[k]).trim() : undefined;
  // 掩码穿透（审查 1-5）：提交掩码视为未修改，返回 undefined 走「保留旧值」分支
  const strKept = (k) => {
    const v = str(k);
    return v === API_KEY_MASK ? undefined : v;
  };
  const next = {
    ...current,
    aiDescEnabled: !!settings.aiDescEnabled,
    aiEngine: engine,
    aiApiUrl: String(settings.aiApiUrl || '').trim() || (engine === 'baidu' ? baiduUrl(current) : metasoUrl(current)),
    aiApiKey: (String(settings.aiApiKey || '').trim() && String(settings.aiApiKey).trim() !== API_KEY_MASK) ? String(settings.aiApiKey).trim() : (current.aiApiKey || ''),
    baiduApiUrl: String(settings.baiduApiUrl || '').trim() || (engine === 'baidu' ? String(settings.aiApiUrl || '').trim() : current.baiduApiUrl) || '',
    metasoApiUrl: String(settings.metasoApiUrl || '').trim() || (engine === 'metaso' ? String(settings.aiApiUrl || '').trim() : current.metasoApiUrl) || '',
    // 百度千帆模型配置
    baiduApiKey: strKept('baiduApiKey') ?? (current.baiduApiKey || ''),
    baiduModel: str('baiduModel') ?? (current.baiduModel || ''),
    baiduPrompt: str('baiduPrompt') ?? (current.baiduPrompt || ''),
    baiduTimeout: settings.baiduTimeout !== undefined ? clampTimeout(settings.baiduTimeout, 30) : (current.baiduTimeout || 30),
    // 秘塔模型配置
    metasoApiKey: strKept('metasoApiKey') ?? (current.metasoApiKey || ''),
    metasoModel: str('metasoModel') ?? (current.metasoModel || ''),
    metasoPrompt: str('metasoPrompt') ?? (current.metasoPrompt || ''),
    metasoTimeout: settings.metasoTimeout !== undefined ? clampTimeout(settings.metasoTimeout, 30) : (current.metasoTimeout || 30),
    // 知乎直答配置
    zhihuApiUrl: str('zhihuApiUrl') ?? (current.zhihuApiUrl || ''),
    zhihuApiKey: strKept('zhihuApiKey') ?? (current.zhihuApiKey || current.zhihuAccessSecret || ''),
    zhihuModel: str('zhihuModel') ?? (current.zhihuModel || ''),
    zhihuPrompt: str('zhihuPrompt') ?? (current.zhihuPrompt || ''),
    zhihuTimeout: settings.zhihuTimeout !== undefined ? clampTimeout(settings.zhihuTimeout, 30) : (current.zhihuTimeout || 30)
  };
  // 大模型管理：只接受已知模型字段，并且不能通过通用设置通道绕过验证状态。
  if (settings.models && typeof settings.models === 'object') {
    const currentModels = loadModelsConfig();
    next.models = {};
    for (const modelKey of AI_MODEL_KEYS) {
      const submitted = settings.models[modelKey];
      const currentModel = currentModels[modelKey];
      if (!submitted || typeof submitted !== 'object') {
        next.models[modelKey] = currentModel;
        continue;
      }
      next.models[modelKey] = {
        ...currentModel,
        apiUrl: String(submitted.apiUrl || currentModel.apiUrl || '').trim(),
        apiKey: String(submitted.apiKey || currentModel.apiKey || '').trim(),
        model: String(submitted.model || currentModel.model || '').trim(),
        prompt: String(submitted.prompt || currentModel.prompt || '').trim(),
        customName: String(submitted.customName || currentModel.customName || '').trim(),
        timeout: clampTimeout(submitted.timeout, currentModel.timeout || 30),
        verified: !!currentModel.verified,
        enabled: !!submitted.enabled && !!currentModel.verified
      };
    }
  }
  if (settings.aiScopes && typeof settings.aiScopes === 'object') {
    const scopes = loadScopeEngines();
    for (const scope of AI_SCOPES.concat(GLOBAL_ENGINE_KEY)) {
      const candidate = settings.aiScopes[scope];
      if (AI_MODEL_KEYS.includes(candidate)) scopes[scope] = candidate;
    }
    next.aiScopes = scopes;
  }
  // 清理已下线的「本地模型」与旧版知乎遗留字段，避免配置文件残留失效引擎
  // （zhihuApiUrl 现为正式字段不再删除；zhihuAccessSecret 已迁移至 zhihuApiKey）
  ['localApiUrl', 'localApiKey', 'localModel', 'localPrompt', 'localTimeout'].forEach(k => delete next[k]);
  delete next.zhihuAccessSecret;
  const ok = saveAiSettings(next);
  writeLog('info', `保存 AI 简介设置: enabled=${next.aiDescEnabled}, engine=${next.aiEngine}`);
  return { success: ok, message: ok ? '' : '写入配置文件失败' };
});

// 获取条目简介（按模块隔离：电脑优化中心 / 启动项管理 / 右键管理 各自使用自己选择的模型）
// 隐私约束：联网仅上传条目名称与厂商（或分组）名称，不含注册表路径等本机敏感信息
handleSafe('aidesc:get', async (event, { name, company, force, scope } = {}) => {
  const menuName = String(name || '').trim();
  const vendor = String(company || '').trim();
  if (!menuName) return { success: false, message: '缺少名称' };

  // 模块隔离：未传 scope 时按右键管理处理，保证旧调用不报错
  const scopeKey = AI_SCOPES.includes(scope) ? scope : 'contextmenu';
  const scopeMeta = AI_SCOPE_META[scopeKey];
  const models = loadModelsConfig();
  // 统筹全局：所有模块统一使用「大模型管理」中设置的生效模型
  const engineKey = loadScopeEngines()[GLOBAL_ENGINE_KEY];
  const cfg = models[engineKey];
  const cache = loadAiCache();
  const cacheKey = aiCacheKey(menuName, vendor, `global:${engineKey}:${String((cfg && cfg.model) || '')}`);

  // 同一条目在不同模块下各自缓存，互不串用
  if (!force) {
    const hit = cache[cacheKey];
    if (hit && hit.desc && (Date.now() - Number(hit.timestamp || 0)) < AI_CACHE_TTL) {
      return { success: true, data: { desc: hit.desc, source: hit.source || modelDisplayName(engineKey, cfg), cached: true } };
    }
  }

  // 该模块所选模型未启用 → 提示前往「设置 - 大模型管理」开启，不静默切换到别的模型
  if (!cfg || !cfg.enabled) {
    return { success: false, message: 'disabled', data: { model: modelDisplayName(engineKey, cfg) } };
  }
  const isBaidu = engineKey === 'baidu_pro';
  if (!isBaidu && !String(cfg.apiUrl || '').trim()) {
    return { success: false, message: '该模型尚未填写 API 接口地址，请在「设置 - 大模型管理」中补全' };
  }

  // 百度千帆超当日限额时直接返回提示，不降级到其他模型（避免简介来源与选择不一致）
  if (isBaidu && getBaiduDailyCount() >= BAIDU_DAILY_LIMIT) {
    writeLog('warn', `百度千帆今日调用已达 ${BAIDU_DAILY_LIMIT} 次上限`);
    return { success: false, message: '百度千帆今日调用已达上限，请更换模型或明日再试' };
  }
  if (isBaidu) incrementBaiduDailyCount();

  const desc = await callModelDescription(engineKey, cfg, menuName, vendor, scopeMeta.prompt);
  if (!desc) {
    writeLog('warn', `AI 简介获取失败 [${scopeMeta.label}/${modelDisplayName(engineKey, cfg)}]: ${menuName}`);
    return { success: false, message: '该条目暂时无法获取简介，请检查模型配置或稍后重试' };
  }

  const source = modelDisplayName(engineKey, cfg);
  cache[cacheKey] = { desc, source, timestamp: Date.now() };
  saveAiCache(cache);
  writeLog('info', `AI 简介获取成功 [${scopeMeta.label}/${source}]: ${menuName}`);
  return { success: true, data: { desc, source, cached: false } };
});

// ==================== 优化项优缺点 AI 生成（优先知乎 → 百度 → 秘塔） ====================
const OPTIMIZER_ADVICE_SYSTEM = '你是专业的 Windows 系统优化助手。请用简洁客观的中文，针对给定优化项分别说明优点与缺点，语言精炼、不说空话和营销话术，不要输出思考过程，只输出最终结果。';
const OPTIMIZER_ADVICE_TEMPLATE = '优化项名称：{title}\n优化项说明：{desc}\n请分别给出该优化项的「优点」和「缺点」，各用一到三句话，并严格按下面两行格式输出：\n优点：...\n缺点：...';

function buildAdviceQuery(title, desc) {
  return OPTIMIZER_ADVICE_TEMPLATE.replace('{title}', title).replace('{desc}', desc);
}

function parseProsCons(text) {
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  const pros = (t.match(/优点[：:]\s*([\s\S]*?)(?=\n\s*缺点[：:]|$)/) || [])[1];
  const cons = (t.match(/缺点[：:]\s*([\s\S]*?)$/) || [])[1];
  const clean = (s) => String(s || '').replace(/^[\s\-—*·]+|[\s\-—*·]+$/g, '').trim();
  const p = clean(pros), c = clean(cons);
  if (!p && !c) return { pros: t, cons: '' };
  return { pros: p, cons: c };
}

// 优先使用「电脑优化中心」所选模型，失败再按已启用的其他模型依次尝试，返回 { pros, cons, source }
handleSafe('optimizer:genadvice', async (event, { optionId } = {}) => {
  const opt = OPTIMIZER.OPTIONS.find(o => o.id === optionId);
  if (!opt) return { success: false, message: '未知的优化选项' };
  const title = opt.title || optionId;
  const desc = opt.desc || '';
  const models = loadModelsConfig();
  const preferred = loadScopeEngines().optimizer;
  const order = [preferred, ...AI_MODEL_KEYS.filter(k => k !== preferred)]
    .filter(k => AI_MODEL_KEYS.includes(k))
    .filter((k, i, arr) => arr.indexOf(k) === i)
    .filter(k => models[k] && models[k].enabled);
  if (!order.length) {
    return { success: false, message: '当前没有已启用的模型，请在「设置 - 大模型管理」中启用并保存至少一个模型' };
  }
  let text = null; let usedEngine = '';
  for (const eng of order) {
    try {
      text = await callModelText(eng, models[eng], `${OPTIMIZER_ADVICE_SYSTEM}\n${buildAdviceQuery(title, desc)}`);
    } catch (e) { text = null; }
    if (text) { usedEngine = eng; break; }
  }
  if (!text) {
    writeLog('warn', `优化项优缺点生成失败: ${title}`);
    return { success: false, message: '所选模型未返回结果，请在「设置 - 大模型管理」中检查地址、密钥与模型名称（或确认网络）' };
  }
  const parsed = parseProsCons(text);
  const source = modelDisplayName(usedEngine, models[usedEngine]);
  writeLog('info', `优化项优缺点生成成功 (${source}): ${title}`);
  return { success: true, data: { pros: parsed.pros, cons: parsed.cons, raw: text, source } };
});

// ==================== 网速测试 IPC ====================
const NETSPEED_SCRIPT = require('./src/scripts-powershell/netspeed-scripts');
const DEVICE_INFO_SCRIPT = require('./src/scripts-powershell/device-info-scripts');
const DISKBENCH_SCRIPT = require('./src/scripts-powershell/diskbench-scripts');
const REALTIME_SCRIPT = require('./src/scripts-powershell/realtime-scripts');
const OVERVIEW_SCRIPT = require('./src/scripts-powershell/overview-scripts');

handleSafe('device:scan', async () => {
  const scriptPath = writeTempScript(DEVICE_INFO_SCRIPT.scan());
  try {
    const { stdout, stderr, code } = await runPowerShellFile(scriptPath, { timeout: 60000 });
    if (code !== 0) return { success: false, message: stderr || '设备信息扫描失败' };
    return { success: true, data: JSON.parse(stdout.trim()) };
  } catch (e) {
    return { success: false, message: e.message };
  } finally { try { fs.unlinkSync(scriptPath); } catch (e) {} }
});

// 系统信息缓存：首次扫描写入 %APPDATA%\Trim\system-info.json，此后优先读缓存，手动刷新才重新扫描
const SYSTEM_INFO_FILE = path.join(APP_DATA_DIR, 'system-info.json');

function loadSystemInfoCache() {
  try {
    if (fs.existsSync(SYSTEM_INFO_FILE)) {
      const data = JSON.parse(fs.readFileSync(SYSTEM_INFO_FILE, 'utf8'));
      if (data && data.timestamp && data.data) return data;
    }
  } catch (e) { writeLog('warn', `读取系统信息缓存失败: ${e.message}`); }
  return null;
}

function saveSystemInfoCache(data) {
  try {
    const dir = path.dirname(SYSTEM_INFO_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    SECURITY.atomicWriteJson(SYSTEM_INFO_FILE, { timestamp: Date.now(), data });
    return true;
  } catch (e) { writeLog('error', `保存系统信息缓存失败: ${e.message}`); return false; }
}

handleSafe('overview:hardware', async (event, { refresh = false } = {}) => {
  if (!refresh) {
    const cached = loadSystemInfoCache();
    if (cached) return { success: true, data: cached.data, cached: true, cachedAt: cached.timestamp };
  }
  const scriptPath = writeTempScript(DEVICE_INFO_SCRIPT.scan());
  try {
    const { stdout, stderr, code } = await runPowerShellFile(scriptPath, { timeout: 60000 });
    if (code !== 0) throw new Error(stderr || '设备信息扫描失败');
    const data = JSON.parse(stdout.trim());
    saveSystemInfoCache(data);
    return { success: true, data, cached: false };
  } catch (e) {
    const cached = loadSystemInfoCache();
    if (cached) return { success: true, data: cached.data, cached: true, cachedAt: cached.timestamp, degraded: true };
    return { success: false, message: e.message };
  } finally { try { fs.unlinkSync(scriptPath); } catch (e) {} }
});

// 系统指标采集：带结果缓存 + 在途去重。
// 作用：1) 轮询窗口内的重复请求直接命中缓存；2) 采集耗时超过轮询间隔时，
// 在途去重保证同一时刻最多只有一个 PowerShell 进程在跑（避免进程堆积推高内存）。
let overviewMetricsCache = null; // { at, data }
let overviewMetricsInflight = null; // Promise 去重句柄
async function collectOverviewMetrics() {
  if (overviewMetricsInflight) return overviewMetricsInflight;
  overviewMetricsInflight = (async () => {
    const scriptPath = writeTempScript(OVERVIEW_SCRIPT.metrics());
    try {
      const { stdout, stderr, code } = await runPowerShellFile(scriptPath, { timeout: 60000 });
      if (code !== 0) throw new Error(stderr || '系统指标采集失败');
      const data = JSON.parse(stdout.trim());
      overviewMetricsCache = { at: Date.now(), data };
      return { success: true, data };
    } catch (e) {
      return { success: false, message: e.message };
    } finally {
      try { fs.unlinkSync(scriptPath); } catch (e) {}
      overviewMetricsInflight = null;
    }
  })();
  return overviewMetricsInflight;
}

handleSafe('overview:metrics', async () => {
  if (overviewMetricsCache && Date.now() - overviewMetricsCache.at < 2500) {
    return { success: true, data: overviewMetricsCache.data, cached: true };
  }
  return collectOverviewMetrics();
});

// ==================== 系统体检（v2.6.0 P1-6，只读诊断） ====================
// 全部只读检测，不改任何系统设置；每条结论自带证据等级（本机实测/机制明确/未验证），
// 检测不出时如实标「未验证」，不伪造结论。结果缓存 5 分钟，避免频繁拉起 PowerShell。
let checkupCache = null; // { at, checks }
let checkupInflight = null;
async function collectSystemCheckup() {
  if (checkupInflight) return checkupInflight;
  checkupInflight = (async () => {
    const scriptPath = writeTempScript(OVERVIEW_SCRIPT.checkup());
    try {
      const { stdout, stderr, code } = await runPowerShellFile(scriptPath, { timeout: 90000 });
      if (code !== 0) throw new Error(stderr || '系统体检脚本执行失败');
      const parsed = JSON.parse(stdout.trim());
      const checks = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.checks) ? parsed.checks : []);
      checkupCache = { at: Date.now(), checks };
      return { success: true, data: { checks, at: checkupCache.at } };
    } catch (e) {
      return { success: false, message: e.message };
    } finally {
      try { fs.unlinkSync(scriptPath); } catch (e) {}
      checkupInflight = null;
    }
  })();
  return checkupInflight;
}

handleSafe('overview:checkup', async (event, { refresh = false } = {}) => {
  if (!refresh && checkupCache && Date.now() - checkupCache.at < 5 * 60 * 1000) {
    return { success: true, data: { checks: checkupCache.checks, at: checkupCache.at }, cached: true };
  }
  return collectSystemCheckup();
});

handleSafe('diskbench:run', async (event, options = {}) => {
  const requestedPath = String(options?.path || '').trim();
  if (!requestedPath || !fs.existsSync(requestedPath)) return { success: false, message: '测速路径不存在' };
  try {
    const stat = fs.lstatSync(requestedPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { success: false, message: '测速路径必须是普通目录' };
  } catch (_) {
    return { success: false, message: '测速路径不可访问' };
  }
  const safeOptions = {
    path: path.resolve(requestedPath),
    blockSize: [4096, 65536, 1048576].includes(Number(options?.blockSize)) ? Number(options.blockSize) : 1048576,
    queueDepth: 1,
    threads: 1,
    duration: [4, 8, 16].includes(Number(options?.duration)) ? Number(options.duration) : 8
  };
  const scriptPath = writeTempScript(DISKBENCH_SCRIPT.run(safeOptions));
  // 4 个测试阶段（seqwrite/seqread/randread/randwrite）各跑 duration 秒，另留启动与缓冲清理余量
  const benchTimeoutMs = Number(safeOptions.duration) * 1000 * 4 + 60000;
  const resultLines = [];
  let outputBuffer = '';
  try {
    const { stdout, stderr, code } = await runPowerShellFile(scriptPath, {
      timeout: benchTimeoutMs,
      onStdout: (chunk) => {
        // 进度行 __PROG__{json} 实时转发渲染进程；其余为最终 JSON 结果
        outputBuffer += chunk;
        let newline;
        while ((newline = outputBuffer.indexOf('\n')) >= 0) {
          const line = outputBuffer.slice(0, newline).replace(/\r$/, '');
          outputBuffer = outputBuffer.slice(newline + 1);
          const m = /^\s*__PROG__(.+)$/.exec(line);
          if (m) {
            try { if (!event.sender.isDestroyed()) event.sender.send('diskbench:progress', JSON.parse(m[1])); } catch (e) {}
          } else if (line.trim()) {
            resultLines.push(line);
          }
        }
      }
    });
    if (outputBuffer.trim()) resultLines.push(outputBuffer.trim());
    if (code !== 0) return { success: false, message: stderr || '磁盘测速失败' };
    const text = (resultLines.join('\n') || stdout).trim();
    let data;
    try { data = JSON.parse(text); } catch (err) {
      const last = text.split(/\r?\n/).filter(l => l.trim()).pop();
      data = JSON.parse(last);
    }
    return { success: data.measured === true, data };
  } catch (e) {
    return { success: false, message: e.message };
  } finally { try { fs.unlinkSync(scriptPath); } catch (e) {} }
});

// ==================== 磁盘测速历史记录 IPC ====================
const BENCH_HISTORY_FILE = path.join(APP_DATA_DIR, 'bench-history.json');
const MAX_HISTORY = 50;

function loadBenchHistory() {
  try {
    if (fs.existsSync(BENCH_HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(BENCH_HISTORY_FILE, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    writeLog('error', `读取测速历史失败: ${e.message}`);
  }
  return [];
}

function saveBenchHistory(records) {
  try {
    const dir = path.dirname(BENCH_HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    SECURITY.atomicWriteJson(BENCH_HISTORY_FILE, records.slice(0, MAX_HISTORY));
    return true;
  } catch (e) {
    writeLog('error', `保存测速历史失败: ${e.message}`);
    return false;
  }
}

handleSafe('bench-history:add', (event, { record }) => {
  try {
    const records = loadBenchHistory();
    records.unshift({
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      timestamp: new Date().toISOString(),
      ...record
    });
    saveBenchHistory(records);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

handleSafe('bench-history:list', () => {
  return { success: true, data: loadBenchHistory() };
});

handleSafe('bench-history:delete', (event, { id }) => {
  try {
    const records = loadBenchHistory().filter(r => r.id !== id);
    saveBenchHistory(records);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

handleSafe('bench-history:clear', () => {
  try {
    saveBenchHistory([]);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// ==================== UAC 权限提升 IPC ====================
// 应用以普通权限启动（asInvoker），需要管理员权限时通过 UAC 重新拉起
handleSafe('elevate:status', async () => {
  return { isAdmin: await isAdmin() };
});

// B5：提权成功 ≠ 新实例启动成功（新实例可能因崩溃等原因立刻退出）。
// 旧实例等待新实例发出的 second-instance 信号确认其存活后再退出释放锁；
// 超时则保持当前实例存活并通知渲染层提示用户。
const ELEVATE_HANDSHAKE_TIMEOUT = 20000;
let elevateHandshakeArmed = false;
function armElevateHandshake() {
  if (elevateHandshakeArmed) return;
  elevateHandshakeArmed = true;
  writeLog('info', '等待提权后的新实例就绪');
  const startedAt = Date.now();
  const onSecondInstance = (event, argv = []) => {
    // 只认带提权标志的信号：等待期间用户手动再次启动应用（无标志）不应触发退出
    if (!argv.includes(ELEVATED_RELAUNCH_FLAG)) return;
    elevateHandshakeArmed = false;
    app.removeListener('second-instance', onSecondInstance);
    writeLog('info', '检测到提权后的新实例已启动，退出当前实例');
    app.quit();
  };
  app.on('second-instance', onSecondInstance);
  const check = setInterval(() => {
    if (!elevateHandshakeArmed) { clearInterval(check); return; }
    if (Date.now() - startedAt > ELEVATE_HANDSHAKE_TIMEOUT) {
      clearInterval(check);
      app.removeListener('second-instance', onSecondInstance);
      elevateHandshakeArmed = false;
      writeLog('warn', '未检测到提权后的新实例启动，保持当前实例运行');
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('elevate:notice', { message: '未检测到新实例启动，已保持当前运行状态' });
        }
      } catch (e) {}
    }
  }, 500);
}

handleSafe('elevate:request', (event) => {
  // 审查 1-3：UAC 提权是最高价值 IPC 目标，必须校验请求来源
  return new Promise((resolve) => {
    writeLog('info', '请求管理员权限提升 (UAC)');
    const exe = process.execPath;
    const args = isDev ? [path.join(__dirname)] : [];
    args.push(ELEVATED_RELAUNCH_FLAG);
    const escapedExe = exe.replace(/'/g, "''");
    const argsPart = args.map(a => `'${a.replace(/'/g, "''")}'`).join(' ');
    // 通过 PowerShell Start-Process -Verb RunAs 弹出 UAC
    const script = `try { Start-Process -FilePath '${escapedExe}' -Verb RunAs ${argsPart} -ErrorAction Stop; exit 0 } catch { exit 1 }`;
    // B4：15s 超时兜底，pwsh 卡死时不再永久挂起
    runPowerShell(script, { timeout: 15000 }).then(result => {
      if (result.timedOut) {
        writeLog('error', 'UAC 提权请求超时');
        resolve({ success: false, message: '提权请求超时，请重试' });
        return;
      }
      if (result.code === 0) {
        writeLog('info', 'UAC 提权成功，等待新实例就绪后退出当前实例');
        resolve({ success: true, relaunching: true });
        armElevateHandshake();
      } else {
        writeLog('warn', 'UAC 提权被用户取消');
        resolve({ success: false, message: '提权请求被取消或失败' });
      }
    }).catch(err => {
      resolve({ success: false, message: err.message });
    });
  });
});

// ==================== 关闭流程（v2.7.0：关闭即隐，后台静默收尾） ====================
// 点击关闭按钮：主窗口立即从屏幕消失（无 Toast、无确认、无等待动画）；随后主进程在
// 后台静默完成收尾——等删除类任务落定（清理结果不可回滚，半途强退会丢统计）、
// 断开子进程（pwsh / finder 等全部网络与 IO）、清理临时脚本、刷盘日志与窗口状态——
// 然后自动退出。用户视角 = 「点了 X 就关了」；工程视角 = 收尾一个不少，只是不可见。
// 旧「感谢使用」渲染层 Toast 流程已移除（app.js 不再监听 app:shutdown，通道保留作扩展点）。
let isShuttingDown = false;
// 进行中的删除类任务计数（cleanup:execute 单次最长 10 分钟）
let activeCleanupRuns = 0;

function requestSilentQuit() {
  const tryQuit = () => {
    if (activeCleanupRuns > 0 || maintenanceRunning) {
      // 后台静默等待删除类任务完成（窗口已隐藏，用户无感），不丢结果统计
      setTimeout(tryQuit, 500);
      return;
    }
    app.quit(); // before-quit：flushLogSync + saveWindowState + taskkill 全部子进程 + 清理临时脚本
    // 兜底：quit 被意外阻塞（如 taskkill 卡死）时强制退出，不留僵尸进程
    setTimeout(() => { try { flushLogSync(); } catch (_) {} app.exit(0); }, 5000);
  };
  tryQuit();
}

function registerShutdownHook() {
  mainWindow.on('close', (e) => {
    if (isShuttingDown) return; // app.quit() 触发的二次 close 直接放行
    isShuttingDown = true;
    e.preventDefault();
    try { mainWindow.hide(); } catch (err) {} // 窗口立即消失 = 用户感知的「已关闭」
    writeLog('info', '收到关闭请求：窗口已隐藏，后台静默收尾后自动退出');
    requestSilentQuit();
  });
}

// 兼容入口：渲染层 shutdown:complete / 预留扩展点仍走这里（渲染层 v2.7.0 起不再主动触发）
function performFinalClose() {
  try { mainWindow?.hide(); } catch (e) {}
  requestSilentQuit();
}

onSafe('shutdown:begin', () => {
  // 预留：尚未接线。渲染层当前不再参与关闭编排，此通道保留作扩展点，勿当冗余删除。
});

onSafe('shutdown:complete', () => {
  performFinalClose();
});

handleSafe('netspeed:ping', async () => {
  const script = NETSPEED_SCRIPT.ping();
  const scriptPath = writeTempScript(script);
  try {
    const { stdout, code, timedOut } = await runPowerShellFile(scriptPath, { timeout: 8000 });
    if (code === 0) {
      try { return { success: true, data: JSON.parse(stdout.trim()) }; } catch (e) {}
    }
    return { success: false, message: timedOut ? 'Ping 测试超时，请重试' : 'Ping 测试失败' };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

handleSafe('netspeed:throughput', async (event, { duration }) => {
  const requestedDuration = Math.max(1, Math.min(60, Number(duration) || 10));
  const script = NETSPEED_SCRIPT.throughput(requestedDuration);
  const scriptPath = writeTempScript(script);
  try {
    const { stdout, code, timedOut, stderr } = await runPowerShellFile(scriptPath, { timeout: requestedDuration * 1000 + 15000 });
    if (code === 0) {
      try { return { success: true, data: JSON.parse(stdout.trim()) }; } catch (e) {}
    }
    return { success: false, message: timedOut ? '测速超时，请重试' : (stderr || '测速失败') };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// ==================== 实时网速监控 IPC ====================
// 枚举本机物理网卡
handleSafe('realtime:adapters', async () => {
  const scriptPath = writeTempScript(REALTIME_SCRIPT.adapters());
  try {
    const { stdout, code, timedOut, stderr } = await runPowerShellFile(scriptPath, { timeout: 10000 });
    if (timedOut) return { success: false, message: '网卡枚举超时，请重试' };
    if (code !== 0) return { success: false, message: stderr || '网卡枚举失败' };
    try {
      return JSON.parse(stdout.trim());
    } catch (e) {
      return { success: false, message: '解析网卡列表失败' };
    }
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// ==================== 实时网速：常驻流式采样器 ====================
// 旧实现每 1.5s 拉起一个 pwsh 进程（冷启动 ~1.2s + 内部 900ms 采样窗），
// 采样耗时大于轮询间隔导致进程相互重叠：图表数据断续、CPU/内存占用高。
// 新实现：单个常驻 pwsh 进程每秒输出一行 JSON，主进程解析缓存，
// IPC 直接返回缓存值（毫秒级），渲染层图表数据平滑连续。
const rtSampler = {
  child: null,
  buf: '',
  latest: null,      // { t, adapters: [{ name, up, down }] }
  lastRequestAt: 0,
  idleTimer: null
};

const REALTIME_STREAM_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$first = @{}
while ($true) {
  $cur = @{}
  try {
    Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface -ErrorAction Stop |
      Where-Object { $_.Name -notlike '*_Total*' } |
      ForEach-Object { $cur[[string]$_.Name] = @{ rx = [double]$_.BytesReceivedPersec; tx = [double]$_.BytesSentPersec } }
  } catch {}
  if ($first.Count -gt 0 -and $cur.Count -gt 0) {
    $adapters = @()
    foreach ($k in $cur.Keys) {
      if (-not $first.ContainsKey($k)) { continue }
      $rx = [Math]::Max(0, $cur[$k].rx - $first[$k].rx)
      $tx = [Math]::Max(0, $cur[$k].tx - $first[$k].tx)
      $adapters += @{ name = [string]$k; up = [Math]::Round($tx, 0); down = [Math]::Round($rx, 0) }
    }
    @{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); adapters = $adapters } | ConvertTo-Json -Compress -Depth 4 | Write-Output
  }
  $first = $cur
  Start-Sleep -Milliseconds 1000
}
`;

function stopRealtimeSampler() {
  if (rtSampler.idleTimer) { clearInterval(rtSampler.idleTimer); rtSampler.idleTimer = null; }
  if (rtSampler.child) {
    try { rtSampler.child.kill(); } catch (e) {}
    rtSampler.child = null;
  }
  rtSampler.buf = '';
  rtSampler.latest = null;
}

function ensureRealtimeSampler() {
  rtSampler.lastRequestAt = Date.now();
  if (rtSampler.child) return;
  let executable;
  try {
    executable = resolvePowerShell7Path();
  } catch (err) {
    writeLog('error', err.message);
    return;
  }
  const child = spawn(executable, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', REALTIME_STREAM_SCRIPT
  ], { windowsHide: true });
  rtSampler.child = child;
  rtSampler.buf = '';
  registerBackendChild(child, executable, ['-Command', 'realtime-stream']);
  child.stdout.on('data', d => {
    rtSampler.buf += d.toString('utf8');
    let idx;
    while ((idx = rtSampler.buf.indexOf('\n')) !== -1) {
      const line = rtSampler.buf.slice(0, idx).trim();
      rtSampler.buf = rtSampler.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && Array.isArray(obj.adapters)) {
          rtSampler.latest = { t: obj.t || Date.now(), adapters: obj.adapters };
        }
      } catch (e) { /* 非完整 JSON 行，忽略 */ }
    }
  });
  child.on('close', () => {
    if (rtSampler.child === child) {
      rtSampler.child = null;
      rtSampler.latest = null;
    }
  });
  child.on('error', err => {
    writeLog('error', `实时网速采样进程启动失败: ${err.message}`);
    if (rtSampler.child === child) rtSampler.child = null;
  });
  // 空闲自动回收：连续 30s 无采样请求则结束常驻进程（离开测速页后不占资源）
  if (rtSampler.idleTimer) clearInterval(rtSampler.idleTimer);
  rtSampler.idleTimer = setInterval(() => {
    if (Date.now() - rtSampler.lastRequestAt > 30000) stopRealtimeSampler();
  }, 10000);
  writeLog('info', '实时网速流式采样器启动');
}

// 单次流量采样（各活动网卡上下行速率 B/s）—— 返回流式采样器缓存
handleSafe('realtime:sample', async () => {
  ensureRealtimeSampler();
  if (rtSampler.latest) {
    return { success: true, adapters: rtSampler.latest.adapters, t: rtSampler.latest.t };
  }
  // 首个基线窗口（约 1s）内暂无差值数据：返回空列表而非失败，渲染层继续等待
  if (rtSampler.child) return { success: true, adapters: [] };
  return { success: false, message: '流量采样进程未就绪' };
});

// 丢包检测（ping 默认网关）
handleSafe('realtime:loss', async () => {
  const scriptPath = writeTempScript(REALTIME_SCRIPT.loss());
  try {
    const { stdout, code, timedOut } = await runPowerShellFile(scriptPath, { timeout: 10000 });
    if (timedOut) return { success: false, message: '丢包检测超时' };
    if (code !== 0) return { success: false, message: '丢包检测失败' };
    try {
      return JSON.parse(stdout.trim());
    } catch (e) {
      return { success: false, message: '解析丢包结果失败' };
    }
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// ==================== 实时网速：记录报告 IPC ====================
// 报告 JSON 存入 %APPDATA%\Trim\cache\realtime-reports\，超过 7 天自动清理
const REALTIME_REPORT_DIR = path.join(APP_DATA_DIR, 'cache', 'realtime-reports');
const REALTIME_REPORT_TTL = 7 * 24 * 60 * 60 * 1000;

function ensureRealtimeReportDir() {
  if (!fs.existsSync(REALTIME_REPORT_DIR)) fs.mkdirSync(REALTIME_REPORT_DIR, { recursive: true });
  return REALTIME_REPORT_DIR;
}

// 清理超过 7 天的旧报告（保存/列出时都会调用）
function cleanupRealtimeReports() {
  try {
    ensureRealtimeReportDir();
    const now = Date.now();
    for (const f of fs.readdirSync(REALTIME_REPORT_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        if (now - fs.statSync(path.join(REALTIME_REPORT_DIR, f)).mtimeMs > REALTIME_REPORT_TTL) {
          fs.unlinkSync(path.join(REALTIME_REPORT_DIR, f));
        }
      } catch (e) {}
    }
  } catch (e) { writeLog('warn', `清理旧网速报告失败: ${e.message}`); }
}

function readRealtimeReports() {
  cleanupRealtimeReports();
  const out = [];
  try {
    for (const f of fs.readdirSync(REALTIME_REPORT_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(REALTIME_REPORT_DIR, f), 'utf8'));
        out.push({
          name: f, createdAt: d.createdAt, durationSec: d.durationSec,
          maxDown: d.maxDown, maxUp: d.maxUp, minDown: d.minDown, minUp: d.minUp,
          avgDown: d.avgDown, avgUp: d.avgUp, samples: d.samples || [], adapter: d.adapter || ''
        });
      } catch (e) {}
    }
  } catch (e) {}
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

handleSafe('realtime:report-save', (event, { data } = {}) => {
  try {
    ensureRealtimeReportDir();
    cleanupRealtimeReports();
    const name = `realtime-${Date.now()}.json`;
    SECURITY.atomicWriteJson(path.join(REALTIME_REPORT_DIR, name), data || {});
    return { success: true, name };
  } catch (e) {
    writeLog('error', `保存网速报告失败: ${e.message}`);
    return { success: false, message: e.message };
  }
});

handleSafe('realtime:report-list', () => ({ success: true, reports: readRealtimeReports() }));

handleSafe('realtime:report-delete', (event, { name } = {}) => {
  try {
    const fp = path.join(REALTIME_REPORT_DIR, path.basename(String(name || '')));
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return { success: true };
  } catch (e) { return { success: false, message: e.message }; }
});

handleSafe('realtime:report-clear', () => {
  try {
    ensureRealtimeReportDir();
    for (const f of fs.readdirSync(REALTIME_REPORT_DIR)) {
      if (f.endsWith('.json')) { try { fs.unlinkSync(path.join(REALTIME_REPORT_DIR, f)); } catch (e) {} }
    }
    return { success: true };
  } catch (e) { return { success: false, message: e.message }; }
});

// ==================== 内存清理 IPC ====================
// 参考 Mem Reduct：NtSetSystemInformation 按区域清理工作集 / 系统文件缓存 /
// 备用列表 / 修改列表 / 注册表缓存 / 合并物理内存页。需管理员权限。
const MEMORY_SCRIPT = require('./src/scripts-powershell/memory-scripts');

handleSafe('memory:info', async () => {
  const scriptPath = writeTempScript(MEMORY_SCRIPT.MEM_INFO_SCRIPT);
  try {
    const { stdout, code, timedOut } = await runPowerShellFile(scriptPath, { timeout: 15000 });
    if (timedOut) return { success: false, message: '读取内存信息超时' };
    if (code !== 0) return { success: false, message: '读取内存信息失败' };
    try {
      const data = JSON.parse(stdout.trim());
      return { success: true, data };
    } catch (e) {
      return { success: false, message: '解析内存信息失败' };
    }
  } catch (e) {
    return { success: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

handleSafe('memory:clean', async (event, { items = [] } = {}) => {
  const list = Array.isArray(items) ? items.filter(i => typeof i === 'string') : [];
  if (!list.length) return { success: false, message: '未选择要清理的内存区域' };
  const scriptPath = writeTempScript(MEMORY_SCRIPT.cleanScript(list));
  try {
    const { stdout, code, timedOut } = await runPowerShellFile(scriptPath, { timeout: 60000 });
    if (timedOut) return { success: false, message: '内存清理超时（部分操作可能未完成）' };
    if (code !== 0) return { success: false, message: '内存清理执行失败' };
    try {
      const data = JSON.parse(stdout.trim());
      const failed = Array.isArray(data?.results) ? data.results.filter(item => item && item.ok === false).length : 0;
      return { success: failed === 0 && Array.isArray(data?.results), data };
    } catch (e) {
      return { success: false, message: '解析清理结果失败' };
    }
  } catch (e) {
    return { success: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

handleSafe('memory:processes', async () => {
  const scriptPath = writeTempScript(MEMORY_SCRIPT.PROCESSES_SCRIPT);
  try {
    const { stdout, code, timedOut } = await runPowerShellFile(scriptPath, { timeout: 20000 });
    if (timedOut) return { success: false, message: '读取进程列表超时' };
    if (code !== 0) return { success: false, message: '读取进程列表失败' };
    try {
      const data = JSON.parse(stdout.trim());
      const processes = Array.isArray(data) ? data : (data ? [data] : []);
      lastProcessSnapshot = new Map(processes
        .filter(p => Number.isInteger(Number(p.Id)) && Number(p.Id) > 0)
        .map(p => [Number(p.Id), { Id: Number(p.Id), ProcessName: String(p.ProcessName || ''), Path: String(p.Path || '') }]));
      return { success: true, processes };
    } catch (e) {
      return { success: false, message: '解析进程列表失败' };
    }
  } catch (e) {
    return { success: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

handleSafe('memory:kill', async (event, { pid } = {}) => {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { success: false, message: '无效的进程 ID' };
  const known = lastProcessSnapshot.get(n);
  if (!known) return { success: false, message: '进程不是最近一次扫描结果，已拒绝结束' };
  const scriptPath = writeTempScript(MEMORY_SCRIPT.killScript(n, known.ProcessName));
  try {
    const { stdout, code, timedOut } = await runPowerShellFile(scriptPath, { timeout: 15000 });
    if (timedOut) return { success: false, message: '结束进程超时' };
    if (code !== 0) return { success: false, message: '结束进程失败' };
    try {
      return JSON.parse(stdout.trim());
    } catch (e) {
      return { success: false, message: '解析结果失败' };
    }
  } catch (e) {
    return { success: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// 顽固软件专杀：一次性结束 MuMu/UU远程/抖音/剪映/WPS/微软电脑管家 的后台常驻与守护进程
handleSafe('memory:stubborn-kill', async (event) => {
  const scriptPath = writeTempScript(MEMORY_SCRIPT.STUBBORN_KILL_SCRIPT);
  try {
    const { stdout, code, timedOut } = await runPowerShellFile(scriptPath, { timeout: 30000 });
    if (timedOut) return { success: false, message: '顽固软件专杀超时' };
    if (code !== 0) return { success: false, message: '顽固软件专杀执行失败' };
    try {
      return { success: true, data: JSON.parse(stdout.trim()) };
    } catch (e) {
      return { success: false, message: '解析专杀结果失败' };
    }
  } catch (e) {
    return { success: false, message: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// ==================== 安装路径绑定 IPC ====================
const PATHSCAN_SCRIPT = require('./src/scripts-powershell/pathscan-scripts');
const PATHS_CONFIG_FILE = path.join(APP_DATA_DIR, 'paths.json');

function loadPathsConfig() {
  try {
    if (fs.existsSync(PATHS_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(PATHS_CONFIG_FILE, 'utf8'));
      // 剥离历史版本遗留的软件清单（不再展示与维护）
      if (cfg && typeof cfg === 'object') delete cfg.softwareInventory;
      return cfg || {};
    }
  } catch (e) {
    writeLog('error', `读取路径配置失败: ${e.message}`);
  }
  return {};
}

function savePathsConfig(config) {
  try {
    const dir = path.dirname(PATHS_CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    SECURITY.atomicWriteJson(PATHS_CONFIG_FILE, config);
    writeLog('info', '路径配置已保存');
    return true;
  } catch (e) {
    writeLog('error', `保存路径配置失败: ${e.message}`);
    return false;
  }
}

// 自动扫描安装路径
handleSafe('paths:scan', async () => {
  // 任务3：注入当前生效规则库（数据目录覆盖/自定义合并后）——规则库在线更新后，
  // 路径绑定扫描的应用候选目录自动同步；规则不可用时 pathscan 走内置兜底。
  const scriptPath = writeTempScript(PATHSCAN_SCRIPT.scan(JSON.stringify(CLEANUP_SCRIPT.rules())));
  try {
    writeLog('info', '开始扫描安装路径');
    const { stdout, stderr, code } = await runPowerShellFile(scriptPath, { timeout: 120000 });
    if (code !== 0) {
      writeLog('error', `路径扫描失败: ${stderr}`);
      return { success: false, message: stderr || '扫描失败', data: {} };
    }
    try {
      const data = JSON.parse(stdout.trim());
      // 标准化：去除首尾空白与包裹引号（注册表 InstallLocation 常带引号）
      for (const k of Object.keys(data)) {
        if (typeof data[k] === 'string') {
          data[k] = data[k].trim().replace(/^"+|"+$/g, '').trim();
        }
      }
      // 软件清单不落盘：仅扫描进程内部用于路径匹配，UI 已不再展示
      delete data.softwareInventory;
      // 自动扫描结果立即落盘；设置页只展示其中的常用路径。
      const persisted = loadPathsConfig();
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string' && value) persisted[key] = value;
        if (Array.isArray(value)) persisted[key] = value;
      }
      persisted.lastScanAt = data.scannedAt || new Date().toISOString();
      savePathsConfig(persisted);
      writeLog('info', '路径扫描完成');
      return { success: true, data };
    } catch (e) {
      return { success: false, message: '解析结果失败', raw: stdout };
    }
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// 读取已保存的路径配置
handleSafe('paths:load', () => {
  return { success: true, data: loadPathsConfig() };
});

// 保存单个路径
handleSafe('paths:save', (event, { key, value }) => {
  const allowedKeys = new Set(['qqFileDir', 'wechatFileDir', 'neteaseCacheDir', 'wechatCacheDir', 'douyinCacheDir', 'qqCacheDir']);
  if (!allowedKeys.has(key) || typeof value !== 'string' || value.length > 1024 || value.includes('\0')) {
    return { success: false, message: '路径配置无效' };
  }
  const config = loadPathsConfig();
  config[key] = value;
  // 校验目录是否存在
  const exists = typeof value === 'string' && value ? fs.existsSync(value) : false;
  const saved = savePathsConfig(config);
  return { success: saved, exists };
});

// 浏览选择文件夹
handleSafe('paths:browse', async (event, { title, defaultPath }) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || '选择文件夹',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
    return { success: true, path: result.filePaths[0] };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// 校验路径是否存在
handleSafe('paths:validate', (event, { path: dirPath }) => {
  try {
    return { success: true, exists: dirPath ? fs.existsSync(dirPath) : false };
  } catch (e) {
    return { success: false, exists: false };
  }
});

// 提取指定安装目录下主程序 exe 的真实图标（dataURL），用于路径绑定弹窗分组标题头
// exe 名称按软件固定候选依次探测，取第一个存在的
handleSafe('paths:app-icon', async (event, { installPath, exeCandidates = [] } = {}) => {
  try {
    if (!installPath || !fs.existsSync(installPath)) return { success: false, dataUrl: null };
    const exeList = Array.isArray(exeCandidates) ? exeCandidates : [];
    for (const exe of exeList) {
      if (!exe) continue;
      const exePath = path.join(installPath, exe);
      if (fs.existsSync(exePath)) {
        const icon = await app.getFileIcon(exePath, { size: 'large' });
        if (icon && !icon.isEmpty()) {
          return { success: true, dataUrl: icon.toDataURL() };
        }
      }
    }
    // 安装目录本身作为图标源（部分应用目录根含 exe）
    const icon = await app.getFileIcon(installPath, { size: 'large' });
    if (icon && !icon.isEmpty()) return { success: true, dataUrl: icon.toDataURL() };
    return { success: false, dataUrl: null };
  } catch (e) {
    return { success: false, dataUrl: null };
  }
});

// 按绝对路径提取图标（.ico / .exe / .dll），用于为固定图标路径的软件兜底
// （例：抖音安装目录下的 exe 图标不正确时，可直接使用其资源目录中的 app_icon.ico）
// 安全约束：仅允许提取图标类文件，避免渲染层借该通道探测任意文件
const ICON_EXT_WHITELIST = ['.ico', '.exe', '.dll'];
// ==================== 内置图标释放 ====================
// 打包为 asar 后，app.getFileIcon 走原生 Shell API，无法读取 asar 虚拟文件系统内的文件。
// 因此随包分发的内置图标（如 src/assets/ico/douyin.ico）必须先释放到用户目录，再按真实路径提取。
const BUNDLED_ICON_DIR = path.join(APP_DATA_DIR, 'icons');

function ensureBundledIcon(relPath) {
  const src = path.resolve(__dirname, relPath);
  if (!isPathUnderRoot(src, __dirname)) return null;
  try {
    if (!fs.existsSync(src)) return null;
    if (!fs.existsSync(BUNDLED_ICON_DIR)) fs.mkdirSync(BUNDLED_ICON_DIR, { recursive: true });
    const dest = path.join(BUNDLED_ICON_DIR, path.basename(relPath));
    const srcStat = fs.statSync(src);
    const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null;
    if (!destStat || destStat.size !== srcStat.size) fs.copyFileSync(src, dest);
    return dest;
  } catch (e) {
    writeLog('warn', `释放内置图标失败: ${e.message}`);
    return null;
  }
}

handleSafe('paths:file-icon', async (event, { filePath } = {}) => {
  try {
    const raw = String(filePath || '').trim();
    if (!raw) return { success: false, dataUrl: null };
    // 相对路径按应用根目录解析（用于随包分发的内置图标，如 src/assets/ico/douyin.ico）
    let target = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(__dirname, raw);
    // 相对路径必须落在应用目录内，避免目录穿越读取应用外的文件
    if (!path.isAbsolute(raw)) {
      if (!isPathUnderRoot(target, __dirname)) {
        writeLog('warn', `拒绝提取应用目录外的图标：${raw}`);
        return { success: false, dataUrl: null, message: '图标路径越界' };
      }
      // 释放到用户目录，取得原生 API 可读取的真实路径
      target = ensureBundledIcon(raw) || target;
    }
    if (!target || !fs.existsSync(target)) return { success: false, dataUrl: null };
    if (!ICON_EXT_WHITELIST.includes(path.extname(target).toLowerCase())) {
      writeLog('warn', `拒绝提取非图标文件：${target}`);
      return { success: false, dataUrl: null, message: '仅支持 .ico / .exe / .dll 文件' };
    }
    const icon = await app.getFileIcon(target, { size: 'large' });
    if (icon && !icon.isEmpty()) return { success: true, dataUrl: icon.toDataURL() };
    return { success: false, dataUrl: null };
  } catch (e) {
    return { success: false, dataUrl: null };
  }
});

// ==================== 设置 → 字体管理（应用内弹窗） ====================
// 识别 5 款指定系统字体的可用性（文件存在性检测，无需管理员权限）；
// 内嵌 MiSans 可变字体随应用分发（src/assets/fonts/MiSansVF.ttf）；
// 支持导入 1 款外部字体（复制副本到 %APPDATA%\Trim\fonts\，记录持久化到 settings.json）。
const FONTS_DIR = path.join(APP_DATA_DIR, 'fonts');
const FONT_SYSTEM_FAMILIES = [
  { family: '微软雅黑', cssStack: "'微软雅黑', 'Microsoft YaHei', sans-serif", files: ['C:\\Windows\\Fonts\\msyh.ttc', 'C:\\Windows\\Fonts\\msyh.ttf'] },
  { family: '黑体', cssStack: "'黑体', SimHei, sans-serif", files: ['C:\\Windows\\Fonts\\simhei.ttf'] },
  { family: '宋体', cssStack: "'宋体', SimSun, serif", files: ['C:\\Windows\\Fonts\\simsun.ttc'] },
  { family: '楷体', cssStack: "'楷体', KaiTi, serif", files: ['C:\\Windows\\Fonts\\simkai.ttf'] },
  { family: 'Times New Roman', cssStack: "'Times New Roman', Times, serif", files: ['C:\\Windows\\Fonts\\times.ttf'] }
];
const FONT_MISANS = { family: 'MiSans', cssStack: "'MiSans', '微软雅黑', 'Microsoft YaHei', sans-serif" };
const FONT_DEFAULTS = { family: 'MiSans', weight: 400, size: 16 };

function loadFontState() {
  const s = loadAiSettings();
  return {
    settings: { ...FONT_DEFAULTS, ...(s.font || {}) },
    imported: (s.fontImported && typeof s.fontImported === 'object') ? s.fontImported : null
  };
}

function fontCssStackFor(record) {
  const family = String(record.family || '').replace(/['\\]/g, '');
  return `'${family}', '微软雅黑', 'Microsoft YaHei', sans-serif`;
}

// 字体文件魔数校验，阻止导入损坏 / 非字体文件后注入无效 @font-face
function isFontFileValid(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4);
      const read = fs.readSync(fd, buf, 0, 4, 0);
      if (read < 4) return false;
      const hex = buf.toString('hex');
      if (hex === '00010000') return true;            // TTF
      if (buf.toString('ascii') === 'OTTO') return true; // OTF
      if (buf.toString('ascii') === 'ttcf') return true; // TTC 集合
      if (buf.toString('ascii') === 'true') return true; // 旧式 TTF
      if (buf.toString('ascii').startsWith('wOF')) return true; // WOFF / WOFF2
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return false;
  }
}

handleSafe('fonts:list', () => {
  try {
    const { settings, imported } = loadFontState();
    const system = FONT_SYSTEM_FAMILIES.map(f => ({
      family: f.family,
      cssStack: f.cssStack,
      available: f.files.some(p => fs.existsSync(p)),
      builtin: false,
      imported: false
    }));
    const list = [
      ...system,
      { family: FONT_MISANS.family, cssStack: FONT_MISANS.cssStack, available: true, builtin: true, imported: false },
      ...(imported ? [{
        family: imported.family,
        cssStack: fontCssStackFor(imported),
        available: fs.existsSync(imported.copyPath || ''),
        builtin: false,
        imported: true,
        copyUrl: (imported.copyPath && fs.existsSync(imported.copyPath)) ? url.pathToFileURL(imported.copyPath).href : '',
        sourcePath: imported.sourcePath || ''
      }] : [])
    ];
    return { success: true, data: { list, settings, imported: imported ? { family: imported.family, sourcePath: imported.sourcePath || '', copyPath: imported.copyPath || '' } : null } };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// 导入字体：文件对话框 → 魔数校验 → 复制副本到 userData/fonts/ → 记录到 settings.json
// 单字体约束：仅保留 1 款导入字体，再次导入时替换（删除旧副本与旧记录）
handleSafe('fonts:import', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入字体文件（将替换当前已导入字体）',
      properties: ['openFile'],
      filters: [{ name: '字体文件', extensions: ['ttf', 'otf', 'woff', 'woff2'] }]
    });
    if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
    const src = result.filePaths[0];
    if (!fs.existsSync(src)) return { success: false, message: '字体文件不存在或不可访问' };
    const stat = fs.statSync(src);
    if (!stat.isFile() || stat.size === 0) return { success: false, message: '字体文件为空或不可读取' };
    if (!isFontFileValid(src)) return { success: false, message: '该文件不是有效的字体文件（支持 .ttf / .otf / .woff / .woff2），请检查文件是否损坏' };

    if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR, { recursive: true });
    const s = loadAiSettings();
    const prev = s.fontImported;
    const family = path.basename(src).replace(/\.(ttf|otf|woff2?)$/i, '').replace(/['\\]/g, '').trim() || '导入字体';
    const copyPath = path.join(FONTS_DIR, `imported${path.extname(src).toLowerCase() || '.ttf'}`);
    fs.copyFileSync(src, copyPath);
    // 替换旧导入：删除旧副本（路径不同才删，相同则已被覆盖）
    if (prev && prev.copyPath && path.resolve(prev.copyPath) !== path.resolve(copyPath)) {
      try { fs.rmSync(prev.copyPath, { force: true }); } catch (e) { writeLog('warn', `旧导入字体副本删除失败: ${e.message}`); }
    }
    const record = { family, sourcePath: src, copyPath, importedAt: new Date().toISOString() };
    s.fontImported = record;
    saveAiSettings(s);
    writeLog('info', `导入字体: ${family}（副本已复制到 ${copyPath}）`);
    return { success: true, data: { family, copyUrl: url.pathToFileURL(copyPath).href } };
  } catch (e) {
    writeLog('error', `导入字体失败: ${e.message}`);
    return { success: false, message: `导入失败：${e.message}` };
  }
});

// 删除导入字体：移除 JSON 记录 + 删除本地副本（不触碰用户原始文件）
handleSafe('fonts:remove-imported', () => {
  try {
    const s = loadAiSettings();
    const prev = s.fontImported;
    if (!prev) return { success: true, data: { removed: false } };
    delete s.fontImported;
    // 若当前选中字体正是被删除的导入字体，回退默认 MiSans
    if (s.font && String(s.font.family || '') === String(prev.family || '')) {
      s.font = { ...s.font, family: FONT_DEFAULTS.family };
    }
    saveAiSettings(s);
    let fileDeleted = true;
    if (prev.copyPath) {
      try { fs.rmSync(prev.copyPath, { force: true }); } catch (e) { fileDeleted = false; writeLog('warn', `导入字体副本删除失败: ${e.message}`); }
    }
    writeLog('info', `删除导入字体: ${prev.family || ''}${fileDeleted ? '' : '（副本文件删除失败，记录已移除）'}`);
    return { success: true, data: { removed: true, fileDeleted } };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// 保存字体配置（family / weight / size），持久化到 settings.json 的 font 字段
handleSafe('fonts:save-config', (event, { config } = {}) => {
  try {
    const cfg = config || {};
    const s = loadAiSettings();
    const prev = s.font || {};
    const size = Math.min(24, Math.max(12, Number(cfg.size) || FONT_DEFAULTS.size));
    const weight = Math.min(1000, Math.max(100, Number(cfg.weight) || FONT_DEFAULTS.weight));
    s.font = {
      family: String(cfg.family || prev.family || FONT_DEFAULTS.family).replace(/['\\]/g, ''),
      weight,
      size
    };
    saveAiSettings(s);
    return { success: true, data: s.font };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// ==================== 内存清理 → 应用进程管理 独立窗口 ====================
// 与「大模型管理」窗口同级：承载运行进程列表（按路径分组 + 实例缩进的进程树），
// 支持搜索 / 刷新 / 逐项或整体结束进程。
let processManagerWindow = null;

handleSafe('processManager:open-window', async () => {
  if (processManagerWindow && !processManagerWindow.isDestroyed()) {
    processManagerWindow.focus();
    return { success: true, alreadyOpen: true };
  }
  processManagerWindow = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 640,
    minHeight: 480,
    parent: mainWindow,
    modal: false,
    title: '应用进程管理',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'src', 'assets', 'ico', 'Trim.ico'),
    backgroundColor: '#f3f3f3',
    // 原生材质与主窗同源（appearance.json.material）；渲染层半透明化见 window-material.js
    ...childWindowMaterialOption(),
    // 先隐藏待首帧渲染完成再显示，避免打开瞬间黑/白闪一帧
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  secureWindowNavigation(processManagerWindow);
  processManagerWindow.loadFile(path.join(__dirname, 'src', 'process-manager-window.html'));
  processManagerWindow.once('ready-to-show', () => {
    if (processManagerWindow && !processManagerWindow.isDestroyed()) processManagerWindow.show();
  });
  processManagerWindow.on('closed', () => { processManagerWindow = null; });
  return { success: true };
});

// 关闭「应用进程管理」窗口（由窗口内「完成」按钮调用）
handleSafe('processManager:close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
  return { success: true };
});

// 「应用进程管理」窗口操作完成后，向主窗口推送最新统计，供内存清理页进程卡片回显
onSafe('processManager:report', (event, payload = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('processManager:update', {
    totalCount: Number.isInteger(payload.totalCount) ? payload.totalCount : null,
    updatedAt: Date.now()
  });
});

// ==================== 大模型管理 独立窗口 ====================
let modelsWindow = null;

handleSafe('models:open-window', async () => {
  if (modelsWindow && !modelsWindow.isDestroyed()) {
    modelsWindow.focus();
    return { success: true, alreadyOpen: true };
  }
  modelsWindow = new BrowserWindow({
    width: 720,
    height: 680,
    minWidth: 600,
    minHeight: 520,
    parent: mainWindow,
    modal: false,
    title: '大模型管理',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'src', 'assets', 'ico', 'Trim.ico'),
    backgroundColor: '#f3f3f3',
    // 原生材质与主窗同源（appearance.json.material）；渲染层半透明化见 window-material.js
    ...childWindowMaterialOption(),
    // 先隐藏待首帧渲染完成再显示，避免打开瞬间黑/白闪一帧
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  secureWindowNavigation(modelsWindow);
  modelsWindow.loadFile(path.join(__dirname, 'src', 'models-window.html'));
  modelsWindow.once('ready-to-show', () => {
    if (modelsWindow && !modelsWindow.isDestroyed()) modelsWindow.show();
  });
  modelsWindow.on('closed', () => { modelsWindow = null; });
  return { success: true };
});

handleSafe('models:close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
  return { success: true };
});

// ==================== 图片预览 独立窗口 ====================
let previewWindow = null;

handleSafe('preview:open-window', async (event, payload = {}) => {
  // payload: { images: [{filePath, name, size}], index: 0, itemName: 'xxx' }
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.focus();
    previewWindow.webContents.send('preview:data', payload);
    return { success: true, alreadyOpen: true };
  }
  previewWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 480,
    parent: mainWindow,
    modal: false,
    title: '图片预览',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'src', 'assets', 'ico', 'Trim.ico'),
    backgroundColor: '#000000',
    // 先隐藏待首帧渲染完成再显示，避免打开瞬间（尤其图片加载）黑闪一帧
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  secureWindowNavigation(previewWindow);
  previewWindow.loadFile(path.join(__dirname, 'src', 'preview-window.html'));
  previewWindow.once('ready-to-show', () => {
    if (previewWindow && !previewWindow.isDestroyed()) previewWindow.show();
  });
  previewWindow.webContents.on('did-finish-load', () => {
    if (!previewWindow.isDestroyed()) previewWindow.webContents.send('preview:data', payload);
  });
  previewWindow.on('closed', () => { previewWindow = null; });
  return { success: true };
});

handleSafe('preview:close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
  return { success: true };
});

// 图片预览窗口删除图片后通知主窗口刷新文件列表
onSafe('preview:image-deleted', (event, filePath) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('preview:image-deleted', filePath);
  }
});

// ==================== 外设优化（更多调优项）独立窗口 ====================
const PERIPHERAL_SCRIPT = require('./src/scripts-powershell/peripheral-scripts');
let peripheralWindow = null;

// 允许写入的合法值（渲染层传值白名单校验）
const PERIPHERAL_ALLOWED = {
  win32: [2, 26, 36, 38, 40],
  keyboard: [16, 18, 20, 22, 100],
  mouse: [16, 18, 20, 22, 100]
};

// ==================== 快捷指令（侧边栏 → 63 条系统快捷入口） ====================
// 数据即白名单：渲染层只传 id，命令原文从数据文件查询，绝不接受用户拼接输入。
const QUICKCMDS = require('./src/scripts/quickcmds-data');

handleSafe('quickcmds:run', async (event, id) => {
  const item = QUICKCMDS.CMDS.find(c => c.id === id);
  if (!item) return { success: false, message: '未知指令' };
  try {
    // 与解包原实现一致：cmd shell 启动（命令为编译期常量，无注入面），
    // start "" 分离新进程不闪黑窗；cmd /k 类命令自动保持窗口便于查看输出。
    exec(`start "" ${item.cmd}`, { windowsHide: true, timeout: 15000 }, (err) => {
      if (err) writeLog('warn', `快捷指令退出码异常: ${item.name}: ${err.message}`);
    });
    writeLog('info', `快捷指令: ${item.name} (${item.cmd})`);
    return { success: true };
  } catch (e) {
    writeLog('error', `快捷指令失败: ${item.name}: ${e.message}`);
    return { success: false, message: e.message };
  }
});

handleSafe('peripheral:open-window', async () => {
  if (peripheralWindow && !peripheralWindow.isDestroyed()) {
    peripheralWindow.focus();
    return { success: true, alreadyOpen: true };
  }
  peripheralWindow = new BrowserWindow({
    width: 860,
    height: 760,
    minWidth: 680,
    minHeight: 560,
    parent: mainWindow,
    modal: false,
    title: '外设优化',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'src', 'assets', 'ico', 'Trim.ico'),
    backgroundColor: '#f3f3f3',
    // 原生材质与主窗同源（appearance.json.material）；渲染层半透明化见 window-material.js
    ...childWindowMaterialOption(),
    // 先隐藏待首帧渲染完成再显示，避免打开瞬间黑/白闪一帧
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  secureWindowNavigation(peripheralWindow);
  peripheralWindow.loadFile(path.join(__dirname, 'src', 'peripheral-window.html'));
  peripheralWindow.once('ready-to-show', () => {
    if (peripheralWindow && !peripheralWindow.isDestroyed()) peripheralWindow.show();
  });
  peripheralWindow.on('closed', () => { peripheralWindow = null; });
  return { success: true };
});

handleSafe('peripheral:close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
  return { success: true };
});

// 读取三组调优的当前注册表值（-1 表示读取失败）
handleSafe('peripheral:query', async () => {
  const scriptPath = writeTempScript(PERIPHERAL_SCRIPT.query());
  try {
    const { stdout, code, stderr } = await runPowerShellFile(scriptPath, { timeout: 20000 });
    if (code !== 0) return { success: false, message: stderr || '读取当前外设设置失败' };
    return { success: true, data: JSON.parse(stdout.trim()) };
  } catch (e) {
    return { success: false, message: e.message };
  } finally { try { fs.unlinkSync(scriptPath); } catch (e) {} }
});

// 应用三组调优值（白名单校验；-1/缺省表示该组不修改）
handleSafe('peripheral:apply', async (event, options = {}) => {
  const filtered = {};
  for (const key of ['win32', 'keyboard', 'mouse']) {
    const v = Number(options[key]);
    if (PERIPHERAL_ALLOWED[key].includes(v)) filtered[key] = v;
    else filtered[key] = -1;
  }
  if (Object.values(filtered).every(v => v === -1)) {
    return { success: false, message: '没有需要应用的设置' };
  }
  const scriptPath = writeTempScript(PERIPHERAL_SCRIPT.apply(filtered));
  try {
    const { code, stderr } = await runPowerShellFile(scriptPath, { timeout: 30000 });
    const ok = code === 0;
    if (!ok) writeLog('warn', `外设优化应用失败 exit=${code}: ${stderr || ''}`);
    return { success: ok, message: ok ? '完成' : '写入注册表失败，可能需要管理员权限' };
  } catch (e) {
    writeLog('error', `外设优化应用异常: ${e.message}`);
    return { success: false, message: e.message };
  } finally { try { fs.unlinkSync(scriptPath); } catch (e) {} }
});

// ==================== 文件清理 IPC ====================
// 安全约束：所有读图 / 删除操作必须限定在最近一次成功扫描的根目录（白名单）内，
// 防止渲染进程被诱导后对任意路径执行读写（纵深防御，渲染层已有限制）。
let lastFileCleanRoot = null; // 最近一次 fileclean:scan 成功返回的扫描根目录
let lastFileCleanFiles = new Set(); // 最近一次扫描明确列出的文件（防止在根目录内任意指定路径）

// 校验路径是否位于允许的扫描根目录下（防止目录穿越）
function isPathUnderRoot(targetPath, root) {
  if (!root || !targetPath) return false;
  const canonicalize = (value) => {
    const resolved = path.resolve(String(value));
    try { return fs.realpathSync.native(resolved); } catch (_) {}
    let current = resolved;
    const missing = [];
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      missing.unshift(path.basename(current));
      current = parent;
    }
    try { return path.join(fs.realpathSync.native(current), ...missing); } catch (_) { return resolved; }
  };
  const rootNorm = canonicalize(root).replace(/[\\/]+$/, '');
  const targetNorm = canonicalize(targetPath);
  if (!targetNorm.toLowerCase().startsWith(rootNorm.toLowerCase())) return false;
  // 防 "C:\root2" 命中 "C:\root" 前缀
  const next = targetNorm.slice(rootNorm.length);
  if (next && !next.startsWith(path.sep)) return false;
  return true;
}

// 扫描 QQ/微信 文件目录中的垃圾文件（缓存接收图片、视频等）
handleSafe('fileclean:scan', async (event, { type, customPath }) => {
  const config = loadPathsConfig();
  let scanPath = '';

  if (type === 'qq') {
    scanPath = config.qqFileDir || path.join(os.homedir(), 'Documents', 'Tencent Files');
  } else if (type === 'wechat') {
    scanPath = config.wechatFileDir || path.join(os.homedir(), 'Documents', 'xwechat_files');
  } else {
    return { success: false, message: '未知类型', data: [] };
  }

  if (customPath && path.resolve(String(customPath)) !== path.resolve(scanPath)) {
    return { success: false, message: '扫描路径必须来自已保存的路径配置', data: [] };
  }

  if (!scanPath || !fs.existsSync(scanPath)) {
    return { success: false, message: '路径不存在，请在设置中配置文件目录', data: [] };
  }
  try {
    const rootStat = fs.lstatSync(scanPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { success: false, message: '扫描目录必须是普通目录', data: [] };
  } catch (_) {
    return { success: false, message: '扫描目录不可访问', data: [] };
  }

  writeLog('info', `文件清理扫描: ${type} -> ${scanPath}`);

  // 使用 Node.js 直接扫描，避免 PowerShell 开销
  try {
    const junkFiles = [];
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
    const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.flv'];
    const cacheExtensions = ['.tmp', '.log', '.bak', '.cache'];
    const maxFiles = 2000;

    function scanDir(dir, depth) {
      if (depth > 4 || junkFiles.length >= maxFiles) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) { return; }

      for (const entry of entries) {
        if (junkFiles.length >= maxFiles) break;
        const fullPath = path.join(dir, entry.name);
        try {
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            // 检查是否是缓存目录
            const lowerName = entry.name.toLowerCase();
            if (lowerName.includes('cache') || lowerName.includes('temp') || lowerName.includes('tmp') ||
                lowerName.includes('image') || lowerName.includes('video') || lowerName.includes('file') ||
                lowerName.includes('recv') || lowerName.includes('recv0') || lowerName.includes('msg')) {
              scanDir(fullPath, depth + 1);
            } else if (depth < 2) {
              scanDir(fullPath, depth + 1);
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            let category = null;
            if (imageExtensions.includes(ext)) category = 'image';
            else if (videoExtensions.includes(ext)) category = 'video';
            else if (cacheExtensions.includes(ext)) category = 'cache';
            else if (entry.name.endsWith('.dat') || entry.name.endsWith('.db') || entry.name.endsWith('.adb')) category = 'data';

            if (category) {
              let stat;
              try { stat = fs.statSync(fullPath); } catch (e) { continue; }
              junkFiles.push({
                path: fullPath,
                name: entry.name,
                size: stat.size,
                category,
                ext,
                mtime: stat.mtime.toISOString()
              });
            }
          }
        } catch (e) {}
      }
    }

    scanDir(scanPath, 0);

    const totalSize = junkFiles.reduce((s, f) => s + f.size, 0);
    writeLog('info', `文件清理扫描完成: ${type}, ${junkFiles.length} 个文件, ${totalSize} 字节`);
    lastFileCleanRoot = path.resolve(scanPath);
    lastFileCleanFiles = new Set(junkFiles.map(file => path.resolve(file.path).toLowerCase()));
    return { success: true, data: { files: junkFiles, totalSize, scanPath } };
  } catch (e) {
    writeLog('error', `文件清理扫描失败: ${e.message}`);
    return { success: false, message: e.message, data: [] };
  }
});

// 读取图片文件为 base64（用于预览）——仅限已扫描目录内的文件
handleSafe('fileclean:read-image', async (event, { filePath }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, message: '文件不存在' };
    }
    if (!isPathUnderRoot(filePath, lastFileCleanRoot) || !lastFileCleanFiles.has(path.resolve(filePath).toLowerCase())) {
      return { success: false, message: '路径不在扫描范围内，已拒绝访问' };
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.gif': 'image/gif',
      '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml'
    };
    const mime = mimeMap[ext] || 'image/jpeg';
    // 限制文件大小（10MB）
    const stat = fs.statSync(filePath);
    if (stat.size > 10 * 1024 * 1024) {
      return { success: false, message: '文件过大，不支持预览' };
    }
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');
    return { success: true, data: `data:${mime};base64,${base64}`, size: stat.size };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// 删除单个文件（图片预览中单独删除当前图片）——仅限已扫描目录内的文件
handleSafe('fileclean:delete-file', async (event, { filePath }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, message: '文件不存在' };
    }
    if (!isPathUnderRoot(filePath, lastFileCleanRoot) || !lastFileCleanFiles.has(path.resolve(filePath).toLowerCase())) {
      return { success: false, message: '路径不在扫描范围内，已拒绝删除' };
    }
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) return { success: false, message: '目标不是普通文件，已拒绝删除' };
    // 审查 1-2：统一删除出口，回收站优先；仅回收站失败时才降级永久删除
    const r = await trashOrUnlink(filePath, { allowPermanent: true });
    if (!r.ok) throw new Error(r.message || '删除失败');
    const batchId = new Date().toISOString().replace(/[:.]/g, '-');
    const manifestPath = saveDeleteManifest(batchId, [{ path: filePath, kind: 'file', size: stat.size, recycled: r.recycled }]);
    writeLog('info', `删除预览图片: ${filePath}（${r.recycled ? '已移入回收站' : '永久删除'}）`);
    return { success: true, recycled: r.recycled, manifestPath };
  } catch (e) {
    writeLog('error', `删除预览图片失败: ${e.message}`);
    return { success: false, message: e.message };
  }
});

// 执行文件清理——仅限已扫描目录内的文件
handleSafe('fileclean:execute', async (event, { files }) => {
  if (!files || !files.length) return { success: false, message: '没有选中文件' };
  writeLog('info', `文件清理: ${files.length} 个文件`);
  let freed = 0, success = 0, failed = 0, recycledCount = 0;
  const details = [];

  for (const file of files) {
    try {
      if (!file || !file.path || !isPathUnderRoot(file.path, lastFileCleanRoot) || !lastFileCleanFiles.has(path.resolve(file.path).toLowerCase())) {
        failed++;
        details.push({ path: file && file.path, status: 'error', freed: 0, message: '路径不在扫描范围内，已拒绝删除' });
        continue;
      }
      if (fs.existsSync(file.path)) {
        const stat = fs.lstatSync(file.path);
        if (!stat.isFile()) throw new Error('目标不是普通文件');
        const size = stat.size;
        // 审查 1-2：统一删除出口，回收站优先；仅回收站失败时才降级永久删除
        const r = await trashOrUnlink(file.path, { allowPermanent: true });
        if (!r.ok) throw new Error(r.message || '删除失败');
        freed += size;
        success++;
        if (r.recycled) recycledCount++;
        details.push({ path: file.path, status: 'ok', freed: size, recycled: r.recycled });
      } else {
        details.push({ path: file.path, status: 'skip', freed: 0, message: '文件不存在' });
      }
    } catch (e) {
      failed++;
      details.push({ path: file.path, status: 'error', freed: 0, message: e.message });
    }
  }

  // 删除清单落盘（与 finder:delete 一致）：成功项记录是否已进回收站，误删可追溯还原
  const batchId = new Date().toISOString().replace(/[:.]/g, '-');
  const manifestPath = saveDeleteManifest(batchId, details
    .filter(d => d.status === 'ok')
    .map(d => ({ path: d.path, kind: 'file', size: d.freed || 0, recycled: !!d.recycled })));

  writeLog('info', `文件清理完成: 释放 ${freed} 字节, ${success} 成功（回收站 ${recycledCount}）, ${failed} 失败${manifestPath ? ` 清单 ${path.basename(manifestPath)}` : ''}`);
  return { success: failed === 0, data: { totalFreed: freed, success, failed, recycled: recycledCount, details, manifestPath } };
});

// ==================== 系统维护修复组 IPC（P2-16） ====================
const MAINTENANCE_SCRIPT = require('./src/scripts-powershell/maintenance-scripts');

// 同一时刻仅允许一个维护任务执行（修复类操作互相占用服务，串行更安全）
let maintenanceRunning = null; // taskId

handleSafe('maintenance:tasks', () => {
  return { success: true, data: MAINTENANCE_SCRIPT.list(), categories: MAINTENANCE_SCRIPT.CATEGORY_ORDER };
});

handleSafe('maintenance:run', async (event, { taskId } = {}) => {
  if (!taskId) return { success: false, message: '缺少任务 ID' };
  if (maintenanceRunning) return { success: false, message: `已有维护任务在执行中（${maintenanceRunning}），请等待完成` };
  let script;
  try {
    script = MAINTENANCE_SCRIPT.run(taskId);
  } catch (e) {
    return { success: false, message: e.message };
  }
  maintenanceRunning = taskId;
  const scriptPath = writeTempScript(script);
  const sender = event.sender;
  const lines = [];
  let result = 'ok';
  try {
    writeLog('info', `维护任务开始: ${taskId}`);
    let buf = '';
    const { code, stderr } = await runPowerShellFile(scriptPath, {
      timeout: 1800000, // SFC/DISM 可能耗时很久，上限 30 分钟
      diagOp: 'maintenance.' + taskId,
      onStdout: (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line) continue;
          if (line.startsWith('@@RESULT@@')) { result = line.slice(10).trim() || 'ok'; continue; }
          if (line.startsWith('@@DIAG@@')) continue; // 由执行层统一提取写日志
          lines.push(line);
          if (sender && !sender.isDestroyed()) {
            try { sender.send('maintenance:output', { taskId, line }); } catch (e) {}
          }
        }
      }
    });
    if (code !== 0 && result === 'ok') result = 'warn';
    writeLog(result === 'ok' ? 'info' : 'warn', `维护任务完成: ${taskId} result=${result} exit=${code}${stderr ? ' stderr=' + stderr.slice(0, 200) : ''}`);
    return { success: result === 'ok', data: { taskId, result, output: lines.join('\n') } };
  } catch (e) {
    writeLog('error', `维护任务异常: ${taskId} -> ${e.message}`);
    return { success: false, message: e.message, data: { taskId, result: 'error', output: lines.join('\n') } };
  } finally {
    maintenanceRunning = null;
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }
});

// ==================== 应用生命周期 ====================
// 使用 Electron 标准 GPU 合成路径。Mica 窗口在禁用硬件加速时可能出现
// 最大化后画面停留在旧尺寸、而 DOM 命中区域已更新的错位问题。

app.whenReady().then(() => {
  migrateLegacyData();
  ensureLogDir();
  cleanupTempScripts();
  // v2.6.0（P0-1）：优化状态记账模块初始化（数据目录确定后）
  OPT_STATE.initDataDir(APP_DATA_DIR, writeLog);
  // v2.6.0（P0-3）：退役优化项版本迁移——对已不在当前目录里的备份记录按原值还原。
  // 不阻塞启动窗口：还原走子进程，后台执行，结果经 optimizer:state-overview 回报渲染层。
  (() => {
    const MIGRATIONS = require('./src/main/version-migrations');
    MIGRATIONS.runRetiredMigrations({
      knownIds: new Set(OPTIMIZER.OPTIONS.map(o => o.id)),
      loadBackups: loadOptBackups,
      saveBackups: saveOptBackups,
      restoreEntry: (id, entry) => restoreBackupValues(entry),
      removeState: (id) => OPT_STATE.remove(id),
      writeLog
    }).then(summary => {
      if (summary.restored.length || summary.failed.length) {
        lastMigrationSummary = summary;
        writeLog('info', `退役优化项迁移完成: 还原 ${summary.restored.length} 项，失败 ${summary.failed.length} 项（失败项保留记录下次重试）`);
      }
    }).catch(e => writeLog('error', `退役优化项迁移异常: ${e.message}`));
  })();
  // 审查 4-3：清理上次规则更新中断残留的 .downloading 孤儿（writeValidated 两步间崩溃遗留）
  try {
    const orphan = path.join(CLEANUP_SCRIPT.dataRulesDir(), 'rules.json.downloading');
    if (fs.existsSync(orphan)) { fs.unlinkSync(orphan); writeLog('info', '已清理上次规则更新残留的 .downloading'); }
  } catch (e) {}
  try {
    writeLog('info', `PowerShell 7: ${resolvePowerShell7Path()}`);
  } catch (e) {
    writeLog('error', e.message);
  }
  // 💭4 加固：本地页面不申请任何系统级 web 权限；仅放行剪贴板复制（cleanup/quickcmds 的 writeText），其余一律拒绝。
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write' || permission === 'clipboard-write');
  });
  createWindow();

  // 批次：自动更新接入——主窗口创建后挂载；内部自行判断 isPackaged，开发环境自动短路
  // v2.6.0（P2-8）：传入数据目录用于镜像偏好持久化
  UPDATER.initUpdater(mainWindow, writeLog, { dataDir: APP_DATA_DIR });

  // 系统指标启动预热：后台提前采集一轮填充缓存，
  // 用户进入/切回「系统体检」首页时首轮渲染即时出数据（无需等 pwsh 冷启动）
  setTimeout(() => { collectOverviewMetrics(); }, 1500);

  // v2.7.0（任务2）：应用首次启动即后台全量扫描优化项是否已生效并持久化（常态化记录）。
  // 延迟 3s 错开指标预热与窗口创建的 pwsh 抢占；扫描失败保留旧记录不影响使用。
  setTimeout(() => { refreshOptimizerDetectCache(); }, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // B9：退出前把日志缓冲强制落盘，防止尾部日志随进程退出丢失
  flushLogSync();
  // C2：兜底持久化窗口状态（performFinalClose 已存过则幂等）
  try { saveWindowState(); } catch (e) {}
  // 清理本应用 spawn 的子进程（仅清理已登记的 PID，绝误杀用户的其它进程）
  if (backendProcs.size > 0) {
    const { execSync } = require('child_process');
    for (const info of backendProcs.values()) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /pid ${info.pid} /T /F`, { stdio: 'ignore' });
        } else {
          process.kill(info.pid, 'SIGTERM');
        }
        writeLog('info', `退出时清理子进程 PID ${info.pid} (${info.kind})`);
      } catch (_) { /* 进程已退出或无权限，忽略 */ }
    }
    backendProcs.clear();
  }
  cleanupTempScripts();
});

// 防止多开：单实例锁已在文件头部请求（requestSingleInstanceLock），此处无需重复处理。
