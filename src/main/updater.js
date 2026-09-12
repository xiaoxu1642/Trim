// src/main/updater.js — 应用自动更新（electron-updater + GitHub Releases）
// 批次：自动更新接入（2026-09-12，方案见 docs规范/update/9.12/electron-updater自动更新方案）
// 约束：
// 1) 仅打包后生效（app.isPackaged），开发环境 npm start 直接短路（resources 下无 app-update.yml）；
// 2) 状态全部经 'updater:state-changed' 事件推给渲染层，由渲染层统一弹窗服务呈现，主进程不弹原生 dialog；
// 3) 发现新版不自动下载、下载完成不强制退出：避免偷跑流量与打断清理/测速/大文件扫描任务；
// 4) 更新源来自打包时自动生成的 resources/app-update.yml（build.publish 配置），不要手写、不要入库。
const { autoUpdater, CancellationToken } = require('electron-updater');
const { app } = require('electron');

let winRef = null;
let writeLog = () => {};
let cancelToken = null;
let started = false;
let checking = false;

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

// mainWindow：主窗口引用；logger：项目现有 writeLog(level, msg)
function initUpdater(mainWindow, logger) {
  if (started) return;
  started = true;
  winRef = mainWindow;
  if (typeof logger === 'function') writeLog = logger;

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
      releaseDate: info.releaseDate
    });
  });
  autoUpdater.on('update-not-available', () =>
    push({ phase: 'latest', currentVersion: String(autoUpdater.currentVersion || app.getVersion()) }));
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

// silent=true：网络失败/无新版都不打扰用户（启动后台检查用）；
// 手动检查传 false，错误态由渲染层显性提示。
async function safeCheck(silent = false) {
  if (!app.isPackaged) return { skipped: true, reason: 'dev' };
  if (checking) return { skipped: true, reason: 'already-checking' };
  checking = true;
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    writeLog('error', `[updater] 检查失败: ${e.message}`);
    if (!silent) push({ phase: 'error', message: e.message });
    return { ok: false, error: e.message };
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

module.exports = { initUpdater, safeCheck, startDownload, cancelDownload, installUpdate };
