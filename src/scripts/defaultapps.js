// defaultapps.js - 默认应用接管（v3.0）
// 三条路径的渲染层编排：
//   A 引导：打开系统「默认应用」设置页（主进程白名单 URI）
//   B 策略 XML（主路径）：DefaultAssociationsConfiguration，官方机制免重启，需管理员
//   C 专家模式：临时禁 UCPD + UserChoice 哈希写入（跨重启状态机由主进程 defaultapps-state.json 记账）
// 安全约定：渲染层只传受支持的 key 与 ProgId 原文；文本一律 escapeHtml，禁拼 HTML。
(function () {
  'use strict';

  const TARGETS = [
    { key: 'http', kind: 'protocol', label: 'HTTP 协议', hint: '网页链接' },
    { key: 'https', kind: 'protocol', label: 'HTTPS 协议', hint: '安全网页链接' },
    { key: '.html', kind: 'extension', label: '.html 文件', hint: '本地网页文件' },
    { key: '.pdf', kind: 'extension', label: '.pdf 文件', hint: 'PDF 文档' }
  ];

  const EXPERT_KEY = 'winclean-appearance';

  let statusData = null;  // defaultapps:status 的 data
  let stateData = null;   // defaultapps:get-state 的 state
  let programs = null;    // defaultapps:list-programs 的 data
  let picks = {};         // 按文件类型模式：key -> progId（用户在页面上的选择）
  let daMode = 'type';    // type = 按文件类型指定 | program = 按程序指定
  let programPicks = {};  // 按程序模式：key -> true（勾选要批量写入的类型）
  let expertMode = false;
  let loading = false;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(type, message, duration) {
    window.app?.toast?.(type, message, duration);
  }

  function readMirror() {
    try { return JSON.parse(localStorage.getItem(EXPERT_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function writeMirror(patch) {
    const ap = readMirror();
    Object.assign(ap, patch);
    try { localStorage.setItem(EXPERT_KEY, JSON.stringify(ap)); } catch (e) {}
  }

  // ==================== 状态展示 ====================
  // 当前关联：优先 UserChoice；其缺失时类级默认才是实际生效的关联（专家模式写入位置），标注「类级」
  function progIdLabel(key) {
    const t = statusData?.targets?.find(x => x.key === key);
    if (t && t.progId) return { name: progDisplayName(t.progId) + '（' + t.progId + '）', muted: false };
    if (t && t.classDefault) return { name: progDisplayName(t.classDefault) + '（类级）', muted: false };
    return { name: '系统默认', muted: true };
  }

  function progDisplayName(progId) {
    const pools = [
      Array.isArray(programs?.protocol) ? programs.protocol : [],
      Array.isArray(programs?.extensionPdf) ? programs.extensionPdf : [],
      Array.isArray(programs?.extensionHtml) ? programs.extensionHtml : []
    ];
    for (const pool of pools) {
      const hit = pool.find(p => p && p.progId === progId && p.name);
      if (hit) return hit.name;
    }
    return progId;
  }

  function candidatesFor(target) {
    if (target.kind === 'protocol') {
      return (Array.isArray(programs?.protocol) ? programs.protocol : []).filter(p => p && p.progId);
    }
    const pool = target.key === '.pdf' ? programs?.extensionPdf : programs?.extensionHtml;
    return (Array.isArray(pool) ? pool : []).filter(p => p && p.progId);
  }

  function renderStatusList() {
    const box = document.getElementById('daStatusList');
    if (!box) return;
    const rows = TARGETS.map(t => {
      const cur = progIdLabel(t.key);
      return '<div class="da-status-row">' +
        '<div class="da-status-copy"><strong>' + escapeHtml(t.label) + '</strong>' +
        '<span>' + escapeHtml(t.hint) + '</span></div>' +
        '<span class="da-status-value' + (cur.muted ? ' muted' : '') + '">' + escapeHtml(cur.name) + '</span>' +
        '</div>';
    });
    box.innerHTML = rows.join('');
  }

  function renderUcpd() {
    const row = document.getElementById('daUcpdRow');
    if (!row) return;
    const start = statusData ? statusData.ucpdStart : null;
    const task = statusData ? statusData.ucpdTaskState : null;
    let badge;
    if (start === 4) {
      badge = '<span class="ds-badge ds-badge-warn">UCPD 已禁用</span>' +
        '<span class="da-ucpd-hint">保护驱动未运行，可直接写入</span>';
    } else if (start == null) {
      badge = '<span class="ds-badge ds-badge-neutral">UCPD 状态未知</span>';
    } else {
      badge = '<span class="ds-badge ds-badge-ok">UCPD 保护中</span>' +
        '<span class="da-ucpd-hint">防篡改驱动运行中' + (task ? ' · 计划任务 ' + escapeHtml(String(task)) : '') + '</span>';
    }
    const policy = statusData && statusData.policyPath
      ? '<div class="da-policy-row"><span class="ds-badge ds-badge-accent">策略生效中</span>' +
        '<span class="da-ucpd-hint" title="' + escapeHtml(statusData.policyPath) + '">DefaultAssociationsConfiguration 已配置</span></div>'
      : '';
    row.innerHTML = '<div class="da-ucpd-line">' + badge + '</div>' + policy;
  }

  function renderPicks() {
    const box = document.getElementById('daPickList');
    if (!box) return;
    if (!programs) {
      box.innerHTML = '<p class="da-hint">候选程序加载中…</p>';
      return;
    }
    const rows = TARGETS.map(t => {
      const cands = candidatesFor(t);
      const cur = (statusData?.targets?.find(x => x.key === t.key) || {}).progId || '';
      const curPick = picks[t.key] != null ? picks[t.key] : cur;
      const opts = ['<option value="">保持现状</option>']
        .concat(cands.map(c =>
          '<option value="' + escapeHtml(c.progId) + '"' + (curPick === c.progId ? ' selected' : '') + '>' +
          escapeHtml(c.name || c.progId) + (c.progId !== (c.name || c.progId) ? '（' + escapeHtml(c.progId) + '）' : '') +
          '</option>'));
      if (!cands.length) {
        opts.push('<option value="" disabled>未枚举到候选程序</option>');
      }
      return '<div class="da-pick-row">' +
        '<div class="da-status-copy"><strong>' + escapeHtml(t.label) + '</strong>' +
        '<span>' + escapeHtml(t.hint) + '</span></div>' +
        '<select class="field-input da-pick-select" data-da-key="' + escapeHtml(t.key) + '">' + opts.join('') + '</select>' +
        '</div>';
    });
    box.innerHTML = rows.join('');
    box.querySelectorAll('.da-pick-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const key = sel.getAttribute('data-da-key');
        if (sel.value) picks[key] = sel.value;
        else delete picks[key];
      });
    });
  }

  // ==================== 按程序指定模式 ====================
  // 候选程序池：合并协议与扩展名两个来源（按 ProgId 去重，保留显示名）
  function allPrograms() {
    const map = new Map();
    const pools = [
      Array.isArray(programs?.protocol) ? programs.protocol : [],
      Array.isArray(programs?.extensionPdf) ? programs.extensionPdf : [],
      Array.isArray(programs?.extensionHtml) ? programs.extensionHtml : []
    ];
    for (const pool of pools) {
      for (const p of pool) {
        if (p && p.progId && !map.has(p.progId)) map.set(p.progId, p);
      }
    }
    return [...map.values()];
  }

  function renderProgramPanel() {
    const panel = document.getElementById('daProgramPanel');
    if (!panel) return;
    if (!programs) {
      panel.innerHTML = '<p class="da-hint">候选程序加载中…</p>';
      return;
    }
    const list = allPrograms();
    const sel = document.getElementById('daProgramSelect');
    const typesBox = document.getElementById('daProgramTypes');
    const hint = document.getElementById('daProgramHint');
    if (!sel || !typesBox || !hint) return;
    if (!list.length) {
      panel.innerHTML = '<p class="da-hint">未枚举到候选程序，请先安装或用「系统设置」确认。</p>';
      return;
    }
    if (!sel.options.length) {
      sel.innerHTML = ['<option value="">选择程序…</option>']
        .concat(list.map(p => '<option value="' + escapeHtml(p.progId) + '">' +
          escapeHtml(p.name || p.progId) + (p.progId !== (p.name || p.progId) ? '（' + escapeHtml(p.progId) + '）' : '') +
          '</option>')).join('');
      sel.addEventListener('change', renderProgramTypes);
    }
    renderProgramTypes();
  }

  function renderProgramTypes() {
    const sel = document.getElementById('daProgramSelect');
    const typesBox = document.getElementById('daProgramTypes');
    const hint = document.getElementById('daProgramHint');
    if (!sel || !typesBox || !hint) return;
    const progId = sel.value || '';
    if (!progId) {
      programPicks = {};
      typesBox.innerHTML = '<span class="da-hint">先选择一个程序</span>';
      hint.textContent = '';
      return;
    }
    // 该程序声明支持的类型 = 在各类型候选池中出现过的；勾选决定批量写入哪些
    const covered = TARGETS.filter(t => candidatesFor(t).some(c => c.progId === progId));
    if (!covered.length) {
      programPicks = {};
      typesBox.innerHTML = '<span class="da-hint">该程序未声明支持受保护的类型（http/https/.html/.pdf）</span>';
      hint.textContent = '';
      return;
    }
    typesBox.innerHTML = covered.map(t => {
      const on = programPicks[t.key] !== false; // 默认全勾
      return '<label class="da-program-type">' +
        '<input type="checkbox" data-da-type="' + escapeHtml(t.key) + '"' + (on ? ' checked' : '') + ' />' +
        escapeHtml(t.label) + '</label>';
    }).join('');
    typesBox.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const key = cb.getAttribute('data-da-type');
        programPicks[key] = cb.checked;
      });
    });
    hint.textContent = '将把勾选的 ' + covered.filter(t => programPicks[t.key] !== false).length + ' 个类型指定为该程序打开；http/https 若系统不接受类级关联，会如实回报。';
  }

  function switchMode(mode) {
    daMode = mode;
    document.querySelectorAll('.da-mode-tab').forEach(btn => {
      const on = btn.getAttribute('data-da-mode') === mode;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const pickList = document.getElementById('daPickList');
    const programPanel = document.getElementById('daProgramPanel');
    if (pickList) pickList.style.display = mode === 'type' ? '' : 'none';
    if (programPanel) programPanel.style.display = mode === 'program' ? '' : 'none';
    if (mode === 'program') renderProgramPanel();
  }

  // ==================== 跨重启状态机横幅 ====================
  function renderStateBanner() {
    const banner = document.getElementById('daStateBanner');
    if (!banner) return;
    const st = stateData || {};
    let html = '';
    const start = st.ucpdStart;
    if (st.phase === 'AWAIT_REBOOT1') {
      if (start === 4) {
        const n = (st.pendingWrites || []).length;
        html = '<div class="da-banner-copy"><strong>上次的专家接管尚未完成</strong>' +
          '<p>UCPD 已确认为禁用状态，检测到 ' + n + ' 项待写入。可直接继续写入。</p></div>' +
          '<div class="da-banner-actions"><button class="btn btn-accent btn-small" id="btnDaResumeWrite">立即继续写入</button></div>';
      } else {
        html = '<div class="da-banner-copy"><strong>等待重启</strong>' +
          '<p>UCPD 禁用已就绪，请重启电脑后回到本页继续写入。（若 Windows 更新重新启用了 UCPD，请重新执行专家接管）</p></div>';
      }
    } else if (st.phase === 'WRITE_DONE') {
      html = '<div class="da-banner-copy"><strong>精确接管写入完成</strong>' +
        '<p>可选择恢复 UCPD 保护（需再重启一次），或保持禁用（省一次重启，代价是长期无防篡改保护）。</p></div>' +
        '<div class="da-banner-actions">' +
        '<button class="btn btn-accent btn-small" id="btnDaBannerRestore">恢复 UCPD 保护</button>' +
        '<button class="btn btn-secondary btn-small" id="btnDaBannerKeep">保持禁用</button></div>';
    } else if (st.phase === 'AWAIT_REBOOT2') {
      html = '<div class="da-banner-copy"><strong>等待重启以恢复保护</strong>' +
        '<p>UCPD 恢复已安排，重启后防篡改保护回归，本流程完成。</p></div>';
    } else if (st.phase === 'XML_APPLIED') {
      html = '<div class="da-banner-copy"><strong>策略接管已应用</strong>' +
        '<p>DefaultAssociationsConfiguration 已写入，下次登录 Windows 时生效（每次登录会重新应用）。</p></div>';
    } else if (st.phase === 'ROLLED_BACK') {
      html = '<div class="da-banner-copy"><strong>专家接管已回滚</strong>' +
        '<p>UCPD 保护即将随下次重启恢复。</p></div>';
    }
    if (html) {
      banner.innerHTML = html;
      banner.style.display = '';
      document.getElementById('btnDaResumeWrite')?.addEventListener('click', () => runExpertWrite(true));
      document.getElementById('btnDaBannerRestore')?.addEventListener('click', restoreUcpd);
      document.getElementById('btnDaBannerKeep')?.addEventListener('click', keepUcpdDisabled);
    } else {
      banner.style.display = 'none';
      banner.innerHTML = '';
    }
    // 「恢复 UCPD」常驻按钮：写入完成或 UCPD 处于禁用时可见
    const restoreBtn = document.getElementById('btnDaRestoreUcpd');
    if (restoreBtn) {
      restoreBtn.style.display = (expertMode && (st.phase === 'WRITE_DONE' || (start === 4 && st.phase))) ? '' : 'none';
    }
  }

  function refreshAll() {
    renderStatusList();
    renderUcpd();
    renderStateBanner();
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const [statusResp, stateResp, progResp, expertResp] = await Promise.all([
        window.api?.defaultapps?.status?.(),
        window.api?.defaultapps?.getState?.(),
        window.api?.defaultapps?.listPrograms?.(),
        window.api?.appearance?.getExpert?.()
      ]);
      if (statusResp?.success) statusData = statusResp.data;
      if (stateResp?.success) stateData = stateResp.state;
      if (progResp?.success) programs = progResp.data;
      expertMode = expertResp ? expertResp.expertMode === true : readMirror().expertMode === true;
      applyExpertVisibility();
      renderPicks();
      if (daMode === 'program') renderProgramPanel();
      refreshAll();
    } finally {
      loading = false;
    }
  }

  // ==================== 专家模式可见性 ====================
  function applyExpertVisibility() {
    const panel = document.getElementById('daExpertPanel');
    const banner = document.getElementById('daExpertBanner');
    if (panel) panel.style.display = expertMode ? '' : 'none';
    if (banner) banner.style.display = expertMode ? 'none' : '';
  }

  // 专家模式开关统一入口（v3.1.0）：设置页开关与本页横幅按钮共用；
  // appearance.json 主进程真源 + localStorage 镜像，回读主进程结果防止不一致
  async function setExpertMode(next) {
    expertMode = next === true;
    writeMirror({ expertMode });
    try {
      const resp = await window.api?.appearance?.setExpert?.(expertMode);
      if (resp && resp.expertMode !== expertMode) expertMode = resp.expertMode;
    } catch (e) {}
    const toggle = document.getElementById('expertModeToggle');
    if (toggle) toggle.checked = expertMode;
    applyExpertVisibility();
    refreshAll();
    toast('info', expertMode ? '专家模式已开启' : '专家模式已关闭');
  }

  function pickEntries() {
    const entries = [];
    for (const t of TARGETS) {
      const sel = document.querySelector('.da-pick-select[data-da-key="' + t.key + '"]');
      const progId = picks[t.key] != null ? picks[t.key] : (sel ? sel.value : '');
      if (progId) entries.push({ key: t.key, kind: t.kind, progId });
    }
    return entries;
  }

  // 当前模式的写入清单：按文件类型取各行下拉；按程序取勾选的覆盖类型
  function currentEntries() {
    if (daMode === 'program') {
      const sel = document.getElementById('daProgramSelect');
      const progId = sel ? sel.value : '';
      if (!progId) return [];
      return TARGETS.filter(t => programPicks[t.key] !== false)
        .filter(t => candidatesFor(t).some(c => c.progId === progId))
        .map(t => ({ key: t.key, kind: t.kind, progId }));
    }
    return pickEntries();
  }

  function requireAdmin(status) {
    if (status && status.isAdmin === false) {
      window.app?.requestElevation?.('「默认应用接管」的策略与驱动操作需要管理员权限。');
      return false;
    }
    return true;
  }

  // ==================== B 路径：策略 XML ====================
  async function applyXml() {
    const entries = currentEntries();
    if (!entries.length) { toast('warning', '请先挑选要接管的项（按文件类型或按程序）'); return; }
    if (!statusData) {
      const resp = await window.api.defaultapps.status();
      if (resp?.success) statusData = resp.data;
    }
    if (!requireAdmin(statusData)) return;
    const ok = await window.app.confirm(
      '策略接管确认',
      '将为 ' + entries.map(e => e.key).join('、') + ' 写入官方 DefaultAssociationsConfiguration 策略：\n\n' +
      entries.map(e => '· ' + e.key + ' → ' + e.progId).join('\n') +
      '\n\n需要管理员权限；配置在下次登录 Windows 时生效，且每次登录都会重新应用。',
      '仍然执行', '取消'
    );
    if (!ok) return;
    const resp = await window.api.defaultapps.applyXml(entries);
    if (resp?.success) {
      toast('success', '策略已写入，下次登录生效');
    } else if (resp?.needAdmin) {
      toast('warning', resp.message || '需要管理员权限');
      window.app?.requestElevation?.('写入默认应用策略需要管理员权限。');
    } else {
      toast('error', resp?.message || '策略写入失败');
    }
    await load();
  }

  async function removeXmlPolicy() {
    if (!requireAdmin(statusData)) return;
    const ok = await window.app.confirm(
      '移除策略接管',
      '将删除 DefaultAssociationsConfiguration 策略键，Windows 恢复由用户手动管理默认应用。已生效的关联不会被自动撤销。',
      '移除', '取消'
    );
    if (!ok) return;
    const resp = await window.api.defaultapps.removeXmlPolicy();
    if (resp?.success) toast('success', '策略已移除');
    else if (resp?.needAdmin) window.app?.requestElevation?.('移除默认应用策略需要管理员权限。');
    else toast('error', resp?.message || '策略移除失败');
    await load();
  }

  // ==================== C 路径：专家模式（类级关联，零哈希） ====================
  async function runExpertWrite(resume) {
    const st = stateData || {};
    const entries = resume && Array.isArray(st.pendingWrites) && st.pendingWrites.length
      ? st.pendingWrites
      : currentEntries();
    if (!entries.length) { toast('warning', '请先挑选要接管的项（按文件类型或按程序）'); return; }

    // 高危红色确认（方案 §4 文案）：绕过防篡改保护层；类级关联对 http/https 可能不生效
    const go = await window.app.confirmDanger(
      '⚠️ 高危操作确认',
      '「临时禁用 UCPD 驱动接管默认应用」会移除系统对默认应用选择的防篡改保护，且 Windows 更新可能重新启用该驱动使设置回滚。此操作可能被安全软件标记为风险行为。\n\n' +
      entries.map(e => '· ' + e.key + ' → ' + e.progId).join('\n') +
      '\n\n写入方式为类级关联（删除 UserChoice + 类级默认，无哈希）：文件类型可靠，http/https 可能不生效。此操作需要重启电脑。',
      '仍然执行', '取消',
      'UCPD 是 Windows 默认应用选择的防篡改保护层，禁用期间任何程序都可能改写默认应用。'
    );
    if (!go) return;

    const statusResp = await window.api.defaultapps.status();
    if (statusResp?.success) statusData = statusResp.data;
    if (!requireAdmin(statusData)) return;

    const ucpdStart = statusData ? statusData.ucpdStart : null;
    if (ucpdStart !== 4) {
      // 第一步：禁用 UCPD + velocity 任务（含待写入清单记账），等用户重启
      const resp = await window.api.defaultapps.setUcpd(true, entries, ucpdStart);
      if (resp?.success) {
        toast('info', 'UCPD 已禁用，请重启电脑后回到本页继续写入');
      } else if (resp?.needAdmin) {
        toast('warning', resp.message || '需要管理员权限');
        window.app?.requestElevation?.('禁用 UCPD 保护驱动需要管理员权限。');
      } else {
        toast('error', resp?.message || 'UCPD 配置失败');
      }
      await load();
      return;
    }

    // UCPD 已禁用（本次会话禁用或上次重启后回来）：类级关联写入
    const writeResp = await window.api.defaultapps.writeClass(entries);
    const results = Array.isArray(writeResp?.data) ? writeResp.data : [];
    const okList = results.filter(r => r.ok).map(r => r.key);
    const failList = results.filter(r => !r.ok);
    if (okList.length) toast('success', '类级关联已写入：' + okList.join('、'));
    for (const f of failList) {
      toast('error', f.key + ' 写入失败：' + (f.message || '系统未接受'), 5000);
    }
    if (!writeResp?.success) {
      // 如实提示：类级关联对强保护类型可能无效，策略接管是主路径
      await window.app.confirm(
        '写入结果提示',
        '部分项未能写入。http/https 属系统强保护，类级关联可能不生效；此类请使用「策略接管」作为主路径。',
        '知道了', '', { }
      );
    }
    await load();
    // 询问是否恢复保护（已长期禁用 UCPD 的用户可跳过询问，直接选保持）
    const svcDisabled = statusData && statusData.ucpdStart === 4;
    if (svcDisabled && okList.length) {
      const restore = await window.app.confirm(
        '是否恢复 UCPD 保护？',
        '恢复后需要再重启一次电脑使保护回归；选择保持禁用可省一次重启，但系统将长期没有默认应用防篡改保护。',
        '恢复保护', '保持禁用'
      );
      if (restore) await restoreUcpd();
      else await keepUcpdDisabled();
    }
  }

  async function restoreUcpd() {
    if (!requireAdmin(statusData)) return;
    const st = stateData || {};
    const resp = await window.api.defaultapps.setUcpd(false, null, st.ucpdOriginalStart);
    if (resp?.success) {
      toast('info', 'UCPD 恢复已安排，重启电脑后保护回归');
    } else if (resp?.needAdmin) {
      window.app?.requestElevation?.('恢复 UCPD 保护驱动需要管理员权限。');
    } else {
      toast('error', resp?.message || 'UCPD 恢复失败');
    }
    await load();
  }

  async function keepUcpdDisabled() {
    // 用户明确选择保持禁用：只记状态，不再动系统
    toast('info', '已保持 UCPD 禁用；随时可在本页点击「恢复 UCPD 保护」');
    const resp = await window.api.defaultapps.getState();
    if (resp?.success) stateData = resp.state;
    refreshAll();
  }

  // ==================== 初始化 ====================
  function init() {
    document.getElementById('btnDaRefresh')?.addEventListener('click', load);
    document.getElementById('btnDaApplyXml')?.addEventListener('click', applyXml);
    document.getElementById('btnDaRemovePolicy')?.addEventListener('click', removeXmlPolicy);
    document.getElementById('btnDaOpenSettings')?.addEventListener('click', () => {
      window.api?.defaultapps?.openSettings?.();
    });
    document.getElementById('btnDaExpertWrite')?.addEventListener('click', () => runExpertWrite(false));
    document.getElementById('btnDaRestoreUcpd')?.addEventListener('click', restoreUcpd);
    document.querySelectorAll('#daModeTabs .da-mode-tab').forEach(btn => {
      btn.addEventListener('click', () => switchMode(btn.getAttribute('data-da-mode')));
    });

    // 专家模式开关（设置页 → 系统信息分区）：appearance.json 主进程真源 + localStorage 镜像
    // 镜像仅在 IPC 失败（resp 缺失）时兜底，禁止陈旧镜像覆盖主进程真值
    const toggle = document.getElementById('expertModeToggle');
    if (toggle) {
      window.api?.appearance?.getExpert?.().then(resp => {
        expertMode = resp ? resp.expertMode === true : readMirror().expertMode === true;
        toggle.checked = expertMode;
      }).catch(() => {});
      toggle.addEventListener('change', () => setExpertMode(toggle.checked));
    }
    // v3.1.0：默认应用页横幅右侧「开启专家模式」快捷按钮
    document.getElementById('btnDaEnableExpert')?.addEventListener('click', () => setExpertMode(true));
  }

  window.defaultapps = { init, load };
})();
