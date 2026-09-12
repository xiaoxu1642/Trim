// cdp-probe-v27.js — v2.7.0 渲染层 CDP 真机验证（临时脚本，验证后删除）
// 覆盖：启动页 FLIP 落位（定时采样 transform）/ 体检去处理+忽略 / detected 持久化 / 关闭即隐
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9333;
const STATE_FILE = path.join(os.homedir(), 'AppData', 'Roaming', 'Trim', 'optimization-state.json');

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
    ws.addEventListener('error', e => reject(new Error('WS 连接失败: ' + (e.message || e))));
  });
}

let seq = 0;
function send(ws, method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.removeEventListener('message', onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error('RPC 超时: ' + method)); }, timeoutMs);
  });
}

async function evaluate(ws, expr, awaitPromise = false) {
  const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result && r.result.value;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const targets = await httpGetJson('/json');
  const page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error('未找到主窗口 target');
  const ws = await connect(page.webSocketDebuggerUrl);
  const results = [];
  const log = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  -> ' + detail : '')); };

  const savedPage = await evaluate(ws, "localStorage.getItem('winclean-active-page')");

  // 自恢复：若连到已进场的旧实例页面（splash 已移除），清 seen 后重载，保证测到首访路径
  const pre = await evaluate(ws, "!!document.getElementById('splash')");
  if (!pre) {
    await evaluate(ws, "localStorage.removeItem('trim_splash_seen'); location.reload(); true");
    await sleep(2500);
  }

  // ===== 1. 启动页：首访模式（结构 + 标题栏隐藏 + 进度推进） =====
  const splash0 = await evaluate(ws, `(() => {
    const s = document.getElementById('splash');
    const t = document.querySelector('.titlebar-title');
    return { exists: !!s, compact: s ? s.classList.contains('compact') : null,
      titleHidden: t ? getComputedStyle(t).visibility === 'hidden' : null,
      firstRun: localStorage.getItem('trim_splash_seen') !== '1' };
  })()`);
  log('启动页挂载且标题栏品牌暂隐', splash0.exists && splash0.titleHidden && splash0.firstRun, JSON.stringify(splash0));

  // 等进度完成出现「点击进入」，点击后采样 FLIP transform
  let clicked = false;
  for (let i = 0; i < 30; i++) {
    const st = await evaluate(ws, "(() => { const b = document.getElementById('splash-enter'); return b ? { hidden: b.hidden, op: getComputedStyle(b).opacity } : null; })()");
    if (st && !st.hidden && Number(st.op) > 0.5) { clicked = true; break; }
    await sleep(300);
  }
  log('首访进度完成出现「点击进入」', clicked);

  // 页面内时钟采样：一次 evaluate 抓 t0 + 4 个中间帧，排除 WS 往复抖动
  const series = await evaluate(ws, `new Promise((resolve) => {
    const el = document.getElementById('splash-trim');
    const vals = [];
    const grab = (label) => { vals.push({ label, tf: getComputedStyle(el).transform }); };
    grab('t0');
    document.getElementById('splash-enter').click();
    [150, 350, 550, 750].forEach((ms) => setTimeout(() => grab('t' + ms), ms));
    setTimeout(() => resolve(vals), 1050);
  })`, true);
  const uniq = [...new Set(series.map(s => s.tf))];
  log('FLIP 落位动画有位移/缩放采样变化', uniq.length >= 3, `${series.length} 帧 / ${uniq.length} 种 transform，首=${series[0].tf.slice(0, 40)} 末=${series[series.length - 1].tf.slice(0, 40)}`);

  // 落位完成后：启动页移除 + 标题栏品牌可见
  await sleep(800);
  const splashEnd = await evaluate(ws, `(() => ({
    gone: !document.getElementById('splash'),
    titleVisible: getComputedStyle(document.querySelector('.titlebar-title')).visibility === 'visible',
    seen: localStorage.getItem('trim_splash_seen') === '1'
  }))()`);
  log('落位完成：启动页移除、标题栏品牌显现、seen 已记录', splashEnd.gone && splashEnd.titleVisible && splashEnd.seen, JSON.stringify(splashEnd));

  // ===== 2. 体检页：bad/warn 行按钮 + 忽略持久化 + 恢复 + 跳转 =====
  await evaluate(ws, "window.app.switchPage('overview')");
  await sleep(1500);
  let checkup = null;
  for (let i = 0; i < 40; i++) {
    checkup = await evaluate(ws, `(() => {
      const root = document.getElementById('ovCheckupList');
      const rows = root ? root.querySelectorAll('.checkup-row') : [];
      if (!rows.length) return null;
      const actionRows = root.querySelectorAll('.checkup-row[data-status="bad"] .checkup-btn, .checkup-row[data-status="warn"] .checkup-btn');
      const ignoreBtns = root.querySelectorAll('[data-checkup-ignore]');
      const jumpBtns = root.querySelectorAll('[data-checkup-jump]');
      return { rows: rows.length, actionBtns: actionRows.length, ignoreBtns: ignoreBtns.length, jumpBtns: jumpBtns.length };
    })()`);
    if (checkup && checkup.rows > 0) break;
    await sleep(1500);
  }
  log('体检条目渲染且 bad/warn 行带按钮', !!checkup && checkup.rows > 0 && checkup.ignoreBtns > 0 && checkup.jumpBtns > 0, JSON.stringify(checkup));

  // 忽略第一条 bad/warn → 行数减少 + localStorage 记录
  const before = await evaluate(ws, "document.querySelectorAll('#ovCheckupList .checkup-row').length");
  const ignoredId = await evaluate(ws, `(() => {
    const btn = document.querySelector('[data-checkup-ignore]');
    if (!btn) return null;
    const id = btn.dataset.checkupIgnore;
    btn.click();
    return id;
  })()`);
  await sleep(300);
  const after = await evaluate(ws, `(() => ({
    rows: document.querySelectorAll('#ovCheckupList .checkup-row').length,
    ignored: JSON.parse(localStorage.getItem('winclean-checkup-ignored') || '[]')
  }))()`);
  log('忽略后条目消失且持久化', before > after.rows && Array.isArray(after.ignored) && after.ignored.includes(ignoredId), `${before}→${after.rows}, id=${ignoredId}`);

  // 恢复入口
  const restored = await evaluate(ws, `(() => {
    const link = document.getElementById('checkupIgnoredRestore');
    if (!link) return null;
    link.click();
    return true;
  })()`);
  await sleep(300);
  const restoredRows = await evaluate(ws, "document.querySelectorAll('#ovCheckupList .checkup-row').length");
  const ignoredNow = await evaluate(ws, "JSON.parse(localStorage.getItem('winclean-checkup-ignored') || '[]').length");
  log('恢复入口还原忽略条目', restored === true && restoredRows === before && ignoredNow === 0, `${restoredRows}/${before}`);

  // 去处理跳转
  const jumpResult = await evaluate(ws, `(() => {
    const btn = document.querySelector('[data-checkup-jump]');
    if (!btn) return null;
    const from = document.querySelector('.page.active') && document.querySelector('.page.active').id;
    btn.click();
    return { from, btn: btn.dataset.checkupJump };
  })()`);
  await sleep(600);
  const activePage = await evaluate(ws, "(document.querySelector('.page.active') || {}).id || ''");
  log('「去处理」跳转对应功能页', !!jumpResult && activePage === 'page-' + jumpResult.btn, JSON.stringify({ jumpResult, activePage }));

  // ===== 3. detected 持久化：等主进程 3s 首启扫描落盘 =====
  let stateFile = null;
  for (let i = 0; i < 20; i++) {
    try {
      if (fs.existsSync(STATE_FILE)) {
        stateFile = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (stateFile.detected && Object.keys(stateFile.detected).length > 0) break;
      }
    } catch (e) {}
    await sleep(1000);
  }
  log('optimization-state.json 含 detected 段（首启扫描持久化）',
    !!stateFile && !!stateFile.detected && Object.keys(stateFile.detected).length > 0,
    stateFile ? `detected=${Object.keys(stateFile.detected).length} 项, items=${Object.keys(stateFile.items || {}).length} 条` : '文件未生成');

  // ===== 清理：恢复本探针改过的偏好 =====
  await evaluate(ws, `localStorage.setItem('winclean-active-page', ${JSON.stringify(savedPage === null ? null : savedPage)});
    localStorage.removeItem('winclean-checkup-ignored');
    localStorage.removeItem('trim_splash_seen'); true`);

  console.log(`\nCDP 验证结果: ${results.filter(r => r.ok).length}/${results.length} 通过（接下来验证关闭即隐）`);
  ws.close();
  process.exit(results.every(r => r.ok) ? 0 : 1);
})().catch(e => { console.error('PROBE-ERROR:', e.message); process.exit(2); });
