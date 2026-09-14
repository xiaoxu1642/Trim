// scripts/restructure-rules.js — 垃圾清理类目体系重构 S1（v3.2.1）
// 按《垃圾清理类目与规则重构方案-2026-09-14》第五节迁移映射表：
//   1) 为全部规则追加元数据 domain/group/nature/regenerable/prov（不改 id、不动执行字段）
//   2) 顶层重排为五域：系统清理 / 应用清理 / 浏览器清理 / 图形与加速 / 维护与特殊操作
//   3) rulesVersion 递增（触发应用内「更新规则库」链路）
// 用法：node scripts/restructure-rules.js
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'data', 'cleanup-rules.json');

// ---- 迁移映射：id → [domain, group, nature, regenerable]（文档 §五 / §3.1 / §3.4） ----
const M = {
  // 域 1 系统清理
  windowsDownloadCache: ['system', 'updates', 'updateResidual', true],
  deliveryOptimization: ['system', 'updates', 'updateResidual', true],
  usoLogs: ['system', 'updates', 'updateResidual', true],
  winsatCache: ['system', 'updates', 'updateResidual', true],
  windowsUpdateLog: ['system', 'updates', 'log', true],
  windowsReport: ['system', 'logs', 'log', true],
  werReportQueue: ['system', 'logs', 'log', true],
  systemLogFiles: ['system', 'logs', 'log', true],
  windowsDebug: ['system', 'logs', 'log', true],
  pantherLogs: ['system', 'logs', 'log', true],
  windowsLogs: ['system', 'logs', 'log', true],
  diagnosisData: ['system', 'logs', 'log', true],
  defenderHistoryRecords: ['system', 'logs', 'log', true],
  prefetchFiles: ['system', 'caches', 'cache', true],
  thumbnailCacheFiles: ['system', 'caches', 'cache', true],
  iconCacheFiles: ['system', 'caches', 'cache', true],
  winINetCache: ['system', 'caches', 'cache', true],
  liveKernelReports: ['system', 'caches', 'cache', true],
  terminalServerCache: ['system', 'caches', 'cache', true],
  dotNetCache: ['system', 'caches', 'cache', true],
  tempFiles: ['system', 'temps', 'temp', true],
  systemTemp: ['system', 'temps', 'temp', true],
  winSxsTempFile: ['system', 'temps', 'temp', true],
  winSxsTempFile2: ['system', 'temps', 'temp', true],
  driverTempExtract: ['system', 'temps', 'temp', true],
  memoryDumpFiles: ['system', 'dumps', 'dump', false],
  userCrashDumps: ['system', 'dumps', 'dump', false],
  winINetCookies: ['system', 'history', 'history', false],
  explorerRecentDocs: ['system', 'history', 'history', false],
  explorerRunMRU: ['system', 'history', 'history', false],
  shellMuiCache: ['system', 'history', 'history', false],
  recentFiles: ['system', 'history', 'history', false],
  dismPlusOld: ['system', 'stale', 'staleBackup', false],
  // 域 2 应用清理
  wechatCache: ['app', 'im', 'cache', true],
  qqCache: ['app', 'im', 'cache', true],
  qqTemp: ['app', 'im', 'cache', true],
  qqFileClean: ['app', 'im', 'fileClean', true],
  wechatFileClean: ['app', 'im', 'fileClean', true],
  neteaseMusicCache: ['app', 'media', 'cache', true],
  douyinCache: ['app', 'media', 'cache', true],
  baiduNetdiskLog: ['app', 'netdisk', 'log', true],
  officeFileCache: ['app', 'office', 'cache', true],
  wpsOldBackup: ['app', 'office', 'staleBackup', false],
  steamCache: ['app', 'game', 'cache', true],
  steamHtmlCache: ['app', 'game', 'cache', true],
  epicWebCache: ['app', 'game', 'cache', true],
  vscodeCache: ['app', 'dev', 'cache', true],
  jetbrainsCache: ['app', 'dev', 'cache', true],
  npmCache: ['app', 'dev', 'cache', true],
  pipCache: ['app', 'dev', 'cache', true],
  nugetCache: ['app', 'dev', 'cache', true],
  // 域 3 浏览器清理
  chromeCache: ['browser', 'webpage', 'cache', true],
  edgeCache: ['browser', 'webpage', 'cache', true],
  qqBrowserCache: ['browser', 'webpage', 'cache', true],
  chromeCodeCache: ['browser', 'codecache', 'cache', true],
  chromeMediaCache: ['browser', 'codecache', 'cache', true],
  edgeMediaCache: ['browser', 'codecache', 'cache', true],
  firefoxCache: ['browser', 'codecache', 'cache', true],
  cloudSyncCache: ['browser', 'sync', 'history', false],
  chromeOldBackup: ['browser', 'stale', 'staleBackup', false],
  // 域 4 图形与加速
  nvidiaCache: ['gfx', 'shader', 'cache', true],
  nvidiaNvCache: ['gfx', 'shader', 'cache', true],
  amdCache: ['gfx', 'shader', 'cache', true],
  intelShaderCache: ['gfx', 'shader', 'cache', true],
  directXShaderCache: ['gfx', 'sysgfx', 'cache', true],
  // 域 5 维护与特殊操作（永不默认勾选）
  dismComponentCleanup: ['special', 'actions', 'action', false],
  recycleBin: ['special', 'actions', 'action', false],
  packageCache: ['special', 'actions', 'action', false]
};

// 新类目体系（域 → 二级分类），title/icon 承接渲染层既有渲染
const DOMAIN_DEFS = [
  {
    key: 'system', title: '系统清理', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>',
    subs: [
      ['updates', '更新与组件残留', '🔄'],
      ['logs', '日志与诊断', '📋'],
      ['caches', '缓存与预读', '⚡'],
      ['temps', '临时文件', '🧹'],
      ['dumps', '崩溃转储', '💥'],
      ['history', '隐私历史', '🕘'],
      ['stale', '过时备份', '📦']
    ]
  },
  {
    key: 'app', title: '应用清理', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h4l4 4 4-4h4c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>',
    subs: [
      ['im', '即时通讯', '💬'],
      ['media', '影音娱乐', '🎬'],
      ['netdisk', '网盘与下载', '☁️'],
      ['office', '办公与文档', '📄'],
      ['game', '游戏平台', '🎮'],
      ['dev', '开发工具', '🛠️']
    ]
  },
  {
    key: 'browser', title: '浏览器清理', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
    subs: [
      ['webpage', '网页缓存', '🌐'],
      ['codecache', '代码与媒体缓存', '🧩'],
      ['sync', '同步与隐私', '🔒'],
      ['stale', '过时版本备份', '📦']
    ]
  },
  {
    key: 'gfx', title: '图形与加速', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 14c1.66 0 3-1.34 3-3S8.66 8 7 8s-3 1.34-3 3 1.34 3 3 3zm5-6h10V5H12v3zm0 12h10v-3H12v3zm0-6h10v-3H12v3zM4 9h2v2H2v-2h2zm0 12v-2h2v2H4zm-2-6h4v2H2v-2z"/></svg>',
    subs: [
      ['shader', '显卡着色器缓存', '🎮'],
      ['sysgfx', '系统图形缓存', '⚡']
    ]
  },
  {
    key: 'special', title: '维护与特殊操作', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
    subs: [
      ['actions', '系统动作', '⚠️']
    ]
  }
];

const raw = fs.readFileSync(SRC, 'utf8');
const parsed = JSON.parse(raw);

// 收集全部条目（按 id 索引），校验映射表全覆盖
const allItems = new Map();
for (const g of parsed.groups) {
  const items = g.subGroups ? g.subGroups.flatMap(sg => sg.items || []) : (g.items || []);
  for (const it of items) allItems.set(it.id, it);
}
const missing = [...allItems.keys()].filter(id => !M[id]);
const extra = Object.keys(M).filter(id => !allItems.has(id));
if (missing.length || extra.length) {
  console.error('映射表与规则库不一致，中止：');
  if (missing.length) console.error('  缺少映射的规则 id: ' + missing.join(', '));
  if (extra.length) console.error('  映射表多余的 id: ' + extra.join(', '));
  process.exit(1);
}

const ORIGIN_REF = new Map();
for (const g of parsed.groups) {
  const ref = g.subGroups ? `${g.key}/${g.subGroups.map(sg => sg.id).join('|')}` : g.key;
  for (const sg of (g.subGroups || [])) {
    for (const it of (sg.items || [])) ORIGIN_REF.set(it.id, `${g.key}/${sg.id}`);
  }
  for (const it of (g.items || [])) ORIGIN_REF.set(it.id, g.key);
}

let count = 0;
const newGroups = DOMAIN_DEFS.map(def => ({
  key: def.key,
  title: def.title,
  icon: def.icon,
  subGroups: def.subs.map(([id, name, icon]) => ({
    id,
    name,
    icon,
    items: []
  }))
}));
const subIndex = new Map();
// 键带域前缀：不同域的子分类 id 可能同名（如 system/stale 与 browser/stale）
for (const g of newGroups) for (const sg of g.subGroups) subIndex.set(g.key + '/' + sg.id, sg);

for (const [id, item] of allItems) {
  const [domain, group, nature, regenerable] = M[id];
  const sg = subIndex.get(domain + '/' + group);
  if (!sg) { console.error('子分类不存在: ' + group); process.exit(1); }
  sg.items.push({
    ...item,
    domain,
    group,
    nature,
    regenerable,
    prov: { source: 'builtin', ref: ORIGIN_REF.get(id) || '', importedAt: '2026-09-14' }
  });
  count++;
}

const out = {
  version: parsed.version,
  rulesVersion: 20260914,
  groups: newGroups
};
fs.writeFileSync(SRC, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`重构完成：${count} 条规则重排为 ${newGroups.length} 个域、${newGroups.reduce((s, g) => s + g.subGroups.length, 0)} 个二级分类；rulesVersion=${out.rulesVersion}`);
for (const g of newGroups) {
  console.log(`  ${g.title}: ${g.subGroups.map(sg => `${sg.name}(${sg.items.length})`).join('、')}`);
}
