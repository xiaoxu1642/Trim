// Motion.Lab-inspired cursor trail（鼠标拖尾）
// 软件范围内轻量紫色光点轨迹：节流生成、CSS 过渡淡出、双重保障移除节点。
(function () {
  'use strict';

  const KEY = 'winclean-mouse-trail';
  const THROTTLE_MS = 22;      // 生成节流
  const FADE_MS = 520;         // 与 main.css 的过渡时长保持一致
  const reduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let enabled = false;
  let layer = null;
  let last = 0;

  function readEnabled() {
    try { return localStorage.getItem(KEY) === 'true'; } catch (_) { return false; }
  }
  function writeEnabled(value) {
    try { localStorage.setItem(KEY, String(value)); } catch (_) {}
  }
  function ensureLayer() {
    if (layer && document.body.contains(layer)) return layer;
    layer = document.createElement('div');
    layer.className = 'mouse-trail-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
    return layer;
  }
  function setEnabled(value) {
    enabled = !reduced && Boolean(value);
    document.body.classList.toggle('mouse-trail-on', enabled);
    const toggle = document.getElementById('mouseTrailToggle');
    if (toggle) toggle.checked = enabled;
    if (!enabled && layer) {
      // C6：关闭时彻底移除图层（原来只清空光点，空 div 一直挂在 DOM 里）
      layer.remove();
      layer = null;
    }
  }
  function spawn(x, y) {
    if (!enabled) return;
    const now = performance.now();
    if (now - last < THROTTLE_MS) return;
    last = now;
    const host = ensureLayer();
    const dot = document.createElement('span');
    dot.className = 'mouse-trail-dot';
    const size = 4 + Math.random() * 4;
    dot.style.width = size + 'px';
    dot.style.height = size + 'px';
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    host.appendChild(dot);

    const remove = () => { if (dot.parentNode) dot.remove(); };
    dot.addEventListener('transitionend', remove, { once: true });
    // 兜底：过渡被跳过（后台窗口、极端节流）时仍能回收节点，杜绝 DOM 累积
    setTimeout(remove, FADE_MS + 260);
    // 强制回流，确保初始态被绘制后再切到淡出态，否则 transition 不会触发
    void dot.offsetWidth;
    dot.classList.add('is-fading');
  }
  function init() {
    setEnabled(readEnabled());
    document.addEventListener('pointermove', (e) => spawn(e.clientX, e.clientY), { passive: true });
    const toggle = document.getElementById('mouseTrailToggle');
    toggle && toggle.addEventListener('change', () => {
      writeEnabled(toggle.checked);
      setEnabled(toggle.checked);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
  window.mouseTrail = { setEnabled, isEnabled: () => enabled };
})();
