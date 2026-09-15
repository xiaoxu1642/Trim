// test-features.js - 无头功能冒烟测试
// 不启动 Electron，仅做静态/模块级验证：语法、数据文件、脚本生成、页面挂载。
// 运行：npm test
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SECURITY = require('./src/main/security');

const ROOT = __dirname;
let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.error('  FAIL  ' + name + '  ->  ' + (err && err.message ? err.message : err));
  }
}

function abs(p) {
  return path.join(ROOT, p);
}

// ==================== 1. JS 语法检查（node --check） ====================
const SYNTAX_FILES = [
  'main.js',
  'preload.js',
  'src/main/diag.js',
  'src/main/optimization-state.js',
  'src/main/ps-rule-path-eval.js',
  'src/main/ps-protect-path.js',
  'src/main/pwsh-runtime.js',
  'src/main/version-migrations.js',
  'src/scripts-powershell/cleanup-scripts.js',
  'src/scripts-powershell/maintenance-scripts.js',
  'src/scripts-powershell/sysdisk-scripts.js',
  'src/scripts-powershell/defaultapps-scripts.js',
  'src/scripts-powershell/netcheck-scripts.js',
  'src/scripts/app.js',
  'src/scripts/cleanup.js',
  'src/scripts/cleanup-fallback.generated.js',
  'src/scripts/ds.js',
  'src/scripts/defaultapps.js',
  'src/scripts/netcheck.js',
  'src/scripts/optimizer.js',
  'src/scripts/overview.js',
  'src/scripts/pathbinding.js',
  'src/scripts/splash.js',
  'src/scripts/modal.js',
  'scripts/clean-old-packages.js',
  'src/scripts/logger.js',
  'src/scripts/intro.js',
  'src/scripts/maintenance.js',
  'src/scripts/memoryclean.js',
  'src/scripts/netspeed-detector.js',
  'src/scripts/netspeed.js',
  'src/scripts/theme.js',
  'src/scripts/updater-ui.js',
  'src/scripts/xtable.js',
  'src/scripts/preview-window.js',
  'src/scripts/contextmenu.js',
  'src/scripts/mouse-trail.js',
  'src/scripts/tilt.js',
  'src/scripts/spotlight.js',
  // T1（2026-09-15）：补齐 23 个零覆盖文件 + 独立进程窗——原先这些文件不语法检查，
  // 7 个 🔴 全部落在零覆盖模块（S13 家族）。入清单后有任何语法破损 npm test 即拦截。
  'src/scripts/deviceinfo.js',
  'src/scripts/diskbench.js',
  'src/scripts/finder.js',
  'src/scripts/fontmanager.js',
  'src/scripts/icon-fallback.js',
  'src/scripts/modelpicker.js',
  'src/scripts/peripheral-window.js',
  'src/scripts/process-manager-window.js',
  'src/scripts/processes.js',
  'src/scripts/quickcmds-data.js',
  'src/scripts/quickcmds.js',
  'src/scripts/realtime.js',
  'src/scripts/runtimes.js',
  'src/scripts/startup.js',
  'src/scripts/sysrestore.js',
  'src/scripts-powershell/contextmenu-scripts.js',
  'src/scripts-powershell/device-info-scripts.js',
  'src/scripts-powershell/diskbench-scripts.js',
  'src/scripts-powershell/memory-scripts.js',
  'src/scripts-powershell/netspeed-scripts.js',
  'src/scripts-powershell/peripheral-scripts.js',
  'src/scripts-powershell/realtime-scripts.js',
  'src/scripts-powershell/runtimes-scripts.js',
  'src/scripts-powershell/startup-scripts.js'
];

console.log('[1/5] JS 语法检查');
for (const f of SYNTAX_FILES) {
  check('node --check ' + f, () => {
    execFileSync(process.execPath, ['--check', abs(f)], { stdio: 'pipe' });
  });
}

check('security 原子 JSON 写入可读回', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trim-test-'));
  try {
    const file = path.join(dir, 'nested', 'settings.json');
    SECURITY.atomicWriteJson(file, { version: 1, ok: true });
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed.ok) throw new Error('原子写入内容不一致');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('security secret mock round-trip 且不保存明文', () => {
  const mock = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: value => value.toString('utf8').replace(/^encrypted:/, '')
  };
  const encrypted = SECURITY.encryptSecret('test-api-key', mock);
  if (!encrypted.startsWith(SECURITY.SECRET_PREFIX) || encrypted.includes('test-api-key')) throw new Error('密钥未加密');
  if (SECURITY.decryptSecret(encrypted, mock) !== 'test-api-key') throw new Error('密钥解密失败');
});

// ==================== 2. 数据文件校验 ====================
console.log('[2/5] 数据文件校验');
check('cleanup-rules.json 可解析且包含清理项', () => {
  const rules = JSON.parse(fs.readFileSync(abs('src/data/cleanup-rules.json'), 'utf8'));
  if (!rules || !Array.isArray(rules.groups) || !rules.groups.length) throw new Error('groups 缺失');
  let items = 0;
  for (const g of rules.groups) {
    items += (g.items || []).length;
    for (const sg of g.subGroups || []) items += (sg.items || []).length;
  }
  if (items < 40) throw new Error('清理项数量异常: ' + items);
});

// 审查 2-2：双源一致性断言——generated FALLBACK 与规则 JSON 漂移时测试失败，提醒重新生成
check('cleanup-fallback.generated.js 与 cleanup-rules.json 一致', () => {
  const expected = JSON.parse(fs.readFileSync(abs('src/data/cleanup-rules.json'), 'utf8'));
  delete globalThis.CLEANUP_RULES_FALLBACK;
  require(abs('src/scripts/cleanup-fallback.generated.js')); // node 下挂到 globalThis
  const embedded = globalThis.CLEANUP_RULES_FALLBACK;
  if (!embedded) throw new Error('generated 文件缺少 CLEANUP_RULES_FALLBACK 赋值');
  if (JSON.stringify(embedded) !== JSON.stringify(expected)) {
    throw new Error('FALLBACK 数据与规则 JSON 不一致，请运行 node scripts/gen-fallback.js');
  }
});

check('本地简介覆盖全部固定可点击项', () => {
  const intros = JSON.parse(fs.readFileSync(abs('src/data/item-intro.json'), 'utf8'));
  const scopes = intros.scopes || {};
  const optimizer = require(abs('src/scripts-powershell/optimizer-scripts.js'));
  const options = optimizer.OPTIONS || (optimizer.options ? optimizer.options() : []);
  const optimizerIntros = scopes.optimizer?.byId || {};
  const missingOptions = options.filter(item => !optimizerIntros[item.id]).map(item => item.id);
  if (missingOptions.length) throw new Error('优化项缺少简介: ' + missingOptions.join(', '));

  const memoryIds = ['workingSet', 'standbyPriority0', 'combine', 'modified', 'standby', 'fileCache', 'registryCache', 'stubbornKill'];
  const memoryIntros = scopes.memoryclean?.byId || {};
  const missingMemory = memoryIds.filter(id => !memoryIntros[id]);
  if (missingMemory.length) throw new Error('内存项缺少简介: ' + missingMemory.join(', '));
});

// 审查v4-M2：readme 是应用内「查看说明」弹窗数据源且打进安装包，
// 关键数字与数据源脱节会误导用户风险判断（v4 报告实测优化中心数字全面漂移）。
check('readme 使用说明数字与实现一致（防漂移）', () => {
  const readme = fs.readFileSync(abs('readme.md'), 'utf8');
  const optimizer = require(abs('src/scripts-powershell/optimizer-scripts.js'));
  const options = optimizer.OPTIONS;
  const groups = new Set(options.map(o => o.group)).size;
  const high = options.filter(o => o.risk === 'high');
  const highNoRestore = high.filter(o => !o.restoreAvailable).length;
  const rules = JSON.parse(fs.readFileSync(abs('src/data/cleanup-rules.json'), 'utf8'));
  let cleanupItems = 0;
  let cleanupHigh = 0;
  for (const g of rules.groups) {
    for (const it of (g.items || [])) { cleanupItems++; if (it.risk === 'high') cleanupHigh++; }
    for (const sg of (g.subGroups || [])) for (const it of (sg.items || [])) { cleanupItems++; if (it.risk === 'high') cleanupHigh++; }
  }
  const mustContain = [
    `${groups} 个分组共 ${options.length} 个优化项`,
    `${options.length} 个优化项按 ${groups} 个分组`,
    `${options.length} 项里有 ${high.length} 项高风险，其中 ${highNoRestore} 项执行后无自动还原`,
    `${high.length} 项高风险里 ${highNoRestore} 项无自动还原`,
    `${rules.groups.length} 大类共 ${cleanupItems} 个清理项`,
    `高风险项共 ${cleanupHigh} 个`
  ];
  // 去掉 markdown 加粗符号后比对，避免文案加粗调整造成误报
  const plain = readme.replace(/\*/g, '');
  const missing = mustContain.filter(s => !plain.includes(s));
  if (missing.length) throw new Error('readme 数字漂移: ' + missing.join(' | '));
});

// 审查v4-M3：右键项删除不可逆（注册表无回收站语义），规范要求红色二次确认
check('contextmenu 删除确认走 confirmDanger', () => {
  const src = fs.readFileSync(abs('src/scripts/contextmenu.js'), 'utf8');
  const idx = src.indexOf('async function removeItem');
  if (idx < 0) throw new Error('removeItem 函数缺失');
  const seg = src.slice(idx, idx + 800);
  if (!seg.includes('confirmDanger')) throw new Error('removeItem 未走 confirmDanger 红色确认');
});

// ==================== 3. 纯模块可加载 + 脚本生成 ====================
console.log('[3/5] PowerShell 脚本生成');
check('maintenance-scripts 导出 list/run/CATEGORY_ORDER', () => {
  const m = require(abs('src/scripts-powershell/maintenance-scripts.js'));
  if (typeof m.list !== 'function' || typeof m.run !== 'function') throw new Error('导出缺失');
  const tasks = m.list();
  if (tasks.length < 11) throw new Error('维护任务数量异常，实际 ' + tasks.length);
  for (const t of tasks) {
    const script = m.run(t.id);
    if (typeof script !== 'string' || !script.length) throw new Error('任务 ' + t.id + ' 脚本为空');
    if (!script.includes('@@RESULT@@')) throw new Error('任务 ' + t.id + ' 缺少 @@RESULT@@ 协议标记');
  }
});

check('cleanup-scripts 可加载', () => {
  const c = require(abs('src/scripts-powershell/cleanup-scripts.js'));
  if (!c || !Object.keys(c).length) throw new Error('模块导出为空');
});

check('清理规则将 DISM ResetBase 标记为高风险', () => {
  const script = require(abs('src/scripts-powershell/cleanup-scripts.js'));
  const rules = script.rules();
  const all = (rules.groups || []).flatMap(g => [...(g.items || []), ...(g.subGroups || []).flatMap(s => s.items || [])]);
  const resetBase = all.find(item => JSON.stringify(item).includes('ResetBase'));
  if (!resetBase || resetBase.risk !== 'high') throw new Error('ResetBase 风险等级未收紧');
});

check('优化器输出失败协议', () => {
  const optimizer = require(abs('src/scripts-powershell/optimizer-scripts.js'));
  const option = optimizer.options ? optimizer.options()[0] : null;
  if (!option || !optimizer.buildScript) return;
  if (!optimizer.buildScript(option).includes('@@FAILED:')) throw new Error('缺少失败计数协议');
});

check('diag 模块生成四元组诊断', () => {
  const d = require(abs('src/main/diag.js'));
  const fn = d.jsDiag || d.diag || d.make;
  if (typeof fn !== 'function') throw new Error('未找到诊断生成函数，exports=' + Object.keys(d).join(','));
  const diag = fn('test.stage', 'none', 'boom');
  for (const key of ['failure_stage', 'mutation_state', 'diagnostic_digest', 'native_error_code']) {
    if (!(key in diag)) throw new Error('缺少字段 ' + key);
  }
});

check('网络测速仅在上传阶段结束后停止', () => {
  const detectorApi = require(abs('src/scripts/netspeed-detector.js'));
  const mib = 1024 * 1024;
  const detector = detectorApi.createUploadEndDetector();
  let result = detector.update({ time: 1000, elapsed: 4000, up: 0 });
  if (result.finish) throw new Error('下载与上传阶段间隙被误判为结束');
  result = detector.update({ time: 1800, elapsed: 4800, up: 20 * mib });
  if (!result.uploadStartedNow || result.finish) throw new Error('上传阶段识别异常');
  result = detector.update({ time: 2600, elapsed: 5600, up: 0.5 * mib });
  if (result.finish) throw new Error('上传单次掉速未经确认即结束');
  result = detector.update({ time: 3400, elapsed: 6400, up: 0.3 * mib });
  if (!result.finish || result.reason !== 'upload-drop') throw new Error('上传大幅掉速未触发结束');
  if (result.dropThreshold < 5 * mib || result.dropThreshold > 10 * mib) throw new Error('掉速阈值不在 5-10 MB/s 范围');
});

check('主窗口最小尺寸与标题栏颜色固定', () => {
  const mainSource = fs.readFileSync(abs('main.js'), 'utf8');
  // 行尾归一：Windows 工作区（core.autocrlf=true）下 CSS 为 CRLF，断言统一用 \n 匹配
  const css = fs.readFileSync(abs('src/styles/main.css'), 'utf8').replace(/\r\n/g, '\n');
  if (!mainSource.includes('MAIN_WINDOW_MIN_WIDTH = 1294') || !mainSource.includes('MAIN_WINDOW_MIN_HEIGHT = 870')) {
    throw new Error('主窗口最小尺寸不是 1294x870');
  }
  // v2.7.2：覆盖层完全透明（rgba(0,0,0,0)），按钮直接浮在 DOM/启动页内容上；
  // 旧固定色 #f7f8fb（及其前身 #F3F3F3）方案已废弃
  if (!mainSource.includes("color: 'rgba(0, 0, 0, 0)'") || !mainSource.includes("symbolColor: '#1A1A1A'")) {
    throw new Error('原生标题栏覆盖层颜色未固定');
  }
  if (!css.includes('body.electron-mica.win-maximized .main-content {\n  background: transparent;')) {
    throw new Error('最大化内容区仍会遮挡主题背景');
  }
});

// ==================== 4. PowerShell 脚本语法（AST 解析） ====================
console.log('[4/5] PowerShell AST 语法校验');
function psParseCheck(label, script) {
  const tmp = path.join(ROOT, '.tmp-ps-syntax-check.ps1');
  // 写入 BOM：powershell.exe 5.1 的 ParseFile 对无 BOM UTF-8 会按 ANSI 解码，
  // 中文字节会吞掉相邻引号导致误报语法错误（运行时使用 pwsh7，无此问题）。
  fs.writeFileSync(tmp, '\uFEFF' + script, 'utf8');
  try {
    const ps = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const out = execFileSync(ps, [
      '-NoProfile', '-NonInteractive', '-Command',
      '$e=$null;[System.Management.Automation.Language.Parser]::ParseFile(' +
      "'" + tmp.replace(/'/g, "''") + "'"+',[ref]$null,[ref]$e)|Out-Null;$e.Count'
    ], { encoding: 'utf8' });
    const count = parseInt(String(out).trim(), 10);
    if (count !== 0) throw new Error(label + ' 存在 ' + count + ' 个语法错误');
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

check('maintenance 全部任务脚本 PS 语法', () => {
  const m = require(abs('src/scripts-powershell/maintenance-scripts.js'));
  for (const t of m.list()) psParseCheck('maint.' + t.id, m.run(t.id));
});

// ---- v2.2 第1批（D5/D6/D14）：cleanup 三个 PS 脚本语法 + 双源一致 + 释放量实测口径 ----
const CLEANUP_PS_FILE = abs('src/scripts-powershell/cleanup-scripts.js');

// 抽取 PS 函数源码（按大括号配平）。Get-PathStats 体内字符串字面量不含花括号，
// 因此朴素计数即可稳定取到完整函数体，用于「两份模板逐字一致」断言。
function extractPsFunction(src, name) {
  const needle = 'function ' + name + ' {';
  const blocks = [];
  let i = src.indexOf(needle);
  while (i !== -1) {
    let depth = 0;
    let j = i + needle.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) throw new Error(name + ' 大括号未配平，无法抽取');
    blocks.push(src.slice(i, j + 1));
    i = src.indexOf(needle, j + 1);
  }
  return blocks;
}

let PS_EXE = null;
function psExe() {
  if (PS_EXE) return PS_EXE;
  const cands = [
    'pwsh',
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ];
  for (const c of cands) {
    try {
      execFileSync(c, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'pipe', timeout: 30000 });
      PS_EXE = c;
      return PS_EXE;
    } catch (e) { /* 试下一个 */ }
  }
  throw new Error('本机无可用 PowerShell（pwsh / powershell.exe 均不可用）');
}

// 临时脚本按 AGENTS.md 约定写 %APPDATA%\Trim\tmp\，不污染仓库
function writeTmpPs(script) {
  const dir = path.join(process.env.APPDATA || require('os').tmpdir(), 'Trim', 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'test-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.ps1');
  fs.writeFileSync(file, script, 'utf8');
  return file;
}

function runPs(script) {
  const file = writeTmpPs(script);
  try {
    return execFileSync(psExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    try { fs.unlinkSync(file); } catch (e) {}
  }
}

function psExitCode(err) {
  return err && typeof err.status === 'number' ? err.status : -1;
}

// execute 脚本末行是 ConvertTo-Json -Compress 的结果；诊断行以 @@ 前缀输出，按首个 '{' 行取
function lastJsonLine(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{')) return JSON.parse(lines[i]);
  }
  throw new Error('未找到 JSON 结果行：' + lines.slice(-3).join(' | '));
}

function flatRuleItems(rules) {
  const out = [];
  for (const g of (rules && rules.groups) || []) {
    if (g.subGroups) for (const sg of g.subGroups) out.push(...(sg.items || []));
    else out.push(...(g.items || []));
  }
  return out;
}

check('cleanup scan/execute/detail 脚本 PS 语法', () => {
  const c = require(CLEANUP_PS_FILE);
  const ids = flatRuleItems(c.rules()).slice(0, 8).map(x => x.id);
  psParseCheck('cleanup.scan', c.scan(ids, {}));
  psParseCheck('cleanup.execute', c.execute([{ id: '__probe__', name: 'probe', path: 'C:\\Windows\\Temp', risk: 'low' }], false, false));
  psParseCheck('cleanup.detail', c.detail(ids[0] || 'x', ''));
});

check('Get-PathStats / Get-PathSize 在 SCAN 与 EXECUTE 中逐字一致', () => {
  const src = fs.readFileSync(CLEANUP_PS_FILE, 'utf8');
  for (const name of ['Get-PathStats', 'Get-PathSize']) {
    const blocks = extractPsFunction(src, name);
    if (blocks.length !== 2) throw new Error(name + ' 应在 scan/execute 各一份，实际 ' + blocks.length + ' 份');
    if (blocks[0] !== blocks[1]) throw new Error(name + ' 两份模板文本不一致（统计口径漂移，D5/D6 结论会互相矛盾）');
  }
});

check('pathPs 释放量来自删除前后实测差值（D6/D14）', () => {
  const c = require(CLEANUP_PS_FILE);
  const ex = c.execute([{ id: 'x', name: 'x', path: 'C:\\Windows\\Temp', risk: 'low' }], false, false);
  for (const needle of [
    'function Resolve-RemoveOutcome',
    '$before = Get-PathStats -Path $Path',
    '$freed = [long]$Before.size - [long]$after.size',
    'if ($after.size -gt 0 -or $after.nfiles -gt 0)'
  ]) {
    if (!ex.includes(needle)) throw new Error('execute 缺少实测口径关键语句：' + needle);
  }
  if (/Recurse\s+-Depth\s+6/.test(ex)) throw new Error('execute 仍有第三次 -Depth 6 残留复查（D14 未闭环）');
  if (!ex.includes('$residual = [long]$result.residual')) throw new Error('execute 未复用 Remove-PathSafely 的残留计数（D14）');
});

check('统计失败与真 0 可区分、致命解析错误显式失败（D5）', () => {
  const c = require(CLEANUP_PS_FILE);
  const sc = c.scan([], {});
  const ex = c.execute([{ id: 'x', name: 'x', path: 'C:\\Windows\\Temp', risk: 'low' }], false, false);
  for (const [label, s] of [['scan', sc], ['execute', ex]]) {
    if (!s.includes('[System.IO.Directory]::EnumerateFileSystemEntries($Path)')) {
      throw new Error(label + ' 缺少根目录可枚举探针（无法区分权限失败与 0 字节）');
    }
    if (!/exit 2/.test(s)) throw new Error(label + ' 致命错误需 exit 2（主进程据此把 stderr 透出为 message）');
    if (!s.includes('[Console]::Error.WriteLine')) throw new Error(label + ' 致命错误须写 stderr（SilentlyContinue 下 Write-Error 不入 stderr）');
  }
  if (!sc.includes('$size = $null') || !sc.includes('if ($pathStats.ok)')) throw new Error('scan 未按三态上报 size');
  if (!sc.includes('if ($null -eq $rules)')) throw new Error('scan 缺少规则库解析致命守卫');
  if (!ex.includes('if ($null -eq $items)')) throw new Error('execute 缺少清理项致命守卫（禁止静默删 0 项报成功）');
  // 实测：PS 里 '[]' | ConvertFrom-Json 落变量同样是 $null，空清单与解析失败无从区分，
  // 故两条守卫必须合并成一条；再写 @($items).Count -eq 0 属于不可达死代码。
  if (!ex.includes('清理项不可用') || !ex.includes('拒绝执行')) throw new Error('execute 空清单守卫文案需同时覆盖「解析失败」与「清单为空」');
  if (ex.includes('if (@($items).Count -eq 0)')) throw new Error('execute 仍有不可达的空数组死守卫（PS 空数组解析后即为 $null）');
  if (!sc.includes('if ($null -eq $categories)')) throw new Error('scan 缺少分类参数致命守卫');
});

check('端到端：pathPs 删除按实测释放并清空目录', () => {
  const c = require(CLEANUP_PS_FILE);
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-d6-'));
  try {
    let total = 0;
    for (const [name, size] of [['a.tmp', 1000], ['b.tmp', 2000], ['c.tmp', 3000]]) {
      fs.writeFileSync(path.join(dir, name), Buffer.alloc(size, 0x61));
      total += size;
    }
    const script = c.execute([{ id: '__trim_d6_probe__', name: 'D6 探针', path: dir, risk: 'low' }], false, false);
    const data = lastJsonLine(runPs(script));
    const d = (data.details || [])[0];
    if (!d) throw new Error('未返回明细');
    if (d.status !== 'ok') throw new Error('探针应为 ok，实际 ' + d.status + ' / ' + d.message);
    if (Number(d.freed) !== total) throw new Error('释放量应为实测 ' + total + '，实际 ' + d.freed);
    if (Number(d.residual) !== 0) throw new Error('ok 项残留应为 0，实际 ' + d.residual);
    if (Number(data.totalFreed) !== total) throw new Error('汇总释放量与实测不符');
    if (fs.existsSync(dir)) throw new Error('探针目录未被删除');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('端到端：高风险门禁与不存在路径均为 skip 且不计释放（D6 门禁前置）', () => {
  const c = require(CLEANUP_PS_FILE);
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-gate-'));
  try {
    fs.writeFileSync(path.join(dir, 'keep.tmp'), Buffer.alloc(4096, 0x62));
    const items = [
      { id: '__probe_high__', name: '高风险未强制', path: dir, risk: 'high' },
      { id: '__probe_missing__', name: '路径不存在', path: path.join(dir, 'no-such-dir'), risk: 'low' }
    ];
    const data = lastJsonLine(runPs(c.execute(items, false, false)));
    const [hi, miss] = data.details || [];
    if (!hi || hi.status !== 'skip' || Number(hi.freed) !== 0) throw new Error('高风险未强制应为 skip/0，实际 ' + JSON.stringify(hi));
    if (!miss || miss.status !== 'skip') throw new Error('不存在路径应为 skip，实际 ' + JSON.stringify(miss));
    if (Number(data.totalFreed) !== 0) throw new Error('skip 项不得计入释放量');
    if (!fs.existsSync(path.join(dir, 'keep.tmp'))) throw new Error('skip 项被误删');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('端到端：空清理项以 exit 2 显式失败（D5）', () => {
  const c = require(CLEANUP_PS_FILE);
  try {
    runPs(c.execute([], false, false));
    throw new Error('空清单应被拒绝执行');
  } catch (e) {
    if (e && /空清单应被拒绝执行/.test(e.message)) throw e;
    if (psExitCode(e) !== 2) throw new Error('应返回退出码 2，实际 ' + psExitCode(e) + '：' + (e && e.message));
    if (!/拒绝执行/.test(String(e.stderr || ''))) throw new Error('stderr 缺少可读原因：' + String(e.stderr).slice(0, 200));
  }
});

// ---- v2.2 第2批（D1）：不可信规则字段的路径求值改走受限求值器 ----
check('全仓 PS 模板零 Invoke-Expression 调用（D1）', () => {
  // 规则 JSON（内置/在线更新/custom 目录）可被外部写入，字段里带 PS 代码即任意代码执行；
  // 注释里保留「为什么换掉它」的历史说明，故须先剔除整行注释再判定。
  const files = [
    'src/scripts-powershell/cleanup-scripts.js',
    'src/scripts-powershell/pathscan-scripts.js',
    'src/scripts-powershell/maintenance-scripts.js',
    'src/main/ps-rule-path-eval.js',
    'src/main/ps-protect-path.js',
    'main.js'
  ];
  for (const f of files) {
    const code = fs.readFileSync(abs(f), 'utf8').split(/\r?\n/)
      .filter((l) => !/^\s*(#|\/\/|\*)/.test(l)).join('\n');
    if (/\bInvoke-Expression\b/i.test(code)) throw new Error(f + ' 仍有 Invoke-Expression 调用');
  }
});

check('pathPs 求值同源注入受限求值器（D1）', () => {
  const { RULE_PATH_EVAL_PS } = require(abs('src/main/ps-rule-path-eval.js'));
  if (!RULE_PATH_EVAL_PS.includes('function Resolve-RulePath')) throw new Error('共享求值器模块未导出函数文本');
  const c = require(CLEANUP_PS_FILE);
  const sc = c.scan([], {});
  const de = c.detail('x', '');
  for (const [label, s] of [['cleanup.scan', sc], ['cleanup.detail', de]]) {
    if (!s.includes('function Resolve-RulePath')) throw new Error(label + ' 未注入受限求值器');
    if (!/Resolve-RulePath -Expr/.test(s)) throw new Error(label + ' 求值点未改走受限求值器');
  }
  const ps = fs.readFileSync(abs('src/scripts-powershell/pathscan-scripts.js'), 'utf8');
  if (!ps.includes("require('../main/ps-rule-path-eval')")) throw new Error('pathscan 未共用同一求值器模块（双源漂移）');
  if (!ps.includes('${RULE_PATH_EVAL_PS}')) throw new Error('pathscan 未注入求值器文本');
});

check('端到端：受限求值器拒绝表达式注入且放行合法式（D1）', () => {
  const { RULE_PATH_EVAL_PS } = require(abs('src/main/ps-rule-path-eval.js'));
  const evil = [
    "''; Remove-Item C:\\ -Recurse #",
    '$(Get-ChildItem C:\\)',
    '${env:windir}',
    '"$env:windir\\Temp"',
    '(Get-Item C:\\).FullName',
    '$env:windir & calc.exe',
    '$env:windir; exit 0',
    '[IO.File]::Delete("C:\\x")',
    '$env:TEMP ` + $env:TEMP',
    'Get-Location',
    '$env:',
    '$env:windir + (1+1)'
  ];
  const good = ['$env:TEMP', "$env:LOCALAPPDATA + '\\Dism++Backup'", "'C:\\$Recycle.Bin'", "'C:\\Users'"];
  const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const ps = "$ErrorActionPreference = 'Stop'\n" + RULE_PATH_EVAL_PS + '\n' +
    '$bad = @(' + evil.map(lit).join(',') + ')\n' +
    '$good = @(' + good.map(lit).join(',') + ')\n' +
    "$r = @(foreach ($e in $bad) { if ((Resolve-RulePath -Expr $e).ok) { 1 } else { 0 } })\n" +
    "$r += @(foreach ($e in $good) { if ((Resolve-RulePath -Expr $e).ok) { 1 } else { 0 } })\n" +
    "$r -join ','\n";
  const line = String(runPs(ps)).trim().split(/\r?\n/).pop();
  if (!/^[\d,]+$/.test(line)) throw new Error('求值器输出不可解析：' + line.slice(0, 120));
  const flags = line.split(',').map(Number);
  if (flags.length !== evil.length + good.length) throw new Error('对拍条数不符');
  const leaked = evil.filter((e, i) => flags[i] === 1);
  if (leaked.length) throw new Error('注入表达式被放行：' + leaked.join(' | '));
  const blocked = good.filter((g, i) => flags[evil.length + i] !== 1);
  if (blocked.length) throw new Error('合法内置表达式被误拒（文法回退）：' + blocked.join(' | '));
});

// ---- v2.2 第2批（D18）：受保护路径前置硬校验 ----
check('保护清单单一来源且双语义正确（D18）', () => {
  const P = require(abs('src/main/ps-protect-path.js'));
  const roots = P.protectedRoots();
  for (const k of ['subtree', 'exact', 'anyDrive']) {
    if (!Array.isArray(roots[k])) throw new Error('清单缺字段 ' + k);
  }
  if (!roots.subtree.includes(path.join(process.env.APPDATA, 'Trim').toLowerCase())) {
    throw new Error('自身数据目录 %APPDATA%\\Trim 未在 subtree 清单');
  }
  if (!roots.anyDrive.includes('system volume information')) {
    throw new Error('System Volume Information 未走 anyDrive（其他分区将不设防）');
  }
  const home = process.env.USERPROFILE;
  const mustReject = [
    '', process.env.WINDIR, 'C:\\', 'c:', process.env.PROGRAMDATA,
    home, path.dirname(home), process.env.APPDATA, process.env.LOCALAPPDATA,
    'C:\\PROGRA~1', 'D:\\System Volume Information\\{x}\\blob',
    path.join(process.env.WINDIR, 'System32', 'config', 'SAM'),
    '\\\\?\\' + process.env.WINDIR
  ];
  const leaks = mustReject.filter((p) => !P.isPathProtected(p));
  if (leaks.length) throw new Error('应拒未拒：' + leaks.join(' | '));
  const mustAllow = [
    path.join(process.env.WINDIR, 'Temp'), path.join(process.env.WINDIR, 'Prefetch'),
    path.join(process.env.LOCALAPPDATA, 'Temp'),
    path.join(home, 'Documents', 'xwechat_files', 'a', 'temp'),
    path.join(process.env.APPDATA, 'Tencent', 'QQ')
  ];
  const over = mustAllow.filter((p) => P.isPathProtected(p));
  if (over.length) throw new Error('应放被误拒（subtree 过宽回潮）：' + over.join(' | '));
  // 刻意决策：内置 recycleBin 规则的 pathPs 就是 C:\$Recycle.Bin，收录等于砍掉用户可见功能。
  // 若后续 D19 改用 Clear-RecycleBin / 逐 SID 子目录，需连同本断言一并改判。
  if (P.isPathProtected('C:\\$Recycle.Bin')) {
    throw new Error('$Recycle.Bin 已改判受保护：需同步改写 recycleBin 规则与本断言');
  }
});

check('删除面全部前置保护闸（D18）', () => {
  const src = fs.readFileSync(CLEANUP_PS_FILE, 'utf8');
  if (!src.includes("require('../main/ps-protect-path')")) throw new Error('cleanup 未共用保护清单模块');
  const c = require(CLEANUP_PS_FILE);
  const ex = c.execute([{ id: 'x', name: 'x', path: 'C:\\x', risk: 'low' }], false, false);
  if (!ex.includes('function Test-PathProtected')) throw new Error('execute 未注入保护判定函数');
  if (!ex.includes('if ($null -eq $tfProtectedRoots)')) throw new Error('清单解析失败未显式退出（静默放行等于没闸）');
  if (/\$\{PROTECTED_JSON_PLACEHOLDER\}/.test(ex)) throw new Error('保护清单占位符未被替换');
  const gates = (ex.match(/Test-PathProtected -Path/g) || []).length;
  if (gates < 4) throw new Error('execute 保护闸不足（永久删除/回收站/fileKeys/空目录剪枝），实际 ' + gates);
  // 汇聚点 Remove-PathSafely 的入口闸必须先于任何删除动作
  const block = extractPsFunction(src, 'Remove-PathSafely');
  if (block.length !== 1) throw new Error('Remove-PathSafely 应恰好一份，实际 ' + block.length);
  const gi = block[0].indexOf('Test-PathProtected');
  const ri = block[0].indexOf('Remove-Item');
  if (gi < 0 || ri < 0 || gi > ri) throw new Error('Remove-PathSafely 入口未先于删除动作挂闸');
  // 主进程统一删除出口同样须判（历史上只在两个调用点各判一次）
  const mjs = fs.readFileSync(abs('main.js'), 'utf8');
  if (!mjs.includes("require('./src/main/ps-protect-path')")) throw new Error('main.js 未走共享清单');
  if (/PROTECTED_DELETE_ROOTS/.test(mjs)) throw new Error('main.js 仍有本地清单副本（双源漂移）');
  const tail = mjs.slice(mjs.indexOf('async function trashOrUnlink'));
  if (!/isProtectedDeletePath\(target\)/.test(tail.slice(0, 900))) throw new Error('trashOrUnlink 未前置保护判定');
});

check('端到端：EXECUTE 拒绝受保护路径（永久/回收站两模式）（D18）', () => {
  const c = require(CLEANUP_PS_FILE);
  const win = process.env.WINDIR || 'C:\\Windows';
  for (const recycle of [false, true]) {
    const data = lastJsonLine(runPs(c.execute([{ id: '__trim_d18__', name: 'D18 探针', path: win, risk: 'low' }], true, recycle)));
    const d = (data.details || [])[0];
    if (!d || d.status !== 'error' || !/受保护路径/.test(String(d.message))) {
      throw new Error((recycle ? '回收站' : '永久') + '模式未拒绝受保护路径：' + JSON.stringify(d));
    }
    if (Number(data.totalFreed) !== 0) throw new Error('保护闸拒绝后不得计入释放量');
  }
});

check('保护判定 JS/PS 同口径对拍（D18）', () => {
  const P = require(abs('src/main/ps-protect-path.js'));
  const home = process.env.USERPROFILE;
  const vectors = [
    process.env.WINDIR, path.join(process.env.WINDIR, 'Temp'), 'C:\\', 'c:', 'C:\\PROGRA~1',
    home, path.join(home, 'Documents'), process.env.APPDATA, process.env.LOCALAPPDATA,
    'D:\\System Volume Information', 'C:\\$Recycle.Bin',
    path.join(process.env.WINDIR, 'System32', 'config'),
    '\\\\?\\' + process.env.WINDIR, path.join(process.env.WINDIR, '..') + '\\Windows'
  ];
  const jsFlags = vectors.map((v) => (P.isPathProtected(v) ? 1 : 0));
  const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const rootsLit = "'" + P.protectedRootsJson().replace(/'/g, "''") + "'";
  const ps = "$ErrorActionPreference = 'Stop'\n" + P.PROTECT_PATH_PS + '\n' +
    '$roots = ConvertFrom-Json -InputObject ' + rootsLit + '\n' +
    'if ($null -eq $roots) { exit 2 }' + '\n' +
    '$paths = @(' + vectors.map(lit).join(',') + ')\n' +
    "$out = @(foreach ($p in $paths) { if (Test-PathProtected -Path $p -Roots $roots) { 1 } else { 0 } })\n" +
    "$out -join ','\n";
  const line = String(runPs(ps)).trim().split(/\r?\n/).pop();
  if (!/^[\d,]+$/.test(line)) throw new Error('PS 判定输出不可解析：' + line.slice(0, 120));
  const psFlags = line.split(',').map(Number);
  if (psFlags.length !== jsFlags.length) throw new Error('条数不符 js=' + jsFlags.length + ' ps=' + psFlags.length);
  const diffs = jsFlags.map((v, i) => (v === psFlags[i] ? null : vectors[i] + ' js=' + v + ' ps=' + psFlags[i])).filter(Boolean);
  if (diffs.length) throw new Error('两侧口径分歧：' + diffs.join(' | '));
});

// FD-2（2026-09-15）：JS/Rust 双层保护清单三端同源——Rust is_protected_path 用主进程
// 注入的 protectedRootsJson()，判定语义须与 JS isPathProtected 逐字一致。此前 Rust
// 各自硬编码：C:\Windows / Program Files / ProgramData / C:\$Recycle.Bin 过度拦截
// （制造 FD-1 假失败），%APPDATA%\Trim 反向漏防。本断言喂同一批向量到 JS 与
// finder.exe `protectcheck --protect <json>`，两侧 0/1 必须完全一致。
check('保护判定 JS/Rust 同口径对拍（FD-2）', () => {
  const P = require(abs('src/main/ps-protect-path.js'));
  const exe = path.join(__dirname, 'native-scanner', 'target', 'release', 'finder.exe');
  if (!fs.existsSync(exe)) throw new Error('缺少 finder.exe，请先 cargo build --release');
  const home = process.env.USERPROFILE;
  const vectors = [
    process.env.WINDIR, path.join(process.env.WINDIR, 'Temp'), 'C:\\', 'c:', 'C:\\PROGRA~1',
    home, path.join(home, 'Documents'), process.env.APPDATA, process.env.LOCALAPPDATA,
    'D:\\System Volume Information', path.join(process.env.APPDATA, 'Trim'),
    path.join(process.env.WINDIR, 'System32', 'config'),
    path.join(process.env.USERPROFILE, 'Downloads', 'cleanup-test.dat'),
    '\\\\?\\' + process.env.WINDIR, '\\\\server\\share\\foo.dat'
  ];
  const jsFlags = vectors.map((v) => (P.isPathProtected(v) ? 1 : 0));
  const { spawnSync } = require('child_process');
  const rs = spawnSync(exe, ['protectcheck', '--protect', P.protectedRootsJson(), ...vectors],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (rs.status !== 0) throw new Error('Rust protectcheck 退出码 ' + rs.status + ': ' + String(rs.stderr).slice(0, 150));
  const line = String(rs.stdout || '').trim().split(/\r?\n/).pop() || '';
  if (!/^[01,]+$/.test(line)) throw new Error('Rust 判定输出不可解析：' + line.slice(0, 120));
  const rustFlags = line.split(',').map(Number);
  if (rustFlags.length !== jsFlags.length) throw new Error('条数不符 js=' + jsFlags.length + ' rust=' + rustFlags.length);
  const diffs = jsFlags.map((v, i) => (v === rustFlags[i] ? null : vectors[i] + ' js=' + v + ' rust=' + rustFlags[i])).filter(Boolean);
  if (diffs.length) throw new Error('JS/Rust 两侧口径分歧：' + diffs.join(' | '));
});

// ---- v2.2 第3批（D2/D4）：删除粒度下沉 contents + 注册表删除前 .reg 备份 ----
check('pathPs 条目 deleteMode 声明齐全（D2）', () => {
  const rules = JSON.parse(fs.readFileSync(abs('src/data/cleanup-rules.json'), 'utf8'));
  const backupIds = new Set(['dismPlusOld', 'chromeOldBackup', 'wpsOldBackup']);
  const items = flatRuleItems(rules);
  const pathPs = items.filter(i => i.pathPs);
  // 2026-09-14：45 → 48（新增 cbsLogs / dismLogs / printSpoolCache）→ 47
  // （printSpoolCache 为支持 restartProcesses 改走 fileKeys 型，不再计入 pathPs）
  if (pathPs.length !== 47) throw new Error('pathPs 条目数应为 47，实际 ' + pathPs.length);
  const missing = pathPs.filter(i => !backupIds.has(i.id) && i.deleteMode !== 'contents').map(i => i.id);
  if (missing.length) throw new Error('非备份类 pathPs 缺 deleteMode=contents：' + missing.join(', '));
  const leaked = pathPs.filter(i => backupIds.has(i.id) && i.deleteMode).map(i => i.id);
  if (leaked.length) throw new Error('备份类不应有 deleteMode（整目录删语义）：' + leaked.join(', '));
});

check('EXECUTE 含 contents 分支且调用点传 Mode（D2）', () => {
  const c = require(CLEANUP_PS_FILE);
  const ex = c.execute([{ id: 'x', name: 'x', path: 'C:\\Windows\\Temp', risk: 'low' }], false, false);
  for (const needle of [
    "[string]$Mode = 'tree'",
    "$Mode -eq 'contents'",
    '已清空目录内容',
    '-Mode ([string]$rule.deleteMode)',
    'Test-PathProtected -Path $child.FullName'
  ]) {
    if (!ex.includes(needle)) throw new Error('execute 缺少 contents 关键语句：' + needle);
  }
});

check('端到端：contents 只删内容保留目录（D2）', () => {
  const c = require(CLEANUP_PS_FILE);
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trim-d2-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.tmp'), Buffer.alloc(1000, 0x61));
    fs.writeFileSync(path.join(dir, 'sub', 'b.tmp'), Buffer.alloc(2000, 0x62));
    fs.writeFileSync(path.join(dir, '.hidden'), Buffer.alloc(500, 0x63));
    // 借用内置 windowsLogs 的 deleteMode=contents 声明，路径覆盖为测试目录（不碰用户数据）
    const script = c.execute([{ id: 'windowsLogs', name: 'D2 探针', path: dir, risk: 'low' }], false, false);
    const data = lastJsonLine(runPs(script));
    const d = (data.details || [])[0];
    if (!d || d.status !== 'ok') throw new Error('contents 探针应为 ok，实际 ' + JSON.stringify(d));
    if (Number(d.freed) !== 3500) throw new Error('释放量应为实测 3500，实际 ' + d.freed);
    if (Number(d.residual) !== 0) throw new Error('contents ok 项残留应为 0，实际 ' + d.residual);
    if (!fs.existsSync(dir)) throw new Error('contents 语义下目录不应被整删');
    if (fs.readdirSync(dir).length !== 0) throw new Error('目录内容未清空');
    if (Number(data.totalFreed) !== 3500) throw new Error('汇总释放量与实测不符');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('EXECUTE 注册表删除前必有备份且 fail-closed（D4）', () => {
  const c = require(CLEANUP_PS_FILE);
  const ex = c.execute([{ id: 'x', name: 'x', path: 'C:\\Windows\\Temp', risk: 'low' }], false, false);
  for (const needle of [
    'function Convert-RegPathForExport',
    'reg.exe export',
    '注册表备份失败，未执行删除',
    'cleanup-reg-backup',
    '$backupFailed = $true'
  ]) {
    if (!ex.includes(needle)) throw new Error('execute 缺少备份关键语句：' + needle);
  }
  // 备份收集必须先于删除循环（先全备份、后统一删除，任何失败整条规则不删）
  const bf = ex.indexOf('$backupFiles += $file');
  const del = ex.indexOf('$okCount = 0; $regFail = 0');
  if (bf < 0 || del < 0 || bf > del) throw new Error('备份必须先于删除循环');
});

check('Convert-RegPathForExport 反向归一化正确（D4）', () => {
  const src = fs.readFileSync(CLEANUP_PS_FILE, 'utf8');
  const fn = extractPsFunction(src, 'Convert-RegPathForExport');
  if (fn.length !== 1) throw new Error('Convert-RegPathForExport 应恰好一份，实际 ' + fn.length);
  const vectors = [
    'Registry::HKEY_CURRENT_USER\\Software\\X', 'HKCU\\Software\\X',
    'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Y', 'HKLM\\SOFTWARE\\Y',
    'Registry::HKEY_CLASSES_ROOT\\Z', 'HKCR\\Z'
  ];
  const expected = ['HKCU\\Software\\X', 'HKCU\\Software\\X', 'HKLM\\SOFTWARE\\Y', 'HKLM\\SOFTWARE\\Y', 'HKCR\\Z', 'HKCR\\Z'];
  const lit = s => "'" + String(s).replace(/'/g, "''") + "'";
  const ps = "$ErrorActionPreference='Stop'\n" + fn[0] + '\n' +
    '$in = @(' + vectors.map(lit).join(',') + ')\n' +
    "$out = @(foreach ($p in $in) { Convert-RegPathForExport $p })\n" +
    "$out -join '|'\n";
  const line = String(runPs(ps)).trim().split(/\r?\n/).pop();
  const got = line.split('|');
  if (got.length !== expected.length) throw new Error('输出条数不符：' + line.slice(0, 160));
  const diffs = got.map((v, i) => (v === expected[i] ? null : vectors[i] + ' -> ' + v + ' ≠ ' + expected[i])).filter(Boolean);
  if (diffs.length) throw new Error('归一化分歧：' + diffs.join(' | '));
});

check('端到端：reg.exe 备份链路成功导出且失败键 fail-closed（D4）', () => {
  const src = fs.readFileSync(CLEANUP_PS_FILE, 'utf8');
  const fn = extractPsFunction(src, 'Convert-RegPathForExport');
  // L2：测试键集中到 HKCU\Software\Trim\selftest\ 测试命名空间，启动时先清扫上次残留
  // （进程被杀场景），不再触碰真实用户键，满足测试卫生（审查规范 05 第四节）
  const selfTestRoot = 'HKCU\\Software\\Trim\\selftest';
  const testKey = selfTestRoot + '\\Trim_D4_Test_' + Date.now();
  const tmpDir = path.join(require('os').tmpdir(), 'trim-d4-test-' + Date.now());
  const ps =
    "$ErrorActionPreference='SilentlyContinue'\n" + fn[0] + '\n' +
    "Get-ChildItem -Path 'HKCU:\\Software\\Trim\\selftest' -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.PSChildName -like 'Trim_D4_Test_*' } | ForEach-Object { " +
    "reg.exe delete ('HKCU\\Software\\Trim\\selftest\\' + $_.PSChildName) /f 2>&1 | Out-Null }\n" +
    "reg.exe add '" + testKey + "' /v t /d 1 /f | Out-Null\n" +
    "New-Item -ItemType Directory -Path '" + tmpDir + "' -Force | Out-Null\n" +
    "$file = Join-Path '" + tmpDir + "' 'backup.reg'\n" +
    "& reg.exe export (Convert-RegPathForExport 'Registry::" + testKey + "') $file /y 2>&1 | Out-Null\n" +
    '$ok = ($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath $file)\n' +
    "& reg.exe export 'HKCU\\Software\\Trim_D4_No_Such_Key' (Join-Path '" + tmpDir + "' 'nope.reg') /y 2>&1 | Out-Null\n" +
    '$fail = ($LASTEXITCODE -ne 0) -or (-not (Test-Path -LiteralPath (Join-Path ' + "'" + tmpDir + "'" + ' "nope.reg")))\n' +
    "reg.exe delete '" + testKey + "' /f | Out-Null\n" +
    "$hasKey = (Select-String -LiteralPath $file -Pattern 'Trim_D4_Test' -Quiet)\n" +
    "[pscustomobject]@{ ok=[int]$ok; fail=[int]$fail; hasKey=[int]$hasKey } | ConvertTo-Json -Compress\n";
  try {
    const out = String(runPs(ps)).trim().split(/\r?\n/).pop();
    const r = JSON.parse(out);
    if (r.ok !== 1 || r.fail !== 1 || r.hasKey !== 1) throw new Error('备份链路结果异常：' + out);
  } finally {
    try { execFileSync('reg', ['delete', testKey, '/f'], { stdio: 'ignore' }); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// ---- v2.2 第3批（D7/D13）：可删性探测 + 两阶段计划驱动（扫描产清单、执行只消费清单）----
const FASTSIZE_DLL = abs('scripts/TrimFastSize.dll');
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

check('TrimFastSize.cs ListDeletable 源码形态（D7）', () => {
  const src = fs.readFileSync(abs('scripts/TrimFastSize.cs'), 'utf8');
  for (const needle of [
    'public static DeletableResult ListDeletable',
    'FileShare.None',
    'public long TotalCount',
    'public sealed class FastFileInfo'
  ]) {
    if (!src.includes(needle)) throw new Error('缺少 ' + needle);
  }
});

check('端到端：DLL ListDeletable 剔除被占用文件（D7）', () => {
  if (!fs.existsSync(FASTSIZE_DLL)) throw new Error('TrimFastSize.dll 未构建，请运行 scripts/build-fastsize.ps1');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trim-d7-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.tmp'), Buffer.alloc(1000, 0x61));
    fs.writeFileSync(path.join(dir, 'b.tmp'), Buffer.alloc(2000, 0x62));
    fs.writeFileSync(path.join(dir, 'c.tmp'), Buffer.alloc(3000, 0x63));
    // 进程内以 FileShare.None 持住 c.tmp——独占句柄使一切新打开（含删除）失败
    const ps =
      "$ErrorActionPreference = 'Stop'\n" +
      'Add-Type -Path ' + lit(FASTSIZE_DLL) + '\n' +
      '$dir = ' + lit(dir) + '\n' +
      "$h = [System.IO.File]::Open((Join-Path $dir 'c.tmp'), 'Open', 'Read', 'None')\n" +
      "$r = [TrimFastSize]::ListDeletable($dir, '*')\n" +
      "$paths = @($r.Files | ForEach-Object { [string]$_.Path })\n" +
      '$sum = 0L; foreach ($f in @($r.Files)) { $sum += [long]$f.Size }\n' +
      '$h.Dispose()\n' +
      "[pscustomobject]@{ n=[int]@($r.Files).Count; total=[long]$r.TotalCount; sum=$sum; " +
      'hasLocked=[int]([bool]($paths -contains (Join-Path $dir \'c.tmp\'))); ' +
      'hasA=[int]([bool]($paths -contains (Join-Path $dir \'a.tmp\'))) } | ConvertTo-Json -Compress\n';
    const r = lastJsonLine(runPs(ps));
    if (r.n !== 2 || r.total !== 3) throw new Error('可删/总数应为 2/3，实际 ' + r.n + '/' + r.total);
    if (r.sum !== 3000) throw new Error('可删字节应为 3000，实际 ' + r.sum);
    if (r.hasLocked !== 0 || r.hasA !== 1) throw new Error('清单错配：被占用文件混入或可删文件缺失');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('端到端：DLL ListDeletable 单文件/被占单文件/不存在路径（D7）', () => {
  if (!fs.existsSync(FASTSIZE_DLL)) throw new Error('TrimFastSize.dll 未构建');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trim-d7f-'));
  try {
    const f1 = path.join(dir, 'f1.tmp');
    const lock1 = path.join(dir, 'lock1.tmp');
    fs.writeFileSync(f1, Buffer.alloc(500, 0x61));
    fs.writeFileSync(lock1, Buffer.alloc(700, 0x62));
    const ps =
      "$ErrorActionPreference = 'Stop'\n" +
      'Add-Type -Path ' + lit(FASTSIZE_DLL) + '\n' +
      '$f1 = ' + lit(f1) + '\n$lock1 = ' + lit(lock1) + '\n$miss = ' + lit(path.join(dir, 'no-such.tmp')) + '\n' +
      "$h = [System.IO.File]::Open($lock1, 'Open', 'Read', 'None')\n" +
      '$rFile = [TrimFastSize]::ListDeletable($f1, "*")\n' +
      '$rLock = [TrimFastSize]::ListDeletable($lock1, "*")\n' +
      '$rMiss = [TrimFastSize]::ListDeletable($miss, "*")\n' +
      '$h.Dispose()\n' +
      "[pscustomobject]@{ " +
      'fileN=[int]@($rFile.Files).Count; fileTotal=[long]$rFile.TotalCount; fileSize=([long]@($rFile.Files)[0].Size); ' +
      'lockN=[int]@($rLock.Files).Count; lockTotal=[long]$rLock.TotalCount; ' +
      'missN=[int]@($rMiss.Files).Count; missTotal=[long]$rMiss.TotalCount } | ConvertTo-Json -Compress\n';
    const r = lastJsonLine(runPs(ps));
    if (r.fileN !== 1 || r.fileTotal !== 1 || r.fileSize !== 500) throw new Error('单文件模式异常：' + JSON.stringify(r));
    if (r.lockN !== 0 || r.lockTotal !== 1) throw new Error('被占单文件应 TotalCount=1 且 Files 为空');
    if (r.missN !== 0 || r.missTotal !== 0) throw new Error('不存在路径应全空');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('SCAN 含可删性探测与 @@PLANFILE@@ 协议（D7/D13 静态）', () => {
  const src = fs.readFileSync(CLEANUP_PS_FILE, 'utf8');
  for (const needle of [
    'function Test-FileDeletable',
    'FileShare.None',
    'function Get-FileKeyDeletable',
    'function Get-PathDeletableStats',
    'Get-FileKeyDeletable -Rule $rule',
    'Get-PathDeletableStats -Path $path',
    "lockedCount = $st.locked",
    "lockedCount = $pathStats.locked",
    'function Test-FileDeletable'
  ]) {
    if (!src.includes(needle)) throw new Error('SCAN 缺少 ' + needle);
  }
  const sc = require(CLEANUP_PS_FILE).scan([], {});
  if (!sc.includes('@@PLANFILE@@')) throw new Error('scan 模板未输出计划文件行');
  if (!sc.includes('function Get-FileKeyDeletable')) throw new Error('scan 模板未注入可删性探测函数');
});

check('端到端：SCAN fileKeys 产 @@PLANFILE@@ 且行数=fileCount（D7/D13）', () => {
  const c = require(CLEANUP_PS_FILE);
  c.setFastSizeDll(FASTSIZE_DLL);
  try {
    const out = String(runPs(c.scan(['iconCacheFiles'], {})));
    const items = [];
    const plans = [];
    for (const raw of out.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('@@ITEM@@')) items.push(JSON.parse(line.slice(8)));
      else if (line.startsWith('@@PLANFILE@@')) plans.push(JSON.parse(line.slice(12)));
    }
    const item = items.find(x => x.id === 'iconCacheFiles');
    if (!item) throw new Error('iconCacheFiles 未被扫描输出');
    if (!('lockedCount' in item) || !('fileCount' in item)) throw new Error('扫描条目缺 lockedCount/fileCount');
    const mine = plans.filter(p => p.id === 'iconCacheFiles');
    if (mine.length !== Number(item.fileCount)) throw new Error('@@PLANFILE@@ 行数 ' + mine.length + ' ≠ fileCount ' + item.fileCount);
    const base = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Explorer').toLowerCase();
    for (const p of mine) {
      if (typeof p.path !== 'string' || !p.path.length) throw new Error('计划文件缺路径');
      if (typeof p.size !== 'number' || p.size < 0) throw new Error('计划文件 size 异常');
      if (!p.path.toLowerCase().startsWith(base)) throw new Error('计划文件越界: ' + p.path);
    }
  } finally {
    c.setFastSizeDll('');
  }
});

check('EXECUTE fileKeys 计划驱动且删除前不重枚举（D13 静态）', () => {
  const c = require(CLEANUP_PS_FILE);
  const ex = c.execute([{ id: 'x', name: 'x', path: 'C:\\Windows\\Temp', risk: 'low' }], false, false);
  for (const needle of [
    '$planFiles = @($item.files)',
    '无可清理文件',
    'if ($p -and $seen.Add($p))',
    'Remove-Item -LiteralPath $p -Force -ErrorAction Stop',
    '$alreadyGone++',
    '待移入回收站'
  ]) {
    if (!ex.includes(needle)) throw new Error('execute 缺少 ' + needle);
  }
  const planI = ex.indexOf('$planFiles = @($item.files)');
  const loopI = ex.indexOf('foreach ($pf in $unique)');
  const residI = ex.indexOf('$residual = @(Get-FileKeySnapshot');
  if (planI < 0 || loopI < 0 || residI < 0) throw new Error('计划驱动关键锚点缺失');
  if (residI < loopI) throw new Error('残留复查必须在删除循环之后（执行期不再有删除前重枚举）');
  if (ex.slice(planI, loopI).includes('Get-FileKeySnapshot')) throw new Error('删除前存在重枚举（TOCTOU 未根治）');
});

check('端到端：EXECUTE 只删计划清单，扫描后新增文件不删（D13 TOCTOU）', () => {
  const c = require(CLEANUP_PS_FILE);
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-d13-'));
  try {
    const a = path.join(dir, 'a.tmp');
    const b = path.join(dir, 'b.tmp');
    fs.writeFileSync(a, Buffer.alloc(1000, 0x61));
    fs.writeFileSync(b, Buffer.alloc(2000, 0x62));
    // 模拟扫描快照：清单只有 a/b；扫描之后、执行之前出现的新文件 fresh 不在清单内
    const item = { id: 'pipCache', name: 'D13 探针', path: dir, risk: 'low', files: [{ path: a, size: 1000 }, { path: b, size: 2000 }] };
    const fresh = path.join(dir, 'fresh.tmp');
    fs.writeFileSync(fresh, Buffer.alloc(5000, 0x64));
    const data = lastJsonLine(runPs(c.execute([item], false, false)));
    const d = (data.details || [])[0];
    if (!d || d.status !== 'ok') throw new Error('计划驱动应 ok，实际 ' + JSON.stringify(d));
    if (Number(d.freed) !== 3000) throw new Error('释放量应为计划内 3000，实际 ' + d.freed);
    if (fs.existsSync(a) || fs.existsSync(b)) throw new Error('计划内文件未被删除');
    if (!fs.existsSync(fresh)) throw new Error('TOCTOU：扫描后新增文件被误删');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('端到端：EXECUTE 计划内被占用文件如实 partial 且不冒领（D7）', () => {
  const c = require(CLEANUP_PS_FILE);
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-d7x-'));
  try {
    const a = path.join(dir, 'a.tmp');
    const lock = path.join(dir, 'lock.tmp');
    fs.writeFileSync(a, Buffer.alloc(1000, 0x61));
    fs.writeFileSync(lock, Buffer.alloc(4000, 0x62));
    const ex = c.execute([{ id: 'pipCache', name: 'D7 探针', path: dir, risk: 'low', files: [{ path: a, size: 1000 }, { path: lock, size: 4000 }] }], false, false);
    // 同一进程先以 FileShare.None 持住 lock.tmp，再内联执行完整 execute 脚本
    const wrapped = "$ErrorActionPreference = 'SilentlyContinue'\n" +
      '$h = [System.IO.File]::Open(' + lit(lock) + ", 'Open', 'Read', 'None')\n" +
      ex + '\n$h.Dispose()\n';
    const data = lastJsonLine(runPs(wrapped));
    const d = (data.details || [])[0];
    if (!d || d.status !== 'partial') throw new Error('应 partial（1 删 1 占用），实际 ' + JSON.stringify(d));
    if (Number(d.freed) !== 1000) throw new Error('释放量不得冒领被占用文件的 4000，实际 ' + d.freed);
    if (fs.existsSync(a)) throw new Error('可删文件未被删除');
    if (!fs.existsSync(lock)) throw new Error('被占用文件不应被删除');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('端到端：回收站模式只发计划内且仍存在的文件（D13）', () => {
  const c = require(CLEANUP_PS_FILE);
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-d13r-'));
  try {
    const a = path.join(dir, 'a.tmp');
    fs.writeFileSync(a, Buffer.alloc(1000, 0x61));
    const gone = path.join(dir, 'gone.tmp'); // 扫描后已消失，仍留在计划清单里
    const item = { id: 'pipCache', name: 'D13 回收站探针', path: dir, risk: 'low', files: [{ path: a, size: 1000 }, { path: gone, size: 2000 }] };
    const out = String(runPs(c.execute([item], false, true)));
    const recs = [];
    let summary = null;
    for (const raw of out.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('@@RECYCLE@@')) recs.push(JSON.parse(line.slice(11)));
      else if (line.startsWith('{')) summary = JSON.parse(line);
    }
    if (recs.length !== 1 || recs[0].path !== a || recs[0].size !== 1000 || recs[0].isDir !== false) {
      throw new Error('回收站应只发计划内仍存在的 1 个文件：' + JSON.stringify(recs));
    }
    const d = ((summary && summary.details) || [])[0];
    if (!d || d.status !== 'recycle' || Number(d.freed) !== 1000) throw new Error('recycle 明细异常：' + JSON.stringify(d));
    if (!fs.existsSync(a)) throw new Error('回收站模式 PS 不应实际删除文件（主进程负责移入）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('main.js 快照聚合 @@PLANFILE@@ 且有防呆上限（D13 静态）', () => {
  const mjs = fs.readFileSync(abs('main.js'), 'utf8');
  for (const needle of [
    'const PLAN_CAP_PER_ITEM = 100000',
    'const PLAN_CAP_TOTAL = 1000000',
    "line.startsWith('@@PLANFILE@@')",
    'item.files = pf || []',
    'planTruncated',
    'filesTruncated'
  ]) {
    if (!mjs.includes(needle)) throw new Error('main.js 缺少 ' + needle);
  }
});

check('main.js fileKeys 明细优先读扫描快照（D13 静态）', () => {
  const mjs = fs.readFileSync(abs('main.js'), 'utf8');
  const start = mjs.indexOf("handleSafe('cleanup:item-detail'");
  const seg = mjs.slice(start, start + 2000);
  if (!seg.includes('known.files')) throw new Error('明细未读快照 files');
  if (!seg.includes('const cap = 600')) throw new Error('明细快照缺 cap 600');
  if (!seg.includes("kind: 'files'")) throw new Error('明细快照缺 kind 标记');
});

// ---- v2.2 第4批（D8/D9）：autoRebuild 传参重建 + detect 无声明时退化为路径存在判定 ----
check('D8：execute 传 autoRebuild，Remove-PathSafely 收口重建分支（D8 静态）', () => {
  const mjs = fs.readFileSync(abs('main.js'), 'utf8');
  if (!mjs.includes('CLEANUP_SCRIPT.execute(safeItems, !!force, !!toRecycle, !!autoRebuild)'))
    throw new Error('main.js 未把 autoRebuild 传给 execute');
  const c = require(CLEANUP_PS_FILE);
  const ex = c.execute([], false, false, true);
  if (!ex.includes('$autoRebuild = $true')) throw new Error('execute 未注入 autoRebuild=true');
  if (!ex.includes('function Remove-PathSafely')) throw new Error('EXECUTE 模板缺 Remove-PathSafely');
  const src = fs.readFileSync(CLEANUP_PS_FILE, 'utf8');
  for (const needle of [
    '[bool]$AutoRebuild = $true',
    '-AutoRebuild $autoRebuild',
    'if ($AutoRebuild)'
  ]) {
    if (!src.includes(needle)) throw new Error('cleanup-scripts.js 缺少 ' + needle);
  }
  // 硬编码重建分支已收口：AutoRebuild 参数存在且据其守卫重建（不再无条件 New-Item）
  if (!src.includes('param([string]$Path, [bool]$Force, [string]$Risk, [string]$Mode = \'tree\', [bool]$AutoRebuild = $true)'))
    throw new Error('Remove-PathSafely 未声明 AutoRebuild 参数并默认 true');
  if ((src.match(/\$rebuilt/g) || []).length < 2) throw new Error('Temp/Prefetch/Recent 重建未受 autoRebuild 守卫');
});

check('D8：autoRebuild=false 时目录型条目删除后不重建空壳（端到端）', () => {
  const c = require(CLEANUP_PS_FILE);
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trim-d8-'));
  try {
    fs.mkdirSync(path.join(dir, 'victim', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'victim', 'sub', 'x.tmp'), 'x');
    // 用 EXECUTE 模板直接跑 tree 模式目录整删（目录型 item 未声明 deleteMode 走 tree），
    // autoRebuild=false => 干净删除且不重建空壳
    const item = { id: 'd8Probe', name: 'D8 探针', path: path.join(dir, 'victim'), risk: 'low' };
    const src = c.execute([item], false, false, false);
    const out = String(runPs(src));
    const summary = JSON.parse(out.trim().split(/\r?\n/).pop());
    const d = summary.details && summary.details[0];
    if (!d) throw new Error('无明细: ' + out);
    if (d.status !== 'ok') throw new Error('autoRebuild=false 应成功清理: ' + d.status + ' / ' + d.message);
    if (fs.existsSync(path.join(dir, 'victim'))) throw new Error('autoRebuild=false 不应重建空壳目录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('D9：Test-RuleDetect 无 detect 退化为主路径存在判定（静态）', () => {
  const src = fs.readFileSync(CLEANUP_PS_FILE, 'utf8');
  const seg = src.slice(src.indexOf('function Test-RuleDetect'), src.indexOf('function Get-BlockedProcesses'));
  for (const needle of [
    'if ($Rule.detect)',
    '退化为「主路径存在性判定」',
    'Resolve-RulePath -Expr',
    'Test-Path -LiteralPath ([string]$rpc.path)',
    'return $true'
  ]) {
    if (!seg.includes(needle)) throw new Error('Test-RuleDetect 缺少 ' + needle);
  }
});

check('端到端：SCAN 按 D9 退化逻辑，主路径不存在的条目不出现在结果（D9）', () => {
  // 真实机器状态可测：tempFiles 主路径（%TEMP%）必然存在→应输出；dismPlusOld 主路径
  // （%LOCALAPPDATA%\Dism++Backup）无 detect 且通常不存在。此处用真实规则库里
  // 「必然存在」的 tempFiles 断言退化不误伤，并核对退化逻辑真实生效（不再恒命中已然可达）。
  const c = require(CLEANUP_PS_FILE);
  const out = String(runPs(c.scan(['tempFiles'], {})));
  const items = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('@@ITEM@@')) items.push(JSON.parse(line.slice(8)));
  }
  const temp = items.find(x => x.id === 'tempFiles');
  if (!temp) throw new Error('tempFiles 主路径 %TEMP% 存在，退化判定不应隐藏它'); // *能见性* 根因回归护栏
  if (!('exists' in temp) || temp.exists !== true) throw new Error('tempFiles exists 应 true');
});

check('D10：PS 侧四处 risk 判断点统一收口 medium 门禁，信任源 $rule.risk（静态）', () => {
  const src = fs.readFileSync(CLEANUP_PS_FILE, 'utf8');
  // 四处判断点：
  //  1) Remove-PathSafely 内部汇聚门禁（$Risk，来自 $rule.risk）
  //  2) fileKeys 分支
  //  3) regKeys 分支
  //  4) pathPs 回收站分支
  const patterns = [
    "$Risk -in @('high', 'medium')",
    '[string]$rule.risk -in @(\'high\', \'medium\')',
    '[string]$rule.risk -in @(\'high\', \'medium\')',
    '[string]$rule.risk -in @(\'high\', \'medium\')'
  ];
  for (const needle of patterns) {
    const n = (src.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (n < 1) throw new Error('缺少 $risk/risk -in @(high,medium) 门禁: ' + needle);
  }
  // 旧式单 high 门禁不应残留（risk -eq 'high'）
  if (/'-eq\s*'high'/.test(src))
    throw new Error('仍残留旧式 risk -eq high 单点门禁');
  // v3.3.0：强制删除勾选框已移除（固定不执行），skip 文案不再引用已删除的 UI
  if (src.includes('需勾选强制删除'))
    throw new Error('门禁 skip 文案仍引用已移除的「强制删除」勾选框');
  if ((src.match(/高\/中风险项按默认策略跳过/g) || []).length !== 4)
    throw new Error('门禁 skip 文案未统一为 高/中风险项按默认策略跳过');
});

check('D10：渲染层 risk 分级确认 + modal warning 层级 + confirmWarning 入口（静态）', () => {
  const cl = fs.readFileSync(abs('src/scripts/cleanup.js'), 'utf8');
  if (!cl.includes('const mediumRisk ='))
    throw new Error('cleanup.js 未提取 mediumRisk');
  if (!cl.includes('window.app?.confirmWarning'))
    throw new Error('cleanup.js 未调用 confirmWarning 做中风险确认');
  if (!cl.includes("r && (r.risk === 'high' || r.risk === 'medium')"))
    throw new Error('cleanup.js 未统一 high+medium 高风险池');
  const app = fs.readFileSync(abs('src/scripts/app.js'), 'utf8');
  if (!app.includes('function confirmWarning('))
    throw new Error('app.js 未提供 confirmWarning 语义入口');
  if (!app.includes('confirmWarning') || !/window\.app\s*=\s*\{[\s\S]*confirmWarning[\s\S]*\}/.test(app))
    throw new Error('app.js 未导出 confirmWarning');
  const modal = fs.readFileSync(abs('src/scripts/modal.js'), 'utf8');
  if (!modal.includes('warning = false'))
    throw new Error('modal.confirm 未声明 warning 参数');
  if (!modal.includes('btn-warning'))
    throw new Error('modal.confirm 未渲染 btn-warning 黄色按钮');
  if (!modal.includes('confirm-warning-hint'))
    throw new Error('modal.confirm 未渲染 confirm-warning-hint 黄色警示块');
  const css = fs.readFileSync(abs('src/styles/main.css'), 'utf8');
  for (const s of ['.btn-warning', '.confirm-warning-hint']) {
    if (!css.includes(s)) throw new Error('main.css 缺少 ' + s);
  }
});

// ==================== 5. 页面挂载检查 ====================
console.log('[5/5] index.html 挂载检查');
check('index.html 包含 maintenance 页面与脚本引用', () => {
  const html = fs.readFileSync(abs('src/index.html'), 'utf8');
  for (const needle of [
    'id="page-maintenance"',
    'scripts/maintenance.js',
    'scripts/netspeed-detector.js'
  ]) {
    if (!html.includes(needle)) throw new Error('缺少 ' + needle);
  }
  for (const gone of ['page-bigfile', 'scripts/bigfile.js', 'disk-health', 'diskHealth']) {
    if (html.includes(gone)) throw new Error('已删除功能仍残留 ' + gone);
  }
});

// ==================== 6. v2.6.0 批次（优化中心安全增强 / 系统体检 / 多线路更新 / 便携模式） ====================
console.log('[6/6] v2.6.0 批次检查');

check('optimization-state 记账 fail-closed 语义', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trim-optstate-'));
  const OPT_STATE = require(abs('src/main/optimization-state'));
  try {
    OPT_STATE.initDataDir(dir, () => {});
    if (!OPT_STATE.ready()) throw new Error('initDataDir 后应 ready');
    if (OPT_STATE.get('x')) throw new Error('初始应无记录');
    if (!OPT_STATE.recordPending('x', { title: '测试项', kinds: ['reg', 'cmd'] })) throw new Error('recordPending 应成功');
    // 记账成功后才允许执行——写不进去就不改
    const rec = OPT_STATE.get('x');
    if (!rec || rec.status !== 'pending' || rec.kinds.join() !== 'reg,cmd') throw new Error('pending 记录形状不符');
    if (!OPT_STATE.markApplied('x', 'partial')) throw new Error('markApplied 应成功');
    if (OPT_STATE.get('x').status !== 'applied' || OPT_STATE.get('x').lastVerify !== 'partial') throw new Error('applied 转正不符');
    if (!OPT_STATE.remove('x')) throw new Error('remove 应成功');
    if (OPT_STATE.get('x')) throw new Error('销账后应无记录');
    // 损坏隔离：写入垃圾后 load 应自愈为空且不抛异常
    fs.writeFileSync(path.join(dir, 'optimization-state.json'), '{broken', 'utf8');
    const state = JSON.parse(JSON.stringify(OPT_STATE.all()));
    if (Object.keys(state).length !== 0) throw new Error('损坏文件应隔离并返回空清单');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('version-migrations 退役迁移语义（成功销账 / 失败保留 / 目录内不碰）', () => {
  // runRetiredMigrations 是异步实现，子进程里跑桩断言（非零退出 = 失败）
  const child = [
    "const MIGRATIONS=require(" + JSON.stringify(abs('src/main/version-migrations.js')) + ");",
    "const backups={retired_one:{values:[{hive:'HKEY_CURRENT_USER',sub:'Software\\\\TrimTest',key:'A',exists:true}]},still_listed:{values:[]},broken_one:{values:[{hive:'HKEY_CURRENT_USER',sub:'Software\\\\TrimTest',key:'B',exists:false}]}};",
    "const removed=[];const saved=[];",
    "MIGRATIONS.runRetiredMigrations({",
    "  knownIds:new Set(['still_listed']),",
    "  loadBackups:()=>({...backups}),",
    "  saveBackups:(m)=>{saved.push(Object.keys(m).sort());},",
    "  restoreEntry:async(id)=>(id==='broken_one'?{ok:false,reason:'模拟失败'}:{ok:true}),",
    "  removeState:(id)=>{removed.push(id);},",
    "  writeLog:()=>{}",
    "}).then(s=>{",
    "  if(s.restored.length!==1||s.restored[0].id!=='retired_one') throw new Error('应恰好还原 retired_one');",
    "  if(s.failed.length!==1||s.failed[0].id!=='broken_one') throw new Error('应恰好失败 broken_one');",
    "  if(removed.join()!=='retired_one') throw new Error('仅成功项销账');",
    "  if(JSON.stringify(saved)!==JSON.stringify([['broken_one','still_listed']])) throw new Error('失败项与目录内项都应原样保留');",
    "  console.log('OK');",
    "}).catch(e=>{console.error(e.message);process.exit(1);});"
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 20000 });
  if (!out.includes('OK')) throw new Error('迁移断言未通过: ' + out);
});

check('retired-optimizations.json 结构合法', () => {
  const m = JSON.parse(fs.readFileSync(abs('src/data/retired-optimizations.json'), 'utf8'));
  if (m.version !== 1 || !Array.isArray(m.items)) throw new Error('顶层结构应为 {version:1, items:[]}');
  for (const it of m.items) {
    if (!it || typeof it.id !== 'string' || !it.id) throw new Error('items 条目缺少 id');
  }
});

check('优化项 effect 预期效果字段全覆盖（P2-7）', () => {
  const optimizer = require(abs('src/scripts-powershell/optimizer-scripts.js'));
  const valid = new Set(['明显', '一般', '微小', '未验证']);
  const missing = optimizer.OPTIONS.filter(o => !valid.has(o.effect));
  if (missing.length) throw new Error('effect 缺失或非法: ' + missing.map(o => o.id).join(', '));
  // 渲染层徽章映射须覆盖全部四个档位
  const optSrc = fs.readFileSync(abs('src/scripts/optimizer.js'), 'utf8');
  for (const lv of valid) {
    if (!optSrc.includes("'" + lv + "'")) throw new Error('optimizer.js EFFECT_BADGE 缺少档位 ' + lv);
  }
});

check('系统体检脚本 PS 语法（P1-6）', () => {
  const OVERVIEW = require(abs('src/scripts-powershell/overview-scripts.js'));
  psParseCheck('overview.checkup', OVERVIEW.checkup());
  const script = OVERVIEW.checkup();
  if (script.includes('`')) throw new Error('体检脚本含反引号（模板字符串冲突风险）');
  if (/\$\{/.test(script)) throw new Error('体检脚本含 ${ 序列（JS 模板插值冲突风险）');
  for (const need of ['ConvertTo-Json', 'Add-Check', 'Get-PhysicalDisk', 'Get-MpComputerStatus']) {
    if (!script.includes(need)) throw new Error('体检脚本缺少 ' + need);
  }
});

check('updater 多线路容灾与镜像持久化（P2-8）', () => {
  // updater.js 依赖 electron 运行时（electron-updater 在普通 node 下 require 即失败），
  // 这里做源码级断言；运行时行为由 CDP 真机验证兜底。
  const src = fs.readFileSync(abs('src/main/updater.js'), 'utf8');
  const mirrorIds = ['gh-proxy', 'ghfast'];
  for (const id of mirrorIds) {
    if (!src.includes(`id: '${id}'`)) throw new Error('缺少镜像线路 ' + id);
  }
  // 镜像 base 必须是 https 且指向 releases/latest/download/（latest.yml 与安装包同目录）
  const bases = [...src.matchAll(/base:\s*'([^']+)'/g)].map(m => m[1]);
  if (bases.length < 2) throw new Error('镜像线路不足两条');
  for (const b of bases) {
    if (!/^https:\/\//.test(b) || !b.endsWith('/')) throw new Error('镜像 base 必须是 https 且以 / 结尾: ' + b);
    if (!b.includes('releases/latest/download/')) throw new Error('镜像 base 应指向 releases/latest/download: ' + b);
  }
  for (const fn of ['setMirror', 'getMirror', 'loadMirrorPref', 'saveMirrorPref', 'orderedFeeds']) {
    if (!src.includes('function ' + fn)) throw new Error('updater.js 缺少 ' + fn);
  }
  if (!src.includes('module.exports = { initUpdater, safeCheck, startDownload, cancelDownload, installUpdate, setMirror, getMirror, MIRRORS }')) {
    throw new Error('module.exports 未导出 setMirror/getMirror/MIRRORS');
  }
});

// 火眼眼审查 2026-09-14（代码审查报告-2026-09-14-火眼眼.md）修复回归断言：
// 防降级 fail-closed / settings:save SSRF / 规则库防回滚水位线 / 统一脱敏 / 防闪与 shimmer
check('火眼眼审查修复：updater 防降级 fail-closed', () => {
  const src = fs.readFileSync(abs('src/main/updater.js'), 'utf8');
  const vfn = (src.match(/function isVersionNewerOrEqual\(remote, current\) \{[\s\S]*?\n\}/) || [])[0];
  if (!vfn) throw new Error('isVersionNewerOrEqual 缺失');
  if (!/if \(!Number\.isFinite\(x\) \|\| !Number\.isFinite\(y\)\) return false;/.test(vfn)) {
    throw new Error('版本段解析失败未 fail-closed（畸形远端版本不得绕过降级拦截）');
  }
  if (!/\} catch \{ return false; \}/.test(vfn)) throw new Error('比较异常分支未 fail-closed');
});

check('火眼眼审查修复：settings:save 全 URL 字段 SSRF 校验', () => {
  const mainSrc = fs.readFileSync(abs('main.js'), 'utf8');
  if (!mainSrc.includes('const URL_FIELD_LABELS')) throw new Error('settings:save 缺少 URL 字段校验表');
  // models[].apiUrl 同样必须过 ^https?:// 与 isPrivateApiUrl 两道闸
  if (!/const modelUrl = String\(submitted\.apiUrl \|\| currentModel\.apiUrl[\s\S]{0,600}isPrivateApiUrl\(modelUrl\)/.test(mainSrc)) {
    throw new Error('settings:save 未对 models[].apiUrl 做 isPrivateApiUrl 校验');
  }
  if (!/for \(const \[field, label\] of Object\.entries\(URL_FIELD_LABELS\)\)[\s\S]{0,300}isPrivateApiUrl\(v\)/.test(mainSrc)) {
    throw new Error('settings:save 平铺 URL 字段未做 isPrivateApiUrl 校验');
  }
});

check('火眼眼审查修复：规则库防回滚水位线', () => {
  const cs = fs.readFileSync(abs('src/scripts-powershell/cleanup-scripts.js'), 'utf8');
  const mainSrc = fs.readFileSync(abs('main.js'), 'utf8');
  if (!cs.includes('rules-watermark.json')) throw new Error('cleanup-scripts 缺少水位线文件');
  for (const fn of ['function getRulesWatermark', 'function setRulesWatermark']) {
    if (!cs.includes(fn)) throw new Error('cleanup-scripts 缺少 ' + fn);
  }
  // 读侧：验签通过后仍要拒绝低于 max(内置, 水位线) 的旧签名文件（防重放）
  if (!/const floor = Math\.max\(builtinVersion, watermark\);[\s\S]{0,200}return null;/.test(cs)) {
    throw new Error('readVerifiedDataRules 缺少防回滚下限判定');
  }
  if (!cs.includes('module.exports = {') || !/getRulesWatermark,\s*\n\s*setRulesWatermark,/.test(cs)) {
    throw new Error('cleanup-scripts 未导出 getRulesWatermark/setRulesWatermark');
  }
  // 主进程侧：更新下限含水位线，落盘成功后抬升
  if (!mainSrc.includes('CLEANUP_SCRIPT.getRulesWatermark()')) throw new Error('main.js 更新/检测下限未接入水位线');
  if (!mainSrc.includes('CLEANUP_SCRIPT.setRulesWatermark(result.version)')) throw new Error('更新落盘后未抬升水位线');
});

check('火眼眼审查修复：统一脱敏出口与渲染层护栏', () => {
  const sec = fs.readFileSync(abs('src/main/security.js'), 'utf8');
  const mainSrc = fs.readFileSync(abs('main.js'), 'utf8');
  const boot = fs.readFileSync(abs('src/scripts/theme-boot.js'), 'utf8');
  const lg = fs.readFileSync(abs('src/scripts/liquid-glass.js'), 'utf8');
  if (!sec.includes('function maskSettings') || !sec.includes('maskSettings')) throw new Error('security.js 缺少 maskSettings');
  if (!mainSrc.includes('const API_KEY_MASK = SECURITY.SECRET_MASK')) throw new Error('API_KEY_MASK 未收敛到 security.js 单一来源');
  if (!mainSrc.includes('SECURITY.maskSettings(resp.data)')) throw new Error('settings:load 出口未套用统一脱敏');
  // theme-boot 必须挂 documentElement（head 期 body 为 null，写 body 防闪失效）
  if (!boot.includes('document.documentElement.classList.add')) throw new Error('theme-boot 未挂 documentElement');
  if (/\bdocument\.body\.(className|classList)/.test(boot)) throw new Error('theme-boot 不得再写 document.body（head 期无效）');
  // shimmer 后台暂停
  if (!/if \(document\.hidden\) return;/.test(lg)) throw new Error('liquid-glass shimmer 缺少 document.hidden 暂停');
});

// 扫描 Rust 化（P3，方案 v1.1）：双引擎对拍——同一份合成规则分别喂 PS SCAN_SCRIPT 与
// finder.exe cleanup 子命令，@@ITEM@@/@@PLANFILE@@ 逐字段比对。合成树覆盖：pathPs 统计、
// 不存在路径隐藏、fileKeys pattern+excludeKeys、独占锁探测（locked 口径）、restartProcesses
// 免探测、regKeys 计数（含 value='*' 语义）、configuredPaths 覆盖、stdin 负例 fail-closed。
check('双引擎对拍：cleanup 扫描 PS 与 Rust 逐字段一致（P3）', () => {
  const { spawn, spawnSync } = require('child_process');
  const exe = path.join(__dirname, 'native-scanner', 'target', 'release', 'finder.exe');
  if (!fs.existsSync(exe)) throw new Error('finder.exe 未构建：先执行 cargo build --release（native-scanner）');
  const c = require(CLEANUP_PS_FILE);
  if (fs.existsSync(FASTSIZE_DLL)) c.setFastSizeDll(FASTSIZE_DLL); // PS 侧走 ListDeletable 口径（与 Rust 同源）

  const stamp = Date.now();
  const mk = (n) => path.join(require('os').tmpdir(), `trim-p3-${stamp}-${n}`);
  const dirA = mk('a'), dirB = mk('b'), dirC = mk('c'), dirD = mk('d'), dirMissing = mk('missing');
  const mkDir = (d) => fs.mkdirSync(d, { recursive: true });
  const put = (d, n, size) => fs.writeFileSync(path.join(d, n), Buffer.alloc(size, 0x61));
  mkDir(dirA); mkDir(path.join(dirA, 'sub')); put(dirA, 'a.txt', 100); put(dirA, 'b.log', 200); put(path.join(dirA, 'sub'), 'c.txt', 50);
  mkDir(dirB); mkDir(path.join(dirB, 'keep')); put(dirB, 'x.log', 10); put(dirB, 'y.txt', 20); put(path.join(dirB, 'keep'), 'note.txt', 5);
  mkDir(dirC); put(dirC, 'free.bin', 300); put(dirC, 'lock.bin', 500);
  mkDir(dirD); put(dirD, 'r.bin', 400);

  // 注册表测试键：1 键 + 2 值 + 1 子键 → Measure-RegRule 计数 = 1 + 2 + 1 = 4
  const regKey = 'HKCU\\Software\\Trim\\selftest\\Trim_P3_' + stamp;
  runPs(
    "reg.exe add '" + regKey + "' /v v1 /d 1 /f | Out-Null\n" +
    "reg.exe add '" + regKey + "' /v v2 /d 2 /f | Out-Null\n" +
    "reg.exe add '" + regKey + "\\sub' /v t /d 1 /f | Out-Null\n"
  );

  // 独占锁持有进程：node fs 无法指定 FileShare.None，用后台 pwsh 持锁（对齐 D7 用例语义）。
  // spawn 异步持有 + 探针确认锁生效后再跑双引擎，杜绝「锁未生效导致锁定计数为 0」的偶发。
  const lockPath = path.join(dirC, 'lock.bin');
  const locker = spawn(psExe(), ['-NoProfile', '-Command',
    "$h = [System.IO.File]::Open(" + lit(lockPath) + ", 'Open', 'Read', 'None'); Start-Sleep -Seconds 90; $h.Dispose()"],
    { windowsHide: true, stdio: 'ignore' });
  const lockState = (() => {
    // pwsh 冷启动 1-2s：单次探测会跑在持锁进程就绪之前（实测偶发），改为轮询确认
    let state = 'unlocked';
    for (let i = 0; i < 6; i++) {
      state = String(runPs(
        "try { $h = [System.IO.File]::Open(" + lit(lockPath) + ", 'Open', 'Read', 'None'); $h.Dispose(); Write-Output 'unlocked' } catch { Write-Output 'locked' }\n"
      )).trim().split(/\r?\n/).pop();
      if (state === 'locked') break;
      spawnSync(psExe(), ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 600'], { windowsHide: true });
    }
    return state;
  })();
  if (lockState !== 'locked') throw new Error('独占锁未生效（locker 启动失败），无法验证锁定口径');

  const configured = { p3Cache: dirB }; // configuredPaths 覆盖：pathPs 求值路径存在但被覆盖为 dirB
  const rules = {
    version: 1, rulesVersion: 1,
    groups: [{
      key: 't', title: 't',
      items: [
        { id: 'p3DirA', name: '目录A', risk: 'low', pathPs: "'" + dirA + "'" },
        { id: 'p3Missing', name: '不存在', risk: 'low', pathPs: "'" + dirMissing + "'" },
        { id: 'p3Logs', name: '日志', risk: 'low', fileKeys: [{ path: dirB, pattern: '*.log' }], excludeKeys: [{ path: path.join(dirB, 'keep'), type: 'dir' }] },
        { id: 'p3Locked', name: '锁文件', risk: 'low', fileKeys: [{ path: dirC, pattern: '*' }] },
        { id: 'p3Restart', name: '免探测', risk: 'low', fileKeys: [{ path: dirD, pattern: '*' }], restartProcesses: [{ name: 'explorer', restart: 'process' }] },
        { id: 'p3Reg', name: '注册表', risk: 'medium', regKeys: [{ path: regKey }] },
        { id: 'p3Cache', name: '缓存覆盖', risk: 'low', pathPs: "'" + dirA + "'" }
      ]
    }]
  };
  const categories = rules.groups[0].items.map(i => i.id);
  const fields = ['name', 'configuredPath', 'path', 'pathSource', 'pathCandidates', 'autoPath', 'autoSize', 'size', 'fileCount', 'lockedCount', 'regCount', 'risk', 'exists'];
  const parse = (stdout) => {
    const items = [], plans = [];
    for (const line of String(stdout).split(/\r?\n/)) {
      if (line.startsWith('@@ITEM@@')) items.push(JSON.parse(line.slice(8)));
      else if (line.startsWith('@@PLANFILE@@')) plans.push(JSON.parse(line.slice(12)));
    }
    return { items, plans };
  };
  const lit2 = (s) => JSON.stringify(s);
  try {
    // PS 引擎（规则注入）
    const script = c.scan(categories, configured, rules);
    const file = writeTmpPs(script);
    let psOut;
    try {
      psOut = execFileSync(psExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
        { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    } finally { try { fs.unlinkSync(file); } catch (e) {} }
    const ps = parse(psOut);
    // Rust 引擎（stdin 规则注入）
    const rs = spawnSync(exe, ['cleanup', JSON.stringify(categories), JSON.stringify(configured)],
      { encoding: 'utf8', input: JSON.stringify(rules), timeout: 120000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (rs.status !== 0) throw new Error('Rust 引擎退出码 ' + rs.status + ': ' + String(rs.stderr).slice(0, 200));
    const ru = parse(rs.stdout);

    const m1 = new Map(ps.items.map(i => [i.id, i]));
    const m2 = new Map(ru.items.map(i => [i.id, i]));
    // 缺失集合一致：p3Missing 必须双侧都不输出（detect 退化主路径判定）
    const ids1 = new Set(ps.items.map(i => i.id)), ids2 = new Set(ru.items.map(i => i.id));
    for (const id of ids1) if (!ids2.has(id)) throw new Error(`Rust 缺少条目 ${id}`);
    for (const id of ids2) if (!ids1.has(id)) throw new Error(`Rust 多出条目 ${id}`);
    if (ids1.has('p3Missing')) throw new Error('不存在路径条目未被隐藏');
    // 逐字段一致
    for (const id of ids1) {
      const a = m1.get(id), b = m2.get(id);
      for (const f of fields) {
        const va = JSON.stringify(a[f] === undefined ? null : a[f]);
        const vb = JSON.stringify(b[f] === undefined ? null : b[f]);
        if (va !== vb) throw new Error(`[${id}] ${f} 不一致: PS=${va} Rust=${vb}`);
      }
    }
    // 口径断言（双侧同验，防「一致地错」）
    const st = (m) => m.get('p3DirA');
    if (st(m1).size !== 350 || st(m2).size !== 350) throw new Error(`pathPs 统计口径异常: PS=${st(m1).size} Rust=${st(m2).size}（期望 350）`);
    if (m1.get('p3Logs').fileCount !== 1 || m2.get('p3Logs').fileCount !== 1) throw new Error('excludeKeys/pattern 过滤口径异常');
    if (m1.get('p3Locked').lockedCount !== 1 || m2.get('p3Locked').lockedCount !== 1) throw new Error('独占锁探测口径异常（locked 应为 1）');
    if (m1.get('p3Locked').size !== 300 || m2.get('p3Locked').size !== 300) throw new Error('被占用文件应剔除出 size（期望 300）');
    if (m1.get('p3Restart').size !== 400 || m2.get('p3Restart').size !== 400) throw new Error('restartProcesses 免探测口径异常（期望 400）');
    if (m1.get('p3Reg').regCount !== 4 || m2.get('p3Reg').regCount !== 4) throw new Error('注册表计数口径异常（期望 4）');
    if (m1.get('p3Reg').size !== null || m2.get('p3Reg').size !== null) throw new Error('regKeys size 应为 null');
    if (m1.get('p3Cache').path !== dirB || m2.get('p3Cache').path !== dirB) throw new Error('configuredPaths 覆盖未生效');
    if (m1.get('p3Cache').configuredPath !== dirA) throw new Error('configuredPath 应保留求值原路径');
    // PLANFILE：锁文件条目只含 free.bin
    const lockRowsPs = ps.plans.filter(p => p.id === 'p3Locked').map(p => p.path).sort();
    const lockRowsRu = ru.plans.filter(p => p.id === 'p3Locked').map(p => p.path).sort();
    if (lockRowsPs.length !== 1 || lockRowsRu.length !== 1 || lockRowsPs[0] !== lockRowsRu[0] || !lockRowsRu[0].includes('free.bin')) {
      throw new Error(`PLANFILE 口径异常: PS=${JSON.stringify(lockRowsPs)} Rust=${JSON.stringify(lockRowsRu)}`);
    }
    // stdin 负例：坏 JSON → exit 2（fail-closed，方案 v1.1 红线 5）
    const neg = spawnSync(exe, ['cleanup', '["p3DirA"]', '{}'], { encoding: 'utf8', input: '{bad', timeout: 30000, windowsHide: true });
    if (neg.status !== 2) throw new Error('stdin 坏 JSON 应 exit 2，实际 ' + neg.status);
  } finally {
    try { locker && typeof locker.pid === 'number' && process.kill(locker.pid); } catch (e) {}
    try { fs.rmSync(dirA, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(dirB, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(dirC, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(dirD, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(dirMissing, { recursive: true, force: true }); } catch (e) {}
    runPs("reg.exe delete '" + regKey + "' /f 2>&1 | Out-Null\n");
  }
});

// v3.3.4：清理前占用检测（Rust checklocked + 渲染层弹窗）与清理结果文案纠偏
check('v3.3.4 占用检测链路：IPC 双侧对齐 + kill 通道不入只读白名单', () => {
  const mainSrc = fs.readFileSync(abs('main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(abs('preload.js'), 'utf8');
  for (const ch of ['cleanup:check-locked', 'cleanup:kill-locked-processes']) {
    if (!mainSrc.includes(`'${ch}'`)) throw new Error('main.js 缺少通道 ' + ch);
    if (!preloadSrc.includes(`'${ch}'`)) throw new Error('preload.js 缺少通道 ' + ch);
  }
  // 结束进程是危险操作，绝不允许进「跳过来源校验」的只读白名单
  const wl = mainSrc.match(/const SIDE_EFFECT_FREE = new Set\(\[([\s\S]*?)\]\);/);
  if (!wl) throw new Error('未找到 SIDE_EFFECT_FREE 白名单');
  if (wl[1].includes('cleanup:kill-locked-processes')) throw new Error('kill 通道不得进只读白名单');
  // kill 目标必须来自最近一次检测白名单（渲染层不可指定 PID）
  if (!/lastLockCheckProcs/.test(mainSrc)) throw new Error('缺少占用检测进程白名单变量');
  if (!/cleanup:kill-locked-processes[\s\S]{0,400}lastLockCheckProcs/.test(mainSrc)) {
    throw new Error('kill 通道未消费检测白名单');
  }
  // 行协议前缀长度必须精确（@@LOCKED@@ 与 @@PLANFILE@@ 长度不同，错位会让解析静默失败）
  if (!mainSrc.includes(`line.slice('@@LOCKED@@'.length)`)) {
    throw new Error('@@LOCKED@@ 行解析未使用前缀长度（易与 12 字符的 @@PLANFILE@@ 混淆）');
  }
  // Rust 侧：checklocked 子命令已接线，且 RM 结构体按 4 字节对齐（u64 FILETIME 会让应用名错位）
  const rs = fs.readFileSync(abs('native-scanner/src/main.rs'), 'utf8');
  if (!rs.includes('"checklocked"')) throw new Error('finder 未接线 checklocked 子命令');
  const cs = fs.readFileSync(abs('native-scanner/src/cleanup_scan.rs'), 'utf8');
  for (const needle of ['RmStartSession', 'RmRegisterResources', 'RmGetList', 'ProcessStartTimeLow']) {
    if (!cs.includes(needle)) throw new Error('cleanup_scan 缺少 ' + needle);
  }
  if (/ProcessStartTime: u64/.test(cs)) throw new Error('RM_UNIQUE_PROCESS 不得用 u64 FILETIME（4 字节对齐偏差致应用名错位）');
});

check('v3.3.4 文案纠偏：partial 不计入 failed + 占用弹窗骨架', () => {
  const mainSrc = fs.readFileSync(abs('main.js'), 'utf8');
  const cjs = fs.readFileSync(abs('src/scripts/cleanup.js'), 'utf8');
  // partial（部分成功）与 error（硬失败）分开统计：failed 只收 error
  if (!/data\.failed = dts\.filter\(d => d\.status === 'error'\)\.length/.test(mainSrc)) {
    throw new Error('清理汇总未把 partial 从 failed 拆出');
  }
  if (!mainSrc.includes('data.partial = nPartial')) throw new Error('缺少 partial 上报');
  // 回收站分支同样拆分
  if (!/data\.partial = \(data\.details \|\| \[\]\)\.filter\(d => d\.status === 'partial'\)\.length/.test(mainSrc)) {
    throw new Error('回收站分支未拆分 partial');
  }
  // 渲染层：partial 单独提示，且不再与 failed 混为一谈
  if (!/result\.partial > 0/.test(cjs)) throw new Error('渲染层未区分 partial 提示');
  // 占用弹窗：进程列表 + 两个按钮
  for (const needle of ['lock-app-list', 'data-lock="kill"', 'data-lock="skip"', '不结束并放弃清理它们', '立即结束进程']) {
    if (!cjs.includes(needle)) throw new Error('占用弹窗缺少 ' + needle);
  }
  // 关闭弹窗（×/ESC/背景）不得静默继续清理
  if (!/onClose\(\) \{ finish\('cancel'\); \}/.test(cjs)) throw new Error('占用弹窗关闭未按取消处理');
  // v3.3.4：第三段版本明确为「云端 winapp2 版本」（远端取的就是 winapp2 基线版本号）
  const html = fs.readFileSync(abs('src/index.html'), 'utf8');
  if (!cjs.includes('云端 winapp2 版本为：')) throw new Error('渲染层版本文案未改为「云端 winapp2 版本」');
  if (!html.includes('云端 winapp2 版本为：--')) throw new Error('index.html 静态初值未同步新版本文案');
  if (cjs.includes('，云端版本为：') || html.includes('，云端版本为：')) {
    throw new Error('仍残留旧文案「云端版本为」，会与 winapp2 语义混淆');
  }
  // 第三段必须取远端 winapp2Version（取 remoteVersion 会错显本机规则库版本号）
  if (!/setVersionInfo\(resp\.currentVersion, resp\.currentWinapp2Version, resp\.remoteWinapp2Version\)/.test(cjs)) {
    throw new Error('云端段未使用 remoteWinapp2Version（winapp2 语义不符）');
  }
});

check('v3.3.4 图标：ICO 8 帧完整且生成器与产物同源', () => {
  const ico = fs.readFileSync(abs('src/assets/ico/Trim.ico'));
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('Trim.ico 头非法');
  const count = ico.readUInt16LE(4);
  if (count !== 8) throw new Error(`Trim.ico 应为 8 帧（PIL 保存会漏帧，需手工组装），实际 ${count}`);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    sizes.push(ico[off] === 0 ? 256 : ico[off]);
  }
  const expect = [16, 24, 32, 48, 64, 96, 128, 256];
  if (sizes.join(',') !== expect.join(',')) throw new Error(`Trim.ico 帧尺寸异常: ${sizes.join(',')}`);
  // 每帧偏移与长度必须在文件范围内（防手工组装越界）
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const len = ico.readUInt32LE(off + 8);
    const pos = ico.readUInt32LE(off + 12);
    if (pos + len > ico.length) throw new Error(`Trim.ico 第 ${i} 帧越界`);
  }
  for (const s of [12, 16, 24, 32, 48, 64, 96]) {
    if (!fs.existsSync(abs(`src/assets/ico/icon_${s}x${s}.png`))) throw new Error(`缺少 icon_${s}x${s}.png`);
  }
  // 生成器须保留「小尺寸不羽化」与「手工组装 ICO」两处修正，防重跑回归白角/漏帧
  const gen = fs.readFileSync(abs('scripts/fix_icons.py'), 'utf8');
  if (!/if size > 16:/.test(gen)) throw new Error('生成器缺少小尺寸不羽化分支');
  if (!/struct\.pack\("<BBBBHHII"/.test(gen)) throw new Error('生成器缺少手工组装 ICO');
});

check('v3.3.4 内置 pwsh 运行时：IPC 双侧对齐 + 状态通道只读白名单', () => {
  const mainSrc = fs.readFileSync(abs('main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(abs('preload.js'), 'utf8');
  for (const ch of ['pwsh:status', 'pwsh:prepare']) {
    if (!mainSrc.includes(`'${ch}'`)) throw new Error('main.js 缺少通道 ' + ch);
    if (!preloadSrc.includes(`'${ch}'`)) throw new Error('preload.js 缺少通道 ' + ch);
  }
  // pwsh:status 是只读查询，必须入 SIDE_EFFECT_FREE 白名单
  if (!mainSrc.includes("'pwsh:status'")) throw new Error('pwsh:status 未登记白名单');
  // pwsh:prepare 有副作用（触发解压），绝不能入只读白名单
  const wl = mainSrc.match(/const SIDE_EFFECT_FREE = new Set\(\[([\s\S]*?)\]\);/);
  if (!wl) throw new Error('未找到 SIDE_EFFECT_FREE 白名单');
  if (wl[1].includes('pwsh:prepare')) throw new Error('pwsh:prepare 不得进只读白名单');
  // 候选链必须包含内置运行时末位注入
  if (!mainSrc.includes('PWSH_RUNTIME.latestReadyExePath()')) throw new Error('候选链未注入内置运行时');
  // 解压必须用 tar.exe（方案指定，避开 Expand-Archive 的长路径问题）
  const rt = fs.readFileSync(abs('src/main/pwsh-runtime.js'), 'utf8');
  if (!rt.includes("'tar.exe'")) throw new Error('pwsh-runtime 未使用 tar.exe 解压');
  if (rt.includes('Expand-Archive')) throw new Error('pwsh-runtime 不得使用 Expand-Archive');
});

check('v2.6.0 新增 IPC 通道 main/preload 双侧对齐', () => {
  const mainSrc = fs.readFileSync(abs('main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(abs('preload.js'), 'utf8');
  const channels = [
    'optimizer:state-overview',
    'overview:checkup',
    'updater:set-mirror',
    'updater:get-mirror'
  ];
  for (const ch of channels) {
    if (!mainSrc.includes(`'${ch}'`)) throw new Error('main.js 缺少通道 ' + ch);
    if (!preloadSrc.includes(`'${ch}'`)) throw new Error('preload.js 缺少通道 ' + ch);
  }
  // 只读白名单登记（体检/镜像读取）
  if (!mainSrc.includes("'overview:checkup',                                          // 系统体检")) {
    throw new Error('SIDE_EFFECT_FREE 白名单未登记 overview:checkup');
  }
});

check('便携模式标记检测与数据目录切换（P2-9）', () => {
  const mainSrc = fs.readFileSync(abs('main.js'), 'utf8');
  for (const needle of ['Trim.portable', 'IS_PORTABLE', "app.setPath('userData'"]) {
    if (!mainSrc.includes(needle)) throw new Error('main.js 缺少便携模式关键代码: ' + needle);
  }
  if (!mainSrc.includes('portable: IS_PORTABLE')) throw new Error('app:get-info 未返回 portable 字段');
});

// ==================== 7. v2.7.0 批次（体检去处理/忽略 / 首启扫描持久化 / 启动页 / 关闭即隐） ====================
console.log('[7/7] v2.7.0 批次检查');

check('optimization-state detected 检测结果持久化（含重读）', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trim-optdetect-'));
  const OPT_STATE = require(abs('src/main/optimization-state'));
  try {
    OPT_STATE.initDataDir(dir, () => {});
    if (!OPT_STATE.recordPending('y', { title: '持久化测试', kinds: ['reg'] })) throw new Error('recordPending 应成功');
    OPT_STATE.markApplied('y', 'pass');
    if (!OPT_STATE.setDetectedEntry('y', true)) throw new Error('setDetectedEntry 应成功');
    OPT_STATE.replaceDetected({ z: { optimized: false, at: '2026-09-13T00:00:00Z' } });
    // replaceDetected = 全量替换语义：旧的 y 条目应被清掉，只保留传入的 z
    let all = OPT_STATE.getDetectedAll();
    if (all.y) throw new Error('replaceDetected 应清掉未传入的条目（全量替换）');
    if (!all.z || all.z.optimized !== false) throw new Error('replaceDetected 应写入传入清单');
    OPT_STATE.setDetectedEntry('z', true);
    all = OPT_STATE.getDetectedAll();
    if (!all.z || all.z.optimized !== true) throw new Error('setDetectedEntry 后应可读回');
    // 重新 init（模拟下次启动）验证落盘持久
    OPT_STATE.initDataDir(dir, () => {});
    all = OPT_STATE.getDetectedAll();
    if (!all.z || all.z.optimized !== true) throw new Error('detected 未持久化到磁盘');
    if (!OPT_STATE.get('y')) throw new Error('items 记录应与 detected 同文件共存');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('体检「去处理/忽略」映射与忽略持久化键（任务1）', () => {
  const ovSrc = fs.readFileSync(abs('src/scripts/overview.js'), 'utf8');
  if (!ovSrc.includes("CHECKUP_IGNORE_KEY = 'winclean-checkup-ignored'")) throw new Error('缺少忽略持久化键');
  // 跳转目标必须是 index.html 导航中真实存在的 data-page 键
  const html = fs.readFileSync(abs('src/index.html'), 'utf8');
  const pageKeys = new Set([...html.matchAll(/data-page="([^"]+)"/g)].map(m => m[1]));
  const jumps = [...ovSrc.matchAll(/page:\s*'([a-z]+)'/g)].map(m => m[1]);
  if (!jumps.length) throw new Error('CHECKUP_JUMP 映射为空');
  for (const p of jumps) {
    if (!pageKeys.has(p)) throw new Error('体检跳转目标不存在于导航: ' + p);
  }
  // bad/warn 行必须同时提供忽略按钮，去处理仅在映射命中时渲染
  for (const needle of ["status === 'bad' || c.status === 'warn'", 'data-checkup-ignore', 'data-checkup-jump']) {
    if (!ovSrc.includes(needle)) throw new Error('overview.js 缺少 ' + needle);
  }
});

check('启动页结构与脚本引用（任务3）', () => {
  const html = fs.readFileSync(abs('src/index.html'), 'utf8');
  for (const id of ['id="splash"', 'id="splash-trim"', 'id="splash-canvas"', 'id="splash-enter"']) {
    if (!html.includes(id)) throw new Error('index.html 缺少启动页结构 ' + id);
  }
  const splashIdx = html.indexOf('<script src="scripts/splash.js"></script>');
  const trailIdx = html.indexOf('<script src="scripts/mouse-trail.js"></script>');
  if (splashIdx === -1 || trailIdx === -1 || splashIdx > trailIdx) throw new Error('splash.js 必须在 body 末尾脚本中最先加载');
  const js = fs.readFileSync(abs('src/scripts/splash.js'), 'utf8');
  for (const needle of ['.titlebar-title', 'trim_splash_seen', 'prefers-reduced-motion', 'webgl2', 'transitionend']) {
    if (!js.includes(needle)) throw new Error('splash.js 缺少 ' + needle);
  }
  // 落位期间隐藏真实标题栏品牌（CSS :has 规则）
  const css = fs.readFileSync(abs('src/styles/main.css'), 'utf8');
  if (!css.includes('body:has(.splash-overlay:not(.finished)) .titlebar-title')) {
    throw new Error('main.css 缺少标题栏品牌隐藏规则');
  }
  // CSP 禁内联脚本：splash 结构块内不得出现裸 <script> 开标签（只允许 src 引用）
  const splashBlock = html.slice(html.indexOf('id="splash"'), html.indexOf('id="splash"') + 1200);
  if (/<script>(?!\s*<)/.test(splashBlock)) throw new Error('启动页结构含内联脚本（CSP 会静默拦截）');
});

check('关闭即隐：主进程静默收尾编排（任务4）', () => {
  const mainSrc = fs.readFileSync(abs('main.js'), 'utf8');
  for (const needle of ['activeCleanupRuns++', 'activeCleanupRuns--', 'requestSilentQuit', 'mainWindow.hide()']) {
    if (!mainSrc.includes(needle)) throw new Error('main.js 缺少关闭即隐关键代码: ' + needle);
  }
  // 渲染层不再参与关闭编排：主进程不再发送 app:shutdown，app.js 不再监听
  if (mainSrc.includes("webContents.send('app:shutdown')")) throw new Error('main.js 仍在发送 app:shutdown（应已移交静默后台）');
  const appSrc = fs.readFileSync(abs('src/scripts/app.js'), 'utf8');
  if (appSrc.includes('shutdown.onRequest')) throw new Error('app.js 仍在监听 shutdown.onRequest');
  // 更新安装路径提前进入关闭态，防止 close 钩子卡住 quitAndInstall
  if (!/updater:install[\s\S]{0,200}isShuttingDown = true/.test(mainSrc)) throw new Error('updater:install 未提前置关闭态');
});

check('v2.7.2：启动加速编排 / 透明覆盖层 / postbuild 清旧包', () => {
  const appSrc = fs.readFileSync(abs('src/scripts/app.js'), 'utf8');
  const splashSrc = fs.readFileSync(abs('src/scripts/splash.js'), 'utf8');
  // 真实进度绑定：app 初始化完成派发事件，splash 监听收尾
  if (!appSrc.includes("new CustomEvent('trim:boot-ready')")) throw new Error('app.js 未派发 trim:boot-ready');
  if (!splashSrc.includes("addEventListener('trim:boot-ready'")) throw new Error('splash.js 未监听 trim:boot-ready');
  if (!splashSrc.includes('PROGRESS_CAP')) throw new Error('splash.js 缺少真实进度上限（92% 等就绪）');
  // 透明覆盖层（Mineradio 式）：TITLEBAR_OVERLAY 用 rgba(0,0,0,0)，融合通道 splash:overlay 已下线
  const mainSrc = fs.readFileSync(abs('main.js'), 'utf8');
  if (!mainSrc.includes("color: 'rgba(0, 0, 0, 0)'")) throw new Error('TITLEBAR_OVERLAY 未使用透明色');
  if (mainSrc.includes("handleSafe('splash:overlay'") || mainSrc.includes('SPLASH_OVERLAY_COLOR')) throw new Error('splash:overlay 融合通道应已删除');
  const preloadSrc = fs.readFileSync(abs('preload.js'), 'utf8');
  if (preloadSrc.includes('setSplashOverlay')) throw new Error('preload 仍暴露 setSplashOverlay（应已删除）');
  // postbuild 清旧包：脚本接线 + 当前版本保护
  const pkg = JSON.parse(fs.readFileSync(abs('package.json'), 'utf8'));
  if (pkg.scripts.postbuild !== 'node scripts/clean-old-packages.js') throw new Error('postbuild 钩子未接线 clean-old-packages');
  const cleanSrc = fs.readFileSync(abs('scripts/clean-old-packages.js'), 'utf8');
  if (!cleanSrc.includes('m[2] === CURRENT')) throw new Error('clean-old-packages 缺少当前版本保护');
  if (!cleanSrc.includes('SendToRecycleBin')) throw new Error('clean-old-packages 应优先回收站');
});

// ==================== 8. v2.8.0 批次（内嵌壁纸轮换 / 玻璃质感与自适应 / 焦点差异化） ====================
console.log('[8/8] v2.8.0 批次检查');

check('内嵌壁纸资源与轮换引擎（任务2）', () => {
  // v3.2.0：预设壁纸下架「山峰 wp-mountain」（连同极光/落日渐变），资产与选择器同步移除
  for (const f of ['wp-winter.jpg', 'wp-gaming.jpg', 'wp-anime.jpg', 'wp-doll.jpg']) {
    const p = abs('src/assets/bg/' + f);
    if (!fs.existsSync(p)) throw new Error('缺少内嵌壁纸 ' + f);
    if (fs.statSync(p).size > 2 * 1024 * 1024) throw new Error('壁纸体积超 2MB（应压缩）: ' + f);
  }
  for (const gone of ['wp-mountain.jpg', 'aurora', 'sunset']) {
    if (fs.existsSync(abs('src/assets/bg/' + gone))) throw new Error('已下架壁纸资产仍存在: ' + gone);
  }
  const html = fs.readFileSync(abs('src/index.html'), 'utf8');
  for (const wp of ['wp-winter', 'wp-gaming', 'wp-anime', 'wp-doll']) {
    if (!html.includes(`value="${wp}"`)) throw new Error('预设选择器缺少 ' + wp);
  }
  for (const gone of ['value="aurora"', 'value="sunset"', 'value="wp-mountain"']) {
    if (html.includes(gone)) throw new Error('已下架预设仍挂在选择器: ' + gone);
  }
  for (const id of ['wallpaperRotateToggle', 'wallpaperIntervalSelect']) {
    if (!html.includes(`id="${id}"`)) throw new Error('index.html 缺少轮换控件 ' + id);
  }
  const pbSrc = fs.readFileSync(abs('src/scripts/pathbinding.js'), 'utf8');
  for (const needle of ['WP_LIST', 'wallpaperRotate', 'wallpaperInterval', 'visibilitychange']) {
    if (!pbSrc.includes(needle)) throw new Error('pathbinding.js 缺少轮换引擎要素 ' + needle);
  }
  const css = fs.readFileSync(abs('src/styles/main.css'), 'utf8');
  for (const wp of ['wp-winter', 'wp-anime', 'wp-doll']) {
    if (!css.includes(`data-preset-bg="${wp}"`)) throw new Error('main.css 缺少壁纸预设规则 ' + wp);
  }
});

check('v2.8.0 玻璃死代码清理与质感参数化（P0-①/P0-②/P1-⑤）', () => {
  const css = fs.readFileSync(abs('src/styles/main.css'), 'utf8');
  // 暗色玻璃 token 死代码已删（--lg-tint-primary 只应出现一次，即 .theme-light 内）
  const tintCount = (css.match(/--lg-tint-primary:/g) || []).length;
  if (tintCount !== 1) throw new Error('--lg-tint-primary 应只剩 .theme-light 一处，实际 ' + tintCount);
  // 质感参数化：5 处硬编码收敛为变量
  if (css.includes('saturate(1.65)')) throw new Error('main.css 仍存在 saturate(1.65) 硬编码');
  for (const v of ['--glass-satur:', '--glass-bright:', '--glass-blur-soft:']) {
    if (!css.includes(v)) throw new Error('main.css 缺少玻璃参数 ' + v);
  }
  const lgSrc = fs.readFileSync(abs('src/scripts/liquid-glass.js'), 'utf8');
  // 噪点层：feTurbulence 必须在 aberration（full 专属）分支内
  const tbIdx = lgSrc.indexOf("fe('feTurbulence'");
  if (tbIdx === -1) throw new Error('liquid-glass.js 缺少噪点层 feTurbulence');
  const abIdx = lgSrc.indexOf('if (aberration) {', Math.max(0, tbIdx - 600));
  if (abIdx === -1 || abIdx > tbIdx) throw new Error('feTurbulence 未被 aberration（full 档）分支包裹');
  if (!lgSrc.includes('glassSatur') || !lgSrc.includes('glassBright')) throw new Error('liquid-glass.js 未接入质感参数');
  // theme-dark 死语句清理
  const themeSrc = fs.readFileSync(abs('src/scripts/theme.js'), 'utf8');
  for (const f of ['src/scripts/theme.js', 'src/scripts/window-material.js', 'src/scripts/models-window.js', 'src/scripts/process-manager-window.js']) {
    if (fs.readFileSync(abs(f), 'utf8').includes("remove('theme-dark')")) throw new Error(f + ' 仍存在 remove(theme-dark) 死语句');
  }
});

check('v2.8.0 环境自适应与焦点差异化（P0-③/P1-④⑥⑦）', () => {
  const mainSrc = fs.readFileSync(abs('main.js'), 'utf8');
  for (const needle of ["powerMonitor.on('on-battery'", "powerMonitor.on('on-ac'", 'readSysTransparency', 'EnableTransparency',
    'bindFocusBroadcast', "send('appearance:env-state'", "send('window:focus-state'", 'detectDwmInjectTools']) {
    if (!mainSrc.includes(needle)) throw new Error('main.js 缺少 ' + needle);
  }
  // 焦点广播覆盖全部 5 个窗口创建点
  const bindCount = (mainSrc.match(/bindFocusBroadcast\(/g) || []).length;
  if (bindCount < 6) throw new Error('bindFocusBroadcast 应为 1 定义 + 5 调用，实际 ' + bindCount);
  const lgSrc = fs.readFileSync(abs('src/scripts/liquid-glass.js'), 'utf8');
  for (const needle of ['envBattery', 'envNoTransparency', 'prefers-reduced-transparency', 'effectiveMode']) {
    if (!lgSrc.includes(needle)) throw new Error('liquid-glass.js 缺少环境自适应要素 ' + needle);
  }
  // UI 提示不出现任何第三方品牌名（只描述类别）
  const appSrc = fs.readFileSync(abs('src/scripts/app.js'), 'utf8');
  if (!/检测到第三方窗口美化工具/.test(appSrc)) throw new Error('app.js 缺少兼容性提示文案');
  for (const brand of ['DWMBlurGlass', 'MicaForEveryone', 'TranslucentFlyouts']) {
    if (appSrc.includes(brand)) throw new Error('UI 提示不允许出现第三方品牌名: ' + brand);
  }
  // preload 通道
  const preloadSrc = fs.readFileSync(abs('preload.js'), 'utf8');
  for (const needle of ['getEnv', 'onEnvState', 'onFocusState', 'dwmConflict']) {
    if (!preloadSrc.includes(needle)) throw new Error('preload.js 缺少 ' + needle);
  }
  // IPC 双侧对齐
  for (const ch of ['appearance:get-env', 'diag:dwm-conflict']) {
    if (!mainSrc.includes(`'${ch}'`)) throw new Error('main.js 缺少通道 ' + ch);
    if (!preloadSrc.includes(`'${ch}'`)) throw new Error('preload.js 缺少通道 ' + ch);
  }
});

// ==================== 9. v3.0.0 批次（白色容器玻璃化收敛 / 启动页修复） ====================
console.log('[9] v3.0.0 批次检查');

// 防复发断言（docs规范/白色容器玻璃化收敛-方案设计-2026-09-13 第 4 步）：
// token 真源建立后，main.css 不允许再出现「写死白色容器背景」与「写死 blur 实值」——
// 白名单仅限：值含 var( 的回退、带「刻意设计」注释的行（独立观感：启动页/预览窗/样块预览等）。
check('v3.0 玻璃化防复发：无写死白容器背景、无写死 blur（白名单外）', () => {
  const css = fs.readFileSync(abs('src/styles/main.css'), 'utf8');
  const lines = css.split('\n');
  const WHITE = /(?:#fff(?:\b|[0-9a-f])|white\b|rgba\(\s*255\s*,\s*255\s*,\s*255)/i;
  const offenders = [];
  // 只取 background 声明的「值本身」（冒号到第一个分号，跨行渐变兼容），
  // 避免把同一行后续 color:/border-color: 的白色前景误判为容器背景
  const declRe = /\bbackground(?:-color)?:([^;]+);/g;
  let m;
  while ((m = declRe.exec(css)) !== null) {
    const value = m[1];
    if (!WHITE.test(value)) continue;
    if (value.includes('var(')) continue;                    // var() 回退形态豁免
    const lineNo = css.slice(0, m.index).split('\n').length; // 声明起始行（1 基）
    // 「刻意设计」白名单：注释可能写在声明前数行（块首/多行声明前），回溯 12 行窗口
    let marked = false;
    for (let k = Math.max(0, lineNo - 13); k < lineNo; k++) {
      if (lines[k] && lines[k].includes('刻意设计')) { marked = true; break; }
    }
    if (marked) continue;
    offenders.push('L' + lineNo + ': ' + lines[lineNo - 1].trim().slice(0, 90));
  }
  if (offenders.length) throw new Error('存在写死白色背景（应用 token 或标「刻意设计」）:\n' + offenders.join('\n'));

  const blurOffenders = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/backdrop-filter:[^;]*blur\(\s*\d/.test(lines[i])) continue;
    let marked = false;
    for (let k = Math.max(0, i - 12); k <= i; k++) {
      if (lines[k] && lines[k].includes('刻意设计')) { marked = true; break; }
    }
    if (marked) continue;
    blurOffenders.push('L' + (i + 1) + ': ' + lines[i].trim().slice(0, 90));
  }
  if (blurOffenders.length) throw new Error('存在写死 blur 实值（应用 --glass-blur 派生档位或标「刻意设计」）:\n' + blurOffenders.join('\n'));
});

check('v3.0 表面参数唯一真源与情境覆写清除', () => {
  const css = fs.readFileSync(abs('src/styles/main.css'), 'utf8');
  // 真源要素齐全
  for (const v of ['--surface-tint:', '--surface-alpha-card:', '--surface-alpha-card-hover:',
    '--surface-alpha-elevated:', '--surface-alpha-input:', '--knob-bg:',
    '--glass-blur-faint:', '--glass-blur-soft:', '--glass-blur-mid:', '--glass-blur-strong:']) {
    if (!css.includes(v)) throw new Error('main.css 缺少表面参数 ' + v);
  }
  // 表面 token 必须由参数真源合成（值内引用 --surface-tint），不允许再出现字面量定义
  const defs = css.match(/^\s*--bg-(?:card|card-hover|elevated|input):[^\n]+/gm) || [];
  const bad = defs.filter(d => !d.includes('var(--surface-tint)'));
  if (bad.length) throw new Error('表面 token 出现非合成定义: ' + bad.join(' | '));
  // 情境覆写不得复活：玻璃皮肤/预设壁纸/Mica 块内不允许再写 --bg-card 系覆写
  for (const sel of ['body[data-skin="glass"] {', 'body.electron-mica {', 'body.electron-mica.theme-light {']) {
    const idx = css.indexOf(sel);
    if (idx === -1) continue;
    const block = css.slice(idx, css.indexOf('}', idx));
    if (/--bg-(?:card|card-hover|elevated|input)/.test(block)) throw new Error(sel + ' 内不允许再覆写表面 token');
  }
  if (/body\.theme-light\[data-preset-bg\]\s*\{[^}]*--bg-card/.test(css)) {
    throw new Error('theme-light[data-preset-bg] 的 rgba 覆写应保持删除');
  }
});

check('v3.0 启动页进入编排：淡出前解除 fill:both 动画占用', () => {
  const src = fs.readFileSync(abs('src/scripts/splash.js'), 'utf8');
  const idx = src.indexOf('function enterApp');
  if (idx === -1) throw new Error('enterApp 缺失');
  const seg = src.slice(idx, src.indexOf('function initCanvas') > 0 ? src.indexOf('function initCanvas') : idx + 3000);
  if (!seg.includes("el.style.animation = 'none'")) {
    throw new Error('enterApp 淡出未清入场动画——splashFadeIn fill:both 终帧会覆盖内联 opacity:0（进度条残留复现）');
  }
  // trimEl FLIP 的 animation 解除必须保留（PowerPoint 平滑落位依赖）
  if (!seg.includes("trimEl.style.animation = 'none'")) throw new Error('trimEl 的 animation 解除被动到');
});

check('v3.0 默认应用接管 / 网络检测：页面挂载与 IPC 双侧对齐', () => {
  const html = fs.readFileSync(abs('src/index.html'), 'utf8');
  // 导航项与页面容器成对
  for (const p of ['defaultapps', 'netcheck']) {
    if (!html.includes(`data-page="${p}"`)) throw new Error('index.html 缺少导航项 data-page=' + p);
    if (!html.includes(`id="page-${p}"`)) throw new Error('index.html 缺少页面容器 page-' + p);
  }
  // netcheck 必须挂在测速父项的子菜单里
  const submenu = html.slice(html.indexOf('data-nav-submenu="speed"'), html.indexOf('</div>', html.indexOf('data-nav-submenu="speed"')));
  if (!submenu.includes('data-page="netcheck"')) throw new Error('网络检测未挂进测速父项子菜单');
  // script 标签（ds.js 之后、app.js 之前）
  for (const s of ['scripts/defaultapps.js', 'scripts/netcheck.js']) {
    if (!html.includes(`<script src="${s}"></script>`)) throw new Error('index.html 缺少 script 引用 ' + s);
  }
  const appIdx = html.indexOf('<script src="scripts/app.js"></script>');
  for (const s of ['scripts/defaultapps.js', 'scripts/netcheck.js']) {
    if (html.indexOf(`<script src="${s}"></script>`) > appIdx) throw new Error(s + ' 必须在 app.js 之前加载');
  }
  // preload 命名空间白名单
  const preloadSrc = fs.readFileSync(abs('preload.js'), 'utf8');
  for (const ch of ['defaultapps:status', 'defaultapps:list-programs', 'defaultapps:apply-xml',
    'defaultapps:remove-xml-policy', 'defaultapps:set-ucpd', 'defaultapps:write-class',
    'defaultapps:get-state', 'defaultapps:open-settings', 'netcheck:collect', 'netcheck:repair',
    'appearance:get-expert', 'appearance:set-expert']) {
    if (!preloadSrc.includes(`'${ch}'`)) throw new Error('preload.js 缺少通道 ' + ch);
  }
  // main.js 注册对齐 + 只读白名单收口
  const mainSrc = fs.readFileSync(abs('main.js'), 'utf8');
  for (const ch of ['defaultapps:status', 'defaultapps:list-programs', 'defaultapps:apply-xml',
    'defaultapps:remove-xml-policy', 'defaultapps:set-ucpd', 'defaultapps:write-class',
    'defaultapps:get-state', 'defaultapps:open-settings', 'netcheck:collect', 'netcheck:repair',
    'appearance:get-expert', 'appearance:set-expert']) {
    if (!mainSrc.includes(`'${ch}'`)) throw new Error('main.js 缺少通道 ' + ch);
  }
  // 写类通道绝不能混入只读白名单
  const roMatch = mainSrc.match(/const SIDE_EFFECT_FREE = new Set\(\[([\s\S]*?)\]\);/);
  if (!roMatch) throw new Error('SIDE_EFFECT_FREE 白名单缺失');
  for (const ch of ['defaultapps:apply-xml', 'defaultapps:set-ucpd', 'defaultapps:write-class',
    'defaultapps:remove-xml-policy', 'netcheck:repair', 'appearance:set-expert']) {
    if (roMatch[1].includes(`'${ch}'`)) throw new Error('写通道混入 SIDE_EFFECT_FREE: ' + ch);
  }
  // C 路径必须零哈希：类级关联写入，不允许再出现 UserChoice 哈希计算
  const daSrc = fs.readFileSync(abs('src/scripts-powershell/defaultapps-scripts.js'), 'utf8');
  if (/Get-UserChoiceHash|MD5CryptoServiceProvider|ToBase64String/.test(daSrc)) {
    throw new Error('defaultapps-scripts 不应再包含哈希计算（v3.0 已改为类级关联写入）');
  }
  if (!daSrc.includes('function writeClass')) throw new Error('defaultapps-scripts 缺少类级关联写入 writeClass');
  // 渲染层双模式（按文件类型 / 按程序指定）
  const html2 = html;
  if (!html2.includes('data-da-mode="program"') || !html2.includes('id="daProgramSelect"')) {
    throw new Error('默认应用页缺少「按程序指定」模式结构');
  }
  // UCPD 不再随批量服务优化项禁用（与「默认应用接管」统一管理）
  const optSrc = fs.readFileSync(abs('src/scripts-powershell/optimizer-scripts.js'), 'utf8');
  const svcBlock = optSrc.slice(optSrc.indexOf("id: 'tf_svc_extra5'"), optSrc.indexOf("id: 'tf_ctx_copymove'"));
  if (/["']UCPD["']/.test(svcBlock)) throw new Error('tf_svc_extra5 仍包含 UCPD（应已剔出）');
  // 渲染层只传动作 id / 白名单 key：netcheck 修复不得接受渲染层传命令或网卡名
  const ncMain = mainSrc.slice(mainSrc.indexOf('netcheck:repair'), mainSrc.indexOf('netcheck:repair') + 1600);
  if (!ncMain.includes('netcheckSnapshot.find') || !ncMain.includes('NETCHECK_SCRIPT.repair')) {
    throw new Error('netcheck:repair 未走检测快照白名单链路');
  }
});

// ==================== 9. 注册表键归属校验（M4/M5，2026-09-14 重复点审查） ====================
// 同一注册表键下的每个值名只能由一个模块写入；越界或归属表过期都算失败。
console.log('[9/9] 注册表键归属校验');
check('共享注册表键均由唯一模块写入（src/data/reg-ownership.json）', () => {
  const { checkOwnership } = require('./scripts/check-reg-ownership');
  const r = checkOwnership();
  if (r.violations.length) throw new Error('越界写入：\n    ' + r.violations.join('\n    '));
  if (r.missing.length) throw new Error('归属表已过期（请同步更新 reg-ownership.json）：\n    ' + r.missing.join('\n    '));
});

// ==================== 10. v3.5.0 精细化审查批（T1 回归断言） ====================
// 每个 🔴 修复附回归断言（职能家族 S13：零覆盖是这些缺陷的潜伏原因）；外加 T1-4
// 「独立窗口脚本禁引用 window.app」防 PE-1 复发。断言采用源码文本锚，只读不启动应用。
console.log('[10] v3.5.0 精细化审查批');

check('CM-15/CM-16：右键 toggle/remove 请求体带 id + 启停按 id 回挂目标态', () => {
  const cm = fs.readFileSync(abs('src/scripts/contextmenu.js'), 'utf8');
  if (!cm.includes('id: p.item.id')) throw new Error('toggle 请求体未补 id（CM-15）');
  if (!cm.includes('id: item.id')) throw new Error('remove 请求体未补 id（CM-15）');
  const main = fs.readFileSync(abs('main.js'), 'utf8');
  if (!main.includes('wantedEnabled.set(it.id')) throw new Error('toggle 未按 id 回挂调用方 enabled（CM-16）');
  if (!main.includes("wantedEnabled.has(it.id) ? wantedEnabled.get(it.id) : !!it.enabled")) throw new Error('toggle 目标态回挂不完整');
});

check('FC-1/FC-3：文件清理白名单按 type 分槽 + 仅 .dat 归可删 data', () => {
  const main = fs.readFileSync(abs('main.js'), 'utf8');
  if (!main.includes('const fileCleanScopes = new Map()')) throw new Error('文件清理白名单未按 type 分槽（FC-1，QQ+微信互相覆盖）');
  if (!main.includes("endsWith('.dat')) category = 'data'")) throw new Error('FC-3 未收窄 .dat');
  if (main.includes("endsWith('.db') || entry.name.endsWith('.adb')")) throw new Error('FC-3 仍把 .db/.adb 归可删 data（聊天库零确认删除风险）');
});

check('FD-1：finder:delete 部分失败不整批丢弃（success=通道语义 + 回传 data）', () => {
  const main = fs.readFileSync(abs('main.js'), 'utf8');
  if (!main.includes('success: true, data: { totalFreed, success, failed')) throw new Error('finder:delete 未改通道成功语义（FD-1）');
  if (!main.includes('flushLogSync();')) throw new Error('finder:delete 未前刷日志');
});

check('FD-4：finder:delete 删除前预检（statSync + 目标已消失剔除）', () => {
  const main = fs.readFileSync(abs('main.js'), 'utf8');
  if (!main.includes("const st = fs.statSync(it.path)")) throw new Error('finder:delete 删除前无预检（FD-4）');
  if (!main.includes('目标已不存在')) throw new Error('FD-4 未对已消失目标做剔除提示');
});

check('SR-1：create-restore 必须解析 @@FAILED 且创建后回读还原点数量', () => {
  const main = fs.readFileSync(abs('main.js'), 'utf8');
  if (!main.includes('@@FAILED')) throw new Error('create-restore 未解析失败协议（SR-1 门禁架空）');
  if (!main.includes('创建后回读')) throw new Error('create-restore 未做创建后回读（假成功）');
  const opt = fs.readFileSync(abs('src/scripts-powershell/optimizer-scripts.js'), 'utf8');
  if (!opt.includes('$failedSteps++')) throw new Error('buildScript pwsh 分支缺失败计数（SR-1）');
});

check('PM-1/PM-2：memory:kill 主进程关键进程黑名单 + 自我防护 + 空路径不合并分组', () => {
  const main = fs.readFileSync(abs('main.js'), 'utf8');
  if (!main.includes('const CRITICAL_PROCESS_NAMES = new Set(')) throw new Error('memory:kill 无关键进程黑名单（PM-1 蓝屏边界）');
  if (!main.includes('不能结束 Trim 自身进程')) throw new Error('memory:kill 无自我防护（PM-1）');
  const pc = fs.readFileSync(abs('src/scripts/processes.js'), 'utf8');
  if (!pc.includes('__nopath__:')) throw new Error('空路径进程被合并分组（PM-2 一键蓝屏）');
  if (!pc.includes('PM_CRITICAL_NAMES')) throw new Error('processes.js 未给系统进程只读态');
});

check('PE-1/T1-4：独立窗口脚本各自自带 toast，不调用 window.app/window.modal 的 toast（防静默无反馈）', () => {
  const windows = ['peripheral-window.js', 'models-window.js', 'process-manager-window.js', 'preview-window.js'];
  for (const f of windows) {
    const src = fs.readFileSync(abs('src/scripts/' + f), 'utf8');
    if (!/^\s*function toast\s*\(/m.test(src)) throw new Error(f + ' 未自建 toast（PE-1 静默无反馈）');
    // 只拦「调用形」`?.toast(`；注释里点名该隐患的文本不含括号调用，不误伤。
    if (/window\.app\s*\?\s*\.toast\s*\(|window\.modal\s*\?\s*\.toast\s*\(/.test(src)) throw new Error(f + ' 调用 window.app/window.modal 的 toast（PE-1 复发）');
    if (/window\.app\s*\.toast\s*\(/.test(src)) throw new Error(f + ' 以 window.app.toast(...) 调能力（须自建 toast）');
  }
});

check('S4：特权操作服务端 isAdmin + needAdmin 门禁统一（OPT/PE/MA/SU/CM/M）', () => {
  const main = fs.readFileSync(abs('main.js'), 'utf8');
  const gates = [
    '优化操作需要管理员权限',   // OPT-1 optimizer:run
    '外设优化需要管理员权限',   // PE-4 peripheral:apply
    '该维护任务需要管理员权限', // MA-2 maintenance run
    '涉及「所有用户」的启动项需要管理员权限', // SU-1 startup
    '涉及系统级右键菜单的操作需要管理员权限', // CM-3 contextmenu
    '内存清理需要管理员权限'    // M-3 memory:clean
  ];
  for (const g of gates) {
    if (!main.includes(g)) throw new Error('S4 门禁缺失: ' + g);
    if (!main.includes('needAdmin')) throw new Error('S4 未返回 needAdmin 提权入口');
  }
});

check('S6：外设写前备份 + 默认应用记录原 ProgId + 还原点补记账备份', () => {
  const pv = fs.readFileSync(abs('src/scripts-powershell/peripheral-scripts.js'), 'utf8');
  if (!pv.includes('peripheral-backup')) throw new Error('外设 APPLY 未写前备份（PE-5）');
  const da = fs.readFileSync(abs('src/scripts-powershell/defaultapps-scripts.js'), 'utf8');
  if (!da.includes('原 ProgId')) throw new Error('write-class 未记录原 ProgId（DA-3）');
  const main = fs.readFileSync(abs('main.js'), 'utf8');
  if (!/SR-3|OPT_STATE/.test(main)) throw new Error('create-restore 未补记账/备份（SR-3）');
});

check('PE-3：外设白名单合法值集合单一来源（PERIPHERAL_ALLOWED 接入校验）', () => {
  const main = fs.readFileSync(abs('main.js'), 'utf8');
  if (!main.includes('PERIPHERAL_ALLOWED')) throw new Error('main.js 缺 PERIPHERAL_ALLOWED 白名单');
});

// ==================== v3.5.2 v7 审计修复批次 ====================
check('N-1：diskbench 白名单/空间预检三符号已在 main.js 定义并接线', () => {
  const src = fs.readFileSync(abs('main.js'), 'utf8');
  for (const sym of ['function isDiskBenchAllowedPath', 'function getPathFreeBytes', 'const DISKBENCH_MIN_FREE_BYTES']) {
    if (!src.includes(sym)) throw new Error('缺少定义: ' + sym);
  }
  if (!src.includes('isDiskBenchAllowedPath(resolved)')) throw new Error('diskbench:run 未接线白名单');
});

check('OPT-1：高危清单服务端镜像 + confirmedHighRisk 回执双侧接线', () => {
  const main = fs.readFileSync(abs('main.js'), 'utf8');
  const rnd = fs.readFileSync(abs('src/scripts/optimizer.js'), 'utf8');
  if (!main.includes('OPTIMIZER_HAZARD_IDS')) throw new Error('主进程缺高危镜像清单');
  if (!main.includes('params.confirmedHighRisk !== true')) throw new Error('主进程未校验确认回执');
  if (!rnd.includes('runParams.confirmedHighRisk = true')) throw new Error('渲染层未携带确认回执');
  if (!main.includes("'disable_uac'") || !main.includes("'bcd_opt'")) throw new Error('镜像清单 id 不全');
});

check('SR-5：DMTF ±000 偏移按本地时间解释', () => {
  const src = fs.readFileSync(abs('main.js'), 'utf8');
  if (!src.includes('offsetMinutes === 0')) throw new Error('缺少 ±000 本地时间分支');
});

check('MA-1/MA-3：maintenance .reg 走 TRIM_TMP + wu 旧目录清扫', () => {
  const src = fs.readFileSync(abs('src/scripts-powershell/maintenance-scripts.js'), 'utf8');
  if (!src.includes('TRIM_TMP')) throw new Error('.reg 临时文件未走 TRIM_TMP');
  if (!src.includes('.old_*')) throw new Error('缺 wu 旧目录清扫');
});

check('FD-4：空目录删除前空复检（empty 标记 + readdir 预检）', () => {
  const src = fs.readFileSync(abs('main.js'), 'utf8');
  if (!src.includes("empty: item.type === 'emptyfolder'")) throw new Error('快照缺 empty 标记');
  if (!src.includes('空目录已不再为空')) throw new Error('缺空复检');
});

check('RT-1：运行库安装执行前 SHA-256 复核', () => {
  const src = fs.readFileSync(abs('main.js'), 'utf8');
  if (!src.includes('执行前复核未通过')) throw new Error('缺执行前复核');
});

check('LG-1：滤镜桶引用计数回收（useFilter/releaseFilter/sweepUnusedFilters）', () => {
  const src = fs.readFileSync(abs('src/scripts/liquid-glass.js'), 'utf8');
  for (const sym of ['function useFilter', 'function releaseFilter', 'function sweepUnusedFilters', 'sweepUnusedFilters() === 0']) {
    if (!src.includes(sym)) throw new Error('缺少: ' + sym);
  }
});

check('SET-3：models[].apiKey 掩码穿透', () => {
  const src = fs.readFileSync(abs('main.js'), 'utf8');
  if (!src.includes('submitted.apiKey !== undefined')) throw new Error('models apiKey 缺掩码穿透');
});

check('PM-4：进程管理窗 Esc 守卫（确认框打开时不关窗）', () => {
  const src = fs.readFileSync(abs('src/scripts/process-manager-window.js'), 'utf8');
  if (!src.includes("querySelector('.usage-backdrop')")) throw new Error('缺 Esc 守卫');
});

check('v7-2/v7-3：Rust protect_roots 落 default_from_env + 回收站失败原因透传', () => {
  const rs = fs.readFileSync(abs('native-scanner/src/main.rs'), 'utf8');
  if (!rs.includes('ProtectRoots::default_from_env)')) throw new Error('protect_roots 仍落空 Default');
  if (!rs.includes('回收站失败: ')) throw new Error('删除结果缺真实原因');
  if (rs.includes('已永久删除（目标卷不支持回收站）')) throw new Error('硬编码误导文案仍在');
});

check('F2：checkupCache 死代码已删除', () => {
  const src = fs.readFileSync(abs('main.js'), 'utf8');
  if (src.includes('checkupCache')) throw new Error('checkupCache 仍存在');
});


// ==================== 汇总 ====================
console.log('');
console.log(`结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
