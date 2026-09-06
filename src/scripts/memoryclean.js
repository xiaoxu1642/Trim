// memoryclean.js - 内存清理模块
// 参考 Mem Reduct：按内存区域（工作集/修改列表/备用列表/低优先级备用列表/合并物理内存页）
// 勾选清理；区域条目点击弹窗查看详细简介（复用启动项管理的交互）。
// 「运行中的进程」入口精简为「去管理」按钮，详细列表在独立「应用进程管理」窗口展示
// （见 process-manager-window.js + processes.js）。
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // 内存清理区域定义（与 memory-scripts.js 的 cleanScript 顺序保持一致）
  // 注：系统文件缓存(82)、注册表缓存(84) 在 Windows 11 27H2 上系统级不可用，已移除
  // 顽固软件专杀(kind:'stubborn') 走独立脚本（memory:stubborn-kill），非内存区清理。
  const REGIONS = [
    { id: 'workingSet', name: '进程工作集', risk: 'low', checked: true,
      desc: '逐进程收紧内存工作集，系统进程与游戏自动跳过，最常用' },
    { id: 'standbyPriority0', name: '低优先级待机', risk: 'low', checked: true,
      desc: '仅清理 0 优先级待机页，不影响常用缓存，安全' },
    { id: 'combine', name: '组合内存', risk: 'medium', checked: true,
      desc: '物理内存页去重，降低页表开销，Win10+ 可用' },
    { id: 'modified', name: '修改页面列表', risk: 'high', checked: true,
      desc: '脏页写盘后回收，触发磁盘 I/O，可能短暂卡顿' },
    { id: 'standby', name: '待机列表', risk: 'high', checked: true,
      desc: 'SuperFetch 预读缓存，回收最安全、释放量大' },
    // 系统文件缓存(82)、注册表缓存(84)：Windows 11 27H2 上系统级调用返回错误，不可清理，
    // 仅作灰显说明展示（sysUnavailable），不进入可清理/勾选流程。
    { id: 'fileCache', name: '系统文件缓存', sysUnavailable: true,
      desc: '压低缓存上限强制回收文件页（当前系统版本不可用）' },
    { id: 'registryCache', name: '注册表缓存', sysUnavailable: true,
      desc: '注册表预读缓存（Win8.1+ 可用，当前系统版本不可用）' },
    { id: 'stubbornKill', name: '顽固软件专杀', risk: 'medium', checked: true, kind: 'stubborn',
      desc: '一次性结束 MuMu 模拟器 / 网易 UU 远程 / 抖音 / 剪映 / WPS 金山办公 / 微软电脑管家 的后台常驻与守护进程（含这些软件的前台进程，请先保存工作）' }
  ];

  const RISK_LABELS = { low: '低风险', medium: '中风险', high: '高风险' };

  let maximized = false;     // 窗口最大化（指标卡一行展示）

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
  function fmtPercent(p) { return (isFinite(p) ? Math.round(p) : 0) + '%'; }
  function barColor(p) {
    if (p >= 90) return 'linear-gradient(90deg, #DC2626, #EF4444)';
    if (p >= 70) return 'linear-gradient(90deg, #D97706, #F59E0B)';
    return '';
  }
  function setBar(el, percent) {
    if (!el) return;
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    el.style.width = p + '%';
    el.style.background = barColor(p) || '';
  }

  // ==================== 指标卡（与系统概览同款 2x2 / 最大化一行） ====================
  function applyLayout() {
    const el = document.querySelector('.mem-metrics');
    if (el) el.classList.toggle('overview-maximized', maximized);
    fitMemValue();
  }
  if (window.api?.window?.onResized) {
    window.api.window.onResized((bounds) => {
      maximized = !!(bounds && bounds.maximized);
      applyLayout();
    });
  }

  // ==================== 内存信息 ====================
  async function loadInfo() {
    if (window.api?.memory) {
      try {
        const resp = await window.api.memory.info();
        if (resp && resp.success && resp.data) {
          renderInfo(resp.data);
          return;
        }
        throw new Error((resp && resp.message) || '读取失败');
      } catch (e) {
        window.app?.toast('error', '读取内存信息失败：' + e.message);
      }
    } else {
      // 浏览器预览模式模拟
      renderInfo({ total: 16 * 1073741824, free: 5.5 * 1073741824, used: 10.5 * 1073741824, load: 66, pageTotal: 8 * 1073741824, pageUsed: 3 * 1073741824, cache: 2.2 * 1073741824 });
    }
  }

  // 数值过长（如 10.3 GB / 15.7 GB 在四联卡宽度下折成三行）时自动缩小字号，
  // 最多两行封顶（CSS 侧另有 -webkit-line-clamp 兜底）；显示/尺寸变化经 ResizeObserver 重算
  function fitMemValue() {
    const el = $('memUseValue');
    if (!el) return;
    el.style.fontSize = '';
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    const twoLines = lh * 2 + 1;
    let size = parseFloat(cs.fontSize);
    let guard = 8;
    while (guard-- > 0 && el.scrollHeight > twoLines && size > 12) {
      size -= 1;
      el.style.fontSize = size + 'px';
    }
  }
  if (window.ResizeObserver) {
    const fitTarget = document.getElementById('memUseValue');
    if (fitTarget) new ResizeObserver(() => fitMemValue()).observe(fitTarget);
  }

  function renderInfo(d) {
    const total = Number(d.total) || 0;
    const free = Number(d.free) || 0;
    const used = Number(d.used) || 0;
    const load = Number(d.load) || 0;

    // 环形进度已展示百分比（用户要求去掉重复：文字只保留字节数）；
    // ds 未加载（无环）时保留百分比前缀作为降级展示。
    const hasRing = ensureRing();
    const v = $('memUseValue');
    if (v) v.textContent = (hasRing ? '' : fmtPercent(load) + ' · ') + fmtBytes(used) + ' / ' + fmtBytes(total);
    fitMemValue();
    setBar($('memUseBar'), load);
    if (hasRing) setRingValue(load);

    const f = $('memFreeValue');
    if (f) f.textContent = fmtBytes(free);

    const pf = $('memPagefileValue');
    if (pf) {
      const pt = Number(d.pageTotal) || 0;
      const pfUsed = Number(d.pageUsed) || 0;
      pf.textContent = pt ? fmtBytes(pfUsed) + ' / ' + fmtBytes(pt) : '--';
    }

    const c = $('memCacheValue');
    if (c) c.textContent = fmtBytes(Number(d.cache) || 0);
  }

  // 指标卡环形进度（design-system ds.progress.circle）：与线形进度同阈值变色
  let memRing = null;
  function ensureRing() {
    if (memRing) return true;
    const slot = $('memUseRingSlot');
    if (!slot || !window.ds?.progress) return false; // ds.js 未加载时优雅降级为无线环
    memRing = window.ds.progress.circle({ size: 48, stroke: 5, label: '物理内存使用率' });
    slot.appendChild(memRing.el);
    return true;
  }
  function setRingValue(load) {
    const p = Math.max(0, Math.min(100, Number(load) || 0));
    const color = p >= 90 ? '#DC2626' : p >= 70 ? '#D97706' : '';
    memRing.set(p, Math.round(p) + '%', color);
  }

  // ==================== 清理区域表格（点击条目弹简介） ====================
  // 行内展示名称 + 一句话说明（让清理项更易懂）；点击条目仍弹出详细简介弹窗（保留既有交互）。
  function renderRegions() {
    const root = $('memRegionList');
    if (!root) return;
    root.innerHTML = `
      <div class="xtable">
        <div class="xtable-head">
          <div class="xtable-th" style="width:44px">勾选</div>
          <div class="xtable-th" style="flex:1">清理区域</div>
          <div class="xtable-th" style="width:90px">风险</div>
          <div class="xtable-th" style="width:110px">操作</div>
        </div>
        ${REGIONS.map(r => `
          <div class="xtable-row mem-region-row ${r.sysUnavailable ? 'mem-region-disabled' : ''}" data-id="${r.id}" data-tip="点击查看该区域的详细简介">
            <div class="xtable-td" style="width:44px">
              <label class="mem-check">
                <input type="checkbox" data-check="${r.id}" ${r.sysUnavailable ? 'disabled' : ''} ${r.checked ? 'checked' : ''} />
                <span class="mem-check-box"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>
              </label>
            </div>
            <div class="xtable-td" style="flex:1">
              <div class="mem-region-name">${escapeHtml(r.name)}</div>
              <div class="mem-region-desc">${escapeHtml(r.desc)}</div>
            </div>
            <div class="xtable-td" style="width:90px">${r.sysUnavailable
              ? '<span class="category-risk unused">不可用</span>'
              : `<span class="category-risk ${r.risk}">${RISK_LABELS[r.risk]}</span>`}</div>
            <div class="xtable-td" style="width:110px">
              ${r.sysUnavailable
                ? '<span class="mem-region-na">系统级不可用</span>'
                : `<button class="btn btn-secondary btn-small mem-region-clean" data-clean="${r.id}" type="button">清理该项</button>`}
            </div>
          </div>`).join('')}
      </div>`;

    // 勾选状态（跳过系统级不可用项）
    root.querySelectorAll('input[data-check]').forEach(cb => {
      if (cb.disabled) return;
      cb.addEventListener('change', () => {
        const r = REGIONS.find(x => x.id === cb.dataset.check);
        if (r) r.checked = cb.checked;
        updateRegionCount();
      });
    });
    // 单项清理
    root.querySelectorAll('.mem-region-clean').forEach(btn => {
      btn.addEventListener('click', () => runClean([btn.dataset.clean]));
    });
    // 点击条目主体（非按钮/勾选框）→ 弹窗展示详细简介（本地 + 联网 AI）
    root.querySelectorAll('.mem-region-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button, input, label')) return;
        const r = REGIONS.find(x => x.id === row.dataset.id);
        if (r) showRegionIntro(r);
      });
    });
    updateRegionCount();
  }

  function updateRegionCount() {
    const cnt = $('memRegionCount');
    if (!cnt) return;
    const usable = REGIONS.filter(r => !r.sysUnavailable);
    const na = REGIONS.length - usable.length;
    cnt.textContent = `${usable.length} 项可清理 · 已选 ${usable.filter(r => r.checked).length}${na ? ` · ${na} 项系统不可用` : ''}`;
  }

  function selectAll(checked) {
    REGIONS.forEach(r => { if (!r.sysUnavailable) r.checked = checked; });
    renderRegions();
  }

  // ==================== 区域简介弹窗（复用启动项管理交互） ====================
  function showRegionIntro(region) {
    const backdrop = document.createElement('div');
    backdrop.className = 'usage-backdrop';
    backdrop.id = 'memRegionIntroBackdrop';
    backdrop.innerHTML = `
      <div class="usage-modal" role="dialog" aria-modal="true" aria-labelledby="memRegionIntroTitle">
        <div class="usage-header">
          <h2 id="memRegionIntroTitle">${escapeHtml(region.name)}</h2>
          <button class="usage-close" type="button" data-tip="关闭" aria-label="关闭">&times;</button>
        </div>
        <div class="usage-body">
          <div class="startup-intro-meta">内存清理区域 · ${RISK_LABELS[region.risk]}</div>
          <div id="memRegionIntroMount"></div>
        </div>
        <div class="usage-footer">
          <span class="model-picker-spacer"></span>
          <button class="btn btn-primary" id="memRegionIntroClose" type="button">关闭</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const closeIntro = () => {
      document.getElementById('memRegionIntroBackdrop')?.remove();
      document.removeEventListener('keydown', escHandler);
    };
    function escHandler(e) { if (e.key === 'Escape') closeIntro(); }
    document.addEventListener('keydown', escHandler);

    backdrop.querySelector('.usage-close').addEventListener('click', closeIntro);
    backdrop.querySelector('#memRegionIntroClose').addEventListener('click', closeIntro);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) closeIntro(); });

    if (window.intro?.mountIntroPanel) {
      window.intro.mountIntroPanel({
        mount: backdrop.querySelector('#memRegionIntroMount'),
        scope: 'memoryclean',
        name: region.name,
        company: '内存清理',
        item: { id: region.id, name: region.name, group: '内存清理', title: region.name }
      });
    } else {
      backdrop.querySelector('#memRegionIntroMount').innerHTML =
        '<div class="empty-state"><p>简介模块未加载</p></div>';
    }
  }

  // ==================== 执行清理 ====================
  async function runClean(items) {
    const requested = items || REGIONS.filter(r => r.checked).map(r => r.id);
    const selected = REGIONS.filter(r => requested.includes(r.id));
    if (!selected.length) {
      window.app?.toast('warning', '请先勾选要清理的内存区域');
      return;
    }
    const memSel = selected.filter(r => r.kind !== 'stubborn');
    const stubbornSel = selected.filter(r => r.kind === 'stubborn');
    if (stubbornSel.length) await runStubbornKill();
    if (memSel.length) await runMemoryClean(memSel);
  }

  async function runMemoryClean(regions) {
    const list = regions.map(r => r.id);
    // 危险区域二次确认（修改列表 / 备用列表全部）
    const dangerous = regions.filter(r => r.risk === 'high');
    if (dangerous.length) {
      const ok = await window.app.confirmDanger(
        '高危内存清理确认',
        `以下区域属于高危操作，可能导致系统短暂卡顿或需要重新读取数据：\n\n` +
        dangerous.map(r => `· ${r.name}`).join('\n'),
        '仍然清理',
        '取消',
        '此操作可能影响正在运行的应用，请确认已了解风险。'
      );
      if (!ok) return;
    }
    if (!window.api?.memory) {
      window.app?.toast('warning', '预览模式不支持实际清理');
      return;
    }
    window.app?.toast('info', '正在清理内存…');
    try {
      const resp = await window.api.memory.clean(list);
      if (resp && resp.success && resp.data) {
        const d = resp.data;
        const okCount = (d.results || []).filter(x => x.ok).length;
        const failCount = (d.results || []).length - okCount;
        // NTSTATUS 可读化
        const statusText = st => {
          const u = (Number(st) >>> 0).toString(16).toUpperCase().padStart(8, '0');
          const map = { C0000005: '权限不足', C0000022: '访问被拒绝', C0000061: '缺少特权', C0000003: '系统不支持' };
          return map[u] || `0x${u}`;
        };
        const note = (d.results || []).filter(x => !x.ok)
          .map(x => `${x.name}（${statusText(x.status)}）`).join('、');
        const freed = Number(d.freed) || 0;
        window.app?.toast('success', `内存清理完成：释放 ${fmtBytes(freed)}${okCount ? `（成功 ${okCount} 项）` : ''}${failCount ? `，${failCount} 项失败${note ? '：' + note : ''}` : ''}`);
        window.app?.log('info', `内存清理：释放 ${fmtBytes(freed)}，成功 ${okCount} 项，失败 ${failCount} 项`);
        await loadInfo();
        return;
      }
      throw new Error((resp && resp.message) || '清理失败');
    } catch (e) {
      window.app?.toast('error', '内存清理失败：' + e.message);
    }
  }

  // 顽固软件专杀：结束 MuMu/UU远程/抖音/剪映/WPS/微软电脑管家 后台守护进程，结果右上角 toast + 回传日志
  async function runStubbornKill() {
    if (!window.api?.memory?.stubbornKill) {
      window.app?.toast('warning', '预览模式不支持清理顽固软件');
      return;
    }
    window.app?.toast('info', '正在专杀顽固软件后台进程…');
    try {
      const resp = await window.api.memory.stubbornKill();
      if (resp && resp.success && resp.data) {
        const d = resp.data;
        const killed = Number(d.killed) || 0;
        const failed = Number(d.failed) || 0;
        const leftover = Array.isArray(d.leftover) ? d.leftover : [];
        window.app?.toast('success', `顽固软件专杀完成：已结束 ${killed} 个进程` + (failed ? `，${failed} 个失败` : '') + (leftover.length ? `，仍有残留 ${leftover.join('、')}` : ''));
        window.app?.log('info', `顽固软件专杀：已结束 ${killed} 个进程，失败 ${failed} 个，剩余 ${leftover.join('、') || '无'}`);
        return;
      }
      throw new Error((resp && resp.message) || '专杀失败');
    } catch (e) {
      window.app?.toast('error', '顽固软件专杀失败：' + e.message);
    }
  }

  // ==================== 打开「应用进程管理」独立窗口 ====================
  async function openProcessManager() {
    try {
      if (window.api?.processManager?.openWindow) {
        const resp = await window.api.processManager.openWindow();
        if (resp && resp.success) return;
      }
      window.app?.toast('warning', '进程管理窗口暂不可用');
    } catch (e) {
      window.app?.toast('error', '打开进程管理窗口失败：' + e.message);
    }
  }

  // ==================== 初始化 ====================
  function init() {
    $('btnMemRefresh')?.addEventListener('click', () => { loadInfo(); });
    $('btnMemProcesses')?.addEventListener('click', () => { openProcessManager(); });
    $('btnMemClean')?.addEventListener('click', () => { runClean(); });
    $('btnMemSelectAll')?.addEventListener('click', () => selectAll(true));
    $('btnMemSelectNone')?.addEventListener('click', () => selectAll(false));
    $('btnOpenProcessManager')?.addEventListener('click', () => { openProcessManager(); });
    // 进程管理窗口结束进程后，实时更新卡片中间的回显区
    window.api?.processManager?.onUpdate?.((data) => {
      updateProcessEntry(data);
    });
    $('btnMemAiIntro')?.addEventListener('click', () => {
      if (window.modelpicker && typeof window.modelpicker.open === 'function') {
        window.modelpicker.open('memoryclean');
      } else {
        window.app?.toast('warning', '模型选择暂不可用，请稍后重试');
      }
    });
    applyLayout();
    renderRegions();
    loadInfo();
    loadProcessSummary();
  }

  // 读取进程管理窗口打开前的最新进程数，作为卡片初始回显
  async function loadProcessSummary() {
    try {
      if (window.api?.memory?.processes) {
        const resp = await window.api.memory.processes();
        if (resp && resp.success && Array.isArray(resp.processes)) {
          updateProcessEntry({ totalCount: resp.processes.length });
        }
      }
    } catch (_) { /* 静默，保持初始占位文案 */ }
  }

  // 更新「运行中的进程」一行式卡片中间内容区
  function updateProcessEntry(data) {
    const summary = document.querySelector('.process-entry-summary');
    if (!summary) return;
    const total = data && typeof data.totalCount === 'number' ? data.totalCount : null;
    if (total === null) {
      summary.textContent = '尚未管理进程 · 点击「去管理」打开管理窗口';
      summary.className = 'process-entry-summary';
      return;
    }
    summary.textContent = `当前共 ${total} 个运行中的进程 · 点击「去管理」查看详情`;
    summary.className = 'process-entry-summary ok';
  }

  window.memoryclean = { init, loadInfo };
})();
