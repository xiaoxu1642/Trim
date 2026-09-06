// maintenance.js - 系统维护修复组（P2-16）
// 11 项修复任务：分类计数标签 + 任务卡片 + 每项独立确认 + 实时输出面板。
// 批量操作：复选框勾选 + 「执行选中」/「全部执行」+ 进度与成功/失败反馈 + 取消。
// 数据源为主进程 maintenance:tasks（PowerShell 脚本模块），渲染层不硬编码任务逻辑。
(function () {
  'use strict';

  let tasks = [];               // [{ id, title, desc, category, admin }]
  let categories = [];          // ['系统修复','搜索与界面','网络连接']
  let activeCat = '全部';
  let running = null;           // 正在执行的 taskId（同一时刻仅一个）
  const status = new Map();     // taskId -> 'idle'|'running'|'ok'|'warn'|'error'
  const selected = new Set();   // 批量勾选的 taskId（跨分类保留）
  let batch = null;             // 批量状态 { total, done, ok, fail, cancelRequested } | null
  let outputBound = false;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const STATUS_LABEL = {
    idle: '执行', running: '执行中…', ok: '已完成', warn: '部分完成', error: '失败'
  };

  function visibleTasks() {
    if (activeCat === '全部') return tasks;
    return tasks.filter(t => t.category === activeCat);
  }

  function countFor(cat) {
    if (cat === '全部') return tasks.length;
    return tasks.filter(t => t.category === cat).length;
  }

  // ==================== 分类计数标签 ====================
  function renderTabs() {
    const el = document.getElementById('maintTabs');
    if (!el) return;
    const cats = ['全部', ...categories];
    el.innerHTML = cats.map(c => {
      const active = c === activeCat ? ' active' : '';
      return `<button class="filter-tab${active}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}<span class="maint-tab-count">${countFor(c)}</span></button>`;
    }).join('');
    el.querySelectorAll('.filter-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeCat = btn.dataset.cat;
        renderTabs();
        renderList();
        updateBatchbar();
      });
    });
  }

  // ==================== 任务卡片列表 ====================
  function renderList() {
    const el = document.getElementById('maintList');
    if (!el) return;
    const list = visibleTasks();
    if (!list.length) {
      el.innerHTML = window.emptyState
        ? window.emptyState({ icon: 'search', title: '暂无维护任务', desc: '加载任务清单中，请稍后重试' })
        : '<div class="xtable-empty">暂无任务</div>';
      return;
    }
    const busy = !!running || !!batch;
    el.innerHTML = list.map(t => {
      const st = status.get(t.id) || 'idle';
      const isRunning = running === t.id;
      const isSelected = selected.has(t.id);
      const badge = st !== 'idle' ? `<span class="maint-status maint-status-${st}">${STATUS_LABEL[st] || st}</span>` : '';
      const adminTag = t.admin ? '<span class="maint-admin-tag" title="需要管理员权限">管理员</span>' : '';
      return `
        <div class="maint-card${isSelected ? ' selected' : ''}${isRunning ? ' running' : ''}" data-id="${escapeHtml(t.id)}">
          <label class="maint-check" title="勾选后可批量执行">
            <input type="checkbox" data-check="${escapeHtml(t.id)}" ${isSelected ? 'checked' : ''} ${busy ? 'disabled' : ''} />
          </label>
          <div class="maint-card-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>
          </div>
          <div class="maint-card-body">
            <div class="maint-card-title">${escapeHtml(t.title)}${adminTag}${badge}</div>
            <div class="maint-card-desc">${escapeHtml(t.desc)}</div>
          </div>
          <div class="maint-card-actions">
            <button class="btn btn-primary btn-small maint-run-btn" data-run="${escapeHtml(t.id)}" ${busy ? 'disabled' : ''}>
              ${isRunning ? '执行中…' : (st === 'ok' || st === 'warn' || st === 'error' ? '再次执行' : '执行')}
            </button>
          </div>
        </div>`;
    }).join('');
    el.querySelectorAll('[data-run]').forEach(btn => {
      btn.addEventListener('click', () => runTask(btn.dataset.run));
    });
    el.querySelectorAll('[data-check]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(cb.dataset.check);
        else selected.delete(cb.dataset.check);
        const card = cb.closest('.maint-card');
        if (card) card.classList.toggle('selected', cb.checked);
        updateBatchbar();
      });
    });
  }

  // ==================== 批量操作栏 ====================
  function updateBatchbar() {
    const selAll = document.getElementById('maintSelAll');
    const count = document.getElementById('maintSelCount');
    const btnSel = document.getElementById('btnMaintRunSelected');
    const btnAll = document.getElementById('btnMaintRunAll');
    const btnCancel = document.getElementById('btnMaintCancelBatch');
    const progress = document.getElementById('maintBatchProgress');
    if (!selAll || !count || !btnSel || !btnAll || !btnCancel || !progress) return;

    const visible = visibleTasks();
    const selVisible = visible.filter(t => selected.has(t.id)).length;
    const busy = !!batch || !!running;

    // 全选框：全选 / 部分选（indeterminate）/ 未选
    selAll.checked = visible.length > 0 && selVisible === visible.length;
    selAll.indeterminate = selVisible > 0 && selVisible < visible.length;
    selAll.disabled = busy;

    count.textContent = `已选 ${selected.size} 项`;
    btnSel.disabled = busy || selVisible === 0;
    btnSel.textContent = batch ? '批量执行中…' : `执行选中（${selVisible}）`;
    btnAll.disabled = busy || visible.length === 0;
    btnCancel.style.display = batch ? '' : 'none';
    btnCancel.disabled = !batch || batch.cancelRequested;
    btnCancel.textContent = batch && batch.cancelRequested ? '取消中…' : '取消批量';

    if (batch) {
      progress.style.display = 'flex';
      const pct = Math.round((batch.done / batch.total) * 100);
      document.getElementById('maintBatchProgressFill').style.width = pct + '%';
      document.getElementById('maintBatchProgressText').textContent =
        `${batch.done}/${batch.total} · 成功 ${batch.ok} · 失败 ${batch.fail}${batch.cancelRequested ? ' · 取消中' : ''}`;
    } else {
      progress.style.display = 'none';
    }
  }

  // ==================== 输出面板 ====================
  function showOutput(title) {
    const panel = document.getElementById('maintOutput');
    const body = document.getElementById('maintOutputBody');
    const head = document.getElementById('maintOutputTitle');
    if (head) head.textContent = title;
    if (body) body.textContent = '';
    if (panel) panel.style.display = 'block';
  }

  function appendOutput(line) {
    const body = document.getElementById('maintOutputBody');
    if (!body) return;
    body.textContent += (body.textContent ? '\n' : '') + line;
    body.scrollTop = body.scrollHeight;
  }

  function hideOutput() {
    const panel = document.getElementById('maintOutput');
    if (panel && !batch) panel.style.display = 'none';
  }

  // ==================== 执行单个任务（独立确认） ====================
  async function runOne(task) {
    status.set(task.id, 'running');
    renderList();
    try {
      const resp = await window.api.maintenance.run(task.id);
      const result = resp?.data?.result || (resp?.success ? 'ok' : 'error');
      status.set(task.id, resp?.success ? (result === 'ok' ? 'ok' : result === 'warn' ? 'warn' : 'error') : 'error');
      if (!resp?.success) appendOutput('错误：' + (resp?.message || '执行失败'));
      return status.get(task.id);
    } catch (e) {
      status.set(task.id, 'error');
      appendOutput('异常：' + e.message);
      return 'error';
    } finally {
      renderList();
    }
  }

  async function runTask(taskId) {
    if (running || batch) { window.app?.toast?.('warning', '已有维护任务在执行，请稍候'); return; }
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    if (!window.api?.maintenance) { window.app?.toast?.('warning', '浏览器预览模式不支持执行维护任务'); return; }

    // 独立确认：说明该任务会做什么、是否可逆、是否需重启
    const ok = await window.app?.confirm?.(
      `执行「${task.title}」`,
      `${task.desc}\n\n该操作将立即开始，期间请勿关闭应用。${task.admin ? '\n（需要管理员权限）' : ''}`,
      '确认执行',
      '取消'
    );
    if (!ok) return;

    running = taskId;
    updateBatchbar();
    showOutput(`${task.title} · 执行输出`);

    try {
      const st = await runOne(task);
      window.app?.toast?.(st === 'ok' ? 'success' : (st === 'warn' ? 'warning' : 'error'),
        `${task.title} ${STATUS_LABEL[st] || '完成'}`);
    } finally {
      running = null;
      renderList();
      updateBatchbar();
    }
  }

  // ==================== 批量执行（顺序逐项 + 可取消） ====================
  async function runBatch(mode) {
    if (running || batch) { window.app?.toast?.('warning', '已有维护任务在执行，请稍候'); return; }
    if (!window.api?.maintenance) { window.app?.toast?.('warning', '浏览器预览模式不支持执行维护任务'); return; }
    const list = mode === 'all' ? visibleTasks() : visibleTasks().filter(t => selected.has(t.id));
    if (!list.length) {
      window.app?.toast?.('warning', mode === 'all' ? '当前分类下暂无任务' : '请先勾选要执行的项目');
      return;
    }

    const adminCount = list.filter(t => t.admin).length;
    const ok = await window.app?.confirm?.(
      `批量执行 ${list.length} 项维护任务`,
      `将按顺序逐项执行${mode === 'all' ? '当前分类下的全部项目' : '已勾选的项目'}，执行期间可随时点「取消批量」停止后续项目（正在执行的一项会完成后停止）。\n` +
      `${adminCount ? `\n其中 ${adminCount} 项需要管理员权限。` : ''}\n开始后请勿关闭应用。`,
      '开始批量执行',
      '取消'
    );
    if (!ok) return;

    batch = { total: list.length, done: 0, ok: 0, fail: 0, cancelRequested: false };
    showOutput(`批量执行 ${list.length} 项 · 输出`);
    appendOutput(`===== 批量执行开始：共 ${list.length} 项 =====`);
    updateBatchbar();
    renderList();

    for (const task of list) {
      if (batch.cancelRequested) {
        appendOutput(`—— 已取消：跳过「${task.title}」及后续项目 ——`);
        break;
      }
      running = task.id;
      appendOutput(`—— [${batch.done + 1}/${batch.total}] ${task.title} ——`);
      updateBatchbar();

      const st = await runOne(task);
      if (st === 'ok' || st === 'warn') batch.ok++; else batch.fail++;
      batch.done++;
      running = null;
      updateBatchbar();
    }

    const cancelled = batch.cancelRequested;
    const summary = `成功 ${batch.ok} 项 · 失败 ${batch.fail} 项${cancelled ? ' · 已取消剩余' : ''}`;
    appendOutput(`===== 批量执行结束：${summary} =====`);
    window.app?.toast?.(
      cancelled ? 'warning' : (batch.fail ? 'warning' : 'success'),
      cancelled ? `批量执行已取消（${summary}）` : (batch.fail ? `批量执行完成：${summary}` : `批量执行全部完成：${summary}`)
    );
    batch = null;
    updateBatchbar();
    renderList();
  }

  function cancelBatch() {
    if (!batch || batch.cancelRequested) return;
    batch.cancelRequested = true;
    appendOutput('—— 收到取消请求：当前任务完成后停止 ——');
    window.app?.toast?.('info', '将在当前任务完成后停止批量执行');
    updateBatchbar();
  }

  function toggleSelectAll(checked) {
    visibleTasks().forEach(t => {
      if (checked) selected.add(t.id); else selected.delete(t.id);
    });
    renderList();
    updateBatchbar();
  }

  // 实时输出：仅接收当前运行任务的行
  function onOutput(data) {
    if (!data || data.taskId !== running) return;
    appendOutput(data.line);
  }

  async function loadTasks() {
    if (!window.api?.maintenance) { renderList(); return; }
    try {
      const resp = await window.api.maintenance.tasks();
      if (resp && resp.success && Array.isArray(resp.data)) {
        tasks = resp.data;
        categories = Array.isArray(resp.categories) ? resp.categories : [];
        renderTabs();
        renderList();
        updateBatchbar();
      }
    } catch (e) {
      // 静默：保留空态
    }
  }

  function init() {
    if (!outputBound) {
      outputBound = true;
      document.getElementById('btnMaintOutputClose')?.addEventListener('click', hideOutput);
      document.getElementById('maintSelAll')?.addEventListener('change', (e) => toggleSelectAll(e.target.checked));
      document.getElementById('btnMaintRunSelected')?.addEventListener('click', () => runBatch('selected'));
      document.getElementById('btnMaintRunAll')?.addEventListener('click', () => runBatch('all'));
      document.getElementById('btnMaintCancelBatch')?.addEventListener('click', cancelBatch);
      if (window.api?.maintenance?.onOutput) {
        window.api.maintenance.onOutput(onOutput);
      }
    }
    renderTabs();
    renderList();
    updateBatchbar();
    loadTasks();
  }

  window.maintenance = { init };
})();
