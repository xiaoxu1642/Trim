// process-manager-window.js - 内存清理 → 「应用进程管理」独立窗口
// 承载运行进程列表（按路径分组 + 实例缩进的进程树），支持搜索、刷新、逐项/整体结束进程。
// 列表渲染与结束逻辑复用 processes.js（与「内存清理」页共享）。
// 注意：独立窗口未加载 app.js，故 confirm/toast 自行实现（统一使用 .usage-modal 样式）。
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => map[m]);
  }

  function toast(type, message) {
    const host = el('pmGlobalHint');
    if (!host) return;
    host.textContent = message || '';
    host.style.color = type === 'error' ? 'var(--danger)'
      : type === 'success' ? 'var(--success)'
        : type === 'warning' ? 'var(--warning)' : 'var(--fg-tertiary)';
    if (message) setTimeout(() => { if (host.textContent === message) host.textContent = ''; }, 5000);
  }

  // 内置确认框（.usage-backdrop > .usage-modal 三段式）
  function confirmDialog(title, message, confirmText = '确认', cancelText = '取消') {
    return new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.className = 'usage-backdrop';
      backdrop.innerHTML = `
        <div class="usage-modal" role="dialog" aria-modal="true" aria-labelledby="pmConfirmTitle">
          <div class="usage-header">
            <h2 id="pmConfirmTitle">${escapeHtml(title)}</h2>
            <button class="usage-close" type="button" title="关闭" aria-label="关闭">&times;</button>
          </div>
          <div class="usage-body">${escapeHtml(message).replace(/\n/g, '<br>')}</div>
          <div class="usage-footer">
            <span class="model-picker-spacer"></span>
            <button class="btn btn-secondary" id="pmConfirmCancel" type="button">${escapeHtml(cancelText)}</button>
            <button class="btn btn-primary" id="pmConfirmOk" type="button">${escapeHtml(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);

      function cleanup(result) {
        document.removeEventListener('keydown', escHandler);
        backdrop.remove();
        resolve(result);
      }
      function escHandler(e) { if (e.key === 'Escape') cleanup(false); }

      backdrop.querySelector('#pmConfirmOk').addEventListener('click', () => cleanup(true));
      backdrop.querySelector('#pmConfirmCancel').addEventListener('click', () => cleanup(false));
      backdrop.querySelector('.usage-close').addEventListener('click', () => cleanup(false));
      backdrop.addEventListener('click', e => { if (e.target === backdrop) cleanup(false); });
      document.addEventListener('keydown', escHandler);
    });
  }

  let currentProcesses = [];

  function render() {
    const kw = (el('pmSearch') && el('pmSearch').value || '').trim();
    const root = el('pmBody');
    if (window.ProcessTools) {
      window.ProcessTools.renderTree(root, currentProcesses, { onKill, toast, filter: kw });
    }
    const total = (currentProcesses || []).length;
    const cnt = el('pmCount');
    if (cnt) cnt.textContent = total ? `${total} 个进程` : '无进程';
  }

  async function load() {
    try {
      currentProcesses = await window.ProcessTools.fetchProcesses();
    } catch (e) {
      toast('error', '读取进程列表失败：' + e.message);
      currentProcesses = [];
    }
    render();
  }

  // 结束进程（来自 processes.js 渲染的「结束进程 / 结束全部」按钮）
  async function onKill(pids, name, isGroup) {
    const ok = await confirmDialog(
      '结束进程确认',
      isGroup
        ? `即将强制结束应用「${name}」的 ${pids.length} 个进程。\n\n未保存的数据可能丢失，是否继续？`
        : `即将强制结束进程「${name}」（PID ${pids[0]}）。\n\n未保存的数据可能丢失，是否继续？`,
      '结束进程',
      '取消'
    );
    if (!ok) return;
    await window.ProcessTools.killProcesses(pids, name, { confirm: null, toast });
    await load();
    reportProgress();
  }

  // 向主窗口推送本次操作后的统计，供「内存清理」页卡片中间区回显
  function reportProgress() {
    const total = (currentProcesses || []).length;
    if (window.api?.processManager?.report) {
      window.api.processManager.report({ totalCount: total, updatedAt: Date.now() });
    }
  }

  function closeWindow() {
    if (window.api?.processManager?.closeWindow) window.api.processManager.closeWindow();
    else window.close();
  }

  // 恒浅色（v2.1：应用固定浅色，不再跟随系统主题；v2.8.0 清理死代码不再 remove theme-dark）
  function applyTheme() {
    document.body.classList.add('theme-light');
  }

  function init() {
    el('pmCloseBtn')?.addEventListener('click', closeWindow);
    el('pmRefreshBtn')?.addEventListener('click', () => load());
    el('pmSearch')?.addEventListener('input', () => render());
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeWindow(); });
    applyTheme();
    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
