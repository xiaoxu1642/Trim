// src/scripts/updater-ui.js — 自动更新渲染层状态机
// 批次：自动更新接入（2026-09-12）
// 约束：
// 1) 复用 modal.js 统一弹窗骨架（window.modal.create）与 .progress-bar/.progress-fill 现成件；
// 2) 所有动态文本（版本号、更新日志、错误信息）一律 textContent 赋值，禁止拼 HTML；
// 3) window.api / window.modal 缺失时优雅降级（与 ds 未加载兜底一致）；
// 4) 启动后台静默检查的 checking/latest/error 不弹窗，仅手动检查与 available/ready 显性呈现。
(function () {
  'use strict';

  const MODAL_ID = 'updaterModal';

  // 主进程推送的状态负载：phase/idle/checking/available/latest/downloading/ready/error
  const state = {
    phase: 'idle',
    percent: 0,
    version: '',
    currentVersion: '',
    releaseNotes: '',
    releaseDate: '',
    message: '',
    speed: 0,
    transferred: 0,
    total: 0
  };

  let ctrl = null;          // window.modal.create 返回的控制器
  let modalKind = '';       // 当前弹窗形态（避免下载进度刷新时重建弹窗）
  let unbind = null;
  let pendingManual = false; // 点击「检查更新」后置真，checking 事件到达时快照
  let activeManual = false;  // 本轮检查是否手动触发（决定 latest/error 是否打扰用户）

  // ---------------- 工具 ----------------
  function $(sel, root) { return (root || document).querySelector(sel); }

  function toast(type, message, duration) {
    try { window.app && window.app.toast(type, message, duration || 3500); } catch (_) {}
  }

  // 字节数/速率格式化（electron-updater 给的是 byte 与 byte/s）
  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    const units = ['KB', 'MB', 'GB'];
    let val = v / 1024;
    let i = 0;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return val.toFixed(val >= 100 ? 0 : 1) + ' ' + units[i];
  }

  // ---------------- 弹窗构建（静态骨架，无任何动态文本插值） ----------------
  function bodyHtml(kind) {
    if (kind === 'checking') {
      return '<div class="upd-checking"><span class="upd-spinner" aria-hidden="true"></span>' +
        '<span class="upd-checking-text">正在检查更新…</span></div>';
    }
    if (kind === 'available') {
      const badge = window.ds && window.ds.badgeHtml
        ? window.ds.badgeHtml('accent', '新版本', { small: true })
        : '<span class="ds-badge accent sm">新版本</span>';
      return '<div class="upd-available">' +
        '<div class="upd-version-line">' + badge + '<span class="upd-version-new"></span></div>' +
        '<div class="upd-version-current"></div>' +
        '<div class="upd-notes" tabindex="0"></div>' +
        '</div>';
    }
    if (kind === 'downloading') {
      return '<div class="upd-dl">' +
        '<div class="upd-dl-head"><span class="upd-dl-label">正在下载更新</span>' +
        '<span class="upd-dl-percent">0%</span></div>' +
        '<div class="progress-bar" role="progressbar" aria-label="更新包下载进度" ' +
        'aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
        '<div class="progress-fill upd-dl-fill"></div></div>' +
        '<div class="upd-dl-meta"><span class="upd-dl-size"></span>' +
        '<span class="upd-dl-speed"></span></div>' +
        '</div>';
    }
    if (kind === 'ready') {
      return '<div class="upd-ready">' +
        '<div class="upd-ready-title">更新已下载完成</div>' +
        '<p class="upd-ready-desc"></p></div>';
    }
    if (kind === 'error') {
      return '<div class="upd-error"><div class="upd-error-msg"></div></div>';
    }
    return '';
  }

  function footerHtml(kind) {
    const right = '<span class="model-picker-spacer"></span>';
    if (kind === 'checking') {
      return right + '<button class="btn btn-secondary" type="button" data-upd="close">关闭</button>';
    }
    if (kind === 'available') {
      return right +
        '<button class="btn btn-secondary" type="button" data-upd="later">以后再说</button>' +
        '<button class="btn btn-primary" type="button" data-upd="download">下载更新</button>';
    }
    if (kind === 'downloading') {
      return right + '<button class="btn btn-secondary" type="button" data-upd="cancel">取消下载</button>';
    }
    if (kind === 'ready') {
      return right +
        '<button class="btn btn-secondary" type="button" data-upd="later">稍后重启</button>' +
        '<button class="btn btn-primary" type="button" data-upd="install">立即重启</button>';
    }
    if (kind === 'error') {
      return right +
        '<button class="btn btn-secondary" type="button" data-upd="close">关闭</button>' +
        '<button class="btn btn-primary" type="button" data-upd="retry">重试</button>';
    }
    return '';
  }

  function titleOf(kind) {
    return {
      checking: '检查更新',
      available: '发现新版本',
      downloading: '下载更新',
      ready: '更新就绪',
      error: '更新失败'
    }[kind] || '检查更新';
  }

  function closeModal() {
    const c = ctrl;
    ctrl = null;
    modalKind = '';
    try { c && c.close(); } catch (_) {}
  }

  function openModal(kind) {
    if (!window.modal || !window.modal.create) return false;
    if (ctrl && modalKind === kind) { fillModal(kind); return true; }
    closeModal();
    ctrl = window.modal.create({
      id: MODAL_ID,
      title: titleOf(kind),
      width: 440,
      bodyHtml: bodyHtml(kind),
      footerHtml: footerHtml(kind),
      onRequestClose: () => {
        // 下载中点关闭/X/Esc 等同显式取消，避免弹窗关了下载仍偷跑
        if (modalKind === 'downloading') {
          try { window.api.updater.cancelDownload(); } catch (_) {}
        }
      },
      onClose: () => { ctrl = null; modalKind = ''; }
    });
    modalKind = kind;
    bindFooter(kind);
    fillModal(kind);
    return true;
  }

  // footer 按钮统一委托（动态文本无关，仅分发动作）
  function bindFooter(kind) {
    if (!ctrl || !ctrl.footer) return;
    ctrl.footer.addEventListener('click', e => {
      const btnEl = e.target.closest('[data-upd]');
      if (!btnEl) return;
      const act = btnEl.getAttribute('data-upd');
      try {
        if (act === 'download') window.api.updater.download();
        else if (act === 'cancel') window.api.updater.cancelDownload();
        else if (act === 'install') window.api.updater.install();
        else if (act === 'retry') manualCheck();
        else if (act === 'later' || act === 'close') closeModal();
      } catch (err) { /* IPC 异常走 error 状态回流，不在按钮回调里抛 */ }
    });
  }

  // 按形态把 state 里的动态数据写入弹窗（全部 textContent / 样式，无 HTML 拼接）
  function fillModal(kind) {
    if (!ctrl) return;
    const root = ctrl.modal;

    if (kind === 'available') {
      $('.upd-version-new', root).textContent = 'v' + (state.version || '');
      $('.upd-version-current', root).textContent =
        '当前版本 v' + (state.currentVersion || '');
      const notes = $('.upd-notes', root);
      // releaseNotes 可能为空（GitHub 未填发布说明），给兜底文案
      notes.textContent = state.releaseNotes && state.releaseNotes.trim()
        ? state.releaseNotes.trim()
        : '本次更新包含问题修复与体验优化。';
    } else if (kind === 'downloading') {
      fillDownload();
    } else if (kind === 'ready') {
      $('.upd-ready-desc', root).textContent =
        '新版本 v' + (state.version || '') + ' 已下载并校验完成，重启 Trim 后即可生效。';
    } else if (kind === 'error') {
      $('.upd-error-msg', root).textContent = state.message || '检查更新失败，请稍后重试。';
    }
  }

  function fillDownload() {
    if (!ctrl || modalKind !== 'downloading') return;
    const root = ctrl.modal;
    const pct = Math.max(0, Math.min(100, Number(state.percent) || 0));
    const percentEl = $('.upd-dl-percent', root);
    const fillEl = $('.upd-dl-fill', root);
    const sizeEl = $('.upd-dl-size', root);
    const speedEl = $('.upd-dl-speed', root);
    if (percentEl) percentEl.textContent = pct + '%';
    // 优先走 ds.progress.setFill（钳值 + ARIA），ds 缺席时直写宽度降级
    if (window.ds && window.ds.progress && typeof window.ds.progress.setFill === 'function') {
      window.ds.progress.setFill(fillEl, pct);
    } else if (fillEl) {
      fillEl.style.width = pct + '%';
      const host = fillEl.parentElement;
      if (host) host.setAttribute('aria-valuenow', String(Math.round(pct)));
    }
    if (sizeEl) {
      sizeEl.textContent = state.total
        ? fmtBytes(state.transferred) + ' / ' + fmtBytes(state.total)
        : '';
    }
    if (speedEl) speedEl.textContent = state.speed ? fmtBytes(state.speed) + '/s' : '';
  }

  // ---------------- 设置页行状态 ----------------
  let rowBtn = null;
  let rowHint = null;

  function setRow(text, disabled, hint) {
    if (rowBtn) {
      rowBtn.textContent = text;
      rowBtn.disabled = !!disabled;
    }
    if (rowHint && hint !== undefined) rowHint.textContent = hint;
  }

  function syncRow() {
    const cur = state.currentVersion ? 'v' + state.currentVersion : '';
    switch (state.phase) {
      case 'checking':
        setRow('正在检查…', true, '正在向 GitHub 检查新版本…');
        break;
      case 'available':
        setRow('检查更新', false, '发现新版本 v' + (state.version || '') + '，可在弹窗中下载');
        break;
      case 'downloading':
        setRow('正在下载…', true, '正在下载 v' + (state.version || '') + ' … ' + (state.percent || 0) + '%');
        break;
      case 'ready':
        setRow('检查更新', false, 'v' + (state.version || '') + ' 已就绪，重启后生效');
        break;
      case 'latest':
        setRow('检查更新', false, '当前已是最新版本' + (cur ? '（' + cur + '）' : ''));
        break;
      case 'error':
        setRow('检查更新', false, '更新失败，点击按钮重试');
        break;
      default:
        setRow('检查更新', false, cur ? '当前版本 ' + cur : '检查 Trim 是否有新版本');
    }
  }

  // ---------------- 状态机分发 ----------------
  function render() {
    switch (state.phase) {
      case 'idle':
        closeModal();
        break;
      case 'checking':
        // 后台静默检查不弹检查中弹窗；available 到达时自然弹窗
        if (activeManual) openModal('checking');
        break;
      case 'available':
        openModal('available');
        break;
      case 'downloading':
        openModal('downloading');
        fillDownload();
        break;
      case 'ready':
        openModal('ready');
        break;
      case 'latest':
        closeModal();
        if (activeManual) toast('success', '当前已是最新版本' + (state.currentVersion ? '（v' + state.currentVersion + '）' : ''));
        break;
      case 'error':
        // 后台静默检查的网络抖动（国内访问 GitHub 常见）不打扰用户；
        // 手动检查或弹窗已开（例如下载失败）才显性报错。
        if (activeManual || ctrl) openModal('error');
        break;
    }
    syncRow();
  }

  // ---------------- 手动检查 ----------------
  async function manualCheck() {
    if (!window.api || !window.api.updater) {
      toast('info', '当前环境不支持自动更新');
      return;
    }
    pendingManual = true;
    let res = null;
    try {
      res = await window.api.updater.check();
    } catch (e) {
      res = { skipped: false, error: e && e.message };
    }
    // 开发环境/重复检查被主进程短路时没有状态回流，直接在此恢复行状态并提示
    if (res && res.skipped) {
      pendingManual = false;
      activeManual = false;
      state.phase = res.reason === 'dev' ? 'idle' : state.phase;
      if (res.reason === 'dev') {
        state.phase = 'idle';
        syncRow();
        toast('info', '开发环境不检查更新（仅 NSIS 安装版支持自动更新）');
      } else if (res.reason === 'already-checking') {
        toast('info', '正在检查中，请稍候');
      }
    } else if (res && res.ok === false && (state.phase === 'idle' || state.phase === 'checking')) {
      // error 事件通常已回流；极端情况下回流丢失时兜底提示（已在 error 态则不重复渲染）
      state.phase = 'error';
      state.message = res.error || '检查更新失败';
      activeManual = true; // 手动触发的失败需要显性弹窗
      pendingManual = false;
      render();
      activeManual = false;
    }
  }

  // ---------------- 初始化 ----------------
  function init() {
    rowBtn = document.getElementById('btnCheckUpdate');
    rowHint = document.getElementById('updaterCheckHint');
    if (!rowBtn || !window.api || !window.api.updater) return; // 优雅降级

    unbind = window.api.updater.onState(s => {
      if (!s || !s.phase) return;
      if (s.phase === 'checking') activeManual = pendingManual;
      Object.assign(state, s);
      render();
      // 终态后清掉本轮手动标记（available→下载→ready 期间弹窗保持，不受影响）
      if (s.phase === 'latest' || s.phase === 'error' || s.phase === 'idle') {
        pendingManual = false;
        activeManual = false;
      }
    });

    rowBtn.addEventListener('click', manualCheck);

    // 设置页行展示当前版本（与 app.js loadAppInfo 同源，独立获取避免时序耦合）
    if (window.api.app && window.api.app.getInfo) {
      window.api.app.getInfo().then(info => {
        if (info && info.version) {
          state.currentVersion = info.version;
          if (state.phase === 'idle') syncRow();
        }
      }).catch(() => {});
    }

    window.addEventListener('beforeunload', () => {
      try { unbind && unbind(); } catch (_) {}
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
