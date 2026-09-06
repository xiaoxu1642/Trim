// peripheral-window.js - 外设优化（更多调优项）窗口
// 三组注册表调优：Win32PrioritySeparation / KeyboardDataQueueSize / MouseDataQueueSize
// 卡片单选 → 「应用到注册表」写入；「恢复默认」写回 Windows 默认值。
(function () {
  'use strict';

  // ==================== 调优项定义 ====================
  const GROUPS = {
    win32: {
      regName: 'Win32PrioritySeparation',
      recommended: 38,
      defaultValue: 2,
      options: [
        { value: 26, desc: '长时间片+固定调度：上下文切换最少、整体最平滑，后台任务更稳' },
        { value: 36, desc: '短时间片+后台等量：输入延迟最低，但后台无优待' },
        { value: 38, desc: '短时间片+前台3倍时间片：Windows 官方「程序」方案，均衡推荐' },
        { value: 40, desc: '短时间片+前后台等量：公平分配，无前台提升' }
      ]
    },
    keyboard: {
      regName: 'KeyboardDataQueueSize',
      recommended: 18,
      defaultValue: 100,
      options: [
        { value: 16, desc: '最小缓冲：延迟最低，极限连击时可能丢键' },
        { value: 18, desc: '小缓冲：延迟低且连击更稳，均衡之选' },
        { value: 20, desc: '中等缓冲：连击更稳，延迟略升' },
        { value: 22, desc: '较大缓冲：最不易丢键，延迟相对最高' }
      ]
    },
    mouse: {
      regName: 'MouseDataQueueSize',
      recommended: 18,
      defaultValue: 100,
      options: [
        { value: 16, desc: '最小缓冲：延迟最低，高速移动时可能丢事件' },
        { value: 18, desc: '小缓冲：延迟低且移动更稳，均衡之选' },
        { value: 20, desc: '中等缓冲：移动更稳，延迟略升' },
        { value: 22, desc: '较大缓冲：最不易丢事件，延迟相对最高' }
      ]
    }
  };

  // 当前选中值（key → value；null = 未选择，应用时跳过该组）
  const selected = { win32: null, keyboard: null, mouse: null };

  function toast(type, msg) {
    if (window.app?.toast) { window.app.toast(type, msg); return; }
    // 独立窗口无 app 桥时兜底提示
    if (window.modal?.toast) window.modal.toast(type, msg);
  }

  // ==================== 渲染 ====================
  function renderGroup(key) {
    const wrap = document.querySelector(`.peri-cards[data-group="${key}"]`);
    if (!wrap) return;
    const def = GROUPS[key];
    wrap.innerHTML = def.options.map(opt => {
      const isRec = opt.value === def.recommended;
      const isSel = selected[key] === opt.value;
      return `
        <div class="peri-card${isSel ? ' selected' : ''}" data-group="${key}" data-value="${opt.value}" title="${def.regName} = ${opt.value}">
          ${isRec ? '<span class="peri-rec">推荐</span>' : ''}
          <span class="peri-radio" aria-hidden="true"></span>
          <div class="peri-value">${opt.value}</div>
          <div class="peri-regname">${def.regName}</div>
          <div class="peri-desc">${opt.desc}</div>
        </div>`;
    }).join('');
  }

  function renderAll() { Object.keys(GROUPS).forEach(renderGroup); }

  function setNote(text) {
    const note = document.getElementById('periNote');
    if (note && text) note.textContent = text;
  }

  // ==================== 当前值读取 ====================
  function applyCurrentToSelection(data) {
    // 当前值命中选项则预选；未命中（如默认值 2 / 100）则不选，应用时跳过该组
    Object.keys(GROUPS).forEach(key => {
      const cur = Number(data?.[key]);
      selected[key] = GROUPS[key].options.some(o => o.value === cur) ? cur : null;
    });
  }

  async function loadCurrent() {
    if (!window.api?.peripheralWindow?.query) return;
    try {
      const resp = await window.api.peripheralWindow.query();
      if (resp && resp.success) {
        applyCurrentToSelection(resp.data);
        renderAll();
        const d = resp.data || {};
        setNote(`当前注册表值：Win32PrioritySeparation = ${d.win32 ?? '未知'} · KeyboardDataQueueSize = ${d.keyboard ?? '未知'} · MouseDataQueueSize = ${d.mouse ?? '未知'}。键盘 / 鼠标队列大小修改后需重启电脑生效。`);
      }
    } catch (e) { /* 读取失败保持未选状态 */ }
  }

  // ==================== 交互 ====================
  function bindEvents() {
    // 卡片单选（事件委托）
    document.querySelector('.peri-body').addEventListener('click', (e) => {
      const card = e.target.closest('.peri-card');
      if (!card) return;
      const key = card.dataset.group;
      const value = Number(card.dataset.value);
      if (!GROUPS[key]) return;
      selected[key] = value;
      renderGroup(key);
    });

    document.getElementById('btnPeriBack')?.addEventListener('click', close);
    document.getElementById('btnPeriClose')?.addEventListener('click', close);

    document.getElementById('btnPeriApply')?.addEventListener('click', async () => {
      if (!window.api?.peripheralWindow?.apply) { toast('info', '请在 Trim 应用内使用该功能'); return; }
      const payload = {};
      Object.keys(GROUPS).forEach(key => { payload[key] = selected[key] ?? -1; });
      if (Object.keys(GROUPS).every(key => payload[key] === -1)) {
        toast('info', '请先为至少一组调优选择一个数值');
        return;
      }
      const btn = document.getElementById('btnPeriApply');
      btn.disabled = true;
      try {
        const resp = await window.api.peripheralWindow.apply(payload);
        if (resp && resp.success) {
          toast('success', '已应用到注册表' + (payload.keyboard !== -1 || payload.mouse !== -1 ? '，键鼠队列大小重启电脑后生效' : ''));
          await loadCurrent();
        } else {
          toast('error', resp?.message || '应用失败，可能需要以管理员身份运行 Trim');
        }
      } catch (e) {
        toast('error', '应用失败：' + e.message);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('btnPeriReset')?.addEventListener('click', async () => {
      if (!window.api?.peripheralWindow?.apply) { toast('info', '请在 Trim 应用内使用该功能'); return; }
      const btn = document.getElementById('btnPeriReset');
      btn.disabled = true;
      try {
        const resp = await window.api.peripheralWindow.apply({
          win32: GROUPS.win32.defaultValue,
          keyboard: GROUPS.keyboard.defaultValue,
          mouse: GROUPS.mouse.defaultValue
        });
        if (resp && resp.success) {
          toast('success', '已恢复 Windows 默认值，键鼠队列大小重启电脑后生效');
          await loadCurrent();
        } else {
          toast('error', resp?.message || '恢复失败，可能需要以管理员身份运行 Trim');
        }
      } catch (e) {
        toast('error', '恢复失败：' + e.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function close() {
    if (window.api?.peripheralWindow?.closeWindow) {
      window.api.peripheralWindow.closeWindow();
    } else {
      window.close();
    }
  }

  function init() {
    renderAll();
    bindEvents();
    loadCurrent();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
