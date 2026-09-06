// cleanup.js - C 盘清理模块
// 实现扫描、勾选、清理、进度显示
(function () {
  'use strict';

  // 分类定义：唯一数据源为 src/data/cleanup-rules.json（P1-9 数据化）。
  // Electron 运行时经 IPC（cleanup.rules）读取该 JSON 构建 CATEGORIES；
  // 下方 FALLBACK 副本仅用于浏览器预览模式与 IPC 不可用时的兜底。
  // Windows 系统采用二级菜单分类（参考截图），其它仍为扁平。
  const CATEGORIES_FALLBACK = {
    windows: {
      title: 'Windows 系统',
      icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 12V6.75l6-1.32v6.48L3 12zm17-9v8.75l-10 .15V5.21L20 3zM3 13l6 .09v6.81l-6-1.15V13zm17 .25V22l-10-1.91V13.1l10 .15z"/></svg>',
      // 二级分类：每个 subGroup 是一个可折叠、可批量勾选的分类
      subGroups: [
        {
          id: 'outdated', name: '过时文件', icon: '⏳',
          items: [
            { id: 'dismPlusOld', name: '以前的Dism++组件', risk: 'low' },
            { id: 'chromeOldBackup', name: 'Chrome浏览器老版本备份', risk: 'low' },
            { id: 'wpsOldBackup', name: 'WPS老版本备份', risk: 'low' }
          ]
        },
        {
          id: 'system', name: '系统相关', icon: '⚙️',
          items: [
            { id: 'windowsReport', name: 'Windows报告', risk: 'low' },
            { id: 'windowsUpdateLog', name: 'Windows更新安装记录', risk: 'low' },
            { id: 'diagnosisData', name: '诊断数据目录', risk: 'low' },
            { id: 'explorerRecentDocs', name: '最近文档注册表记录', risk: 'low' },
            { id: 'explorerRunMRU', name: '运行对话框历史', risk: 'low' },
            { id: 'shellMuiCache', name: '资源管理器名称缓存', risk: 'low' }
          ]
        },
        {
          id: 'cache', name: '缓存文件', icon: '🗂️',
          items: [
            { id: 'windowsDownloadCache', name: 'Windows下载缓存', risk: 'medium' },
            { id: 'deliveryOptimization', name: '传递优化缓存', risk: 'low' },
            { id: 'terminalServerCache', name: 'Terminal Server Client缓存', risk: 'low' },
            { id: 'dotNetCache', name: '.NET程序集缓存', risk: 'low' },
            { id: 'prefetchFiles', name: 'Windows预读取文件', risk: 'low' },
            { id: 'thumbnailCacheFiles', name: '缩略图缓存(需重启explorer)', risk: 'low' },
            { id: 'iconCacheFiles', name: '图标缓存(需重启explorer)', risk: 'low' },
            { id: 'winINetCache', name: 'WinINet网页缓存', risk: 'low' },
            { id: 'winINetCookies', name: 'WinINet Cookies', risk: 'low' },
            { id: 'userCrashDumps', name: '用户崩溃转储', risk: 'low' }
          ]
        },
        {
          id: 'app', name: '应用程序', icon: '📦',
          items: [
            { id: 'packageCache', name: 'Windows Installer 补丁缓存', risk: 'high' },
            { id: 'defenderHistoryRecords', name: 'Windows Defender保护历史记录', risk: 'low' }
          ]
        },
        {
          id: 'temp', name: '临时文件', icon: '📄',
          items: [
            { id: 'winSxsTempFile', name: 'WinSxS临时文件', risk: 'medium' },
            { id: 'winSxsTempFile2', name: 'WinSxS临时文件', risk: 'medium' },
            { id: 'windowsLogs', name: 'Windows日志', risk: 'low' },
            { id: 'tempFiles', name: '临时文件', risk: 'low' },
            { id: 'driverTempExtract', name: '常见的驱动临时解压目录', risk: 'medium' },
            { id: 'qqTemp', name: 'QQ临时数据', risk: 'low' },
            { id: 'baiduNetdiskLog', name: '百度网盘日志', risk: 'low' },
            { id: 'recycleBin', name: '回收站', risk: 'medium' },
            { id: 'memoryDumpFiles', name: '系统以及程序崩溃dmp文件（by YukiSakura）', risk: 'low' },
            { id: 'recentFiles', name: '最近文档快捷方式', risk: 'low' },
            { id: 'dismComponentCleanup', name: 'DISM 组件清理 (WinSxS /ResetBase)', risk: 'medium' },
            { id: 'directXShaderCache', name: 'DirectX 着色器缓存', risk: 'low' }
          ]
        }
      ]
    },
    gpu: {
      title: '显卡缓存',
      icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M2 7v10l3 2v-3h2v3l3 2v-3h2v3l3 2v-3h2v3l3 2V7l-3-2v3h-2V5l-3-2v3h-2V3l-3 2v3H7V5L4 7v3H2z"/></svg>',
      items: [
        { id: 'nvidiaCache', name: 'NVIDIA 显卡缓存 (GLCache/DXCache)', risk: 'low' },
        { id: 'nvidiaNvCache', name: 'NVIDIA 全局缓存 (NV_Cache)', risk: 'low' },
        { id: 'amdCache', name: 'AMD 显卡缓存 (DxCache/Cache)', risk: 'low' },
        { id: 'intelShaderCache', name: 'Intel 着色器缓存', risk: 'low' }
      ]
    },
    browser: {
      title: '浏览器',
      icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
      items: [
        { id: 'chromeCache', name: 'Chrome 浏览器缓存', risk: 'low' },
        { id: 'chromeCodeCache', name: 'Chrome 代码缓存', risk: 'low' },
        { id: 'chromeMediaCache', name: 'Chrome 媒体缓存', risk: 'low' },
        { id: 'edgeMediaCache', name: 'Edge 媒体缓存', risk: 'low' },
        { id: 'edgeCache', name: 'Edge 浏览器缓存', risk: 'low' },
        { id: 'firefoxCache', name: 'Firefox 浏览器缓存', risk: 'low' },
        { id: 'qqBrowserCache', name: 'QQ浏览器缓存', risk: 'low' }
      ]
    },
    apps: {
      title: '应用程序',
      icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z"/></svg>',
      items: [
        { id: 'steamCache', name: 'Steam 下载与缓存', risk: 'low' },
        { id: 'neteaseMusicCache', name: '网易云音乐缓存', risk: 'low' },
        { id: 'wechatCache', name: '微信缓存', risk: 'low' },
        { id: 'qqCache', name: 'QQ缓存', risk: 'low' },
        { id: 'douyinCache', name: '抖音缓存', risk: 'low' },
        { id: 'steamHtmlCache', name: 'Steam 内置浏览器缓存', risk: 'low' },
        { id: 'epicWebCache', name: 'Epic 启动器网页缓存', risk: 'low' },
        { id: 'officeFileCache', name: 'Office 文件缓存', risk: 'medium' },
        { id: 'vscodeCache', name: 'VS Code 缓存', risk: 'low' },
        { id: 'jetbrainsCache', name: 'JetBrains IDE 缓存', risk: 'low' },
        { id: 'npmCache', name: 'npm 包缓存', risk: 'low' },
        { id: 'pipCache', name: 'pip 包缓存', risk: 'low' },
        { id: 'nugetCache', name: 'NuGet 全局包缓存', risk: 'medium' }
      ]
    },
    fileclean: {
      title: '文件清理',
      icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 18c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
      items: [
        { id: 'qqFileClean', name: 'QQ文件清理', risk: 'low', fileCleanType: 'qq' },
        { id: 'wechatFileClean', name: '微信文件清理', risk: 'low', fileCleanType: 'wechat' }
      ]
    }
  };

  // 从 cleanup-rules.json 的分组项提取渲染层所需字段（id/name/risk/fileCleanType）
  function pickRuleItem(it) {
    const o = { id: it.id, name: it.name, risk: it.risk };
    if (it.fileCleanType) o.fileCleanType = it.fileCleanType;
    return o;
  }

  // 将 JSON 的 groups 数组转换为按 key 索引的 CATEGORIES 对象（与 FALLBACK 形状一致）
  function buildCategoriesFromRules(rules) {
    const out = {};
    for (const g of rules.groups) {
      const group = { title: g.title, icon: g.icon };
      if (Array.isArray(g.subGroups)) {
        group.subGroups = g.subGroups.map(sg => ({
          id: sg.id, name: sg.name, icon: sg.icon,
          items: sg.items.map(pickRuleItem)
        }));
      } else if (Array.isArray(g.items)) {
        group.items = g.items.map(pickRuleItem);
      }
      out[g.key] = group;
    }
    return out;
  }

  // 运行时生效的分类定义：默认用 FALLBACK，Electron 下由 init() 经 IPC 从 JSON 覆盖。
  let CATEGORIES = CATEGORIES_FALLBACK;

  // 展平所有分类的 id（用于一键扫描 / 全选）
  function getAllIds() {
    const ids = [];
    for (const group of Object.values(CATEGORIES)) {
      if (group.subGroups) {
        for (const sg of group.subGroups) {
          for (const it of sg.items) ids.push(it.id);
        }
      } else if (group.items) {
        for (const it of group.items) ids.push(it.id);
      }
    }
    return ids;
  }
  let ALL_IDS = getAllIds(); // IPC 覆盖 CATEGORIES 后在 init() 中重算

  // 模拟数据（用于浏览器预览模式）
  const MOCK_SIZES = {
    // Windows 系统二级分类
    dismPlusOld: 89 * 1024 * 1024,
    chromeOldBackup: 128 * 1024 * 1024,
    wpsOldBackup: 234 * 1024 * 1024,
    windowsReport: 67 * 1024 * 1024,
    windowsUpdateLog: 45 * 1024 * 1024,
    diagnosisData: 220 * 1024 * 1024,
    windowsDownloadCache: 1024 * 1024 * 1024,
    deliveryOptimization: 234 * 1024 * 1024,
    terminalServerCache: 18 * 1024 * 1024,
    dotNetCache: 45 * 1024 * 1024,
    prefetchFiles: 89 * 1024 * 1024,
    thumbnailCacheFiles: 234 * 1024 * 1024,
    winINetCache: 156 * 1024 * 1024,
     winINetCookies: 23 * 1024 * 1024,
     userCrashDumps: 76 * 1024 * 1024,
    packageCache: 567 * 1024 * 1024,
    defenderHistoryRecords: 89 * 1024 * 1024,
    winSxsTempFile: 345 * 1024 * 1024,
    winSxsTempFile2: 128 * 1024 * 1024,
    windowsLogs: 89 * 1024 * 1024,
    tempFiles: 567 * 1024 * 1024,
    driverTempExtract: 123 * 1024 * 1024,
    qqTemp: 234 * 1024 * 1024,
    baiduNetdiskLog: 156 * 1024 * 1024,
    recycleBin: 89 * 1024 * 1024,
    memoryDumpFiles: 345 * 1024 * 1024,
     dismComponentCleanup: 0,
     directXShaderCache: 112 * 1024 * 1024,
    // 显卡 / 浏览器 / 应用
    nvidiaCache: 345 * 1024 * 1024,
    nvidiaNvCache: 128 * 1024 * 1024,
    amdCache: 234 * 1024 * 1024,
    intelShaderCache: 67 * 1024 * 1024,
    chromeCache: 567 * 1024 * 1024,
     chromeCodeCache: 234 * 1024 * 1024,
     chromeMediaCache: 96 * 1024 * 1024,
     edgeMediaCache: 84 * 1024 * 1024,
     edgeCache: 345 * 1024 * 1024,
    steamCache: 890 * 1024 * 1024,
    neteaseMusicCache: 386 * 1024 * 1024,
    wechatCache: 742 * 1024 * 1024,
    qqCache: 456 * 1024 * 1024,
    douyinCache: 518 * 1024 * 1024,
    qqFileClean: 890 * 1024 * 1024,
    wechatFileClean: 1234 * 1024 * 1024
  };

  const MOCK_PATHS = {
    neteaseMusicCache: '%LOCALAPPDATA%\\NetEase\\CloudMusic\\Cache',
    wechatCache: '%USERPROFILE%\\Documents\\xwechat_files',
    qqCache: '%APPDATA%\\Tencent\\QQ\\Cache',
    douyinCache: '%LOCALAPPDATA%\\Douyin',
    qqFileClean: '%USERPROFILE%\\Documents\\Tencent Files',
    wechatFileClean: '%USERPROFILE%\\Documents\\xwechat_files'
  };

  // 文件清理项 ID（使用独立扫描/清理逻辑）
  const FILECLEAN_IDS = ['qqFileClean', 'wechatFileClean'];

  // P1 安装检测（detect）未命中的条目：扫描后从列表隐藏（重新扫描/换规则后自动恢复）
  const hiddenIds = new Set();
  function visibleItems(items) { return items.filter(i => !hiddenIds.has(i.id)); }

  // 状态
  let scanResults = new Map();
  let selectedIds = new Set();
  let isScanning = false;
  let isCleaning = false;
  // 文件清理扫描结果：id -> { files: [...], totalSize, scanPath }
  let fileCleanData = new Map();

  // 工具：格式化字节
  function formatSize(bytes) {
    if (bytes === 0 || bytes === null || bytes === undefined) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
    const v = bytes / Math.pow(k, i);
    return v.toFixed(v < 10 && i > 0 ? 2 : v < 100 && i > 0 ? 1 : 0) + ' ' + units[i];
  }

  function getItemById(id) {
    for (const group of Object.values(CATEGORIES)) {
      if (group.subGroups) {
        for (const sg of group.subGroups) {
          const item = sg.items.find(i => i.id === id);
          if (item) return { ...item, group: group.title, subGroup: sg.name };
        }
      } else if (group.items) {
        const item = group.items.find(i => i.id === id);
        if (item) return { ...item, group: group.title };
      }
    }
    return null;
  }

  // 取某个 subGroup 的全部子项 id（已移除项不参与）
  function getSubGroupItemIds(subGroupId) {
    const sg = CATEGORIES.windows.subGroups.find(s => s.id === subGroupId);
    return sg ? sg.items.map(i => i.id) : [];
  }

  // ==================== 详细信息表格（资源管理器风格） ====================
  const RISK_ORDER = { low: 0, medium: 1, high: 2 };
  const RISK_LABELS = { low: '安全', medium: '注意', high: '高风险' };

  // 每个表格独立的排序状态：tableKey -> {key, dir}
  const sortStates = {};
  // 折叠状态持久（重渲染/排序时保留）：'group:windows' / 'sub:outdated'
  const collapsedKeys = new Set();
  let defaultCollapsedInitialized = false;

  const COL_CHECK = { key: 'check', label: '', width: 40, minWidth: 40, sortable: false, resizable: false };
  const COL_NAME = { key: 'name', label: '名称', width: 220, minWidth: 100 };
  const COL_PATH = { key: 'path', label: '路径', minWidth: 140 };
  const COL_RISK = { key: 'risk', label: '风险', width: 84, minWidth: 64, align: 'center' };
  const COL_SIZE = { key: 'size', label: '占用大小', width: 110, minWidth: 84, align: 'end' };
  const COL_ACTIONS = { key: 'actions', label: '操作', width: 112, minWidth: 84, sortable: false, align: 'center' };

  function columnsFor(groupKey) {
    // P3：全部分组都提供「明细」操作列（fileclean 组沿用图片预览按钮）
    const cols = [COL_CHECK, COL_NAME, COL_PATH, COL_RISK, COL_SIZE, COL_ACTIONS];
    return cols;
  }

  // 各列排序取值函数
  const SORT_FNS = {
    name: it => it.name,
    path: it => (scanResults.get(it.id) || {}).path || null,
    risk: it => (RISK_ORDER[it.risk] !== undefined ? RISK_ORDER[it.risk] : 0),
    size: it => {
      const r = scanResults.get(it.id);
      return r && r.size !== null && r.size !== undefined ? r.size : null;
    }
  };

  function getSortState(tableKey) {
    if (!sortStates[tableKey]) sortStates[tableKey] = { key: null, dir: 'asc' };
    return sortStates[tableKey];
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function groupTotalSize(items) {
    return items.reduce((s, i) => s + (scanResults.get(i.id)?.size || 0), 0);
  }

  function toggleCollapsible(group, content, key) {
    if (!group || !content) return;
    const willExpand = group.classList.contains('collapsed');
    if (key) {
      if (willExpand) collapsedKeys.delete(key); else collapsedKeys.add(key);
    }
    if (willExpand) {
      group.classList.remove('collapsed');
      content.style.maxHeight = '0px';
      requestAnimationFrame(() => {
        content.style.maxHeight = `${content.scrollHeight}px`;
        // Electron 强制回流补丁：读取 offsetHeight 触发 Chromium 立即重排，
        // 修复窗口使用 transparent/backgroundMaterial + 滚动容器 + max-height
        // 动画时，DOM 已展开但子项数据行布局未刷新、视觉空白的问题。
        void content.offsetHeight;
        // 虚拟滚动重算：折叠期间容器高度为 0，虚拟列表只渲染了缓冲行，
        // 展开后无滚动事件触发，需主动 render 恢复完整可视行
        virtualLists.forEach(v => { try { v.render(); } catch (e) {} });
      });
      // 动画结束后释放 maxHeight，避免内容被固定高度裁剪（grid 布局未完成时 scrollHeight 偏小）
      setTimeout(() => {
        if (!group.classList.contains('collapsed')) {
          content.style.maxHeight = '';
          void content.offsetHeight;
          virtualLists.forEach(v => { try { v.render(); } catch (e) {} });
        }
      }, 360);
      return;
    }

    content.style.maxHeight = `${content.scrollHeight}px`;
    requestAnimationFrame(() => {
      group.classList.add('collapsed');
      content.style.maxHeight = '0px';
    });
  }

  // 渲染一张表格：表头（排序/列宽）+ 数据行
  // 虚拟滚动（windowing）：body 留空，完整 rows 进入待办队列，由 renderCategoryList
  // 末尾统一挂载 createVirtualList，只渲染视口附近行（取代「分批 + 加载更多」）。
  let pendingBatches = []; // [{ tableKey, groupKey, columns, rows }]
  let virtualLists = [];   // 正在生效的虚拟滚动实例（重渲染前统一销毁，防 resize 监听泄漏）
  let rowDelegationBound = false; // 行点击/预览的容器级委托是否已绑定（一次性）

  function renderTable(groupKey, items, tableKey) {
    const columns = columnsFor(groupKey);
    const state = getSortState(tableKey);
    const sorted = xtable.sortItems(items, state, SORT_FNS);
    const head = xtable.renderHeader(columns, state);
    pendingBatches.push({ tableKey, groupKey, columns, rows: sorted });
    return `<div class="xtable xtable-virtual" data-table="${tableKey}" data-group-key="${groupKey}">${head}<div class="xtable-body"></div></div>`;
  }

  function previewBtnHtml(item, hasImages, imageCount) {
    return `<button class="fileclean-preview-btn" data-preview="${item.id}" ${hasImages ? '' : 'disabled'} title="${hasImages ? `预览 ${imageCount} 张图片` : '无可预览图片'}">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
      预览${hasImages ? ` (${imageCount})` : ''}
    </button>`;
  }

  // 渲染单个数据行（列布局样式与表头共用 buildLayout，保证对齐）
  function renderRow(item, columns, groupKey) {
    const layout = xtable.buildLayout(columns);
    const result = scanResults.get(item.id);
    const size = result ? result.size : null;
    const isSelected = selectedIds.has(item.id);
    const isFileClean = FILECLEAN_IDS.includes(item.id);
    const hasImages = isFileClean && fileCleanData.has(item.id) &&
      fileCleanData.get(item.id).files.some(f => f.category === 'image');
    const imageCount = isFileClean && fileCleanData.has(item.id)
      ? fileCleanData.get(item.id).files.filter(f => f.category === 'image').length
      : 0;

    const cells = layout.map(({ col, style }) => {
      let inner = '';
      switch (col.key) {
        case 'check':
          inner = `<div class="checkbox ${isSelected ? 'checked' : ''}" data-checkbox="${item.id}"></div>`;
          break;
        case 'name':
          // 中缝省略：超长文件名保留首尾（title 仍展示完整原文）
          inner = `<span class="xtable-cell-text" title="${escapeHtml(item.name)}">${escapeHtml(xtable.middleEllipsis(item.name, 40))}</span>`;
          break;
        case 'path':
          if (result && result.path) {
            const autoTag = result.pathSource === 'auto' ? ' <span class="path-auto-tag">自动定位</span>' : '';
            // P1：fileKeys/regKeys 条目的规模标签 + requiredStoppedProcesses 命中提示标签
            const fileTag = result.fileCount > 0 ? ` <span class="path-auto-tag">共 ${result.fileCount} 个文件</span>` : '';
            const regTag = result.regCount > 0 ? ` <span class="path-auto-tag">注册表 ${result.regCount} 项</span>` : '';
            const blockedTag = Array.isArray(result.blockedBy) && result.blockedBy.length
              ? ` <span class="path-blocked-tag" data-tip="执行前会跳过此项目并提示原因">需关闭: ${escapeHtml(result.blockedBy.join(', '))}</span>` : '';
            inner = `<span class="xtable-cell-text xtable-cell-path" title="${escapeHtml(result.path)}">${escapeHtml(xtable.middleEllipsis(result.path, 72))}${autoTag}${fileTag}${regTag}${blockedTag}</span>`;
          } else {
            inner = '<span class="xtable-cell-muted">—</span>';
          }
          break;
        case 'risk':
          inner = `<span class="category-risk ${item.risk}">${RISK_LABELS[item.risk] || item.risk}</span>`;
          break;
        case 'size':
          inner = size !== null && size !== undefined ? formatSize(size) : '<span class="xtable-cell-muted">—</span>';
          break;
        case 'actions':
          if (isFileClean) {
            inner = previewBtnHtml(item, hasImages, imageCount);
          } else {
            // P3：明细按钮——弹窗枚举该条目将删除的具体文件清单（只读）
            inner = `<button class="fileclean-preview-btn" data-detail="${item.id}" data-tip="查看此条目包含的具体文件清单（只读，最多展示 600 条）">明细</button>`;
          }
          break;
      }
      const align = col.align === 'end' ? ' data-align="end"' : (col.align === 'center' ? ' data-align="center"' : '');
      return `<div class="xtable-td" data-cell="${col.key}" style="${style}"${align}>${inner}</div>`;
    }).join('');

    return `<div class="xtable-row" data-id="${item.id}">${cells}</div>`;
  }

  // 渲染分类列表（表格视图，支持二级分类）
  function renderCategoryList() {
    const container = document.getElementById('categoryList');
    if (!container) return;
    // 首次进入磁盘清理保持紧凑折叠态；用户展开后的状态在会话内保留。
    if (!defaultCollapsedInitialized) {
      Object.entries(CATEGORIES).forEach(([groupKey, group]) => {
        collapsedKeys.add('group:' + groupKey);
        if (Array.isArray(group.subGroups)) {
          group.subGroups.forEach(sg => collapsedKeys.add('sub:' + sg.id));
        }
      });
      defaultCollapsedInitialized = true;
    }
    virtualLists.forEach(v => v.destroy());
    virtualLists = [];
    container.innerHTML = '';
    pendingBatches = [];

    // 行点击/预览按钮：容器级事件委托（一次性绑定）。
    // #categoryList 节点跨重渲染持久（仅替换 innerHTML），委托监听器持续有效，
    // 分批追加的新行无需重新绑定事件。
    if (!rowDelegationBound) {
      rowDelegationBound = true;
      container.addEventListener('click', e => {
        const previewBtn = e.target.closest('.fileclean-preview-btn[data-preview]');
        if (previewBtn) {
          e.stopPropagation();
          if (!previewBtn.disabled) openPreview(previewBtn.dataset.preview);
          return;
        }
        const detailBtn = e.target.closest('[data-detail]');
        if (detailBtn) {
          e.stopPropagation();
          openItemDetail(detailBtn.dataset.detail);
          return;
        }
        const row = e.target.closest('.xtable-row');
        if (!row || !container.contains(row)) return;
        if (window.getSelection && window.getSelection().toString()) return;
        toggleSelection(row.dataset.id);
      });
    }

    for (const [groupKey, rawGroup] of Object.entries(CATEGORIES)) {
      // P1：detect 未命中的隐藏条目不渲染（分组计数/大小汇总同步排除）
      const group = rawGroup.subGroups
        ? { ...rawGroup, subGroups: rawGroup.subGroups.map(sg => ({ ...sg, items: visibleItems(sg.items) })).filter(sg => sg.items.length > 0) }
        : { ...rawGroup, items: visibleItems(rawGroup.items || []) };
      const groupEl = document.createElement('div');
      groupEl.className = 'category-group' + (groupKey === 'fileclean' ? ' fileclean-group' : '');

      if (group.subGroups) {
        // 二级分类布局（Windows 系统）
        const subGroups = group.subGroups.filter(sg => sg.items.length > 0);
        const totalItems = subGroups.reduce((s, sg) => s + sg.items.length, 0);
        groupEl.innerHTML = `
          <div class="category-group-header" data-group-toggle="${groupKey}">
            <span class="category-group-icon">${group.icon}</span>
            <span>${group.title}</span>
            <span style="margin-left:auto;font-size:11px;color:var(--fg-tertiary)" data-group-count="${groupKey}">${totalItems} 项 · ${subGroups.length} 分类</span>
          </div>
          <div class="category-group-content" data-group-content="${groupKey}">
            ${subGroups.map(sg => renderSubGroup(sg)).join('')}
          </div>
        `;
      } else {
        // 扁平布局（显卡 / 浏览器 / 应用 / 文件清理）
        const items = group.items;
        if (!items.length) continue;
        groupEl.innerHTML = `
          <div class="category-group-header" data-group-toggle="${groupKey}">
            <span class="category-group-icon">${group.icon}</span>
            <span>${group.title}</span>
            <span style="margin-left:auto;font-size:11px;color:var(--fg-tertiary)" data-group-count="${groupKey}">${items.length} 项</span>
          </div>
          <div class="category-group-content" data-group-content="${groupKey}">
            ${renderTable(groupKey, items, groupKey)}
          </div>
        `;
      }

      container.appendChild(groupEl);
    }

    // 恢复折叠状态 + 设置展开内容高度（展开态不锁死 maxHeight，避免 grid 布局未完成时 scrollHeight 偏小导致内容被裁剪）
    container.querySelectorAll('.category-group').forEach(g => {
      const toggle = g.querySelector(':scope > .category-group-header');
      const content = g.querySelector(':scope > .category-group-content');
      if (!toggle || !content) return;
      const key = 'group:' + toggle.dataset.groupToggle;
      if (collapsedKeys.has(key)) {
        g.classList.add('collapsed');
        content.style.maxHeight = '0px';
      } else {
        content.style.maxHeight = '';
      }
    });
    container.querySelectorAll('.sub-group').forEach(sg => {
      const content = sg.querySelector(':scope > .sub-group-content');
      if (!content) return;
      const key = 'sub:' + sg.dataset.subGroup;
      if (collapsedKeys.has(key)) {
        sg.classList.add('collapsed');
        content.style.maxHeight = '0px';
      } else {
        content.style.maxHeight = '';
      }
    });

    // 表头交互（排序 + 列宽拖拽）
    container.querySelectorAll('.xtable').forEach(tbl => {
      const state = getSortState(tbl.dataset.table);
      xtable.bindHeader(tbl, state, () => renderCategoryList());
    });

    // 绑定折叠：顶层分组
    container.querySelectorAll('[data-group-toggle]').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.checkbox') || e.target.closest('.xtable')) return;
        const group = el.closest('.category-group');
        toggleCollapsible(group, group.querySelector(':scope > .category-group-content'), 'group:' + el.dataset.groupToggle);
      });
    });

    // 绑定二级分类折叠
    container.querySelectorAll('[data-sub-toggle]').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.checkbox') || e.target.closest('.xtable')) return;
        const sg = el.closest('.sub-group');
        toggleCollapsible(sg, sg.querySelector(':scope > .sub-group-content'), 'sub:' + el.dataset.subToggle);
      });
    });

    // 绑定父级复选框（批量勾选/取消所有子项）
    container.querySelectorAll('[data-sub-checkbox]').forEach(cb => {
      cb.addEventListener('click', e => {
        e.stopPropagation();
        const sgId = cb.dataset.subCheckbox;
        const ids = getSubGroupItemIds(sgId);
        // 全部已勾 → 全不勾；任一未勾 → 全勾
        const allSelected = ids.every(id => selectedIds.has(id));
        if (allSelected) {
          ids.forEach(id => selectedIds.delete(id));
        } else {
          ids.forEach(id => selectedIds.add(id));
        }
        updateUI();
      });
    });

    // 虚拟滚动（windowing）：为每张表挂载 createVirtualList，只渲染视口附近行。
    // 行点击/预览已走容器委托，无需逐行重绑事件。
    pendingBatches.forEach(pb => {
      const bodyEl = container.querySelector(`.xtable[data-table="${pb.tableKey}"] .xtable-body`);
      if (!bodyEl) return;
      virtualLists.push(
        xtable.createVirtualList(bodyEl, {
          rows: pb.rows,
          renderRow: item => renderRow(item, pb.columns, pb.groupKey)
        })
      );
    });
    pendingBatches = [];
  }

  // 渲染单个二级分类
  function renderSubGroup(sg) {
    const sizePart = groupTotalSize(sg.items) > 0 ? ` · ${formatSize(groupTotalSize(sg.items))}` : '';
    return `
      <div class="sub-group" data-sub-group="${sg.id}">
        <div class="sub-group-header" data-sub-toggle="${sg.id}">
          <span class="sub-group-chevron">${chevronSvg()}</span>
          <div class="checkbox" data-sub-checkbox="${sg.id}"></div>
          <span class="sub-group-name">${sg.name}</span>
          <span style="margin-left:auto;font-size:11px;color:var(--fg-tertiary)" data-sub-meta="${sg.id}">${sg.items.length} 项${sizePart}</span>
        </div>
        <div class="sub-group-content">
          ${renderTable('windows', sg.items, 'win:' + sg.id)}
        </div>
      </div>
    `;
  }

  function chevronSvg() {
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>';
  }

  function toggleSelection(id) {
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
    } else {
      selectedIds.add(id);
    }
    updateUI();
  }

  function selectAll() {
    for (const id of ALL_IDS) selectedIds.add(id);
    updateUI();
  }

  function deselectAll() {
    selectedIds.clear();
    updateUI();
  }

  // 全选/全不选切换：已全选 → 全不选；否则 → 全选
  function toggleSelectAll() {
    const allSelected = ALL_IDS.length > 0 && ALL_IDS.every(id => selectedIds.has(id));
    if (allSelected) deselectAll();
    else selectAll();
  }

  // 同步全选按钮文字（全选 ⇄ 全不选）
  function updateSelectAllButton() {
    const text = document.getElementById('btnSelectAllText');
    if (!text) return;
    const allSelected = ALL_IDS.length > 0 && ALL_IDS.every(id => selectedIds.has(id));
    text.textContent = allSelected ? '全不选' : '全选';
  }

  // 收集所有分类下的子项（含二级分类；detect 未命中的隐藏项不参与数量/大小汇总）
  function getGroupItems(group) {
    const items = group.subGroups ? group.subGroups.flatMap(sg => sg.items) : (group.items || []);
    return visibleItems(items);
  }

  function updateUI() {
    // 子项复选框
    document.querySelectorAll('[data-checkbox]').forEach(cb => {
      const id = cb.dataset.checkbox;
      cb.classList.toggle('checked', selectedIds.has(id));
    });

    // 父级（二级分类）复选框：none / indeterminate / all
    for (const group of Object.values(CATEGORIES)) {
      if (!group.subGroups) continue;
      for (const sg of group.subGroups) {
        const sgItems = sg.items;
        if (!sgItems.length) continue;
        const cb = document.querySelector(`[data-sub-checkbox="${sg.id}"]`);
        if (!cb) continue;
        cb.classList.remove('checked', 'indeterminate');
        const total = sgItems.length;
        const selected = sgItems.filter(i => selectedIds.has(i.id)).length;
        if (selected === 0) {
          // none
        } else if (selected === total) {
          cb.classList.add('checked');
        } else {
          cb.classList.add('indeterminate');
        }
        // 元信息更新（条目数量 + 总占用大小）
        const metaEl = document.querySelector(`[data-sub-meta="${sg.id}"]`);
        if (metaEl) {
          const sgSize = sgItems.reduce((s, i) => s + (scanResults.get(i.id)?.size || 0), 0);
          const sgSelected = sgItems.filter(i => selectedIds.has(i.id)).length;
          const sizePart = sgSize > 0 ? ` · ${formatSize(sgSize)}` : '';
          metaEl.textContent = sgSelected > 0
            ? `${sgSelected}/${total} 项${sizePart}`
            : `${total} 项${sizePart}`;
        }
      }
    }

    // 总览
    const totalSize = Array.from(selectedIds)
      .map(id => scanResults.get(id)?.size || 0)
      .reduce((a, b) => a + b, 0);
    const totalEl = document.getElementById('totalSize');
    const countEl = document.getElementById('selectedCount');
    if (totalEl) totalEl.textContent = formatSize(totalSize);
    if (countEl) countEl.textContent = selectedIds.size;
    updateSelectAllButton();

    // 清理按钮
    const cleanBtn = document.getElementById('btnClean');
    if (cleanBtn) cleanBtn.disabled = selectedIds.size === 0 || isScanning || isCleaning;

    // 顶层分组汇总（条目数量 + 总占用大小，兼容扁平分组）
    for (const [groupKey, group] of Object.entries(CATEGORIES)) {
      const items = getGroupItems(group);
      const groupSize = groupTotalSize(items);
      const countEl = document.querySelector(`[data-group-count="${groupKey}"]`);
      if (!countEl) continue;
      const totalItems = items.length;
      const selectedCount = items.filter(i => selectedIds.has(i.id)).length;
      const sizePart = groupSize > 0 ? ` · ${formatSize(groupSize)}` : '';
      if (group.subGroups) {
        countEl.textContent = `${totalItems} 项 · ${group.subGroups.length} 分类${selectedCount > 0 ? ` · ${selectedCount}/${totalItems} 已选` : ''}${sizePart}`;
      } else {
        countEl.textContent = `${totalItems} 项${selectedCount > 0 ? ` · ${selectedCount}/${totalItems} 已选` : ''}${sizePart}`;
      }
    }
  }

  // 进度条
  function setProgress(percent, label) {
    const section = document.getElementById('progressSection');
    const fill = document.getElementById('progressFill');
    const valueEl = document.getElementById('progressValue');
    const labelEl = document.getElementById('progressLabel');
    if (section) section.style.display = 'block';
    if (section) section.setAttribute('aria-busy', percent < 100 ? 'true' : 'false');
    if (fill) fill.style.width = percent + '%';
    if (valueEl) valueEl.textContent = Math.round(percent) + '%';
    if (labelEl && label) labelEl.textContent = label;
  }

  function hideProgress() {
    const section = document.getElementById('progressSection');
    if (section) {
      section.style.display = 'none';
      section.setAttribute('aria-busy', 'false');
    }
  }

  // ==================== P1-12：扫描进度流式化 ====================
  // 主进程逐项推送 cleanup:scan-progress；此处真实更新进度条（0-90% 按项数折算）
  // 并就地更新对应行的 大小/路径 单元格，避免整表重渲染。
  let streamThrottleRaf = 0;
  let streamTotals = new Map(); // groupKey -> 已流式回传的 size 合计（供分组汇总）

  // 条目 id -> 顶层分组 key（getItemById 返回的 group 是标题，不能直接用于 data-group-count）
  function groupKeyForItem(id) {
    for (const [gk, group] of Object.entries(CATEGORIES)) {
      if (getGroupItems(group).some(it => it.id === id)) return gk;
    }
    return null;
  }

  function onScanProgress(payload) {
    if (!isScanning || !payload || !payload.item) return;
    const r = payload.item;
    scanResults.set(r.id, r);
    if (r.size > 0) {
      const gk = groupKeyForItem(r.id);
      if (gk) streamTotals.set(gk, (streamTotals.get(gk) || 0) + r.size);
    }
    const pct = payload.total > 0 ? Math.min(90, Math.round((payload.done / payload.total) * 90)) : 0;
    setProgress(pct, `扫描中... ${payload.done}/${payload.total} 项 · ${Math.round(pct)}%`);
    if (!streamThrottleRaf) {
      streamThrottleRaf = requestAnimationFrame(() => {
        streamThrottleRaf = 0;
        patchRow(r);
        updateGroupSummary(r);
      });
    }
  }

  // 就地更新单行的 size / path 单元格（行不存在或已重渲染则跳过，最终统一重渲染兜底）
  function patchRow(r) {
    const row = document.querySelector(`#categoryList .xtable-row[data-id="${CSS.escape(r.id)}"]`);
    if (!row) return;
    const sizeCell = row.querySelector('[data-cell="size"]');
    if (sizeCell) sizeCell.innerHTML = (r.size !== null && r.size !== undefined) ? formatSize(r.size) : '<span class="xtable-cell-muted">—</span>';
    const pathCell = row.querySelector('[data-cell="path"]');
    if (pathCell && r.path) {
      const autoTag = r.pathSource === 'auto' ? ' <span class="path-auto-tag">自动定位</span>' : '';
      const fileTag = r.fileCount > 0 ? ` <span class="path-auto-tag">共 ${r.fileCount} 个文件</span>` : '';
      const regTag = r.regCount > 0 ? ` <span class="path-auto-tag">注册表 ${r.regCount} 项</span>` : '';
      const blockedTag = Array.isArray(r.blockedBy) && r.blockedBy.length
        ? ` <span class="path-blocked-tag" data-tip="执行前会跳过此项目并提示原因">需关闭: ${escapeHtml(r.blockedBy.join(', '))}</span>` : '';
      pathCell.innerHTML = `<span class="xtable-cell-text xtable-cell-path" title="${escapeHtml(r.path)}">${escapeHtml(xtable.middleEllipsis(r.path, 72))}${autoTag}${fileTag}${regTag}${blockedTag}</span>`;
    }
  }

  // 流式阶段仅更新分组计数条中的大小部分，避免整表重渲染
  function updateGroupSummary(r) {
    const gk = groupKeyForItem(r.id);
    if (!gk) return;
    const countEl = document.querySelector(`[data-group-count="${gk}"]`);
    if (!countEl) return;
    const group = CATEGORIES[gk];
    if (!group) return;
    const items = getGroupItems(group);
    const totalItems = items.length;
    const selectedCount = items.filter(i => selectedIds.has(i.id)).length;
    const size = streamTotals.get(gk) || 0;
    const sizePart = size > 0 ? ` · ${formatSize(size)}` : '';
    if (group.subGroups) {
      countEl.textContent = `${totalItems} 项 · ${group.subGroups.length} 分类${selectedCount > 0 ? ` · ${selectedCount}/${totalItems} 已选` : ''}${sizePart}`;
    } else {
      countEl.textContent = `${totalItems} 项${selectedCount > 0 ? ` · ${selectedCount}/${totalItems} 已选` : ''}${sizePart}`;
    }
  }

  // 扫描
  async function scan() {
    if (isScanning) return;
    isScanning = true;
    selectedIds.clear();
    scanResults.clear();
    fileCleanData.clear();
    updateUI();

    setProgress(0, '正在准备扫描...');
    const btnScan = document.getElementById('btnScan');
    if (btnScan) btnScan.disabled = true;

    streamTotals.clear();
    // Electron 模式：进度由 cleanup:scan-progress 逐项真实推送（P1-12）。
    // 预览/旧 preload 无该事件时，退回模拟进度。
    const streaming = !!(window.api?.cleanup?.onScanProgress);
    let progress = 0;
    let progressTimer = null;
    if (!streaming) {
      progressTimer = setInterval(() => {
        if (isScanning && progress < 90) {
          progress += 5;
          setProgress(progress, `扫描中... ${Math.round(progress)}%`);
        }
      }, 200);
    }

    try {
      let results = [];
      if (window.api?.cleanup) {
        // Electron 模式：调用 PowerShell（排除文件清理项）
        const regularIds = ALL_IDS.filter(id => !FILECLEAN_IDS.includes(id));
        const resp = await window.api.cleanup.scan(regularIds);
        if (!resp.success) {
          throw new Error(resp.message || '扫描失败');
        }
        results = resp.data;

        // 文件清理项独立扫描
        const pathConfig = window.pathbinding?.getConfig?.() || {};
        for (const id of FILECLEAN_IDS) {
          const item = getItemById(id);
          if (!item || !item.fileCleanType) continue;
          const customPath = item.fileCleanType === 'qq' ? pathConfig.qqFileDir : pathConfig.wechatFileDir;
          try {
            const fcResp = await window.api.fileclean.scan(item.fileCleanType, customPath);
            if (fcResp.success && fcResp.data) {
              fileCleanData.set(id, fcResp.data);
              results.push({
                id,
                name: item.name,
                path: fcResp.data.scanPath,
                pathSource: 'configured',
                size: fcResp.data.totalSize,
                risk: 'low',
                exists: true
              });
            } else {
              results.push({
                id,
                name: item.name,
                path: customPath || '未配置',
                pathSource: 'configured',
                size: 0,
                risk: 'low',
                exists: false
              });
            }
          } catch (e) {
            results.push({
              id,
              name: item.name,
              path: customPath || '未配置',
              pathSource: 'configured',
              size: 0,
              risk: 'low',
              exists: false
            });
          }
        }
      } else {
        // 浏览器预览模式：使用模拟数据
        await new Promise(r => setTimeout(r, 1500));
        results = ALL_IDS.map(id => ({
          id,
          name: getItemById(id)?.name || id,
          path: MOCK_PATHS[id] || `C:\\Windows\\...\\${id}`,
          pathSource: MOCK_PATHS[id] ? 'configured' : 'configured',
          size: MOCK_SIZES[id] || Math.floor(Math.random() * 500) * 1024 * 1024,
          risk: getItemById(id)?.risk || 'low',
          exists: true
        }));
        // 模拟文件清理数据
        for (const id of FILECLEAN_IDS) {
          const mockFiles = [];
          for (let i = 0; i < 15; i++) {
            mockFiles.push({
              path: `C:\\mock\\${id}\\image_${i}.jpg`,
              name: `image_${i}.jpg`,
              size: Math.floor(Math.random() * 5000000),
              category: 'image',
              ext: '.jpg',
              mtime: new Date().toISOString()
            });
          }
          fileCleanData.set(id, {
            files: mockFiles,
            totalSize: MOCK_SIZES[id] || 0,
            scanPath: MOCK_PATHS[id] || 'C:\\mock'
          });
        }
      }

      // P1：detect 未命中的条目不会出现在扫描结果中——标记为隐藏（重新扫描/换规则后恢复）
      hiddenIds.clear();
      const gotIds = new Set(results.map(r => r.id));
      for (const id of ALL_IDS) {
        if (!FILECLEAN_IDS.includes(id) && !gotIds.has(id)) hiddenIds.add(id);
      }
      for (const r of results) {
        scanResults.set(r.id, r);
      }
      // 应用缓存可能被安装到其他位置。自动发现只作为候选，必须由用户确认后才采用。
      const relocations = results.filter(r => r.pathSource === 'auto' && r.autoPath && r.autoPath !== r.configuredPath);
      for (const result of relocations) {
        const useAutoPath = await window.app?.confirm(
          `${result.name}发现其他目录`,
          `检测到可用缓存目录：\n${result.autoPath}\n\n原配置路径：\n${result.configuredPath || result.path}\n\n是否使用自动发现的目录进行本次扫描和清理？`,
          '使用此目录'
        );
        if (!useAutoPath) {
          result.path = result.configuredPath || result.path;
          result.pathSource = 'configured';
          result.exists = false;
          result.size = 0;
        }
        scanResults.set(result.id, result);
      }
      setProgress(100, '扫描完成');
      // 默认勾选所有安全项
      for (const r of results) {
        if (r.risk === 'low' && r.size > 0) selectedIds.add(r.id);
      }
      await new Promise(r => setTimeout(r, 400));
      hideProgress();
      // 重新渲染带 size
      renderCategoryList();
      updateUI();
      const total = Array.from(scanResults.values()).reduce((s, r) => s + r.size, 0);
      window.app?.toast('success', `扫描完成，共发现 ${formatSize(total)} 可清理空间`);
    } catch (e) {
      hideProgress();
      window.app?.toast('error', '扫描失败: ' + e.message);
      maybeOfferElevation('扫描失败，可能需要管理员权限才能访问部分系统目录。');
    } finally {
      isScanning = false;
      if (btnScan) btnScan.disabled = false;
    }
  }

  function setCleaningBtn(cleaning) {
    const btn = document.getElementById('btnClean');
    if (!btn) return;
    btn.classList.toggle('busy', cleaning);
    const label = btn.querySelector('span');
    if (label) label.textContent = cleaning ? '清理中...' : '开始清理';
  }

  // 清理
  async function clean() {
    if (isCleaning || selectedIds.size === 0) return;
    isCleaning = true;
    setCleaningBtn(true);
    updateUI();

    const highRisk = Array.from(selectedIds)
      .map(id => scanResults.get(id))
      .filter(r => r && r.risk === 'high');

    // 高风险二次确认（红色，删除类操作规范要求）
    if (highRisk.length > 0) {
      const ok = await window.app?.confirmDanger(
        '高风险操作确认',
        `您选择了 ${highRisk.length} 个高风险项（如 Windows.old、WinSxS）：\n${highRisk.map(r => '• ' + r.name).join('\n')}`,
        '确认清理',
        '取消',
        '删除后可能无法恢复，请确认已了解风险。'
      );
      if (!ok) {
        isCleaning = false;
        updateUI();
        return;
      }
    }

    const allItems = Array.from(selectedIds).map(id => scanResults.get(id)).filter(Boolean);
    // 分离常规清理项和文件清理项
    const regularItems = allItems.filter(i => !FILECLEAN_IDS.includes(i.id));
    const fileCleanItems = allItems.filter(i => FILECLEAN_IDS.includes(i.id));
    // P3：三个执行选项真正接线（此前 force 恒为 true，强制删除/自动重建勾选框形同虚设）
    const force = !!document.getElementById('optForceDelete')?.checked;
    const toRecycle = !!document.getElementById('optRecycleBin')?.checked;
    const autoRebuild = !!document.getElementById('optAutoRebuild')?.checked;
    setProgress(0, '开始清理...');

    let progress = 0;
    const progressTimer = setInterval(() => {
      if (isCleaning && progress < 90) {
        progress += 3;
        setProgress(progress, `清理中... ${progress}%`);
      }
    }, 200);

    try {
      let result;

      if (window.api?.cleanup) {
        // 常规清理
        let regularResult = { totalFreed: 0, success: 0, failed: 0, skipped: 0, details: [] };
        if (regularItems.length > 0) {
          const resp = await window.api.cleanup.execute(regularItems, force, toRecycle, autoRebuild);
          if (!resp.success) throw new Error(resp.message);
          regularResult = resp.data;
        }

        // 文件清理
        let fcFreed = 0, fcSuccess = 0, fcFailed = 0;
        const fcDetails = [];
        for (const item of fileCleanItems) {
          const data = fileCleanData.get(item.id);
          if (data && data.files && data.files.length > 0) {
            const fcResp = await window.api.fileclean.execute(data.files);
            if (fcResp.success) {
              fcFreed += fcResp.data.totalFreed;
              fcSuccess += fcResp.data.success;
              fcFailed += fcResp.data.failed;
              fcDetails.push(...(fcResp.data.details || []).map(d => ({
                id: item.id,
                name: item.name,
                status: d.status,
                freed: d.freed,
                message: d.message || ''
              })));
            }
          }
        }

        result = {
          totalFreed: (regularResult.totalFreed || 0) + fcFreed,
          success: (regularResult.success || 0) + fcSuccess,
          failed: (regularResult.failed || 0) + fcFailed,
          skipped: regularResult.skipped || 0,
          details: [...(regularResult.details || []), ...fcDetails]
        };
      } else {
        // 预览模式：模拟清理
        await new Promise(r => setTimeout(r, 2000));
        result = {
          totalFreed: allItems.reduce((s, i) => s + (i.size || 0), 0),
          success: allItems.length,
          failed: 0,
          skipped: 0,
          details: allItems.map(i => ({
            id: i.id,
            name: i.name,
            status: 'ok',
            freed: i.size || 0,
            message: '已清理'
          }))
        };
      }

      setProgress(100, '清理完成');
      clearInterval(progressTimer);

      // 从结果中移除已清理的
      for (const d of result.details || []) {
        if (d.status === 'ok') {
          scanResults.delete(d.id);
          selectedIds.delete(d.id);
        }
      }

      // 上述命令并未真正执行；按审查结论 B6 删除该假日志，日志库只记录真实发生的操作。

      setTimeout(() => {
        hideProgress();
        renderCategoryList();
        updateUI();
        const freed = result.totalFreed || 0;
        window.app?.toast('success', `清理完成！释放 ${formatSize(freed)} 空间`);
        // P3 残留复查提示：清理后仍有文件/注册表残留的项
        const residualItems = (result.details || []).filter(d => (Number(d.residual) || 0) > 0);
        if (residualItems.length > 0) {
          window.app?.toast('warning', `${residualItems.length} 项仍有残留（文件可能被占用，可关闭相关程序或重启后再试）`);
        }
        if (result.failed > 0) {
          window.app?.toast('warning', `${result.failed} 项清理失败（可能文件被占用）`);
          maybeOfferElevation(`${result.failed} 项清理失败，可能需要管理员权限才能删除这些文件。`);
        }
      }, 600);
    } catch (e) {
      clearInterval(progressTimer);
      hideProgress();
      window.app?.toast('error', '清理失败: ' + e.message);
      maybeOfferElevation('清理操作失败，可能需要管理员权限。');
    } finally {
      isCleaning = false;
      setCleaningBtn(false);
      updateUI();
    }
  }

  // 无管理员权限时提供 UAC 提权入口（应用以 asInvoker 启动，按需提权）
  function maybeOfferElevation(reason) {
    try {
      const state = window.app?.getState?.();
      // isAdmin === false 表示已检测且非管理员；null 表示未检测完成
      if (state && state.isAdmin === false) {
        window.app?.requestElevation?.(reason);
      }
    } catch (_) { /* 提权提示失败不影响主流程 */ }
  }

  // ==================== 图片预览（独立窗口） ====================
  // 打开独立「图片预览」窗口显示某个一级分类/子分组下的全部图片；
  // 删除图片后由主进程 preview:image-deleted 通知本页刷新列表。
  function openPreview(id) {
    const data = fileCleanData.get(id);
    if (!data || !data.files) return;
    const images = data.files.filter(f => f.category === 'image');
    if (images.length === 0) {
      window.app?.toast('info', '没有可预览的图片文件');
      return;
    }
    const item = getItemById(id);
    const payload = {
      images: images.map(f => ({ path: f.path, name: f.name, size: f.size, category: f.category })),
      index: 0,
      itemName: item ? item.name : id
    };
    if (window.api?.previewWindow?.open) {
      window.api.previewWindow.open(payload);
    } else {
      window.app?.toast('warning', '当前环境不支持打开图片预览窗口');
    }
  }

  // 图片预览窗口删除图片后，同步清理本页数据与扫描结果并刷新
  function initPreviewSync() {
    window.api?.previewWindow?.onImageDeleted?.((filePath) => {
      if (!filePath) return;
      for (const [id, data] of fileCleanData.entries()) {
        if (!data || !Array.isArray(data.files)) continue;
        const idx = data.files.findIndex(f => f.path === filePath);
        if (idx !== -1) {
          const removed = data.files[idx];
          data.files.splice(idx, 1);
          data.totalSize = Math.max(0, (data.totalSize || 0) - (removed.size || 0));
          const sr = scanResults.get(id);
          if (sr) sr.size = Math.max(0, (sr.size || 0) - (removed.size || 0));
          break;
        }
      }
      renderCategoryList();
      updateUI();
    });
  }

  // P2：规则库在线更新（数据目录规则优先于内置规则），成功后重载规则并重渲染
  async function updateRules() {
    const btn = document.getElementById('btnUpdateRules');
    if (!window.api?.cleanup?.updateRules) {
      window.app?.toast('warning', '当前环境不支持在线更新规则库');
      return;
    }
    if (btn) btn.disabled = true;
    try {
      const resp = await window.api.cleanup.updateRules();
      if (resp && resp.success) {
        window.app?.toast('success', `规则库已更新到版本 ${resp.rulesVersion}`);
        hiddenIds.clear();
        await loadRulesFromMain();
      } else {
        window.app?.toast('error', (resp && resp.message) || '规则库更新失败');
      }
    } catch (e) {
      window.app?.toast('error', '规则库更新失败: ' + e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ==================== P3 条目明细弹窗 ====================
  // 枚举单个条目将删除的具体文件清单（只读，最多展示 600 条），支持复制完整清单。
  let detailEscHandler = null;
  function closeItemDetail() {
    if (detailEscHandler) { document.removeEventListener('keydown', detailEscHandler); detailEscHandler = null; }
    document.getElementById('itemDetailBackdrop')?.remove();
  }

  function openItemDetail(id) {
    const result = scanResults.get(id);
    const item = getItemById(id);
    closeItemDetail();
    const backdrop = document.createElement('div');
    backdrop.className = 'usage-backdrop';
    backdrop.id = 'itemDetailBackdrop';
    backdrop.innerHTML = `
      <div class="usage-modal" role="dialog" aria-modal="true" aria-labelledby="itemDetailTitle">
        <div class="usage-header">
          <h2 id="itemDetailTitle">${escapeHtml((item && item.name) || id)} · 文件明细</h2>
          <button class="usage-close" id="itemDetailClose" type="button" title="关闭" aria-label="关闭">&times;</button>
        </div>
        <div class="usage-body" id="itemDetailBody">
          <div class="empty-state"><p>正在枚举文件清单…</p></div>
        </div>
        <div class="usage-footer pw-footer">
          <span class="pw-last-scan" id="itemDetailMeta"></span>
          <span class="model-picker-spacer"></span>
          <button class="btn btn-secondary" id="itemDetailCopy" type="button">复制完整清单</button>
          <button class="btn btn-primary" id="itemDetailDone" type="button">关闭</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.querySelector('#itemDetailClose').addEventListener('click', closeItemDetail);
    backdrop.querySelector('#itemDetailDone').addEventListener('click', closeItemDetail);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) closeItemDetail(); });
    detailEscHandler = (e) => { if (e.key === 'Escape') closeItemDetail(); };
    document.addEventListener('keydown', detailEscHandler);

    (async () => {
      try {
        const resp = await window.api.cleanup.itemDetail(id, (result && result.path) || '');
        const body = backdrop.querySelector('#itemDetailBody');
        if (!body) return;
        if (!resp || !resp.success) {
          body.innerHTML = `<div class="empty-state"><p>${escapeHtml((resp && resp.message) || '明细枚举失败')}</p></div>`;
          return;
        }
        const { kind, total, truncated, files } = resp.data;
        const meta = backdrop.querySelector('#itemDetailMeta');
        if (kind === 'reg') {
          body.innerHTML = `<div class="empty-state"><p>注册表条目（共 ${total} 项键/值），不产生文件清单。</p></div>`;
        } else if (kind === 'dism') {
          body.innerHTML = `<div class="empty-state"><p>DISM 组件清理为系统级操作，不产生文件清单。</p></div>`;
        } else if (!files.length) {
          body.innerHTML = `<div class="empty-state"><p>未枚举到文件（目录为空或已被清理）。</p></div>`;
        } else {
          body.innerHTML = `<div class="detail-file-list">${files.map(f =>
            `<div class="detail-file-row"><span class="detail-file-path" title="${escapeHtml(f.path)}">${escapeHtml(xtable.middleEllipsis(f.path, 96))}</span><span class="detail-file-size">${formatSize(f.size)}</span></div>`
          ).join('')}</div>`;
        }
        if (meta) meta.textContent = `共 ${total} 个文件${truncated ? '（仅展示前 600 条）' : ''}`;
        backdrop.querySelector('#itemDetailCopy').addEventListener('click', async () => {
          if (!files.length) return;
          try {
            await navigator.clipboard.writeText(files.map(f => f.path).join('\r\n'));
            window.app?.toast('success', `已复制 ${files.length} 条文件路径`);
          } catch (e) {
            window.app?.toast('error', '复制失败: ' + e.message);
          }
        });
      } catch (e) {
        const body = backdrop.querySelector('#itemDetailBody');
        if (body) body.innerHTML = `<div class="empty-state"><p>明细枚举失败: ${escapeHtml(e.message)}</p></div>`;
      }
    })();
  }

  function init() {
    renderCategoryList();
    updateUI();
    initPreviewSync();

    document.getElementById('btnScan')?.addEventListener('click', scan);
    document.getElementById('btnClean')?.addEventListener('click', clean);
    document.getElementById('btnSelectAll')?.addEventListener('click', toggleSelectAll);
    document.getElementById('btnUpdateRules')?.addEventListener('click', updateRules);

    // P1-12：订阅扫描逐项进度（一次性；ipcRenderer.on 会累积，不能放进 scan）
    if (window.api?.cleanup?.onScanProgress) {
      window.api.cleanup.onScanProgress(onScanProgress);
    }

    // P1-9：Electron 运行时从 cleanup-rules.json（唯一数据源）加载分类，
    // 成功后覆盖 FALLBACK 并重算 ALL_IDS、重渲染。浏览器预览模式跳过。
    loadRulesFromMain();
  }

  async function loadRulesFromMain() {
    if (!window.api?.cleanup?.rules) return; // 预览模式或旧 preload：沿用 FALLBACK
    try {
      const resp = await window.api.cleanup.rules();
      if (resp && resp.success && resp.data && Array.isArray(resp.data.groups)) {
        CATEGORIES = buildCategoriesFromRules(resp.data);
        ALL_IDS = getAllIds();
        renderCategoryList();
        updateUI();
      }
    } catch (e) {
      // 加载失败静默回退到 FALLBACK，不影响功能
    }
  }

  window.cleanup = {
    init,
    scan,
    clean,
    formatSize,
    MOCK_SIZES
  };
})();
