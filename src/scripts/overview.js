// overview.js - 系统概览模块
// 实时采集 CPU/内存/磁盘/开机时长，融合硬件信息展示
(function () {
  'use strict';

  const POLL_INTERVAL = 2000; // 实时指标轮询间隔(ms)
  const $ = id => document.getElementById(id);

  const state = {
    running: false,
    timer: null,
    hardwareLoaded: false,
    lastErrAt: 0
  };

  // ===== 格式化工具 =====
  function fmtBytes(bytes) {
    if (!isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i <= 1 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
  }
  function fmtPercent(p) { return (isFinite(p) ? Math.round(p) : 0) + '%'; }
  function escapeHtml(s) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => map[m]);
  }
  // 进度条颜色：按使用率分档
  function barColor(p) {
    if (p >= 90) return 'linear-gradient(90deg, #DC2626, #EF4444)';
    if (p >= 70) return 'linear-gradient(90deg, #D97706, #F59E0B)';
    return '';
  }
  function setBar(id, percent) {
    const bar = $(id);
    if (!bar) return;
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    bar.style.width = p + '%';
    bar.style.background = barColor(p) || '';
  }

  // ===== 实时指标渲染 =====
  function renderMetrics(data) {
    const d = data || {};
    const cpu = Number(d.cpu) || 0;
    const cpuEl = $('ovCpuValue');
    if (cpuEl) cpuEl.textContent = fmtPercent(cpu);
    setBar('ovCpuBar', cpu);

    const mem = d.memory || {};
    const memEl = $('ovMemValue');
    if (memEl) memEl.textContent = fmtPercent(mem.percent) + ' · ' + fmtBytes(mem.used) + ' / ' + fmtBytes(mem.total);
    setBar('ovMemBar', mem.percent);

    const uptimeEl = $('ovUptimeValue');
    if (uptimeEl) uptimeEl.textContent = d.uptime || '--';
    renderDisks(d.disks || []);
  }

  // 概览卡片布局：非最大化 2x2（两列两行），最大化一行展示全部
  function applyMaximizedLayout() {
    const metrics = document.querySelector('.overview-metrics');
    if (!metrics) return;
    metrics.classList.toggle('overview-maximized', state.maximized);
  }
  state.maximized = false;
  if (window.api?.window?.onResized) {
    window.api.window.onResized((bounds) => {
      state.maximized = !!(bounds && bounds.maximized);
      applyMaximizedLayout();
    });
  }

  function renderDisks(disks) {
    const valueEl = $('ovDiskValue');
    if (!valueEl) return;
    const labelEl = $('ovDiskLabel');
    if (!disks || !disks.length) {
      valueEl.textContent = '--';
      setBar('ovDiskBar', 0);
      if (labelEl) labelEl.textContent = '磁盘使用';
      return;
    }
    // 优先系统盘(通常 C:)，否则取第一个磁盘作为主磁盘
    const primary = disks.find(d => /^c:/i.test(String(d.name || ''))) || disks[0];
    const p = Math.max(0, Math.min(100, Number(primary.percent) || 0));
    valueEl.textContent = fmtPercent(p) + ' · ' + fmtBytes(primary.used) + ' / ' + fmtBytes(primary.total);
    if (labelEl) labelEl.textContent = (primary.name || '磁盘') + ' 磁盘使用';
    setBar('ovDiskBar', p);
  }

  // ===== 硬件信息（首次扫描缓存，后期手动刷新才更新） =====
  async function loadHardware(force) {
    if (state.hardwareLoaded && !force) return;
    const el = $('ovHardwareRows');
    if (!el) return;
    if (!state.hardwareLoaded || force) el.innerHTML = '<div class="empty-state"><p>加载中...</p></div>';
    try {
      let data = null;
      let cachedAt = null;
      if (window.api?.overview?.hardware) {
        const resp = await window.api.overview.hardware({ refresh: !!force });
        if (!resp.success) throw new Error(resp.message);
        data = resp.data;
        cachedAt = resp.cachedAt || null;
      } else if (window.api?.device) {
        const resp = await window.api.device.scan();
        if (!resp.success) throw new Error(resp.message);
        data = resp.data;
      }
      const normalized = window.deviceinfo ? window.deviceinfo.normalize(data) : {};
      const rows = [
        ['系统', normalized.system], ['处理器', normalized.processor], ['显卡', normalized.graphics],
        ['主板', normalized.motherboard], ['硬盘', normalized.disks], ['显示器', normalized.monitors], ['内存', normalized.memory]
      ];
      if (cachedAt) {
        const t = new Date(cachedAt);
        rows.push(['信息更新于', t.toLocaleString('zh-CN', { hour12: false }) + '（点击刷新可更新）']);
      }
      el.innerHTML = rows.map(([label, value]) =>
        `<div class="device-info-row"><span class="device-info-label">${label}</span><span class="device-info-value">${escapeHtml(value || '--')}</span></div>`
      ).join('');
      state.hardwareLoaded = true;
    } catch (e) {
      el.innerHTML = `<div class="empty-state"><p>硬件信息加载失败：${escapeHtml(e.message)}</p></div>`;
    }
  }

  // ===== 采集 =====
  async function tick() {
    if (window.api?.overview) {
      try {
        const resp = await window.api.overview.metrics();
        if (!resp || !resp.success) throw new Error(resp?.message || '指标采集失败');
        renderMetrics(resp.data);
        if (!state.hardwareLoaded) loadHardware();
      } catch (e) {
        const now = Date.now();
        // 节流：10 秒内只提示一次，避免刷屏
        if (now - state.lastErrAt > 10000) {
          state.lastErrAt = now;
          window.app?.toast('error', '系统指标采集失败：' + (e?.message || e));
        }
      }
    } else {
      // 浏览器预览模式模拟数据
      renderMetrics({
        cpu: Math.round(20 + Math.random() * 40),
        memory: { total: 16 * 1073741824, free: 6 * 1073741824, used: 10 * 1073741824, percent: 62 },
        disks: [
          { name: 'C:', label: '', total: 476 * 1073741824, free: 210 * 1073741824, used: 266 * 1073741824, percent: 56 },
          { name: 'D:', label: '数据', total: 931 * 1073741824, free: 620 * 1073741824, used: 311 * 1073741824, percent: 33 }
        ],
        uptime: '2 天 5 小时 30 分钟',
        processes: 260,
        system: { caption: 'Microsoft Windows 11 专业工作站版', version: '10.0.28000', build: '2525', computerName: 'DESKTOP-XIAOXU', userName: 'xiaoxu' }
      });
      loadHardware();
    }
  }

  // ===== 控制 =====
  function start() {
    if (state.running) return;
    state.running = true;
    state.hardwareLoaded = false;
    applyMaximizedLayout();
    tick();
    // 硬件信息走主进程缓存（毫秒级），立即渲染，避免等首轮指标采集完成才加载
    loadHardware();
    state.timer = setInterval(tick, POLL_INTERVAL);
    window.app?.log('info', '系统概览实时监控启动');
  }

  function stop() {
    if (!state.running) return;
    state.running = false;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    window.app?.log('info', '系统概览实时监控停止');
  }

  function refresh() {
    loadHardware(true);
    tick();
  }

  function init() {
    $('btnOverviewRefresh')?.addEventListener('click', refresh);
    // 概览卡片整卡跳转：内存卡 → 内存清理，磁盘卡 → 磁盘清理（data-jump 指定目标页）
    document.querySelectorAll('.overview-jump-card').forEach(card => {
      card.addEventListener('click', () => {
        const page = card.dataset.jump;
        if (page) window.app?.switchPage(page);
      });
    });
  }

  window.overview = { init, start, stop, refresh };
})();
