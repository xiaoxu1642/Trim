// app.js - 主应用逻辑
// 负责页面路由、模态框、Toast、IPC 桥接、设置
(function () {
  'use strict';

  // 侧边栏折叠/展开
  const SIDEBAR_KEY = 'winclean-sidebar-collapsed';

  function getSidebarCollapsed() {
    try { return localStorage.getItem(SIDEBAR_KEY) === 'true'; } catch (e) { return false; }
  }

  function setSidebarCollapsed(collapsed) {
    try { localStorage.setItem(SIDEBAR_KEY, String(collapsed)); } catch (e) {}
  }

  function applySidebarState(collapsed) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('collapsed', collapsed);
  }

  function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const collapsed = sidebar.classList.toggle('collapsed');
    setSidebarCollapsed(collapsed);
  }

  // 侧边栏子菜单（父级条目箭头）展开/折叠状态持久化
  const NAVSUB_KEY_PREFIX = 'winclean-navsub-';

  // 返回 null 表示用户从未手动设置过；业务层据此决定默认展开策略
  function getNavSubExpanded(key) {
    try {
      const val = localStorage.getItem(NAVSUB_KEY_PREFIX + key);
      if (val === null) return null;
      return val === 'true';
    } catch (e) { return null; }
  }

  function setNavSubExpanded(key, expanded) {
    try { localStorage.setItem(NAVSUB_KEY_PREFIX + key, String(expanded)); } catch (e) {}
  }

  // 默认展开策略：所有父级分组默认折叠；右键管理分类树的展开/收起由页面切换驱动
  function getNavSubDefaultExpanded(key) {
    return false;
  }

  function applyNavSubState(key, expanded) {
    const item = document.querySelector(`[data-nav-toggle="${key}"]`);
    const submenu = document.querySelector(`[data-nav-submenu="${key}"]`);
    item?.classList.toggle('expanded', expanded);
    submenu?.classList.toggle('expanded', expanded);
    if (submenu) {
      // 展开时回填带缓冲的 max-height：内容高度 + 缓冲，避免展开后滚动条出现/文本回流导致的轻微裁切
      // （收起时清空内联样式，回退到 CSS 的 max-height:0）
      if (expanded) {
        submenu.style.maxHeight = Math.max(600, submenu.scrollHeight + 40) + 'px';
      } else {
        submenu.style.maxHeight = '';
      }
    }
  }

  function toggleNavSub(key) {
    const item = document.querySelector(`[data-nav-toggle="${key}"]`);
    const expanded = !item?.classList.contains('expanded');
    applyNavSubState(key, expanded);
    setNavSubExpanded(key, expanded);
    if (expanded) {
      // 展开后将子菜单滚动到导航可见区域，避免窗口较矮时看不到全部分类
      document.querySelector(`[data-nav-submenu="${key}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    return expanded;
  }

  // 路由
  const ACTIVE_PAGE_KEY = 'winclean-active-page';

  function switchPage(pageName) {
    // 持久化活跃页（窗口状态记忆：启动恢复上次页面）
    try { localStorage.setItem(ACTIVE_PAGE_KEY, pageName); } catch (e) {}
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.page === pageName);
    });
    document.querySelectorAll('.page').forEach(el => {
      el.classList.toggle('active', el.id === 'page-' + pageName);
    });
    document.querySelectorAll('.nav-subitem').forEach(el => {
      // 分类树子项（data-category）高亮由右键管理模块独立维护，切换页面不清除
      if (el.dataset.category !== undefined) return;
      el.classList.toggle('active', el.dataset.page === pageName);
    });
    const speedParent = document.querySelector('[data-nav-toggle="speed"]');
    if (speedParent) speedParent.classList.toggle('active', pageName === 'netspeed' || pageName === 'diskbench');

    // 页面进入逻辑
    if (pageName === 'logs') logger.load();
    if (pageName === 'startup') startup.load();
    if (pageName === 'quickcmds') window.quickcmds?.init?.();
    if (pageName === 'memoryclean') {
      window.memoryclean?.loadInfo?.();
    }
    if (pageName === 'settings') { pathbinding.init(); }
    // 实时网速（已并入网络测速页）：进入网络测速页启动采集，离开停止，避免后台空耗 CPU
    if (pageName === 'netspeed') realtime.start();
    else realtime.stop();
    // 系统概览：进入启动实时指标轮询，离开停止
    if (pageName === 'overview') overview.start();
    else overview.stop();
    // 网络测速：仅点击"开始测速"按钮后才加载网页；离开本页回收 iframe 与采样定时器
    if (pageName !== 'netspeed') window.netspeed?.stop?.();
  }

  // 模态确认（统一使用 .usage-backdrop > .usage-modal 三段式，与「去设置」弹窗一致）
  function confirm(title, message, confirmText = '确认', cancelText = '取消') {
    return new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.className = 'usage-backdrop';
      backdrop.id = 'appConfirmBackdrop';
      backdrop.innerHTML = `
        <div class="usage-modal" role="dialog" aria-modal="true" aria-labelledby="appConfirmTitle">
          <div class="usage-header">
            <h2 id="appConfirmTitle">${escapeHtml(title)}</h2>
            <button class="usage-close" type="button" title="关闭" aria-label="关闭">&times;</button>
          </div>
          <div class="usage-body" id="appConfirmBody"></div>
          <div class="usage-footer">
            <span class="model-picker-spacer"></span>
            <button class="btn btn-secondary" id="appConfirmCancel" type="button">${escapeHtml(cancelText)}</button>
            <button class="btn btn-primary" id="appConfirmOk" type="button">${escapeHtml(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);

      const body = backdrop.querySelector('#appConfirmBody');
      if (body) body.innerHTML = escapeHtml(message).replace(/\n/g, '<br>');

      const btnConfirm = backdrop.querySelector('#appConfirmOk');
      const btnCancel = backdrop.querySelector('#appConfirmCancel');

      function cleanup(result) {
        document.removeEventListener('keydown', escHandler);
        backdrop.remove();
        resolve(result);
      }
      function escHandler(e) { if (e.key === 'Escape') cleanup(false); }

      btnConfirm.addEventListener('click', () => cleanup(true));
      btnCancel.addEventListener('click', () => cleanup(false));
      backdrop.querySelector('.usage-close').addEventListener('click', () => cleanup(false));
      backdrop.addEventListener('click', e => { if (e.target === backdrop) cleanup(false); });
      document.addEventListener('keydown', escHandler);
    });
  }

  // 应用状态（管理员权限等）
  const appState = { isAdmin: null };

  // 请求 UAC 提权（弹出系统 UAC 对话框，成功后应用以管理员重启）
  async function requestElevation(reason) {
    if (!window.api?.elevate) {
      toast('warning', '当前环境不支持权限提升');
      return false;
    }
    const ok = await confirm(
      '提升管理员权限',
      (reason || '部分操作需要管理员权限才能完成。') + '\n\n点击"提升权限"将弹出系统 UAC 确认框，应用会以管理员身份重启。',
      '提升权限',
      '取消'
    );
    if (!ok) return false;
    try {
      const resp = await window.api.elevate.request();
      if (resp.success) {
        toast('info', '提权成功，应用即将以管理员身份重启');
        return true;
      }
      toast('warning', resp.message || '提权请求已取消');
      return false;
    } catch (e) {
      toast('error', '提权失败: ' + e.message);
      return false;
    }
  }

  // Toast 通知
  // 活动中的 Toast 注册表（用于点击空白区域时关闭最顶层 Toast）
  const activeToasts = [];

  function toast(type, message, duration = 3000, options = {}) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const icons = {
      success: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
      error: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>',
      warning: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
      info: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>'
    };

    const el = document.createElement('div');
    el.className = `toast ${type}${options.guide ? ' toast-guide' : ''}`;
    const messageHtml = escapeHtml(message).replace(/\n/g, '<br>');
    el.innerHTML = `
      <div class="toast-icon">${icons[type] || icons.info}</div>
      <div class="toast-message">
        ${options.title ? `<div class="toast-title">${escapeHtml(options.title)}</div>` : ''}
        <div>${messageHtml}</div>
      </div>
      ${options.closable ? '<button class="toast-close" type="button" aria-label="关闭通知" title="关闭">&times;</button>' : ''}
    `;
    container.appendChild(el);

    let removeTimer;
    const entry = { el };
    entry.remove = () => {
      clearTimeout(removeTimer);
      const i = activeToasts.indexOf(entry);
      if (i > -1) activeToasts.splice(i, 1);
      if (el.classList.contains('removing')) return;
      el.classList.add('removing');
      setTimeout(() => el.remove(), 200);
    };
    activeToasts.push(entry);
    el.querySelector('.toast-close')?.addEventListener('click', entry.remove);
    removeTimer = setTimeout(entry.remove, duration);
  }

  // 点击窗口内空白区域关闭最顶层 Toast（超时自动关闭逻辑保留，此为额外手动关闭方式）
  function dismissTopToastOnClick(e) {
    if (!activeToasts.length) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    // 点击交互控件 / 弹窗 / Toast 本体时保留原有功能，不触发关闭
    if (t.closest('button, a, input, select, textarea, label, .toast, .usage-backdrop, .preview-backdrop, .ctx-detail-backdrop, .nav-item, .nav-subitem, .filter-tab, .checkbox, .context-item, .category-item, .ctx-cat-header, [contenteditable]')) return;
    // 自顶向下找最近添加且未移除的 Toast（关闭流程 Toast 不可手动关闭）
    for (let i = activeToasts.length - 1; i >= 0; i--) {
      const entry = activeToasts[i];
      if (entry.el && !entry.el.classList.contains('toast-shutdown')) {
        entry.remove();
        return;
      }
    }
  }

  // 轻量 Markdown 渲染（支持标题/表格/列表/引用/粗体/行内代码/分隔线，满足 readme.md 需要）
  function renderMarkdown(md) {
    const escapeHtmlInline = (text) => escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    const lines = String(md || '').split(/\r?\n/);
    let html = '';
    let listType = null; // 'ol' | 'ul'
    let inTable = false;

    const closeList = () => {
      if (listType) { html += `</${listType}>`; listType = null; }
    };
    const closeTable = () => {
      if (inTable) { html += '</tbody></table>'; inTable = false; }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, '');
      const trimmed = line.trim();
      if (!trimmed) { closeList(); closeTable(); html += '\n'; continue; }

      // 分隔线
      if (/^(-{3,}|\*{3,})$/.test(trimmed)) { closeList(); closeTable(); html += '<hr>'; continue; }
      // 标题
      const hm = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (hm) { closeList(); closeTable(); const lv = hm[1].length; html += `<h${lv}>${escapeHtmlInline(hm[2])}</h${lv}>`; continue; }
      // 引用
      if (trimmed.startsWith('> ')) { closeList(); closeTable(); html += `<blockquote>${escapeHtmlInline(trimmed.slice(2))}</blockquote>`; continue; }
      // 表格：表头行 + 分隔行 + 数据行（一次性收集整块）
      if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        const isSepNext = /^\|[\s:|-]+\|$/.test(next) && /-/.test(next);
        if (isSepNext) {
          closeList(); closeTable();
          const headerCells = trimmed.slice(1, -1).split('|').map(c => escapeHtmlInline(c.trim()));
          html += `<table><thead><tr>${headerCells.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
          inTable = true;
          i += 2; // 跳过表头行与分隔行
          while (i < lines.length) {
            const row = lines[i].trim();
            if (!(row.startsWith('|') && row.endsWith('|'))) break;
            const dataCells = row.slice(1, -1).split('|').map(c => escapeHtmlInline(c.trim()));
            html += `<tr>${dataCells.map(c => `<td>${c}</td>`).join('')}</tr>`;
            i++;
          }
          i--; // 外层 for 会再次 ++
          closeTable();
          continue;
        }
      }
      // 有序列表
      const olm = trimmed.match(/^\d+[.)]\s+(.*)$/);
      if (olm) { closeTable(); if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; } html += `<li>${escapeHtmlInline(olm[1])}</li>`; continue; }
      // 无序列表
      const uls = trimmed.match(/^[-*+]\s+(.*)$/);
      if (uls) { closeTable(); if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; } html += `<li>${escapeHtmlInline(uls[1])}</li>`; continue; }

      // 普通段落
      closeList(); closeTable();
      html += `<p>${escapeHtmlInline(trimmed)}</p>`;
    }
    closeList(); closeTable();
    return html;
  }

  async function showUsageGuide() {
    const backdrop = document.getElementById('usageBackdrop');
    if (!backdrop) return;
    backdrop.style.display = 'flex';
    const body = document.getElementById('usageBody');
    if (!window.api?.app?.readUsage) {
      body.innerHTML = '<div class="empty-state"><p>使用说明仅在 Electron 环境中可用</p></div>';
      return;
    }
    try {
      const resp = await window.api.app.readUsage();
      if (resp && resp.success) {
        body.innerHTML = renderMarkdown(resp.content);
      } else {
        body.innerHTML = `<div class="empty-state"><p>${escapeHtml((resp && resp.message) || '加载使用说明失败')}</p></div>`;
      }
    } catch (e) {
      body.innerHTML = `<div class="empty-state"><p>加载使用说明失败: ${escapeHtml(e.message)}</p></div>`;
    }
  }

  function closeUsageGuide() {
    const backdrop = document.getElementById('usageBackdrop');
    if (backdrop) backdrop.style.display = 'none';
  }

  function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, m => map[m]);
  }

  // 日志（暴露给其它模块）
  function log(level, message) {
    return logger.write(level, message);
  }

  // 加载应用信息
  async function loadAppInfo() {
    if (!window.api?.app) {
      // 浏览器预览模式
      setInfo('infoVersion', '1.3.0');
      setInfo('infoElectron', 'N/A');
      setInfo('infoNode', 'N/A');
      setInfo('infoChrome', navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || 'N/A');
      setInfo('infoOS', navigator.platform);
      setInfo('infoBuild', 'N/A');
      setInfo('infoFluent', '基础支持');
      setInfo('infoMica', '未启用');
      setInfo('infoUser', '本地用户');
      setInfo('infoAdmin', '否');
      return;
    }
    try {
      const info = await window.api.app.getInfo();
      setInfo('infoVersion', info.version);
      setInfo('infoElectron', info.electron);
      setInfo('infoNode', info.node);
      setInfo('infoChrome', info.chrome);
      setInfo('infoOS', `${info.osVersion} (${info.arch})`);
      setInfo('infoBuild', `Build ${info.osBuild || '未知'}`);
      const fluentText = { full: '完整支持 (Mica + Acrylic)', partial: '部分支持 (基础 Mica)', none: '不支持' };
      setInfo('infoFluent', fluentText[info.fluentSupport] || info.fluentSupport || '未知');
      setInfo('infoMica', info.micaEnabled ? '已启用（原生）' : '未启用');
      setInfo('infoUser', info.username);
      setInfo('infoAdmin', info.isAdmin ? '是 ✓' : '否 ✗');
      // 全局记录管理员状态（供清理失败时建议提权）
      appState.isAdmin = !!info.isAdmin;
    } catch (e) {
      console.error('加载应用信息失败:', e);
    }
  }

  function setInfo(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  // ==================== 优雅关闭流程 ====================
  // 主进程拦截关闭后触发：展示"感谢使用"Toast，逐步关闭各服务，完成后真正退出
  function startGracefulShutdown() {
    const container = document.getElementById('toastContainer');
    if (!container) {
      // 找不到容器直接完成关闭
      window.api?.shutdown?.complete?.();
      return;
    }

    // 创建常驻关闭 Toast（不自动消失）
    const el = document.createElement('div');
    el.className = 'toast info toast-guide toast-shutdown';
    el.innerHTML = `
      <div class="toast-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg></div>
      <div class="toast-message">
        <div class="toast-title">感谢使用</div>
        <div class="shutdown-steps" id="shutdownSteps">
          <div class="shutdown-step active" data-step="1">正在断开网络连接…</div>
          <div class="shutdown-step" data-step="2">正在停止后台任务…</div>
          <div class="shutdown-step" data-step="3">正在清理临时文件…</div>
          <div class="shutdown-step" data-step="4">正在保存配置与日志…</div>
        </div>
      </div>
    `;
    container.appendChild(el);

    const markStep = (n, ok = true) => {
      const step = el.querySelector(`[data-step="${n}"]`);
      if (!step) return;
      step.classList.remove('active');
      step.classList.add(ok ? 'done' : 'failed');
    };
    const activateStep = (n) => {
      el.querySelector(`[data-step="${n}"]`)?.classList.add('active');
    };

    const wait = ms => new Promise(r => setTimeout(r, ms));

    (async () => {
      try {
        // 步骤1：断开网络连接（卸载外部测速 iframe）
        activateStep(1);
        try {
          const frame = document.getElementById('externalTestFrame');
          if (frame && frame.src !== 'about:blank') frame.src = 'about:blank';
        } catch (e) {}
        await wait(450);
        markStep(1);

        // 步骤2：停止后台任务（取消测速等）
        activateStep(2);
        try {
          if (window.netspeed) window.netspeed.loaded = false;
        } catch (e) {}
        await wait(400);
        markStep(2);

        // 步骤3：清理临时文件（主进程执行，此处展示状态）
        activateStep(3);
        await wait(450);
        markStep(3);

        // 步骤4：保存配置与日志
        activateStep(4);
        try {
          await log('info', '应用关闭：服务与端口已全部释放');
        } catch (e) {}
        await wait(400);
        markStep(4);

        // 全部完成，稍微停留后通知主进程关闭
        await wait(500);
        window.api?.shutdown?.complete?.();
      } catch (e) {
        // 异常兜底：确保最终能关闭
        window.api?.shutdown?.complete?.();
      }
    })();
  }

  // 初始化
  function init() {
    // 恢复侧边栏折叠状态
    applySidebarState(getSidebarCollapsed());

    // 空状态 CTA：委托转发到目标按钮（如「立即扫描」→ btnScan / btnScanStartup）
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-empty-cta]') : null;
      if (!btn) return;
      const target = document.getElementById(btn.dataset.emptyCta);
      if (target) target.click();
    });

    // 侧边栏折叠/展开按钮
    document.getElementById('sidebarToggle')?.addEventListener('click', toggleSidebar);

    // 导航：父级条目点击标题主体仅切换页面（不展开子菜单）；
    // 展开/收起子菜单只响应箭头热区（.nav-parent-toggle）
    document.querySelectorAll('.nav-item').forEach(el => {
      el.addEventListener('click', () => {
        const toggle = el.dataset.navToggle;
        if (toggle) {
          // 侧边栏整体折叠时，先展开侧边栏
          if (document.getElementById('sidebar')?.classList.contains('collapsed')) {
            applySidebarState(false);
            setSidebarCollapsed(false);
            return;
          }
          // 点击标题主体仅切换页面
          switchPage(el.dataset.page);
          return;
        }
        switchPage(el.dataset.page);
      });
      const arrow = el.querySelector('.nav-parent-toggle');
      if (arrow) {
        arrow.addEventListener('click', (e) => {
          e.stopPropagation();
          if (el.dataset.navToggle) toggleNavSub(el.dataset.navToggle);
        });
      }
    });
    document.querySelectorAll('.nav-subitem').forEach(el => {
      // 分类树子项（data-category）的点击由右键管理模块处理（切换分类筛选，不切页面）
      if (el.dataset.category !== undefined) return;
      el.addEventListener('click', () => {
        // 优化中心分类子项：设置分类过滤并切换到优化页
        if (el.dataset.optcat !== undefined) {
          window.optimizer?.setCategory?.(el.dataset.optcat);
          switchPage('optimizer');
          return;
        }
        switchPage(el.dataset.page);
      });
    });
    // 恢复各父级子菜单的展开/折叠状态（默认折叠；用户手动切换后持久保留）
    document.querySelectorAll('[data-nav-submenu]').forEach(sub => {
      const key = sub.dataset.navSubmenu;
      const saved = getNavSubExpanded(key);
      applyNavSubState(key, saved === null ? getNavSubDefaultExpanded(key) : saved);
    });

    // 侧边栏滚轮联动：鼠标悬停在导航区（含展开的子菜单）时，
    // 优先滚动侧边栏本身，直到侧边栏滚动到底/顶（全部功能显示完整），
    // 剩余增量再转发到主内容区，避免滚动被展开项"困住"。
    const navSection = document.querySelector('.nav-section');
    const mainContent = document.getElementById('mainContent');
    if (navSection && mainContent) {
      navSection.addEventListener('wheel', (e) => {
        let delta = e.deltaY;
        if (e.deltaMode === 1) delta *= 16;        // 行 → 像素
        else if (e.deltaMode === 2) delta *= mainContent.clientHeight; // 页 → 像素
        const maxNavScroll = navSection.scrollHeight - navSection.clientHeight;
        if (maxNavScroll <= 0) {
          // 侧边栏无可滚动空间：增量直接给主内容
          mainContent.scrollTop += delta;
          e.preventDefault();
          return;
        }
        // 先滚动侧边栏，边界外的剩余增量交给主内容
        const newTop = navSection.scrollTop + delta;
        if (newTop < 0) {
          mainContent.scrollTop += newTop; // 侧边栏到顶后，向上部分滚主内容
          navSection.scrollTop = 0;
        } else if (newTop > maxNavScroll) {
          const leftover = newTop - maxNavScroll;
          mainContent.scrollTop += leftover; // 侧边栏到底后，向下部分滚主内容
          navSection.scrollTop = maxNavScroll;
        } else {
          navSection.scrollTop = newTop;
        }
        e.preventDefault();
      }, { passive: false });
    }

    // 模态默认关闭（usage-modal 由各自创建逻辑处理 backdrop 点击关闭）

    // 点击空白区域关闭最顶层 Toast
    document.addEventListener('click', dismissTopToastOnClick);

    // ==================== 窗口尺寸变化修复（最大化/还原/手动缩放） ====================
    // 只强制一次布局回流，不给标题栏/主布局追加 transform 合成层；后者在
    // Electron 最大化后可能留下过期的 hit-test 缓存，导致鼠标事件落不到按钮。
    let resizeTimer = null;
    function forceHitTestRefresh() {
      void document.documentElement.offsetWidth;
      void document.body.offsetHeight;
      requestAnimationFrame(() => {
        void document.querySelector('.layout')?.offsetWidth;
        refreshCollapseHeights();
      });
    }
    function refreshCollapseHeights() {
      document.querySelectorAll(
        '.category-group:not(.collapsed) > .category-group-content, ' +
        '.sub-group:not(.collapsed) > .sub-group-content, ' +
        '.ctx-cat-group:not(.collapsed) > .ctx-cat-content, ' +
        '.nav-submenu.expanded'
      ).forEach(el => {
        el.style.maxHeight = el.scrollHeight + 'px';
      });
    }
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        forceHitTestRefresh();
      }, 120);
    });
    window.api?.window?.onResized?.((bounds) => {
      // Win11 27H2：最大化期间由渲染层自绘不透明底色，避免 DWM 材质层黑帧；
      // 强制一次回流促使合成器立即提交新帧，消除最大化/还原后的残帧。
      const isMax = !!(bounds && bounds.maximized);
      if (document.body.classList.contains('win-maximized') !== isMax) {
        document.body.classList.toggle('win-maximized', isMax);
        void document.body.offsetHeight;
      }
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(forceHitTestRefresh, 0);
    });

    // 日志页面
    document.getElementById('btnRefreshLog')?.addEventListener('click', () => logger.load());
    document.getElementById('btnExportLog')?.addEventListener('click', () => logger.export());
    document.getElementById('btnClearLog')?.addEventListener('click', () => logger.clear());
    document.getElementById('btnUsageGuide')?.addEventListener('click', showUsageGuide);
    document.getElementById('btnUsageClose')?.addEventListener('click', closeUsageGuide);
    const usageBackdrop = document.getElementById('usageBackdrop');
    usageBackdrop?.addEventListener('click', (e) => {
      if (e.target === usageBackdrop) closeUsageGuide();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && usageBackdrop && usageBackdrop.style.display === 'flex') {
        closeUsageGuide();
      }
    });

    // 设置 - 主题切换
    document.querySelectorAll('input[name="theme"]').forEach(el => {
      el.addEventListener('change', () => {
        const v = el.value;
        theme.setStored(v);
        theme.apply(v);
      });
    });

    // 加载应用信息
    loadAppInfo();

    // 初始化各模块
    cleanup.init();
    contextmenu.init();
    optimizer.init();
    netspeed.init();
    realtime.init();
    diskbench.init();
    deviceinfo.init();
    overview.init();
    sysrestore.init();
    memoryclean.init();
    startup.init();
    window.maintenance?.init?.();

    // 字体管理：启动时恢复已保存的字体 / 字重 / 字号设置（默认 MiSans · 400 · 16px）
    window.fontmanager?.restore?.();

    // 暴露给其它模块（须在页面模块启动逻辑之前，保证其可调用 app 能力）
    window.app = { toast, confirm, log, switchPage, loadAppInfo, requestElevation, getState: () => appState };

    // 初始加载：恢复上次活跃页（窗口状态记忆），无记录则默认系统概览
    const lastPage = (() => { try { return localStorage.getItem(ACTIVE_PAGE_KEY); } catch (e) { return null; } })();
    if (lastPage && lastPage !== 'overview' && document.getElementById('page-' + lastPage)) {
      switchPage(lastPage);
    } else if (document.getElementById('page-overview')?.classList.contains('active')) {
      overview.start();
    }

    // 初始化日志
    setTimeout(() => log('info', '应用启动'), 500);

    // 监听主进程的优雅关闭请求（用户点击关闭按钮时触发）
    if (window.api?.shutdown?.onRequest) {
      window.api.shutdown.onRequest(startGracefulShutdown);
    }

    // 内存占用优化：窗口最小化/隐藏后主动回收渲染进程堆内存
    // （主进程经 js-flags --expose-gc 暴露 gc()，同时通过 memory:trim 通知；浏览器模式退化为 visibilitychange）
    const trimRendererMemory = () => { try { window.gc && window.gc(); } catch (e) {} };
    if (window.api?.app?.onMemoryTrim) {
      window.api.app.onMemoryTrim(trimRendererMemory);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') trimRendererMemory();
    });
  }

  // 等待 DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
