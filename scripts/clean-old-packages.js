// scripts/clean-old-packages.js — 构建后自动清理旧版本安装包（v2.7.1 起，postbuild 钩子）
// 政策（用户裁定）：每次构建新包后，build-release/ 里所有非当前版本的安装包全部移除。
// 删除方式：回收站优先（可还原，与用户此前的清理偏好一致）；回收站不可用时降级永久删除并告警。
// 范围：仅匹配 Trim-Setup-<ver>.exe / Trim-Portable-<ver>.exe 及其 .blockmap；
//       latest.yml / builder-debug.yml / win-unpacked/ / cdp-shots/ 等当前构建产物不动。
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build-release');
const CURRENT = require(path.join(ROOT, 'package.json')).version;
const PKG_RE = /^(Trim-Setup|Trim-Portable)-(\d+\.\d+\.\d+)\.exe(\.blockmap)?$/;

function recycleOrDelete(file) {
  // 回收站：PowerShell VisualBasic FileSystem（SendToRecycleBin），与手动清理同路
  try {
    const ps = 'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
      `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile("${file.replace(/"/g, '')}", "OnlyErrorDialogs", "SendToRecycleBin")`;
    execFileSync('pwsh', ['-NoProfile', '-Command', ps], { stdio: 'pipe', timeout: 30000 });
    return 'recycled';
  } catch (e) {
    try {
      fs.rmSync(file, { force: true });
      return 'deleted';
    } catch (e2) {
      return 'failed';
    }
  }
}

if (!fs.existsSync(OUT_DIR)) process.exit(0);
const removed = [];
const failed = [];
for (const name of fs.readdirSync(OUT_DIR)) {
  const m = PKG_RE.exec(name);
  if (!m) continue;
  if (m[2] === CURRENT) continue; // 当前版本产物保留
  const outcome = recycleOrDelete(path.join(OUT_DIR, name));
  if (outcome === 'failed') failed.push(name);
  else removed.push(`${name}（${outcome === 'recycled' ? '已入回收站' : '已永久删除'}）`);
}
if (removed.length) console.log('已清理旧版本安装包：\n  ' + removed.join('\n  '));
else console.log('无旧版本安装包需要清理。');
if (failed.length) {
  console.warn('以下文件清理失败（占用/权限），请手动处理：' + failed.join(', '));
  process.exitCode = 1; // 不阻塞构建结果，但让失败可见
}
