// test-features.js - 无头功能冒烟测试
// 不启动 Electron，仅做静态/模块级验证：语法、数据文件、脚本生成、页面挂载。
// 运行：npm test
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SECURITY = require('./src/security');

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
  'src/diag.js',
  'src/scripts-powershell/cleanup-scripts.js',
  'src/scripts-powershell/maintenance-scripts.js',
  'src/scripts/app.js',
  'src/scripts/cleanup.js',
  'src/scripts/intro.js',
  'src/scripts/maintenance.js',
  'src/scripts/netspeed-detector.js',
  'src/scripts/netspeed.js',
  'src/scripts/theme.js',
  'src/scripts/xtable.js'
];

console.log('[1/5] JS 语法检查');
for (const f of SYNTAX_FILES) {
  check('node --check ' + f, () => {
    execFileSync(process.execPath, ['--check', abs(f)], { stdio: 'pipe' });
  });
}

check('security 原子 JSON 写入可读回', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tuneforge-test-'));
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
  const d = require(abs('src/diag.js'));
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
  const css = fs.readFileSync(abs('src/styles/main.css'), 'utf8');
  if (!mainSource.includes('MAIN_WINDOW_MIN_WIDTH = 1294') || !mainSource.includes('MAIN_WINDOW_MIN_HEIGHT = 870')) {
    throw new Error('主窗口最小尺寸不是 1294x870');
  }
  if (!mainSource.includes("color: '#F3F3F3'") || !mainSource.includes("symbolColor: '#1A1A1A'")) {
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

// ==================== 汇总 ====================
console.log('');
console.log(`结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
