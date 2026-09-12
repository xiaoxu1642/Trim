// src/main/updater.js — 应用自动更新（electron-updater + GitHub Releases，多线路容灾）
// 批次：自动更新接入（2026-09-12，方案见 docs规范/update/9.12/electron-updater自动更新方案）
//       v2.6.0（P2-8）多线路容灾：GitHub 直连失败时按序回退镜像线路（复用规则库更新
//       「多源按序回退」模式；electron-updater 单实例无法并发竞速，顺序回退是等价容灾）。
// 约束：
// 1) 仅打包后生效（app.isPackaged），开发环境 npm start 直接短路（resources 下无 app-update.yml）；
// 2) 状态全部经 'updater:state-changed' 事件推给渲染层，由渲染层统一弹窗服务呈现，主进程不弹原生 dialog；
// 3) 发现新版不自动下载、下载完成不强制退出：避免偷跑流量与打断清理/测速/大文件扫描任务；
// 4) 更新源来自打包时自动生成的 resources/app-update.yml（build.publish 配置），不要手写、不要入库；
// 5) 完整性锚点：latest.yml 内 sha512 由 electron-updater 下载后强校验——镜像只是传输通道，
//    与规则库更新「任何源都只是通道，内容必须自证可信」同一信任模型，故镜像域名无需额外白名单。
const { autoUpdater, CancellationToken } = require('electron-updater');
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// —— 线路定义（P2-8）——
// 默认线路：GitHub Releases（来自 app-update.yml）；镜像线路：gh-proxy 系对
// releases/latest/download/ 的转发（generic provider，直接拉 latest.yml 与安装包）。
// 新增镜像时同步更新渲染层设置页下拉（src/scripts/updater-ui.js 的 MIRROR_OPTIONS）。
const GITHUB_FEED = { provider: 'github', owner: 'xiaoxu1642', repo: 'Trim' };
const MIRRORS = [
  { id: 'gh-proxy', label: 'gh-proxy 镜像', base: 'https://gh-proxy.com/https://github.com/xiaoxu1642/Trim/releases/latest/download/' },
  { id: 'ghfast', label: 'ghfast 镜像', base: 'https://ghfast.top/https://github.com/xiaoxu1642/Trim/releases/latest/download/' }
];
const MIRROR_IDS = ['auto', 'github', ...MIRRORS.map(m => m.id)];
const MIRROR_FILE = 'update-mirror.json'; // 数据目录下的用户镜像偏好
const CHECK_TIMEOUT_MS = 20000;           // 单线路检查超时（竞速另一条前不再等太久）

let winRef = null;
let writeLog = () => {};
let cancelToken = null;
let started = false;
let checking = false;
let dataDir = null;        // 由 main.js 注入（镜像偏好持久化位置）
let mirrorPref = 'auto';   // auto = GitHub 优先失败自动回退；指定镜像 = 镜像优先
let activeMirror = 'github'; // 最近一次成功线路（回报渲染层）

// 统一向主窗口渲染层推送状态（phase: idle/checking/available/latest/downloading/ready/error）
function push(state) {
  try {
    if (winRef && !winRef.isDestroyed()) winRef.webContents.send('updater:state-changed', state);
  } catch (_) { /* 窗口已销毁时静默 */ }
}

// GitHub releaseNotes 可能是字符串、{note} 对象数组或空值，统一拍平成纯文本
function normalizeNotes(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes.map(n => (n && (n.note || n.title)) || '').filter(Boolean).join('\n');
  }
  return String(notes);
}

// —— 镜像偏好持久化（P2-8）——
function loadMirrorPref() {
  if (!dataDir) return 'auto';
  try {
    const file = path.join(dataDir, MIRROR_FILE);
    if (!fs.existsSync(file)) return 'auto';
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const id = cfg && typeof cfg.mirror === 'string' ? cfg.mirror : 'auto';
    return MIRROR_IDS.includes(id) ? id : 'auto';
  } catch (_) {
    return 'auto';
  }
}

function saveMirrorPref(id) {
  if (!dataDir) return { ok: false, reason: 'no-datadir' };
  if (!MIRROR_IDS.includes(id)) return { ok: false, reason: 'unknown-mirror' };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = path.join(dataDir, MIRROR_FILE + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ mirror: id }), 'utf8');
    fs.renameSync(tmp, path.join(dataDir, MIRROR_FILE));
    mirrorPref = id;
    return { ok: true };
  } catch (e) {
    writeLog('warn', `[updater] 保存镜像偏好失败: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// 按用户偏好排出线路尝试顺序：指定镜像时镜像优先（GitHub 兜底），auto 时 GitHub 优先
function orderedFeeds() {
  const defaultFeed = { id: 'github', label: 'GitHub 直连', config: GITHUB_FEED };
  const mirrorFeeds = MIRRORS.map(m => ({
    id: m.id,
    label: m.label,
    config: { provider: 'generic', url: m.base }
  }));
  if (mirrorPref !== 'auto' && mirrorPref !== 'github') {
    const first = mirrorFeeds.find(m => m.id === mirrorPref);
    if (first) return [first, defaultFeed, ...mirrorFeeds.filter(m => m.id !== first.id)];
  }
  return [defaultFeed, ...mirrorFeeds];
}

// mainWindow：主窗口引用；logger：项目现有 writeLog(level, msg)；opts.dataDir：数据目录（镜像偏好持久化）
function initUpdater(mainWindow, logger, opts = {}) {
  if (started) return;
  started = true;
  winRef = mainWindow;
  if (typeof logger === 'function') writeLog = logger;
  dataDir = typeof opts.dataDir === 'string' ? opts.dataDir : null;
  mirrorPref = loadMirrorPref();
  if (mirrorPref !== 'auto') writeLog('info', `[updater] 已加载更新镜像偏好: ${mirrorPref}`);

  if (!app.isPackaged) {
    writeLog('info', '[updater] 开发环境，跳过自动更新');
    return;
  }

  autoUpdater.autoDownload = false;       // 发现新版先问用户，不偷跑流量
  autoUpdater.autoInstallOnAppQuit = true; // 已下载完时，退出应用顺手安装
  autoUpdater.logger = {
    info: m => writeLog('info', `[updater] ${m}`),
    warn: m => writeLog('warn', `[updater] ${m}`),
    error: m => writeLog('error', `[updater] ${m}`),
    debug: () => {}
  };

  autoUpdater.on('checking-for-update', () => push({ phase: 'checking' }));
  autoUpdater.on('update-available', info => {
    writeLog('info', `[updater] 发现新版本 ${info.version}（当前 ${info.currentVersion}）`);
    push({
      phase: 'available',
      version: info.version,
      currentVersion: String(info.currentVersion || app.getVersion()),
      releaseNotes: normalizeNotes(info.releaseNotes),
      releaseDate: info.releaseDate,
      via: activeMirror
    });
  });
  autoUpdater.on('update-not-available', () =>
    push({ phase: 'latest', currentVersion: String(autoUpdater.currentVersion || app.getVersion()), via: activeMirror }));
  autoUpdater.on('download-progress', p => push({
    phase: 'downloading',
    percent: Math.round(p.percent || 0),
    speed: p.bytesPerSecond || 0,
    transferred: p.transferred || 0,
    total: p.total || 0
  }));
  autoUpdater.on('update-downloaded', info => {
    writeLog('info', `[updater] 新版本 ${info.version} 下载完成，等待用户确认安装`);
    push({ phase: 'ready', version: info.version });
  });
  autoUpdater.on('error', err => {
    // 后台静默检查常见网络抖动（国内访问 GitHub）：记日志即可，是否打扰用户由 safeCheck 的 silent 决定；
    // 但 autoUpdater 自身的 error 事件不区分触发来源，渲染层按本次检查是否手动决定是否弹窗。
    writeLog('error', `[updater] ${(err && err.stack) || err}`);
    push({ phase: 'error', message: (err && err.message) || String(err) });
  });

  // 启动 8s 后静默检查一次：避开窗口动画与概览预热的资源抢占期
  setTimeout(() => { safeCheck(true); }, 8000);
}

// 按单条线路检查一次；electron-updater 的 error 事件在本进程内先于 checkForUpdates 的
// rejection 回流，这里靠 mute 窗口期吞掉事件侧的重复推送，只以返回值为准。
function checkOnce(feed, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve({ ok: false, error: `检查超时（${feed.label}）` }); }
    }, timeoutMs);
    autoUpdater.setFeedURL(feed.config);
    autoUpdater.checkForUpdates().then(() => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: true, feed }); }
    }).catch(e => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: e.message }); }
    });
  });
}

// silent=true：网络失败/无新版都不打扰用户（启动后台检查用）；
// 手动检查传 false，错误态由渲染层显性提示。
// 多线路容灾（P2-8）：按 orderedFeeds() 顺序逐条尝试，任一线路成功即止；
// 全部失败才报 error。成功线路记入 activeMirror 并回报渲染层（via 字段）。
async function safeCheck(silent = false) {
  if (!app.isPackaged) return { skipped: true, reason: 'dev' };
  if (checking) return { skipped: true, reason: 'already-checking' };
  checking = true;
  push({ phase: 'checking' });
  let lastError = '';
  try {
    const feeds = orderedFeeds();
    for (const feed of feeds) {
      const r = await checkOnce(feed, CHECK_TIMEOUT_MS);
      if (r.ok) {
        activeMirror = feed.id;
        if (feed.id !== 'github') writeLog('info', `[updater] 经 ${feed.label} 检查成功`);
        return { ok: true, via: feed.id };
      }
      lastError = r.error || '未知错误';
      writeLog('warn', `[updater] 线路 ${feed.label} 检查失败: ${lastError}`);
    }
    writeLog('error', `[updater] 检查失败（全部线路）: ${lastError}`);
    if (!silent) push({ phase: 'error', message: lastError });
    return { ok: false, error: lastError };
  } finally {
    checking = false;
  }
}

async function startDownload() {
  if (cancelToken) return { ok: false, error: 'already-downloading' };
  cancelToken = new CancellationToken();
  try {
    await autoUpdater.downloadUpdate(cancelToken);
    return { ok: true };
  } catch (e) {
    // 用户主动取消时 electron-updater 抛 canceled，归位 idle 且不算错误弹窗
    const canceled = /cancel/i.test(e && e.message || '');
    cancelToken = null;
    writeLog('error', `[updater] 下载失败: ${e.message}`);
    push({ phase: canceled ? 'idle' : 'error', message: canceled ? '' : e.message });
    return { ok: false, canceled, error: e.message };
  }
}

function cancelDownload() {
  try { cancelToken && cancelToken.cancel(); } catch (_) {}
  cancelToken = null;
  push({ phase: 'idle' });
}

function installUpdate() {
  writeLog('info', '[updater] 用户确认安装，退出并执行替换');
  // isSilent=true 由 NSIS 静默安装；isForceRunAfter=true 安装完自动重启 Trim
  autoUpdater.quitAndInstall(true, true);
}

// P2-8：渲染层设置页切换镜像（'auto' = GitHub 优先 + 自动回退）
function setMirror(id) {
  const r = saveMirrorPref(id);
  if (r.ok) writeLog('info', `[updater] 更新镜像偏好已保存: ${id}`);
  return { ...r, mirror: mirrorPref };
}

function getMirror() {
  return { mirror: mirrorPref, options: [{ id: 'auto', label: '自动（推荐）' }, { id: 'github', label: 'GitHub 直连' }, ...MIRRORS.map(m => ({ id: m.id, label: m.label }))] };
}

module.exports = { initUpdater, safeCheck, startDownload, cancelDownload, installUpdate, setMirror, getMirror, MIRRORS };
