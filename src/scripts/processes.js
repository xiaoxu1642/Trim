// processes.js - 共享进程读取 / 进程树渲染 / 结束进程逻辑
// 同时供「内存清理」页（点击「去管理」后跳转）与独立「应用进程管理」窗口使用。
// 数据来源：主进程 memory:processes（PowerShell 读取，形状 {Id, ProcessName, mem, Path}）。
// 渲染采用「按路径分组 → 实例缩进」的进程树（始终展开，不折叠），与微软电脑管家
// 「应用进程管理」保持一致：图标 + 名称 + 内存占用 + 单一「结束进程」按钮。
(function () {
  'use strict';

  function escapeHtml(s) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => map[m]);
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
  function fmtBytes(bytes) {
    if (!isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i <= 1 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
  }
  function sumMem(procs) {
    return procs.reduce((s, p) => s + (Number(p.mem) || 0), 0);
  }

  // 进程树展开状态（按分组路径记忆，刷新后保留；默认全折叠）
  const expandedPaths = new Set();
  // 当前生效的虚拟滚动实例（windowing）；重渲染前销毁，防 scroll/resize 监听泄漏
  let activeVL = null;
  // 分组行/子行统一行高（与 .xtable-row min-height 对齐，虚拟滚动窗口计算依赖它）
  const PM_ROW_H = 44;

  // 读取进程列表（预览模式返回模拟数据）
  async function fetchProcesses() {
    if (window.api?.memory) {
      const resp = await window.api.memory.processes();
      if (resp && resp.success) return resp.processes || [];
      throw new Error((resp && resp.message) || '读取失败');
    }
    return [
      { Id: 1204, ProcessName: 'explorer', mem: 210 * 1048576, Path: 'C:\\Windows\\explorer.exe' },
      { Id: 3312, ProcessName: 'chrome', mem: 890 * 1048576, Path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
      { Id: 4313, ProcessName: 'chrome', mem: 420 * 1048576, Path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
      { Id: 668, ProcessName: 'Code', mem: 720 * 1048576, Path: 'C:\\Users\\CHENG\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe' }
    ];
  }

  // 渲染进程树
  // root: 容器元素；processes: 数组；opts: { onKill(pid, name), toast(type,msg), filter, icons }
  function renderTree(root, processes, opts) {
    if (!root) return;
    opts = opts || {};
    const kw = String(opts.filter || '').trim().toLowerCase();
    const list = processes.filter(p => {
      if (!kw) return true;
      return String(p.ProcessName || '').toLowerCase().includes(kw) || String(p.Id || '').includes(kw);
    });

    if (!list.length) {
      root.innerHTML = '<div class="empty-state"><p>' + (processes.length ? '没有匹配的进程' : '暂无进程数据') + '</p></div>';
      return;
    }

    // 按路径分组（同路径 = 同一应用，多实例合并为树）
    const groups = new Map();
    for (const p of list) {
      const path = p.Path || '';
      if (!groups.has(path)) groups.set(path, []);
      groups.get(path).push(p);
    }
    const groupArr = [...groups.entries()].sort((a, b) => sumMem(b[1]) - sumMem(a[1]));

    const toggleSvg = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>';
    const killBtn = (pid, name, label) =>
      `<button class="btn btn-secondary btn-small pm-kill" data-pid="${escapeAttr(String(pid))}" data-name="${escapeAttr(name || '')}" type="button">${label || '结束进程'}</button>`;

    const headHtml = `
      <div class="xtable-head">
        <div class="xtable-th" style="flex:1.4">应用</div>
        <div class="xtable-th" style="flex:1.4">路径</div>
        <div class="xtable-th" style="width:120px" data-align="end">内存占用</div>
        <div class="xtable-th" style="width:110px">操作</div>
      </div>`;

    root.innerHTML = `<div class="xtable xtable-virtual pm-virtual">${headHtml}<div class="xtable-body"></div></div>`;
    const bodyEl = root.querySelector('.xtable-body');

    // 展平可见行序列：分组行恒在；「已展开」的分组其后追加全部子行。
    // 虚拟滚动只渲染视口附近行，进程再多也流畅（对齐 NexBox 的 windowing）。
    const flat = [];
    const rebuildFlat = () => {
      flat.length = 0;
      for (const [path, procs] of groupArr) {
        const key = path || '(未知路径)';
        flat.push({ t: 'group', key, path, procs });
        if (expandedPaths.has(key)) {
          for (const p of procs) flat.push({ t: 'child', key, p });
        }
      }
    };
    rebuildFlat();

    const buildGroupRow = (item) => {
      const { key, path, procs } = item;
      const main = procs[0];
      const total = sumMem(procs);
      const multi = procs.length > 1;
      const exePath = (path || '').trim();
      const expanded = expandedPaths.has(key);
      return `
        <div class="xtable-row mem-group-row" data-path="${escapeAttr(key)}" aria-expanded="${expanded}">
          <div class="xtable-td" style="flex:1.4">
            <span class="mem-tree-toggle" data-tip="展开/收起该应用的 ${multi ? '多个进程' : '进程'}"><span class="mem-tree-toggle-icon">${toggleSvg}</span></span>
            <img class="pm-app-icon" data-icon-path="${escapeAttr(exePath)}" alt="" width="18" height="18" />
            <span class="mem-tree-name">${escapeHtml(main.ProcessName || '未知')}</span>
            ${multi ? `<span class="mem-tree-count">${procs.length} 个进程</span>` : ''}
          </div>
          <div class="xtable-td" style="flex:1.4"><span class="xtable-cell-text xtable-cell-path" data-tip="${escapeAttr(path || '')}">${escapeHtml(window.xtable && xtable.middleEllipsis ? xtable.middleEllipsis(path || '—', 72) : (path || '—'))}</span></div>
          <div class="xtable-td" style="width:120px" data-align="end"><span class="xtable-cell-text">${fmtBytes(total)}</span></div>
          <div class="xtable-td" style="width:110px">${killBtn(main.Id, main.ProcessName, multi ? '结束全部' : '结束进程')}</div>
        </div>`;
    };

    const buildChildRow = (item) => {
      const p = item.p;
      return `
        <div class="xtable-row mem-child-row" data-pid="${escapeAttr(String(p.Id))}" data-parent="${escapeAttr(item.key)}">
          <div class="xtable-td" style="flex:1.4"><span class="xtable-cell-text mem-tree-child">${escapeHtml(p.ProcessName || '未知')} · PID ${escapeHtml(String(p.Id))}</span></div>
          <div class="xtable-td" style="flex:1.4"></div>
          <div class="xtable-td" style="width:120px" data-align="end"><span class="xtable-cell-text">${fmtBytes(Number(p.mem) || 0)}</span></div>
          <div class="xtable-td" style="width:110px">${killBtn(p.Id, p.ProcessName, '结束进程')}</div>
        </div>`;
    };

    activeVL = window.xtable.createVirtualList(bodyEl, {
      rows: flat,
      rowHeight: PM_ROW_H,
      overscan: 8,
      renderRow: item => item.t === 'group' ? buildGroupRow(item) : buildChildRow(item)
    });

    // 事件委托（虚拟行随滚动反复重建，不能逐行绑事件）：
    // ① 分组行整行点击 → 展开/收起其下实例，重建可见序列后重算窗口；
    // ② .pm-kill → 结束进程（按钮优先，避免触发分组行展开）。
    const onClick = (e) => {
      if (e.target.closest('.mem-group-row') && !e.target.closest('button, label, input')) {
        const path = e.target.closest('.mem-group-row').getAttribute('data-path');
        if (expandedPaths.has(path)) expandedPaths.delete(path); else expandedPaths.add(path);
        rebuildFlat();
        if (activeVL) activeVL.render();
        return;
      }
      const killBtnF = e.target.closest('.pm-kill');
      if (killBtnF) {
        e.stopPropagation();
        const pid = Number(killBtnF.dataset.pid);
        const name = killBtnF.dataset.name;
        const isGroup = !!killBtnF.closest('.mem-group-row') && !killBtnF.closest('.mem-child-row');
        const procs = isGroup ? (groups.get(killBtnF.closest('.mem-group-row').dataset.path) || []) : [Number(killBtnF.dataset.pid)];
        if (opts.onKill) opts.onKill(isGroup ? procs.map(x => Number(x.Id)) : [pid], name, isGroup);
      }
    };
    if (root.__pmClick && root.__pmClick !== onClick) root.removeEventListener('click', root.__pmClick);
    root.__pmClick = onClick;
    root.addEventListener('click', onClick);

    // 懒加载应用图标：优先取进程 exe 图标；提取失败回退到随包内置兜底图标（Trim.ico，
    // B2：统一走 icon-fallback 共享兜底）。用 MutationObserver 监听虚拟窗口，
    // 滚动新渲染出的行也能吃到图标。
    if (opts.icons !== false && window.api?.paths?.fileIcon) {
      if (root.__pmIconMO) { root.__pmIconMO.disconnect(); root.__pmIconMO = null; }
      const getFallback = () => window.iconFallback
        ? window.iconFallback.getFallbackUrl()
        : Promise.resolve(null);
      const apply = (img, url) => { if (url) img.src = url; else img.style.display = 'none'; };
      const scan = (hosts) => hosts.forEach(img => {
        if (img.dataset.loaded) return;
        img.dataset.loaded = '1';
        const p = img.getAttribute('data-icon-path');
        if (!p) { getFallback().then(url => apply(img, url)); return; }
        window.api.paths.fileIcon(p)
          .then(resp => {
            if (resp && resp.success && resp.dataUrl) img.src = resp.dataUrl;
            else return getFallback().then(url => apply(img, url));
          })
          .catch(() => getFallback().then(url => apply(img, url)));
      });
      scan(bodyEl.querySelectorAll('.pm-app-icon[data-icon-path]'));
      root.__pmIconMO = new MutationObserver(() => scan(bodyEl.querySelectorAll('.pm-app-icon[data-icon-path]:not([data-loaded])')));
      root.__pmIconMO.observe(bodyEl, { childList: true, subtree: true });
    }
  }

  // 结束进程（可批量）
  // pids: 数字数组；opts: { confirm(pid,name)->Promise<bool>, toast(type,msg) }
  async function killProcesses(pids, name, opts) {
    opts = opts || {};
    const toast = opts.toast || (() => {});
    for (const pid of pids) {
      if (opts.confirm) {
        const ok = await opts.confirm(Number(pid), name);
        if (!ok) return false;
      }
      if (window.api?.memory) {
        try {
          const resp = await window.api.memory.kill(Number(pid));
          if (resp && resp.success) {
            toast('success', (resp.message || `进程 ${pid} 已结束`));
          } else {
            toast('warning', (resp && resp.message) || `结束进程 ${pid} 失败`);
          }
        } catch (e) {
          toast('error', '结束进程失败：' + e.message);
        }
      } else {
        toast('warning', '预览模式不支持结束进程');
      }
    }
    return true;
  }

  window.ProcessTools = { fetchProcesses, renderTree, killProcesses, fmtBytes, sumMem };
})();
