// cdp-probe-v28.js — v2.8.0 渲染层 CDP 真机验证（临时脚本，验证后删除）
// 覆盖：壁纸预设与轮换引擎 / 玻璃噪点层 / 环境自适应 / 兼容性提示行 / 无回归
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
function send(ws, method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) { ws.removeEventListener('message', onMsg); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); }
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
  const savedAppearance = await evaluate(ws, "localStorage.getItem('winclean-appearance')");

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  async function shot(name) {
    const r = await send(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, name + '.png'), Buffer.from(r.data, 'base64'));
  }

  // ===== 1. 壁纸预设 =====
  await evaluate(ws, "window.app.switchPage('settings')");
  await sleep(800);
  const wpSet = await evaluate(ws, `(() => {
    const sel = document.getElementById('presetBgSelect');
    if (!sel) return null;
    sel.value = 'wp-winter';
    sel.dispatchEvent(new Event('change'));
    return { value: sel.value, dataset: document.body.dataset.presetBg || '' };
  })()`);
  log('实拍壁纸预设可选且生效', !!wpSet && wpSet.value === 'wp-winter' && wpSet.dataset === 'wp-winter', JSON.stringify(wpSet));
  await sleep(400);
  const bgImage = await evaluate(ws, `(() => {
    const el = document.querySelector('.layout::before') ? null : null;
    // 伪元素需用 getComputedStyle(el, '::before')
    const cs = getComputedStyle(document.querySelector('.layout'), '::before');
    return { img: cs.backgroundImage || '', display: cs.display };
  })()`);
  log('壁纸底层图已铺（::before 背景图指向内嵌资源）', /wp-winter\.jpg/.test(bgImage.img), bgImage.img.slice(0, 80));
  await shot('wallpaper-winter');

  // ===== 2. 轮换引擎 =====
  const rotOn = await evaluate(ws, `(() => {
    const t = document.getElementById('wallpaperRotateToggle');
    const s = document.getElementById('wallpaperIntervalSelect');
    if (!t || !s) return null;
    t.checked = true;
    t.dispatchEvent(new Event('change'));
    s.value = '10';
    s.dispatchEvent(new Event('change'));
    return { checked: t.checked, interval: s.value, preset: document.body.dataset.presetBg };
  })()`);
  log('轮换开关开启并落到首张壁纸', !!rotOn && rotOn.checked && rotOn.preset === 'wp-winter', JSON.stringify(rotOn));
  // 等 11s：10s 间隔应已切到下一张（列表顺序 winter→mountain）
  await sleep(11200);
  const rotNext = await evaluate(ws, "document.body.dataset.presetBg || ''");
  log('10s 轮换切到下一张（mountain）', rotNext === 'wp-mountain', 'preset=' + rotNext);
  const apRot = await evaluate(ws, "JSON.parse(localStorage.getItem('winclean-appearance') || '{}').wallpaperRotate");
  log('轮换开关状态已持久化', apRot === '1', 'wallpaperRotate=' + apRot);
  // 关闭轮换
  await evaluate(ws, "(() => { const t = document.getElementById('wallpaperRotateToggle'); t.checked = false; t.dispatchEvent(new Event('change')); return true; })()");
  await sleep(200);
  const rotOff = await evaluate(ws, "JSON.parse(localStorage.getItem('winclean-appearance') || '{}').wallpaperRotate");
  log('轮换可关闭且持久化', rotOff === '', 'wallpaperRotate=' + JSON.stringify(rotOff));

  // ===== 3. 液态玻璃：噪点层 + 环境自适应 =====
  const lgEnv = await evaluate(ws, `(() => {
    if (!window.liquidBar) return null;
    window.liquidBar.setMode('full');
    const d = window.liquidBar.debug();
    return d;
  })()`);
  log('玻璃引擎 full 档诊断含环境字段', !!lgEnv && !!lgEnv.env, JSON.stringify(lgEnv && lgEnv.env));
  // full 档滤镜链含 feTurbulence（噪点层）——只统计实际被元素引用的滤镜。
  // 注意：序列化 backdropFilter 带引号 url("#lg-f-x")（AGENTS 陷阱），正则需容引号
  const collectUsed = `(() => {
    const used = new Set();
    document.querySelectorAll('[style*="lg-f-"]').forEach(el => {
      const m = /url\\(["']?#(lg-f-[^)"']+)["']?\\)/.exec(el.style.backdropFilter || '');
      if (m) used.add(m[1]);
    });
    let total = 0, hasNoise = false;
    used.forEach(id => {
      const f = document.getElementById(id);
      if (f) { total++; if (f.querySelector('feTurbulence')) hasNoise = true; }
    });
    return { total, hasNoise };
  })()`;
  const noise = await evaluate(ws, collectUsed);
  log('full 档滤镜链已挂噪点层（feTurbulence）', noise.total > 0 && noise.hasNoise, JSON.stringify(noise));
  await evaluate(ws, "window.liquidBar.setMode('standard')");
  const noiseOff = await evaluate(ws, collectUsed);
  log('standard 档无噪点层（性能护栏）', noiseOff.hasNoise === false && noiseOff.total > 0, JSON.stringify(noiseOff));

  // ===== 4. 兼容性提示行（本机无注入工具 → 隐藏） =====
  const diag = await evaluate(ws, `(() => {
    const row = document.getElementById('diagDwmRow');
    return { visible: row && row.style.display !== 'none' };
  })()`);
  log('兼容性提示行默认隐藏（未检出注入工具）', diag && diag.visible === false, JSON.stringify(diag));

  // ===== 5. 无回归：主界面截图目检 =====
  await evaluate(ws, "window.app.switchPage('overview')");
  await sleep(1000);
  await shot('v28-overview');

  // ===== 清理：恢复偏好 =====
  await evaluate(ws, `localStorage.setItem('winclean-active-page', ${JSON.stringify(savedPage === null ? null : savedPage)});
    localStorage.setItem('winclean-appearance', ${JSON.stringify(savedAppearance === null ? '' : savedAppearance)});
    location.reload(); true`);
  await sleep(1500);

  console.log(`\nCDP 验证结果: ${results.filter(r => r.ok).length}/${results.length} 通过`);
  ws.close();
  process.exit(results.every(r => r.ok) ? 0 : 1);
})().catch(e => { console.error('PROBE-ERROR:', e.message); process.exit(2); });
