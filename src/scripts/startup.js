// startup.js - 启动项管理模块
// 扫描注册表 Run/RunOnce、启动文件夹、登录/开机计划任务；支持禁用/启用（可逆）与备份后删除
(function () {
  'use strict';

  let items = [];
  let filter = 'all';
  let loading = false;

  const SOURCE_META = {
    registry: { label: '注册表', cls: 'reg', color: 'var(--accent)' },
    folder: { label: '启动文件夹', cls: 'folder', color: '#16A34A' },
    task: { label: '计划任务', cls: 'task', color: '#D97706' }
  };

  function el(id) { return document.getElementById(id); }

  function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, m => map[m]);
  }

  function truncate(text, len) {
    const s = String(text || '');
    return s.length > len ? s.slice(0, len) + '…' : s;
  }

  function getFiltered() {
    if (filter === 'all') return items;
    if (filter === 'disabled') return items.filter(i => !i.enabled);
    return items.filter(i => i.source === filter);
  }

  // ==================== 防恢复机制 ====================
  // 用户禁用启动项后，若连续 3 次扫描发现该项仍被外部程序自动恢复（重新启用），
  // 则自动执行「删除 + 加入防恢复黑名单」；黑名单项再次出现时会被立即自动删除，
  // 从源头阻止程序反复创建该启动项。状态持久化在 localStorage。
  const DEFEND_KEY = 'winclean-startup-defend';     // { 指纹: { name, strikes } }
  const BLACKLIST_KEY = 'winclean-startup-blacklist'; // [指纹...]
  const DEFEND_STRIKES_LIMIT = 3;

  function loadStore(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || '');
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function saveStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function fpOf(item) {
    return [item.source || '', item.name || '', item.command || ''].join('|');
  }

  // 扫描完成后调用：黑名单拦截 + 顽固恢复计数升级
  async function enforceStartupDefend() {
    if (!items.length || !window.api?.startup?.remove) return;
    const blacklist = loadStore(BLACKLIST_KEY, []);
    const defend = loadStore(DEFEND_KEY, {});
    let changed = false;
    const autoDeleted = [];
    const escalated = [];

    // 1) 黑名单项再次出现（程序重新创建）→ 立即自动删除（有备份）
    const blItems = items.filter(i => blacklist.includes(fpOf(i)));
    if (blItems.length) {
      try {
        await window.api.startup.remove(blItems);
        autoDeleted.push(...blItems.map(i => i.name || '未命名'));
        const fps = new Set(blItems.map(fpOf));
        items = items.filter(i => !fps.has(fpOf(i)));
        changed = true;
      } catch (e) { /* 删除失败保留，下次扫描再次拦截 */ }
    }

    // 2) 被用户禁用的项又被外部恢复 → 累计计数，达到 3 次自动删除并拉黑
    for (const fp of Object.keys(defend)) {
      const it = items.find(i => fpOf(i) === fp);
      if (!it) continue; // 本扫描未出现
      if (it.enabled) {
        defend[fp] = { name: defend[fp]?.name || it.name || '未命名', strikes: (defend[fp]?.strikes || 0) + 1 };
        if (defend[fp].strikes >= DEFEND_STRIKES_LIMIT) {
          try {
            await window.api.startup.remove([it]);
            if (!blacklist.includes(fp)) blacklist.push(fp);
            escalated.push(defend[fp].name);
            items = items.filter(i => fpOf(i) !== fp);
            changed = true;
            delete defend[fp];
          } catch (e) { /* 删除失败保留计数，下次扫描再次尝试 */ }
        } else {
          window.app?.log?.('warn', `启动项「${defend[fp].name}」禁用后第 ${defend[fp].strikes} 次被自动恢复（${DEFEND_STRIKES_LIMIT} 次将自动删除并拦截）`);
        }
        changed = true;
      }
    }
    saveStore(BLACKLIST_KEY, blacklist);
    saveStore(DEFEND_KEY, defend);
    if (autoDeleted.length) {
      window.app?.log?.('warn', `防恢复拦截：已自动删除黑名单启动项 ${autoDeleted.join('、')}`);
      window.app?.toast('warning', `防恢复拦截：已自动删除 ${autoDeleted.length} 个被阻止的启动项`);
    }
    if (escalated.length) {
      window.app?.log?.('warn', `防恢复机制：以下启动项连续 ${DEFEND_STRIKES_LIMIT} 次禁用后仍被恢复，已自动删除并加入黑名单：${escalated.join('、')}`);
      window.app?.toast('warning', `已自动删除并拦截 ${escalated.length} 个顽固恢复的启动项`);
    }
    if (changed) render();
  }

  async function scan() {
    if (loading) return;
    if (!window.api?.startup?.scan) {
      renderError('启动项管理仅在 Electron 环境中可用');
      return;
    }
    loading = true;
    setScanBusy(true);
    // 阶段二：扫描期间以骨架屏占位（ds.skeletonRows），完成后由 render()/renderError() 替换
    const skeletonList = el('startupList');
    if (skeletonList && window.ds) skeletonList.innerHTML = window.ds.skeletonRows(6);
    try {
      const resp = await window.api.startup.scan();
      if (!resp || !resp.success) {
        renderError((resp && resp.message) || '扫描启动项失败');
        return;
      }
      items = Array.isArray(resp.data) ? resp.data : [];
      // 按 启用状态 -> 来源 -> 名称 排序，禁用项置底
      items.sort((a, b) => {
        if (!!a.enabled !== !!b.enabled) return a.enabled ? -1 : 1;
        const src = (a.source || '').localeCompare(b.source || '');
        if (src) return src;
        return (a.name || '').localeCompare(b.name || '', 'zh');
      });
      window.app?.toast('success', `扫描完成，共发现 ${items.length} 项启动项`);
      // 防恢复机制：黑名单拦截 + 顽固恢复计数（可能自动删除并刷新列表）
      await enforceStartupDefend();
      render();
    } catch (e) {
      renderError(`扫描启动项失败: ${e.message}`);
    } finally {
      loading = false;
      setScanBusy(false);
    }
  }

  function setScanBusy(busy) {
    const btn = el('btnScanStartup');
    if (!btn) return;
    btn.disabled = busy;
    if (busy) {
      btn.dataset.orig = btn.innerHTML;
      btn.innerHTML = '扫描中…';
    } else if (btn.dataset.orig) {
      btn.innerHTML = btn.dataset.orig;
      delete btn.dataset.orig;
    }
  }

  function render() {
    const enabledCount = items.filter(i => i.enabled).length;
    const disabledCount = items.length - enabledCount;
    el('startupTotal').textContent = items.length;
    el('startupEnabled').textContent = enabledCount;
    el('startupDisabled').textContent = disabledCount;
    el('startupListCount').textContent = `${items.length} 项`;

    const listEl = el('startupList');
    const filtered = getFiltered();
    if (!items.length) {
      listEl.innerHTML = window.emptyState
        ? window.emptyState({ icon: 'search', title: '尚未扫描启动项', desc: '扫描将检测启动文件夹、注册表 Run 键与计划任务中的开机自启项目', cta: { text: '立即扫描', target: 'btnScanStartup' } })
        : '<div class="empty-state"><p>点击右上角「扫描启动项」开始检测</p></div>';
      return;
    }
    if (!filtered.length) {
      listEl.innerHTML = window.emptyState
        ? window.emptyState({ icon: 'box', title: '当前筛选下没有启动项', desc: '尝试切换上方筛选条件，或重新扫描启动项' })
        : '<div class="empty-state"><p>当前筛选下没有启动项</p></div>';
      return;
    }

    listEl.innerHTML = filtered.map(i => {
      const meta = SOURCE_META[i.source] || SOURCE_META.registry;
      // 阶段三：徽章统一 design-system（ds-badge sm）；ds 缺席时回退旧标记
      const badge = i.enabled
        ? (window.ds ? window.ds.badgeHtml('ok', '启用', { small: true }) : '<span class="startup-badge on">启用</span>')
        : (window.ds ? window.ds.badgeHtml('warn', '已禁用', { small: true }) : '<span class="startup-badge off">已禁用</span>');
      const cmd = i.command || '';
      const loc = i.location || meta.label;
      const pub = i.publisher ? `<span class="startup-item-pub" data-tip="发布者">${escapeHtml(i.publisher)}</span>` : '';
      const cmdHtml = cmd
        ? `<div class="startup-item-cmd" data-tip="${escapeHtml(cmd)}">${escapeHtml(truncate(cmd, 120))}</div>`
        : '';
      const locPath = i.resolvedPath || i.filePath || '';
      const locBtn = locPath
        ? `<button class="btn btn-small btn-opt-loc" data-id="${escapeHtml(i.id)}" data-path="${escapeHtml(locPath)}" data-tip="打开文件所在位置">位置</button>`
        : '';
      return `
        <div class="startup-item ${i.enabled ? '' : 'disabled'}" data-id="${escapeHtml(i.id)}">
          <input type="checkbox" class="startup-check startup-item-check" data-id="${escapeHtml(i.id)}" aria-label="选择 ${escapeHtml(i.name || '未命名')}">
          <div class="startup-item-icon ${meta.cls}">
            <svg class="startup-item-glyph" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
            <img class="startup-item-icon-img" alt="" width="18" height="18" data-icon-path="${escapeHtml(locPath)}" hidden>
          </div>
          <div class="startup-item-info">
            <div class="startup-item-title">${escapeHtml(i.name || '未命名')} ${badge}</div>
            ${cmdHtml}
            <div class="startup-item-meta">${escapeHtml(loc)}${pub}</div>
          </div>
          <div class="startup-item-ops">
            ${locBtn}
            ${i.enabled
              ? `<button class="btn btn-small btn-opt-toggle off" data-id="${escapeHtml(i.id)}" data-act="disable" data-tip="禁用（可逆）">禁用</button>`
              : `<button class="btn btn-small btn-opt-toggle on" data-id="${escapeHtml(i.id)}" data-act="enable" data-tip="重新启用">启用</button>`}
            <button class="btn btn-small btn-opt-del" data-id="${escapeHtml(i.id)}" data-act="delete" data-tip="备份后删除">删除</button>
          </div>
        </div>`;
    }).join('') + `
      <div class="startup-list-ops">
        <button class="btn btn-secondary btn-small" id="btnStartupDisableBulk">禁用所选</button>
        <button class="btn btn-secondary btn-small" id="btnStartupEnableBulk">启用所选</button>
        <button class="btn btn-danger btn-small" id="btnStartupDeleteBulk">删除所选</button>
      </div>`;

    // B2：有路径的项提取真实程序图标，失败或无路径时统一兜底为 Trim.ico
    applyStartupIcons(listEl);
  }

  // 启动项图标异步应用：优先 fileIcon(项路径)，失败回退 Trim.ico（icon-fallback 共享缓存）；
  // 图标都不可用时保留源类型 SVG 色块作为降级展示。
  async function applyStartupIcons(container) {
    if (!container || !window.iconFallback || !window.api?.paths?.fileIcon) return;
    const imgs = container.querySelectorAll('.startup-item-icon-img');
    if (!imgs.length) return;
    const fallbackUrl = await window.iconFallback.getFallbackUrl();
    imgs.forEach(img => {
      if (img.dataset.iconDone) return;
      img.dataset.iconDone = '1';
      const p = img.getAttribute('data-icon-path');
      const show = (url) => {
        if (!url) return;
        img.src = url;
        img.hidden = false;
        const glyph = img.parentElement && img.parentElement.querySelector('.startup-item-glyph');
        if (glyph) glyph.style.display = 'none';
      };
      if (p) {
        window.api.paths.fileIcon(p)
          .then(r => show(r && r.success && r.dataUrl ? r.dataUrl : fallbackUrl))
          .catch(() => show(fallbackUrl));
      } else {
        show(fallbackUrl);
      }
    });
  }

  function renderError(msg) {
    el('startupTotal').textContent = '-';
    el('startupEnabled').textContent = '-';
    el('startupDisabled').textContent = '-';
    el('startupListCount').textContent = '0 项';
    el('startupList').innerHTML = `<div class="empty-state"><p>${escapeHtml(msg)}</p></div>`;
  }

  function getSelected() {
    const checked = Array.from(el('startupList').querySelectorAll('.startup-item-check:checked'));
    const ids = checked.map(c => c.dataset.id);
    const filtered = getFiltered();
    const sel = items.filter(i => filtered.some(f => f.id === i.id) && ids.includes(i.id));
    return sel;
  }

  function updateBatchButtons() {
    const sel = getSelected();
    const hasEnable = sel.some(i => !i.enabled);
    const hasDisable = sel.some(i => i.enabled);
    el('btnStartupDisable').disabled = !hasDisable;
    el('btnStartupEnable').disabled = !hasEnable;
    el('btnStartupDelete').disabled = !sel.length;
  }

  async function doToggle(selItems, enable) {
    if (!selItems.length) return;
    const act = enable ? '启用' : '禁用';
    const ok = await window.app.confirm(
      `${act}启动项`,
      `将${act}以下 ${selItems.length} 个启动项：\n${selItems.map(i => '· ' + i.name).join('\n')}\n\n${enable ? '（启用后该项将随系统启动运行）' : '（禁用后可随时重新启用，操作可逆）'}`,
      act,
      '取消'
    );
    if (!ok) return;
    try {
      const resp = await window.api.startup.toggle(selItems, enable);
      const failed = resp && resp.failed ? resp.failed : 0;
      if (resp && resp.success) {
        window.app?.toast('success', `${act}完成，成功 ${resp.success || 0} 项`);
      } else {
        window.app?.toast('warning', `${act}部分失败：${failed} 项未生效`);
      }
      const failedIds = new Set((resp && resp.results || []).filter(r => r.status === 'error').map(r => r.id));
      // 防恢复跟踪：禁用成功 → 记录指纹；手动启用成功 → 清除跟踪
      if (!enable) {
        const defend = loadStore(DEFEND_KEY, {});
        selItems.forEach(i => {
          const r = (resp && resp.results || []).find(x => x.id === i.id);
          if (!r || r.status !== 'error') {
            const fp = fpOf(i);
            defend[fp] = { name: i.name || '未命名', strikes: defend[fp]?.strikes || 0 };
          }
        });
        saveStore(DEFEND_KEY, defend);
      } else {
        const defend = loadStore(DEFEND_KEY, {});
        selItems.forEach(i => { delete defend[fpOf(i)]; });
        saveStore(DEFEND_KEY, defend);
      }
      // 刷新：成功的项状态变更后重扫；失败项标记
      if (failedIds.size) {
        items.forEach(i => { if (failedIds.has(i.id)) i._flag = 'error'; });
        render();
      } else {
        await scan();
      }
    } catch (e) {
      window.app?.toast('error', `${act}失败: ${e.message}`);
    }
  }

  async function doDelete(selItems) {
    if (!selItems.length) return;
    // 删除类操作：规范要求红色二次确认
    const ok = await window.app.confirmDanger(
      '删除启动项',
      `将删除以下 ${selItems.length} 个启动项（删除前会自动备份）：\n${selItems.map(i => '· ' + i.name).join('\n')}`,
      '删除',
      '取消',
      '此操作不可逆，删除后需重新配置才能恢复。'
    );
    if (!ok) return;
    try {
      const resp = await window.api.startup.remove(selItems);
      if (resp && resp.success) {
        window.app?.toast('success', `删除完成，成功 ${resp.success || 0} 项`);
      } else {
        window.app?.toast('warning', `删除部分失败：${(resp && resp.failed) || 0} 项未生效`);
      }
      await scan();
    } catch (e) {
      window.app?.toast('error', `删除失败: ${e.message}`);
    }
  }

  async function openLocation(targetPath) {
    if (!targetPath) return;
    try {
      const resp = await window.api.startup.openLocation(targetPath);
      if (!resp || !resp.success) {
        window.app?.toast('warning', (resp && resp.message) || '打开位置失败');
      }
    } catch (e) {
      window.app?.toast('error', `打开位置失败: ${e.message}`);
    }
  }

  // ==================== 启动项简介 ====================
  // 点击行内「简介」按钮 → 弹窗展示本地内置简介；
  // 联网 AI 简介不会自动请求，需用户再次点击面板中的「获取AI简介」才调用所选大模型。
  function showIntro(item) {
    const sourceLabel = (item.source && SOURCE_META[item.source] ? SOURCE_META[item.source].label : '') || item.location || '';
    const backdrop = document.createElement('div');
    backdrop.className = 'usage-backdrop startup-intro-backdrop';
    backdrop.id = 'startupIntroBackdrop';
    backdrop.innerHTML = `
      <div class="usage-modal startup-intro-modal" role="dialog" aria-modal="true" aria-labelledby="startupIntroTitle">
        <div class="usage-header">
          <h2 id="startupIntroTitle">${escapeHtml(item.name || '未命名')}</h2>
          <button class="usage-close" id="startupIntroClose" type="button" data-tip="关闭" aria-label="关闭">&times;</button>
        </div>
        <div class="usage-body startup-intro-body">
          <div class="startup-intro-meta">启动项 · ${escapeHtml(sourceLabel)}${item.publisher ? ' · ' + escapeHtml(item.publisher) : ''}</div>
          <div id="startupIntroMount"></div>
        </div>
        <div class="usage-footer startup-intro-footer">
          <span class="model-picker-spacer"></span>
          <button class="btn btn-primary" id="startupIntroCloseBtn" type="button">关闭</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const closeIntro = () => {
      document.getElementById('startupIntroBackdrop')?.remove();
      document.removeEventListener('keydown', introKeyHandler);
    };
    function introKeyHandler(e) { if (e.key === 'Escape') closeIntro(); }
    document.addEventListener('keydown', introKeyHandler);

    backdrop.querySelector('#startupIntroClose').addEventListener('click', closeIntro);
    backdrop.querySelector('#startupIntroCloseBtn').addEventListener('click', closeIntro);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) closeIntro(); });

    if (window.intro?.mountIntroPanel) {
      window.intro.mountIntroPanel({
        mount: backdrop.querySelector('#startupIntroMount'),
        scope: 'startup',
        name: item.name,
        company: item.publisher || '',
        item
      });
    } else {
      backdrop.querySelector('#startupIntroMount').innerHTML =
        '<div class="empty-state"><p>简介模块未加载</p></div>';
    }
  }

  async function addItem() {
    if (!window.api?.startup?.add) return;
    try {
      const resp = await window.api.startup.add();
      if (!resp) return;
      if (resp.canceled) return;
      if (!resp.success) {
        window.app?.toast('error', (resp && resp.message) || '添加启动项失败');
        return;
      }
      window.app?.toast('success', `已添加启动项：${resp.name || ''}`);
      await scan();
    } catch (e) {
      window.app?.toast('error', `添加启动项失败: ${e.message}`);
    }
  }

  function init() {
    el('btnScanStartup')?.addEventListener('click', () => scan());
    el('btnAddStartup')?.addEventListener('click', () => addItem());
    el('startupSelectAll')?.addEventListener('change', (e) => {
      el('startupList').querySelectorAll('.startup-item-check').forEach(c => {
        c.checked = e.target.checked;
      });
      updateBatchButtons();
    });
    // 顶部批量按钮
    el('btnStartupDisable')?.addEventListener('click', () => doToggle(getSelected(), false));
    el('btnStartupEnable')?.addEventListener('click', () => doToggle(getSelected(), true));
    el('btnStartupDelete')?.addEventListener('click', () => doDelete(getSelected()));
    // 列表内事件委托（筛选变更后列表会重新渲染）
    el('startupList')?.addEventListener('click', (e) => {
      const locBtn = e.target.closest('.btn-opt-loc');
      if (locBtn) {
        openLocation(locBtn.dataset.path);
        return;
      }
      const delBtn = e.target.closest('.btn-opt-del');
      if (delBtn) {
        const item = items.find(i => i.id === delBtn.dataset.id);
        if (item) doDelete([item]);
        return;
      }
      const togBtn = e.target.closest('.btn-opt-toggle');
      if (togBtn) {
        const item = items.find(i => i.id === togBtn.dataset.id);
        if (item) doToggle([item], togBtn.dataset.act === 'enable');
        return;
      }
      const bulkBtn = e.target.closest('#btnStartupDisableBulk, #btnStartupEnableBulk, #btnStartupDeleteBulk');
      if (bulkBtn) {
        const sel = getSelected();
        if (bulkBtn.id === 'btnStartupDisableBulk') doToggle(sel, false);
        else if (bulkBtn.id === 'btnStartupEnableBulk') doToggle(sel, true);
        else if (bulkBtn.id === 'btnStartupDeleteBulk') doDelete(sel);
        return;
      }
      // 点击条目主体（非按钮/复选框区域）→ 弹出详细简介（含本地简介 + 联网 AI 简介）
      if (!e.target.closest('button, input, label')) {
        const row = e.target.closest('.startup-item');
        if (row) {
          const item = items.find(i => i.id === row.dataset.id);
          if (item) showIntro(item);
        }
      }
    });
    // 复选框变化 -> 更新批量按钮
    el('startupList')?.addEventListener('change', (e) => {
      if (e.target.classList.contains('startup-item-check')) updateBatchButtons();
    });
    // 筛选标签
    el('startupFilter')?.addEventListener('click', (e) => {
      const tab = e.target.closest('.filter-tab');
      if (!tab) return;
      el('startupFilter').querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t === tab));
      filter = tab.dataset.filter;
      el('startupSelectAll').checked = false;
      render();
    });
  }

  window.startup = { init, load: scan };
})();
