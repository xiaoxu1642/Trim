// theme.js - 主题管理（深色/浅色模式）
// 支持：系统跟随 + 手动切换 + Electron 原生 Mica 检测 + 主进程主题同步
(function () {
  'use strict';

  const STORAGE_KEY = 'winclean-theme';
  const IS_ELECTRON = !!window.api?.app;

  function getStoredTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'auto';
    } catch (e) {
      return 'auto';
    }
  }

  function setStoredTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) {}
  }

  function getSystemTheme() {
    // Electron 模式：主进程的 nativeTheme 更准确（反映 AppsUseLightTheme），但同步调用
    // 不可用——这里用 matchMedia 作渲染进程近似，主进程经 app:theme-changed 主动推送准确值
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  // 应用 Mica 模式（Electron + Windows 11 时背景透明，让原生 Mica 透出）
  function applyMicaMode(enabled) {
    document.body.classList.toggle('electron-mica', enabled);
  }

  function applyTheme(theme) {
    const resolved = theme === 'auto' ? getSystemTheme() : theme;
    document.body.classList.remove('theme-dark', 'theme-light');
    document.body.classList.add('theme-' + resolved);

    // 标题栏是独立系统表面，不跟随应用主题。
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#f3f3f3');

    ensureRingGradientDef();

    // 同步设置页的单选按钮状态
    document.querySelectorAll('input[name="theme"]').forEach(radio => {
      radio.checked = radio.value === theme;
    });
  }

  // 审查 7-2：名实一致——本函数只在首次调用时创建 defs（之后幂等返回），非每次更新
  // 审查 5-2：环形进度渐变改走强调色 token（两 stop 同色保 url() 引用结构），主题/强调色切换自动跟随
  function ensureRingGradientDef() {
    let defs = document.getElementById('ringGradientDef');
    if (!defs) {
      defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      defs.setAttribute('width', '0');
      defs.setAttribute('height', '0');
      defs.style.position = 'absolute';
      defs.innerHTML = '<defs><linearGradient id="ringGradient" x1="0%" y1="0%" x2="100%" y2="100%">' +
        '<stop offset="0%" stop-color="var(--accent, #8B8EE0)"/>' +
        '<stop offset="100%" stop-color="var(--accent, #8B8EE0)"/>' +
        '</linearGradient></defs>';
      defs.id = 'ringGradientDef';
      document.body.appendChild(defs);
    }
  }

  function toggle() {
    const current = document.body.classList.contains('theme-light') ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    setStoredTheme(next);
    applyTheme(next);
    if (window.app?.toast) {
      window.app.toast('info', `已切换到${next === 'dark' ? '深色' : '浅色'}主题`);
    }
  }

  // 监听系统主题变化（浏览器模式）
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const stored = getStoredTheme();
      if (stored === 'auto') applyTheme('auto');
    });
  }

  // Electron 模式：监听主进程推送的主题变化（nativeTheme，最准确）
  if (window.api?.app?.onThemeChanged) {
    window.api.app.onThemeChanged((theme) => {
      const stored = getStoredTheme();
      if (stored === 'auto') applyTheme(theme);
    });
  }

  window.theme = {
    apply: applyTheme,
    toggle,
    getStored: getStoredTheme,
    setStored: setStoredTheme,
    applyMicaMode
  };

  // 全局应用「设计系统」外观（背景模糊度 + 预设背景）：跨页面/启动即生效，
  // 与设置页共用 localStorage 键 'winclean-appearance'，避免仅设置页生效。
  function applySkinAndPreset() {
    let ap = {};
    try { ap = JSON.parse(localStorage.getItem('winclean-appearance') || '{}') || {}; } catch (e) {}
    // 背景模糊度（设置页整合4）：>0 挂 body[data-skin="glass"] 并按百分比缩放模糊半径
    // （100% = 26px，与原液态玻璃一致；与 pathbinding.js 的 GLASS_MAX_BLUR_PX 共用同一约定，
    // 改动需两处同步）；0% = 经典不透明面板。旧 skin 键按 glass=100% / classic=0% 折算迁移。
    let blur = ap.bgBlur;
    if (blur == null) {
      blur = ap.skin === 'glass' ? 100 : 0;
      ap.bgBlur = blur;
      delete ap.skin;
      try { localStorage.setItem('winclean-appearance', JSON.stringify(ap)); } catch (e) {}
    }
    if (blur > 0) {
      document.body.dataset.skin = 'glass';
      // 审查 5-5：上限与 pathbinding 共用 ds 常量（GLASS_MAX_BLUR_PX），消除两处硬编码漂移
      document.documentElement.style.setProperty('--glass-blur', (blur / 100 * (window.ds?.GLASS_MAX_BLUR_PX || 26)).toFixed(1) + 'px');
    } else {
      delete document.body.dataset.skin;
      document.documentElement.style.removeProperty('--glass-blur');
    }
    if (ap.presetBg) document.body.dataset.presetBg = ap.presetBg;
    else delete document.body.dataset.presetBg;
  }

  // 初始化
  document.addEventListener('DOMContentLoaded', async () => {
    const stored = getStoredTheme();
    applyTheme(stored);
    applySkinAndPreset();

    // Electron 模式：检测 Mica 支持，启用透明背景
    if (IS_ELECTRON && window.api?.app?.getInfo) {
      try {
        const info = await window.api.app.getInfo();
        // 无论系统是否支持 DWM 材质，都同步渲染层状态：不支持时仍使用
        // 对应的 CSS 表面作为可读回退，支持时再叠加原生 Mica/Acrylic。
        applyMicaMode(Boolean(info.micaEnabled));
        try {
          const resp = await window.api?.appearance?.getMaterial?.();
          if (resp && resp.material) {
            // 材质总开关关闭时按「无材质」落 dataset，与手动选择 none 观感一致（窗口界面升级3）
            document.body.dataset.material = resp.materialEnabled === false ? 'none' : resp.material;
          }
        } catch (e) {}
      } catch (e) {
        // 忽略
      }
    }

    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) themeBtn.addEventListener('click', toggle);
  });
})();
