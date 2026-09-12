// cdp-close-v27.js — 验证「关闭即隐」：触发 window.close() → 窗口隐藏 → 进程自动退出
// 同时抓一张 FLIP 落位中途截图（reload 进入首访模式后 300ms 采样）
'use strict';
const fs = require('fs');
const path = require('path');

const PORT = 9333;

function httpGetJson(urlPath) {
  return new Promise((resolve, reject) => {
    require('http').get({ host: '127.0.0.1', port: PORT, path: urlPath }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', e => reject(new Error('WS 连接失败')));
  });
}

let seq = 0;
function send(ws, method, params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) { ws.removeEventListener('message', onMsg); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error('RPC 超时')); }, timeoutMs);
  });
}

async function evaluate(ws, expr, awaitPromise = false) {
  const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result && r.result.value;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const targets = await httpGetJson('/json');
  const page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error('未找到主窗口 target');
  const ws = await connect(page.webSocketDebuggerUrl);

  // 抓落位中途帧：清 seen → reload → 等点击进入 → 点击 → 320ms 后截图
  try {
    fs.rmSync(path.join(__dirname, '..', 'build-release', 'cdp-shots'), { recursive: true, force: true });
    fs.mkdirSync(path.join(__dirname, '..', 'build-release', 'cdp-shots'), { recursive: true });
    await evaluate(ws, "localStorage.removeItem('trim_splash_seen'); location.reload(); true");
    await sleep(3200);
    await evaluate(ws, "(() => { const b = document.getElementById('splash-enter'); if (b && !b.hidden) b.click(); return true; })()");
    await sleep(320);
    const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, '..', 'build-release', 'cdp-shots', 'splash-morphing.png'), Buffer.from(shot.data, 'base64'));
    console.log('PASS  已抓取 FLIP 落位中途截图（320ms）');
    // 等动画完成并恢复 seen 清理
    await sleep(1600);
    await evaluate(ws, "localStorage.removeItem('trim_splash_seen'); localStorage.removeItem('winclean-checkup-ignored'); true");
  } catch (e) {
    console.log('WARN  截图阶段：' + e.message);
  }

  // 关闭即隐：window.close() → close 钩子隐藏窗口 → 后台清理 → 进程退出
  let hidden = false;
  try {
    // Page.captureScreenshot 对 hidden 窗口会失败——先标记当前可截图，关闭后再截应失败
    await evaluate(ws, "window.close(); true");
    await sleep(500);
    try {
      await send(ws, 'Page.captureScreenshot', { format: 'png' });
      hidden = false; // 仍可截图 = 窗口未隐藏（旧流程表现）
    } catch (e) {
      hidden = true;  // 不可截图 ≈ 窗口已隐藏/销毁
    }
  } catch (e) {
    // window.close() 后 WS 可能立刻断开（进程快速退出）——也视为符合「立即关闭」
    hidden = true;
  }
  console.log((hidden ? 'PASS' : 'FAIL') + '  点击关闭后窗口立即隐藏/销毁');

  // 等待进程自动退出（before-quit 清理：日志刷盘 + taskkill 子进程 + 临时脚本清理）
  const { execFileSync } = require('child_process');
  let exited = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe'], { encoding: 'utf8' });
      if (!/electron\.exe/i.test(out)) { exited = true; break; }
    } catch (e) { exited = true; break; }
  }
  console.log((exited ? 'PASS' : 'FAIL') + '  后台静默收尾后进程自动退出（10s 内）');
  process.exit(hidden && exited ? 0 : 1);
})().catch(e => { console.error('PROBE-ERROR:', e.message); process.exit(2); });
