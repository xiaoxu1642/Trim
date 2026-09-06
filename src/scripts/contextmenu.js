// contextmenu.js - 右键菜单管理模块（列表条目 + 详情弹窗 + AI 简介）
// 交互模式：勾选=启用，取消=禁用（可逆，直接写注册表/文件属性）；
// 删除为行内「备份并删除」按钮，操作不可逆。
(function () {
  'use strict';

  let items = [];
  let currentFilter = 'all';
  let isScanning = false;
  let hasScanned = false;
  let iconMap = {};        // clsid -> dataUrl
  let detailItem = null;   // 当前详情弹窗展示的条目
  let detailTrap = null;   // 详情弹窗焦点陷阱（ds.focusTrap）
  let kanbanMasonry = null; // 瀑布流布局引擎（resize 防抖 + FLIP）

  // 11 个分类定义（顺序固定）
  const CATEGORY_ORDER = [
    '文件', 'EXE文件', 'LNK文件', '目录', '文件夹',
    '驱动器', '回收站', '目录背景', '桌面背景',
    '此电脑', '库', '发送到', 'UWP应用'
  ];

  const CATEGORY_ICONS = {
    '文件': '\u{1F4C4}',
    'EXE文件': '\u2699\uFE0F',
    'LNK文件': '\u{1F517}',
    '目录': '\u{1F4C1}',
    '文件夹': '\u{1F4C2}',
    '驱动器': '\u{1F4BF}',
    '回收站': '\u{1F6AE}',
    '目录背景': '\u{1F4CD}',
    '桌面背景': '\u{1F5A5}\uFE0F',
    '此电脑': '\u{1F5A5}\uFE0F',
    '库': '\u{1F4D6}',
    '发送到': '\u{1F4E8}',
    'UWP应用': '\u{1F4F1}'
  };

  // ==================== 侧边栏分类筛选（叠加生效，切换时保留勾选） ====================
  // 侧边栏分组选项 -> 条目匹配函数（「全部」为扁平汇总视图；
  // 标准分类直接匹配，特殊分类按注册表路径正则匹配）
  const SIDEBAR_CATEGORY_MATCH = {
    '全部': () => true,
    '文件': it => ['文件', 'EXE文件', 'LNK文件'].includes(it.category),
    '文件夹': it => it.category === '文件夹',
    '目录': it => it.category === '目录',
    '目录背景': it => it.category === '目录背景',
    '桌面背景': it => it.category === '桌面背景',
    '磁盘分区': it => it.category === '驱动器',
    '所有对象': it => /AllFilesystemObjects/i.test(it.regPath || it.location || ''),
    '此电脑': it => /\{20D04FE0-/i.test(it.regPath || it.location || ''),
    '回收站': it => it.category === '回收站' || /Recycle\.Bin/i.test(it.regPath || it.location || ''),
    '库': it => /Library/i.test(it.regPath || it.location || ''),
    '新建菜单': it => /\\New($|\\)/i.test(it.regPath || it.location || ''),
    '发送到': it => it.category === '发送到' || /SendTo/i.test(it.regPath || it.location || ''),
    '打开方式': it => /OpenWith/i.test(it.regPath || it.location || ''),
    'Win+X': it => /WinX/i.test(it.regPath || it.location || '')
  };
  let currentCategory = '文件';

  // ==================== 看板式多列布局 ====================
  // 每个分类一列（白色圆角卡片），条目竖排：复选框(启用/禁用) + 序号 + 名称(可换行不截断) + 类型/状态标签；
  // 列头 = 分类名 + 项数徽章；列底 = 「全选本类」；窗口不够宽时容器横向滚动。

  // 阶段三：类型/状态徽章统一 design-system（ds-badge sm 紧凑变体）
  function typeBadgeHtml(item) {
    const disabled = item.enabled === false
      ? ' ' + (window.ds
        ? window.ds.badgeHtml('neutral', '已禁用', { small: true, title: '已禁用（取消勾选即可重新启用）' })
        : '<span class="badge off" title="已禁用（取消勾选即可重新启用）">已禁用</span>')
      : '';
    const risk = item.risk === 'protected'
      ? (window.ds ? window.ds.badgeHtml('bad', '系统保护', { small: true }) : '<span class="badge protected">系统保护</span>')
      : (item.isThirdParty
        ? (window.ds ? window.ds.badgeHtml('warn', '第三方', { small: true }) : '<span class="badge third-party">第三方</span>')
        : (window.ds ? window.ds.badgeHtml('ok', '系统原生', { small: true }) : '<span class="badge system">系统原生</span>'));
    return risk + disabled;
  }

  // 是否支持启停切换（UWP 无公开可逆禁用机制）
  function isToggleable(item) {
    if (item.risk === 'protected') return false;
    return !['packagedcom', 'uwp-contract'].includes(item.source);
  }

  // 模拟数据（用于浏览器预览模式；enabled 模拟启停状态）
  const MOCK_ITEMS = [
    { name: 'WinRAR', clsid: '{B41DB860-8EE4-11D2-9906-E49FADC173CA}', company: 'win.rar GmbH', location: 'HKCR\\*\\shellex\\ContextMenuHandlers', isThirdParty: true, isProtected: false, risk: 'high', category: '文件', source: 'shellex', enabled: true },
    { name: 'Notepad++', clsid: '{00F29236-0000-0000-0000-000000000000}', company: 'Don Ho', location: 'HKCR\\*\\shellex\\ContextMenuHandlers', isThirdParty: true, isProtected: false, risk: 'high', category: '文件', source: 'shellex', enabled: true },
    { name: '7-Zip', clsid: '{23170F69-40C1-278A-1000-000100020000}', company: 'Igor Pavlov', location: 'HKCR\\*\\shellex\\ContextMenuHandlers', isThirdParty: true, isProtected: false, risk: 'high', category: '文件', source: 'shellex', enabled: true },
    { name: 'CopyAsPathMenu', clsid: '{DABB4F40-9D11-11D1-AB0A-00C04FC2DC31}', company: 'Microsoft Corporation', location: 'HKCR\\*\\shellex\\ContextMenuHandlers', isThirdParty: false, isProtected: false, risk: 'low', category: '文件', source: 'shellex', enabled: true },
    { name: 'ModernSharing', clsid: '{E2BF9D40-9D11-11D1-AB0A-00C04FC2DC31}', company: 'Microsoft Corporation', location: 'HKCR\\*\\shellex\\ContextMenuHandlers', isThirdParty: false, isProtected: false, risk: 'low', category: '文件', source: 'shellex', enabled: true },
    { name: 'AVG Shell Extension', clsid: '{9F7D8B6E-2A4F-4B9E-A1C8-3D5E7F9B2A1C}', company: 'AVG Technologies', location: 'HKCR\\*\\shellex\\ContextMenuHandlers', isThirdParty: true, isProtected: false, risk: 'high', category: '文件', source: 'shellex', enabled: false },
    { name: 'McAfee File Encryption', clsid: '{A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D}', company: 'McAfee, Inc.', location: 'HKCR\\*\\shellex\\ContextMenuHandlers', isThirdParty: true, isProtected: false, risk: 'high', category: '文件', source: 'shellex', enabled: true },
    { name: '金山文档右键', clsid: '{K7F8A9B0-1C2D-3E4F-5A6B-7C8D9E0F1A2B}', company: 'Kingsoft Office', location: 'HKCR\\*\\shellex\\ContextMenuHandlers', isThirdParty: true, isProtected: false, risk: 'high', category: '文件', source: 'shellex', enabled: true },
    { name: '百度网盘上传', clsid: '{B8A9F0C1-2D3E-4F5A-6B7C-8D9E0F1A2B3C}', company: '百度在线网络技术（北京）有限公司', location: 'HKCR\\*\\shellex\\ContextMenuHandlers', isThirdParty: true, isProtected: false, risk: 'high', category: '文件', source: 'shellex', enabled: true },
    { name: '以管理员身份运行', clsid: '', company: 'Microsoft Corporation', location: 'HKCR\\exefile\\shell', isThirdParty: false, isProtected: false, risk: 'low', category: 'EXE文件', source: 'shell', enabled: true },
    { name: '兼容性疑难解答', clsid: '', company: 'Microsoft Corporation', location: 'HKCR\\exefile\\shell', isThirdParty: false, isProtected: false, risk: 'low', category: 'EXE文件', source: 'shell', enabled: true },
    { name: '打开文件所在位置', clsid: '', company: 'Microsoft Corporation', location: 'HKCR\\lnkfile\\shell', isThirdParty: false, isProtected: false, risk: 'low', category: 'LNK文件', source: 'shell', enabled: true },
    { name: 'FileExplorerClassic', clsid: '{B41DB860-8EE4-11D2-9906-E49FADC173CB}', company: 'Microsoft Corporation', location: 'HKCR\\Directory\\shellex\\ContextMenuHandlers', isThirdParty: false, isProtected: false, risk: 'low', category: '目录', source: 'shellex', enabled: true },
    { name: '在终端中打开', clsid: '{E8F4C2A3-7C9F-4D9B-9F2C-7B2E1A4F8E6D}', company: 'Microsoft Corporation', location: 'HKCR\\Directory\\shell', isThirdParty: false, isProtected: false, risk: 'low', category: '目录', source: 'shell', enabled: true },
    { name: '通过Git提交', clsid: '{A3B2C1D4-E5F6-7890-ABCD-EF0123456789}', company: 'Git SCM', location: 'HKCR\\Directory\\shellex\\ContextMenuHandlers', isThirdParty: true, isProtected: false, risk: 'high', category: '目录', source: 'shellex', enabled: true },
    { name: 'WorkFolders', clsid: '{E8F4C2A3-7C9F-4D9B-9F2C-7B2E1A4F8E6D}', company: 'Microsoft Corporation', location: 'HKCR\\Folder\\shellex\\ContextMenuHandlers', isThirdParty: false, isProtected: false, risk: 'low', category: '文件夹', source: 'shellex', enabled: true },
    { name: '格式化', clsid: '', company: 'Microsoft Corporation', location: 'HKCR\\Drive\\shell', isThirdParty: false, isProtected: false, risk: 'low', category: '驱动器', source: 'shell', enabled: true },
    { name: '磁盘清理', clsid: '', company: 'Microsoft Corporation', location: 'HKCR\\Drive\\shell', isThirdParty: false, isProtected: false, risk: 'low', category: '驱动器', source: 'shell', enabled: true },
    { name: '我的电脑', clsid: '{20D04FE0-3AEA-1069-A2D8-08002B30309D}', company: 'Microsoft Corporation', location: 'HKCR\\Recycle.Bin\\shell', isThirdParty: false, isProtected: true, risk: 'protected', category: '回收站', source: 'shell', enabled: true },
    { name: '清空回收站', clsid: '', company: 'Microsoft Corporation', location: 'HKCR\\Recycle.Bin\\shell', isThirdParty: false, isProtected: false, risk: 'low', category: '回收站', source: 'shell', enabled: true },
    { name: 'NVIDIAPowerUser', clsid: '{B41DB860-8EE4-11D2-9906-E49FADC173CC}', company: 'NVIDIA Corporation', location: 'HKCR\\Directory\\Background\\shellex\\ContextMenuHandlers', isThirdParty: true, isProtected: false, risk: 'high', category: '目录背景', source: 'shellex', enabled: true },
    { name: '新建', clsid: '', company: 'Microsoft Corporation', location: 'HKCR\\Directory\\Background\\shell', isThirdParty: false, isProtected: false, risk: 'low', category: '目录背景', source: 'shell', enabled: true },
    { name: '个性化', clsid: '', company: 'Microsoft Corporation', location: 'HKCR\\DesktopBackground\\shell', isThirdParty: false, isProtected: false, risk: 'low', category: '桌面背景', source: 'shell', enabled: true },
    { name: '显示设置', clsid: '', company: 'Microsoft Corporation', location: 'HKCR\\DesktopBackground\\shell', isThirdParty: false, isProtected: false, risk: 'low', category: '桌面背景', source: 'shell', enabled: true },
    { name: 'Intel 显卡属性', clsid: '{C5B8A5E0-2A4F-4B9E-A1C8-3D5E7F9B2A1D}', company: 'Intel Corporation', location: 'HKCR\\DesktopBackground\\shellex\\ContextMenuHandlers', isThirdParty: true, isProtected: false, risk: 'high', category: '桌面背景', source: 'shellex', enabled: true },
    { name: '桌面快捷方式', clsid: '', company: 'Microsoft Corporation', location: '%APPDATA%\\Microsoft\\Windows\\SendTo', isThirdParty: false, isProtected: false, risk: 'low', category: '发送到', source: 'filesystem', enabled: true },
    { name: '邮件收件人', clsid: '', company: 'Microsoft Corporation', location: '%APPDATA%\\Microsoft\\Windows\\SendTo', isThirdParty: false, isProtected: false, risk: 'low', category: '发送到', source: 'filesystem', enabled: true },
    { name: '蓝牙设备', clsid: '', company: 'Microsoft Corporation', location: '%APPDATA%\\Microsoft\\Windows\\SendTo', isThirdParty: false, isProtected: false, risk: 'low', category: '发送到', source: 'filesystem', enabled: true },
    { name: '百度网盘', clsid: '', company: '百度在线网络技术', location: '%APPDATA%\\Microsoft\\Windows\\SendTo', isThirdParty: true, isProtected: false, risk: 'high', category: '发送到', source: 'filesystem', enabled: true },
    { name: 'Microsoft Edge (ShellExt)', clsid: '{C5B8A5E0-2A4F-4B9E-A1C8-3D5E7F9B2A2E}', company: 'Microsoft Corporation', location: 'HKCU\\Software\\Classes\\PackagedCom', isThirdParty: false, isProtected: false, risk: 'low', category: 'UWP应用', source: 'packagedcom', enabled: true },
    { name: 'Snip & Sketch', clsid: '{D8A9F0C1-2D3E-4F5A-6B7C-8D9E0F1A2B4D}', company: 'Microsoft Corporation', location: 'HKCU\\Software\\Classes\\PackagedCom', isThirdParty: false, isProtected: false, risk: 'low', category: 'UWP应用', source: 'packagedcom', enabled: true }
  ];

  // 获取按分类分组的项（叠加侧边栏分类筛选 + 顶部筛选标签）
  function getGroupedItems() {
    const grouped = {};
    for (const cat of CATEGORY_ORDER) {
      grouped[cat] = [];
    }
    const catMatcher = SIDEBAR_CATEGORY_MATCH[currentCategory] || SIDEBAR_CATEGORY_MATCH['全部'];
    const filtered = items.filter(it => {
      // 侧边栏分类筛选（叠加生效）
      if (catMatcher && !catMatcher(it)) return false;
      if (currentFilter === 'all') return true;
      if (currentFilter === 'high') return it.risk === 'high' || it.risk === 'protected';
      if (currentFilter === 'low') return it.risk === 'low';
      if (currentFilter === 'disabled') return it.enabled === false;
      return true;
    });
    for (const it of filtered) {
      const cat = it.category || '其他';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(it);
    }
    return grouped;
  }

  // 获取某个分类下所有项的唯一标识
  function getItemKey(item) {
    // CLSID 可能在多个分类中复用，必须把分类和注册表路径纳入唯一键
    return [item.category || '', item.regPath || item.location || '', item.name || '', item.clsid || ''].join('|');
  }

  function escapeHtml(value) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(value ?? '').replace(/[&<>"']/g, ch => map[ch]);
  }

  // 默认占位图标（无程序图标时使用）。带 data-icon-fallback 标记，
  // 由 icon-fallback 共享兜底升级为 Trim.ico（B2：全场景统一兜底）；
  // Trim.ico 也提取失败时保留本问号占位。
  function placeholderIconHtml(size) {
    const s = size || 28;
    return `<span class="ctx-item-icon-placeholder" data-icon-fallback data-icon-size="${s}"><svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/></svg></span>`;
  }

  // 条目程序图标（有则展示提取的 DLL 图标，无则占位）
  function itemIconHtml(item, size) {
    if (item.clsid && iconMap[item.clsid]) {
      return `<img class="ctx-item-icon" src="${iconMap[item.clsid]}" alt="" width="${size || 28}" height="${size || 28}" />`;
    }
    return placeholderIconHtml(size);
  }

  function renderList() {
    const container = document.getElementById('contextMenuList');
    if (!container) return;

    if (items.length === 0 && !hasScanned) {
      container.innerHTML = renderEmptyState('点击"扫描右键菜单"开始检测');
      return;
    }

    const grouped = getGroupedItems();
    // 扫描完成后固定展示全部分类，即使某一类暂时没有注册项，也能明确看到扫描范围。
    const activeCategories = (currentFilter === 'all' || currentFilter === 'disabled')
      ? CATEGORY_ORDER
      : CATEGORY_ORDER.filter(cat => grouped[cat] && grouped[cat].length > 0);

    const nonEmptyCategories = activeCategories.filter(cat => (grouped[cat] || []).length > 0);
    if (nonEmptyCategories.length === 0) {
      const msg = currentFilter === 'disabled'
        ? '暂无已禁用的项'
        : (hasScanned ? `「${currentCategory}」分类下暂无匹配项` : '没有匹配的项');
      container.innerHTML = renderEmptyState(msg);
      return;
    }

    // 页头汇总：总条目数 + 分类总数
    const totalShown = nonEmptyCategories.reduce((s, cat) => s + (grouped[cat] || []).length, 0);
    const summary = document.getElementById('contextSummary');
    if (summary) summary.textContent = `共 ${totalShown} 项 · ${nonEmptyCategories.length} 个分类`;

    // 所有看板按项数从少到多升序排列（稳定排序，项数相同保持原相对顺序）
    const sortedCategories = [...nonEmptyCategories].sort(
      (a, b) => (grouped[a] || []).length - (grouped[b] || []).length
    );

    // 看板：瀑布流（Masonry）排布，按升序依次放入最矮列底部
    container.innerHTML = `<div class="ctx-kanban">` +
      sortedCategories.map(cat => renderCategoryColumn(cat, grouped[cat])).join('') +
      `</div>`;

    // 绑定看板行：点击复选框切换启用/禁用，点击其余区域打开详情弹窗
    //（文字选中时跳过以支持复制；删除入口在详情弹窗内）
    container.querySelectorAll('.ctx-kanban-row').forEach(el => {
      el.addEventListener('click', e => {
        const key = el.dataset.itemKey;
        const item = items.find(i => getItemKey(i) === key);
        if (!item) return;
        if (e.target.closest('.checkbox')) {
          toggleItemEnabled(item);
          return;
        }
        if (window.getSelection && window.getSelection().toString()) return;
        openDetail(item);
      });
    });

    // 列底「全选本类」：批量启用/禁用该分类全部可操作项
    container.querySelectorAll('[data-col-selectall]').forEach(btn => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.colSelectall;
        toggleCategoryItems(cat, grouped[cat] || []);
      });
    });

    // 瀑布流布局：重新渲染后立即放置；窗口 resize 由 attach 内部防抖 + FLIP 动画重排
    // 注意：布局容器是每次重渲染重建的 .ctx-kanban，须用 getter 动态获取
    if (!kanbanMasonry && window.kanbanMasonry) {
      kanbanMasonry = window.kanbanMasonry.attach(
        () => container.querySelector('.ctx-kanban'), '.ctx-col', { gap: 14, minCard: 246 }
      );
    }
    if (kanbanMasonry) kanbanMasonry.relayout(false);

    updateUI();
  }

  // 看板列：列头（分类名 + 项数徽章）+ 条目竖排 + 列底「全选本类」
  function renderCategoryColumn(cat, catItems) {
    const icon = CATEGORY_ICONS[cat] || '\u{1F4C4}';
    const disabledCount = catItems.filter(it => it.enabled === false).length;
    const metaText = disabledCount > 0 ? `${catItems.length} 项 · ${disabledCount} 已禁用` : `${catItems.length} 项`;
    const rows = catItems.map((item, i) => renderKanbanRow(item, i + 1)).join('');
    return `
      <div class="ctx-col" data-category="${escapeHtml(cat)}">
        <div class="ctx-col-head">
          <span class="ctx-col-title"><span class="ctx-col-icon">${icon}</span>${escapeHtml(cat)}</span>
          <span class="ctx-col-count" data-cat-meta="${escapeHtml(cat)}">${escapeHtml(metaText)}</span>
        </div>
        <div class="ctx-col-body">${rows}</div>
        <div class="ctx-col-foot">
          <button type="button" class="ctx-col-selectall" data-col-selectall="${escapeHtml(cat)}" title="批量启用/禁用该分类全部可操作项">全选本类</button>
        </div>
      </div>
    `;
  }

  // 看板条目行：复选框(启用/禁用) + 序号 + 名称(可换行) + 类型/状态标签 + 详情图标（厂商信息只在详情弹窗展示）
  function renderKanbanRow(item, index) {
    const key = getItemKey(item);
    const enabled = item.enabled !== false;
    const toggleable = isToggleable(item);
    return `
      <div class="ctx-kanban-row ${item.risk === 'protected' ? 'protected' : ''} ${enabled ? '' : 'disabled-row'}" data-item-key="${escapeHtml(key)}" title="单击查看详情">
        <div class="checkbox ${enabled ? 'checked' : ''} ${toggleable ? '' : 'disabled'}" title="${enabled ? '取消勾选禁用此项' : '勾选启用此项'}"></div>
        <span class="ctx-row-index">${index}</span>
        <span class="ctx-row-main">
          <span class="ctx-row-name">${escapeHtml(item.name)}</span>
        </span>
        <span class="ctx-row-side">${typeBadgeHtml(item)}<span class="ctx-row-detail" title="查看详情">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
        </span></span>
      </div>
    `;
  }

  // ==================== 详情弹窗 ====================
  function openDetail(item) {
    closeDetail();
    detailItem = item;

    const badge = typeBadgeHtml(item);
    const regPath = item.regPath || item.location || '';
    const regJumpable = /^HK(LM|CR|CU|U|CC|PD)/i.test(regPath);

    const backdrop = document.createElement('div');
    backdrop.className = 'ctx-detail-backdrop';
    backdrop.id = 'ctxDetailBackdrop';
    backdrop.innerHTML = `
      <div class="ctx-detail-modal">
        <div class="ctx-detail-header">
          <div class="ctx-detail-icon-wrap" id="ctxDetailIconWrap">${itemIconHtml(item, 40)}</div>
          <div class="ctx-detail-title-wrap">
            <div class="ctx-detail-name">${escapeHtml(item.name)}</div>
            <div class="ctx-detail-badges">${badge}<span class="ctx-detail-cat">${CATEGORY_ICONS[item.category] || ''} ${escapeHtml(item.category || '其他')}</span></div>
          </div>
          <button class="ctx-detail-close" id="ctxDetailClose" title="关闭">&times;</button>
        </div>
        <div class="ctx-detail-body">
          <div class="ctx-detail-grid">
            <div class="ctx-detail-row"><span class="ctx-detail-label">注册表路径</span><span class="ctx-detail-value mono ${regJumpable ? 'ctx-reg-jump' : ''}" ${regJumpable ? 'id="ctxRegJump" title="点击在注册表编辑器中定位（需要时会自动请求管理员权限）"' : ''}>${escapeHtml(regPath || '--')}</span></div>
             <div class="ctx-detail-row"><span class="ctx-detail-label">所属公司</span><span class="ctx-detail-value">${escapeHtml(item.company || '--')}</span></div>
             ${item.filePath ? `<div class="ctx-detail-row"><span class="ctx-detail-label">组件路径</span><span class="ctx-detail-value mono">${escapeHtml(item.filePath)}</span></div>` : ''}
             ${item.command ? `<div class="ctx-detail-row"><span class="ctx-detail-label">执行命令</span><span class="ctx-detail-value mono">${escapeHtml(item.command)}</span></div>` : ''}
             ${item.clsid ? `<div class="ctx-detail-row"><span class="ctx-detail-label">CLSID</span><span class="ctx-detail-value mono">${escapeHtml(item.clsid)}</span></div>` : ''}
            <div class="ctx-detail-row"><span class="ctx-detail-label">组件类型</span><span class="ctx-detail-value">${item.isThirdParty ? '第三方软件' : '系统原生组件'}</span></div>
            <div class="ctx-detail-row"><span class="ctx-detail-label">用途说明</span><span class="ctx-detail-value">${escapeHtml(componentUsage(item))}</span></div>
          </div>
          <div class="ctx-detail-desc">
            <div class="ctx-detail-desc-title">简介</div>
            <div id="ctxIntroMount"></div>
          </div>
          <div class="ctx-detail-actions">
            <button class="ctx-detail-delete" id="ctxDetailDelete" title="备份到桌面后删除此项（不可逆）">备份并删除</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    // B2：详情弹窗无真实图标时，占位符升级为统一的 Trim.ico 兜底图标
    if (window.iconFallback?.applyFallbacks) {
      window.iconFallback.applyFallbacks(backdrop.querySelector('#ctxDetailIconWrap'));
    }

    // 简介面板：打开即展示本地内置简介；联网 AI 简介须再次点击「获取AI简介」才请求大模型
    if (window.intro?.mountIntroPanel) {
      window.intro.mountIntroPanel({
        mount: backdrop.querySelector('#ctxIntroMount'),
        scope: 'contextmenu',
        name: item.name,
        company: item.company,
        item
      });
    }

    backdrop.querySelector('#ctxDetailClose').addEventListener('click', closeDetail);
    // 详情内删除：先关闭弹窗，再走统一的「备份并删除」确认流程
    backdrop.querySelector('#ctxDetailDelete').addEventListener('click', () => {
      const target = item;
      closeDetail();
      removeItem(target);
    });
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) closeDetail();
    });
    document.addEventListener('keydown', detailKeyHandler);

    // 阶段三：详情弹窗接入统一焦点管理（ds.focusTrap）——焦点入弹窗、Tab 陷阱、
    // closeDetail 时归还触发元素；Esc 关闭沿用上方 detailKeyHandler
    if (window.ds?.focusTrap) {
      detailTrap = window.ds.focusTrap(backdrop.querySelector('.ctx-detail-modal'), {
        initialFocus: '#ctxDetailClose'
      });
    }

    // 注册表路径：点击打开 regedit 并定位（需要时自动提权）
    const regJump = backdrop.querySelector('#ctxRegJump');
    if (regJump) {
      regJump.addEventListener('click', async e => {
        // 文字被选中时不触发跳转（支持复制路径）
        if (window.getSelection && window.getSelection().toString()) return;
        const path = item.regPath || item.location || '';
        if (!path) return;
        if (!window.api?.contextmenu?.openInRegedit) {
          window.app?.toast('info', '当前环境不支持打开注册表编辑器');
          return;
        }
        regJump.classList.add('jumping');
        try {
          const resp = await window.api.contextmenu.openInRegedit(path);
          if (resp && resp.success) {
            window.app?.toast('success', resp.message || '已在注册表编辑器中定位');
          } else {
            window.app?.toast('error', (resp && resp.message) || '打开注册表编辑器失败');
          }
        } catch (err) {
          window.app?.toast('error', '打开注册表编辑器失败: ' + err.message);
        } finally {
          regJump.classList.remove('jumping');
        }
      });
    }
  }

  // 组件用途静态说明（系统原生 / 第三方）
  function componentUsage(item) {
    const cat = item.category || '';
    if (item.isThirdParty) {
      return `由 ${item.company || '第三方厂商'} 提供的右键菜单扩展，在「${cat}」上右键时显示其功能入口。`;
    }
    return `Windows 系统原生右键菜单项，属于「${cat}」分类的系统内置功能。`;
  }

  function detailKeyHandler(e) {
    if (e.key === 'Escape') closeDetail();
  }

  function closeDetail() {
    const backdrop = document.getElementById('ctxDetailBackdrop');
    if (backdrop) backdrop.remove();
    document.removeEventListener('keydown', detailKeyHandler);
    if (detailTrap) { detailTrap.release(); detailTrap = null; }
    detailItem = null;
  }

  // 注：AI 简介的加载、缓存与重试统一由 intro.js 的简介面板处理（scope = contextmenu），
  // 此处不再在打开详情时自动发起联网请求。

  // ==================== 图标加载 ====================
  async function loadIcons() {
    if (!window.api?.contextmenu?.icons || !items.length) return;
    try {
      const resp = await window.api.contextmenu.icons(items);
      if (resp.success && resp.data && Object.keys(resp.data).length) {
        iconMap = { ...iconMap, ...resp.data };
        renderList();
      }
    } catch (e) { /* 图标加载失败使用占位图标 */ }
  }

  function renderEmptyState(msg) {
    return window.emptyState
      ? window.emptyState({ icon: 'box', title: msg, desc: hasScanned ? '可尝试切换分类或筛选条件，或重新扫描' : '点击右上角「扫描右键菜单」开始检测' })
      : `<div class="empty-state">
      <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor" opacity="0.3">
        <path d="M4 8h16v2H4V8zm0 5h16v2H4v-2zm0 5h16v2H4v-2z"/>
      </svg>
      <p>${msg}</p>
    </div>`;
  }

  function updateUI() {
    // 更新分类元信息（含禁用计数）
    const grouped = getGroupedItems();
    for (const cat of CATEGORY_ORDER) {
      const catItems = grouped[cat] || [];
      if (catItems.length === 0) continue;
      const metaEl = document.querySelector(`[data-cat-meta="${cat}"]`);
      if (!metaEl) continue;
      const disabledCount = catItems.filter(it => it.enabled === false).length;
      metaEl.textContent = disabledCount > 0 ? `${catItems.length} 项 · ${disabledCount} 已禁用` : `${catItems.length} 项`;
    }

    // 总览：已禁用计数
    const countEl = document.getElementById('contextSelectedCount');
    if (countEl) countEl.textContent = items.filter(it => it.enabled === false).length;
  }

  // ==================== 启停切换（勾选=启用，取消=禁用） ====================
  // 统一批量通道：按 regPath 回写实际生效结果（权限不足 / 路径失效的项保持原状）
  async function applyToggles(payloads) {
    if (!payloads.length) return;
    if (!window.api?.contextmenu?.toggle) {
      // 浏览器预览模式：直接翻转本地状态
      payloads.forEach(p => { p.item.enabled = p.enabled; });
      renderList();
      updateUI();
      return;
    }
    try {
      const resp = await window.api.contextmenu.toggle(payloads.map(p => ({
        name: p.item.name,
        regPath: p.item.regPath || p.item.location || '',
        source: p.item.source,
        enabled: p.enabled
      })));
      const results = (resp.data && resp.data.results) || [];
      const byPath = {};
      for (const r of results) byPath[r.regPath] = r;
      let changed = 0, failed = 0;
      for (const p of payloads) {
        const key = p.item.regPath || p.item.location || '';
        if (results.length === 0) continue;
        const r = byPath[key];
        if (r && r.status === 'ok') {
          // 重命名类切换（shellex '-' 前缀 / 禁用前缀还原）后更新条目路径，
          // 保证不重新扫描的情况下反向切换仍能定位到键
          if (r.newRegPath) p.item.regPath = r.newRegPath;
          p.item.enabled = p.enabled;
          changed++;
        } else {
          failed++;
        }
      }
      if (failed > 0) {
        window.app?.toast('error', `${failed} 项切换失败（可能需要管理员权限）`);
      } else if (payloads.length === 1) {
        const p = payloads[0];
        window.app?.toast(p.enabled ? 'success' : 'info', `${p.item.name} ${p.enabled ? '已启用' : '已禁用'}`);
      } else {
        window.app?.toast('success', `已${payloads[0].enabled ? '启用' : '禁用'} ${changed} 项`);
      }
    } catch (e) {
      window.app?.toast('error', '切换失败: ' + e.message);
    }
    renderList();
    updateUI();
  }

  function toggleItemEnabled(item) {
    if (!isToggleable(item)) {
      if (item.risk === 'protected') {
        window.app?.toast('info', '系统保护项不可操作');
      } else {
        window.app?.toast('info', '该类型暂不支持启停切换');
      }
      return;
    }
    applyToggles([{ item, enabled: item.enabled === false }]);
  }

  async function toggleCategoryItems(cat, catItems) {
    const toggleableItems = catItems.filter(it => isToggleable(it));
    if (!toggleableItems.length) return;
    const target = !toggleableItems.every(it => it.enabled !== false);
    const affected = toggleableItems.filter(it => (it.enabled !== false) !== target);
    if (!affected.length) return;
    if (affected.length > 3) {
      const ok = await window.app?.confirm(
        '批量切换',
        `即将${target ? '启用' : '禁用'}「${cat}」分类下 ${affected.length} 项（切换为可逆操作）。\n\n是否继续？`,
        '确认切换'
      );
      if (!ok) return;
    }
    applyToggles(affected.map(item => ({ item, enabled: target })));
  }

  // ==================== 行内删除（先备份后删除，不可逆） ====================
  async function removeItem(item) {
    const ok = await window.app?.confirm(
      '删除右键菜单项',
      `即将备份并删除「${item.name}」。\n备份文件将保存到桌面"右键菜单备份_时间戳"目录。\n\n是否继续？`,
      '确认删除'
    );
    if (!ok) return;
    try {
      if (window.api?.contextmenu) {
        const backupResp = await window.api.contextmenu.backup([item]);
        if (!backupResp?.success) throw new Error(backupResp?.message || '备份失败，已停止删除');
        const resp = await window.api.contextmenu.remove([{
          name: item.name, regPath: item.regPath, risk: item.risk, source: item.source, clsid: item.clsid, category: item.category
        }]);
        if (!resp.success) throw new Error(resp.message);
        window.app?.toast('success', '已备份并删除所选菜单项');
      } else {
        // 预览模式
        await new Promise(r => setTimeout(r, 800));
        window.app?.toast('success', `[模拟] 已备份到桌面，并删除「${item.name}」`);
      }
      items = items.filter(i => getItemKey(i) !== getItemKey(item));
      if (detailItem === item) closeDetail();
      renderList();
      updateUI();
    } catch (e) {
      window.app?.toast('error', '操作失败: ' + e.message);
    }
  }

  async function scan() {
    if (isScanning) return;
    isScanning = true;
    items = [];
    iconMap = {};
    hasScanned = false;

    const container = document.getElementById('contextMenuList');
    if (container) {
      container.innerHTML = `<div class="empty-state">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor" opacity="0.5" class="spin">
          <path d="M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z"/>
        </svg>
        <p>正在扫描右键菜单扩展项...</p>
      </div>`;
    }

    try {
      if (window.api?.contextmenu) {
        const resp = await window.api.contextmenu.scan();
        if (!resp.success) throw new Error(resp.message);
        items = resp.data;
      } else {
        // 预览模式
        await new Promise(r => setTimeout(r, 1200));
        items = MOCK_ITEMS.map(m => ({ ...m, regPath: m.location + '\\' + m.name }));
      }
      hasScanned = true;
      renderList();
      updateUI();
      // 后台加载程序图标，加载完成后刷新列表
      loadIcons();

      const catCount = CATEGORY_ORDER.filter(c => items.some(i => (i.category || '其他') === c)).length;
      window.app?.toast('success', `扫描完成，共发现 ${items.length} 项，分布于 ${catCount} 个分类`);
    } catch (e) {
      window.app?.toast('error', '扫描失败: ' + e.message);
      if (container) {
        container.innerHTML = `<div class="empty-state"><p>扫描失败: ${escapeHtml(e.message)}</p></div>`;
      }
    } finally {
      isScanning = false;
      updateUI();
    }
  }

  async function restore() {
    const ok = await window.app?.confirm(
      '从备份恢复',
      '将使用桌面上的最新备份目录（右键菜单备份_*）恢复所有右键菜单项。\n是否继续？',
      '确认恢复'
    );
    if (!ok) return;
    try {
      if (window.api?.contextmenu) {
        const resp = await window.api.contextmenu.restore();
        if (!resp.success) throw new Error(resp.message);
        window.app?.toast('success', `已从 ${resp.data.backupDir} 导入 ${resp.data.imported} 项`);
      } else {
        await new Promise(r => setTimeout(r, 800));
        window.app?.toast('info', '[模拟] 已恢复最新备份（浏览器预览模式无实际操作）');
      }
    } catch (e) {
      window.app?.toast('error', '恢复失败: ' + e.message);
    }
  }

  function setFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('#contextFilter .filter-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.filter === filter);
    });
    renderList();
    updateUI();
  }

  // ==================== 侧边栏分类树导航（树状分组，选中项持久化） ====================
  const CATEGORY_STORAGE_KEY = 'winclean-ctx-category';

  function getStoredCategory() {
    try {
      const saved = localStorage.getItem(CATEGORY_STORAGE_KEY);
      // 仅接受合法分类（防止残留旧值）
      return saved && SIDEBAR_CATEGORY_MATCH[saved] ? saved : '文件';
    } catch (e) {
      return '文件';
    }
  }

  function storeCategory(cat) {
    try { localStorage.setItem(CATEGORY_STORAGE_KEY, cat); } catch (e) {}
  }

  // 分类树子项高亮（圆点 + 底色，与测速分组视觉一致）
  function applyCategoryNavActive() {
    document.querySelectorAll('#ctxCategoryNav [data-category]').forEach(el => {
      el.classList.toggle('active', el.dataset.category === currentCategory);
    });
  }

  function setCategory(cat) {
    if (!SIDEBAR_CATEGORY_MATCH[cat]) return;
    currentCategory = cat;
    storeCategory(cat);
    applyCategoryNavActive();
    renderList();
    updateUI();
  }

  function init() {
    document.getElementById('btnScanContext')?.addEventListener('click', scan);
    document.getElementById('btnRestoreMenu')?.addEventListener('click', restore);

    document.querySelectorAll('#contextFilter .filter-tab').forEach(el => {
      el.addEventListener('click', () => setFilter(el.dataset.filter));
    });

    // 侧边栏分类树：点击子项切换分类筛选（与顶部筛选标签叠加生效，保留勾选状态；选中项持久化）
    currentCategory = getStoredCategory();
    applyCategoryNavActive();
    document.querySelectorAll('#ctxCategoryNav [data-category]').forEach(el => {
      el.addEventListener('click', () => {
        const cat = el.dataset.category;
        if (cat === currentCategory) return; // 点击当前激活项不重复刷新
        setCategory(cat);
        if (hasScanned && items.length) {
          const grouped = getGroupedItems();
          const count = Object.values(grouped).reduce((s, arr) => s + arr.length, 0);
          window.app?.toast('info', `已切换到「${cat}」分类，匹配 ${count} 项`);
        }
      });
    });
  }

  window.contextmenu = { init, scan, removeItem, restore, MOCK_ITEMS, CATEGORY_ORDER, openDetail };
})();
