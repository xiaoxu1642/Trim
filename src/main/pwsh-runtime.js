'use strict';
// ============================================================================
// pwsh-runtime.js —— 内置 PowerShell 7 运行时（v3.3.x，方案 A 兜底）
//
// 设计来源：update history/内置PowerShell7运行时-方案设计-2026-09-15.md
// 核心原则：随包 zip 作离线兜底、永远不删 zip、解压到 %LOCALAPPDATA%\Trim\pwsh\<version>\、
//           仅 .ready 标记存在才加入候选链、候选链末位（尊重用户自装版本）。
//
// 目录结构：
//   %LOCALAPPDATA%\Trim\pwsh\
//     ├─ 7.6.6\           ← 当前使用（内含 pwsh.exe）
//     │   └─ .ready       ← 校验通过的标记文件（含版本 + 解压时间戳）
//     └─ .extracting      ← 解压过程锁（防止并发解压）
// ============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PWSH_VERSION = '7.6.6';
const PWSH_ZIP_NAME = `PowerShell-${PWSH_VERSION}-win-x64.zip`;

// 内置 zip 的定位：打包后在 resources/pwsh/ 下，dev 形态在 vendor/pwsh/ 下
function resolveBundledZip() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'pwsh', PWSH_ZIP_NAME) : null,
    path.join(__dirname, '..', '..', 'vendor', 'pwsh', PWSH_ZIP_NAME),
    path.join(process.cwd(), 'vendor', 'pwsh', PWSH_ZIP_NAME),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).size > 0) return c; } catch (_) {}
  }
  return null;
}

// 运行时根目录：%LOCALAPPDATA%\Trim\pwsh
function runtimeRootDir() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Trim', 'pwsh');
}

// 某版本的 pwsh.exe 完整路径
function pwshExePathFor(version) {
  return path.join(runtimeRootDir(), version, 'pwsh.exe');
}

// 某版本目录的 .ready 标记路径
function readyMarkerPath(version) {
  return path.join(runtimeRootDir(), version, '.ready');
}

// 指定版本是否就绪（目录存在 + pwsh.exe 存在 + .ready 标记存在）
function isVersionReady(version) {
  const exe = pwshExePathFor(version);
  const marker = readyMarkerPath(version);
  try {
    return fs.existsSync(exe) && fs.statSync(exe).size > 0 && fs.existsSync(marker);
  } catch (_) {
    return false;
  }
}

// 找到所有已就绪版本（返回版本号数组，按 mtime 倒序，最新的在前）
function listReadyVersions() {
  const root = runtimeRootDir();
  if (!fs.existsSync(root)) return [];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const ready = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (isVersionReady(e.name)) {
        try {
          const mt = fs.statSync(readyMarkerPath(e.name)).mtimeMs;
          ready.push({ version: e.name, mtime: mt });
        } catch (_) { /* 忽略 */ }
      }
    }
    ready.sort((a, b) => b.mtime - a.mtime);
    return ready.map(r => r.version);
  } catch (_) {
    return [];
  }
}

// 取最新已就绪版本的 pwsh.exe 路径（候选链入口 ⑤ 用这个）
function latestReadyExePath() {
  const versions = listReadyVersions();
  if (!versions.length) return null;
  const exe = pwshExePathFor(versions[0]);
  return fs.existsSync(exe) ? exe : null;
}

// 写 .ready 标记
function writeReadyMarker(version) {
  const marker = readyMarkerPath(version);
  const payload = JSON.stringify({
    version,
    readyAt: new Date().toISOString(),
    source: 'bundled-zip',
  });
  fs.writeFileSync(marker, payload, 'utf8');
}

// 异步解压内置 zip 到目标版本目录；解压期间放 .extracting 锁，
// 成功后写 .ready；失败时清理半成品目录（保留 zip 本身不动）。
// onProgress(percent)  0-100，粗略值（tar 不吐进度，用阶段估）。
function extractBundledRuntime({ onProgress, isPwsh7Executable } = {}) {
  return new Promise((resolve, reject) => {
    const zipPath = resolveBundledZip();
    if (!zipPath) {
      reject(new Error('未找到内置 PowerShell 7 zip 包'));
      return;
    }
    const rootDir = runtimeRootDir();
    const versionDir = path.join(rootDir, PWSH_VERSION);
    const lockFile = path.join(rootDir, '.extracting');

    try {
      if (!fs.existsSync(rootDir)) {
        fs.mkdirSync(rootDir, { recursive: true });
      }
      // 解压互斥：已有另一处在解压则直接等（这里不做事件通知，直接返回 pending 态）
      if (fs.existsSync(lockFile)) {
        resolve({ status: 'already-extracting' });
        return;
      }
      // 已就绪则直接返回
      if (isVersionReady(PWSH_VERSION)) {
        resolve({ status: 'already-ready', version: PWSH_VERSION, exe: pwshExePathFor(PWSH_VERSION) });
        return;
      }
      // 清掉半成品（上次解压被打断的残留）
      if (fs.existsSync(versionDir)) {
        try { fs.rmSync(versionDir, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
      }
      fs.mkdirSync(versionDir, { recursive: true });
      fs.writeFileSync(lockFile, String(Date.now()), 'utf8');
    } catch (e) {
      reject(new Error(`无法创建运行时目录: ${e.message}`));
      return;
    }

    if (onProgress) onProgress(5);

    // 用 tar.exe 解压（bsdtar，Win10 1803+ 自带，速度快且无长路径问题）
    let child;
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      try { fs.unlinkSync(lockFile); } catch (_) {}
      if (err) {
        // 失败清理半成品
        try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
        reject(err);
      } else {
        resolve(result);
      }
    };

    try {
      child = spawn('tar.exe', ['-xf', zipPath, '-C', versionDir], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish(new Error(`无法启动 tar.exe: ${e.message}`));
      return;
    }

    // tar 没有原生进度，用阶段估：0-70% 解压、70-90% 校验、90-100% 写标记
    let progressTimer = setInterval(() => {
      if (onProgress) onProgress(10 + Math.floor(Math.random() * 55));
    }, 800);

    child.on('error', (err) => {
      clearInterval(progressTimer);
      finish(new Error(`tar.exe 启动失败: ${err.message}`));
    });
    child.on('close', (code) => {
      clearInterval(progressTimer);
      if (code !== 0) {
        finish(new Error(`tar.exe 解压失败，退出码 ${code}`));
        return;
      }
      if (onProgress) onProgress(75);

      // 校验：pwsh.exe 必须存在且非 0 字节
      const exe = pwshExePathFor(PWSH_VERSION);
      if (!fs.existsSync(exe) || fs.statSync(exe).size === 0) {
        finish(new Error('解压完成但 pwsh.exe 不存在，包可能损坏'));
        return;
      }
      if (onProgress) onProgress(85);

      // 调用方传进来的 pwsh 可执行性校验（带超时参数）
      if (typeof isPwsh7Executable === 'function') {
        try {
          const ok = isPwsh7Executable(exe, 15000);
          if (!ok) {
            finish(new Error('解压后 pwsh.exe 无法运行（可能被安全软件拦截）'));
            return;
          }
        } catch (e) {
          finish(new Error(`pwsh 校验异常: ${e.message}`));
          return;
        }
      }
      if (onProgress) onProgress(95);

      try {
        writeReadyMarker(PWSH_VERSION);
      } catch (e) {
        finish(new Error(`写入 .ready 标记失败: ${e.message}`));
        return;
      }
      if (onProgress) onProgress(100);
      finish(null, { status: 'ready', version: PWSH_VERSION, exe });
    });
  });
}

// 清理旧版本：保留当前版 + 上一版，其余删除（避免占用无限膨胀）
function cleanupOldVersions(keepVersions = []) {
  const root = runtimeRootDir();
  if (!fs.existsSync(root)) return { removed: 0 };
  try {
    const ready = listReadyVersions();
    const keep = new Set([...keepVersions, ...ready.slice(0, 2)]);
    let removed = 0;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (keep.has(e.name)) continue;
      try {
        fs.rmSync(path.join(root, e.name), { recursive: true, force: true, maxRetries: 3 });
        removed++;
      } catch (_) { /* 忽略删不掉的（可能正被占用）*/ }
    }
    return { removed };
  } catch (_) {
    return { removed: 0 };
  }
}

module.exports = {
  PWSH_VERSION,
  PWSH_ZIP_NAME,
  resolveBundledZip,
  runtimeRootDir,
  pwshExePathFor,
  isVersionReady,
  listReadyVersions,
  latestReadyExePath,
  extractBundledRuntime,
  cleanupOldVersions,
  writeReadyMarker,
};
