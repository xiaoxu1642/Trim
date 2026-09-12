// cdp-probe-v26.js — v2.6.0 渲染层 CDP 真机验证（临时脚本，验证后删除）
// 用法：node scripts/cdp-probe-v26.js
// 依赖：Electron 已以 --remote-debugging-port=9333 启动
'use strict';
const fs = require('fs');
const path = require('path');

const PORT = 9333;
const SHOT_DIR = path.join(__dirname, '..', 'build-release', 'cdp-shots');

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
function send(ws, method, params) {
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
    setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error('RPC 超时: ' + method)); }, 30000);
  });
}

async function evaluate(ws, expr, awaitPromise = false) {
  const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result && r.result.value;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const targets = await httpGetJson('/json');
  const page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error('未找到主窗口页面 target: ' + JSON.stringify(targets.map(t => t.url)));
  const ws = await connect(page.webSocketDebuggerUrl);
  const results = [];
  const log = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  -> ' + detail : '')); };

  // 0. 记录当前页面偏好（测完恢复）
  const savedPage = await evaluate(ws, "localStorage.getItem('winclean-active-page')");

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  async function shot(name) {
    const r = await send(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, name + '.png'), Buffer.from(r.data, 'base64'));
  }

  // 1. 导航与页头：系统体检
  await evaluate(ws, "window.app && window.app.switchPage ? window.app.switchPage('overview') : (location.hash='')");
  await sleep(1200);
  const navText = await evaluate(ws, "document.querySelector('.nav-item[data-page=overview] span') && document.querySelector('.nav-item[data-page=overview] span').textContent");
  const pageTitle = await evaluate(ws, "document.querySelector('#page-overview .page-title') && document.querySelector('#page-overview .page-title').textContent");
  log('导航/页头改为「系统体检」', navText === '系统体检' && pageTitle === '系统体检', `nav=${navText}, title=${pageTitle}`);

  // 2. 体检清单渲染（进页自动体检，主进程 5 分钟缓存；首跑需等 PS，放宽到 60s）
  let checkup = null;
  for (let i = 0; i < 40; i++) {
    checkup = await evaluate(ws, `(() => {
      const root = document.getElementById('ovCheckupList');
      if (!root) return null;
      const rows = root.querySelectorAll('.checkup-row');
      if (!rows.length) return { count: 0 };
      return { count: rows.length,
        statuses: [...rows].map(r => r.getAttribute('data-status')).join(','),
        firstTitle: (root.querySelector('.checkup-row-title') || {}).textContent || '',
        firstEvidence: (root.querySelector('.checkup-row-evidence') || {}).textContent || '',
        hasBadge: !!root.querySelector('.ds-badge') };
    })()`);
    if (checkup && checkup.count > 0) break;
    await sleep(1500);
  }
  log('体检清单渲染 ≥9 条', !!checkup && checkup.count >= 9, JSON.stringify(checkup));
  log('体检行含状态徽章与证据等级', !!checkup && checkup.hasBadge && !!checkup.firstEvidence, JSON.stringify(checkup && checkup.firstTitle));
  await shot('overview-checkup');

  // 3. 重新体检按钮存在
  const rerunBtn = await evaluate(ws, "!!document.getElementById('btnCheckupRerun')");
  log('「重新体检」按钮挂载', rerunBtn === true);

  // 4. 优化中心：effect 徽章 + 弹窗
  await evaluate(ws, "window.app.switchPage('optimizer')");
  await sleep(2500);
  const optReady = await evaluate(ws, `(() => {
    const rows = document.querySelectorAll('#optimizerGroups .opt-row');
    return rows.length;
  })()`);
  log('优化中心条目渲染', optReady > 100, 'rows=' + optReady);
  // 点第一行打开弹窗
  const modalInfo = await evaluate(ws, `(() => {
    const row = document.querySelector('#optimizerGroups .opt-row');
    if (!row) return null;
    row.click();
    return true;
  })()`);
  await sleep(600);
  const modal = await evaluate(ws, `(() => {
    const m = document.querySelector('.opt-modal-backdrop');
    if (!m || !m.classList.contains('open')) return null;
    const meta = (m.querySelector('.opt-modal-meta') || {}).textContent || '';
    const hint = (m.querySelector('.opt-modal-effect-hint') || {}).textContent || '';
    return { meta, hintOpen: m.querySelector('.opt-modal-effect-hint') ? m.querySelector('.opt-modal-effect-hint').textContent.length > 0 : false, hint };
  })()`);
  log('详情弹窗打开', !!modal);
  log('弹窗含「效果·」徽章', !!modal && /效果·(明显|一般|微小|未验证)/.test(modal.meta), modal && modal.meta);
  log('预期效果说明行渲染', !!modal && modal.hintOpen && /经验分级/.test(modal.hint));
  await evaluate(ws, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); const c=document.querySelector('.opt-modal-close'); c && c.click();");
  await sleep(400);
  await shot('optimizer-modal');

  // 5. 未还原横幅：结构存在（无 stale 项时应隐藏）
  const stale = await evaluate(ws, `(() => {
    const b = document.getElementById('optimizerStaleBanner');
    return { exists: !!b, hidden: b ? b.style.display === 'none' : false, text: (document.getElementById('optimizerStaleText') || {}).textContent || '' };
  })()`);
  log('未还原横幅结构存在且默认隐藏', stale.exists && stale.hidden, JSON.stringify(stale));

  // 6. 设置页：镜像下拉（主进程动态渲染）+ 便携行
  await evaluate(ws, "window.app.switchPage('settings')");
  await sleep(800);
  let mirror = null;
  for (let i = 0; i < 10; i++) {
    mirror = await evaluate(ws, `(() => {
      const sel = document.getElementById('updaterMirrorSelect');
      if (!sel) return null;
      if (sel.options.length <= 1) return { opts: sel.options.length };
      return { opts: sel.options.length, labels: [...sel.options].map(o => o.textContent).join('|'), value: sel.value };
    })()`);
    if (mirror && mirror.opts > 2) break;
    await sleep(500);
  }
  log('镜像下拉含 4 条线路', !!mirror && mirror.opts === 4, JSON.stringify(mirror));
  const portableRow = await evaluate(ws, "(document.getElementById('infoPortable') || {}).textContent || ''");
  log('系统信息「数据目录」行渲染', /标准安装|便携模式/.test(portableRow), portableRow);
  await shot('settings');

  // 恢复页面偏好
  await evaluate(ws, `localStorage.setItem('winclean-active-page', ${JSON.stringify(savedPage === null ? null : savedPage)}); true`);

  const failed = results.filter(r => !r.ok).length;
  console.log(`\nCDP 验证结果: ${results.length - failed}/${results.length} 通过`);
  ws.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('PROBE-ERROR:', e.message); process.exit(2); });
