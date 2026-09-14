// check-reg-ownership.js - 注册表键归属校验（M4/M5，2026-09-14 优化中心重复点审查）
// 规则与背景见 src/data/reg-ownership.json 的 _comment。
// 目标：同一个注册表键下的每个值名，只能由一个模块写入。两个模块各写一半时，
//       任何一方「还原」都会按整键回滚或连坐删掉对方的键值，用户也说不清值是谁写的。
// 用法：
//   node scripts/check-reg-ownership.js       直接跑，退出码 0 通过 / 1 越界
//   require 后调用 checkOwnership()            供 test-features.js 接入 npm test
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 根键归一化：HKEY_LOCAL_MACHINE / HKLM: / HKLM → HKLM，并压掉重复反斜杠与首尾空白
function normRoot(p) {
  return String(p)
    .replace(/^HKEY_LOCAL_MACHINE/i, 'HKLM')
    .replace(/^HKEY_CURRENT_USER/i, 'HKCU')
    .replace(/^HKEY_CLASSES_ROOT/i, 'HKCR')
    .replace(/^HKEY_USERS/i, 'HKU')
    .replace(/^HKEY_CURRENT_CONFIG/i, 'HKCC')
    .replace(/^(HKLM|HKCU|HKCR|HKU|HKCC):/i, '$1')
    .replace(/\\{2,}/g, '\\')
    .trim()
    .toUpperCase();
}

function normKey(k) {
  return normRoot(k).replace(/\s+/g, ' ');
}

// 解析 .reg 文本 → [{key, name, val}]；只认整行的 [SECTION] 与 "name"=value，
// 因此 PowerShell 脚本里混排的 [Console]::X = ... / [pscustomobject]@{...} 不会被误匹配
function parseReg(text) {
  const out = [];
  if (!text) return out;
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const t = raw.trim();
    const m = t.match(/^\[(.+?)\]$/);
    if (m) { cur = normKey(m[1]); continue; }
    const kv = t.match(/^"([^"]+)"=(.*)$/);
    if (kv && cur) out.push({ key: cur, name: kv[1], val: String(kv[2]).trim() });
  }
  return out;
}

// 收集「键::值名 → 写入方集合」
function collectWrites() {
  const writes = new Map();
  const add = (key, name, mod) => {
    const id = normKey(key) + '::' + String(name).toUpperCase();
    if (!writes.has(id)) writes.set(id, new Set());
    writes.get(id).add(mod);
  };

  // 1) 电脑优化中心：OPTIONS 的 reg 步骤
  const OPTIMIZER = require(path.join(ROOT, 'src', 'scripts-powershell', 'optimizer-scripts.js'));
  for (const o of (OPTIMIZER.OPTIONS || [])) {
    for (const s of (o.steps || [])) {
      if (s && typeof s.reg === 'string') parseReg(s.reg).forEach(r => add(r.key, r.name, 'optimizer'));
    }
  }

  // 2) 系统维护：TASKS 逐项生成真实脚本后再解析（reg 以 here-string 原样嵌入）
  const MAINT = require(path.join(ROOT, 'src', 'scripts-powershell', 'maintenance-scripts.js'));
  for (const t of (MAINT.list ? MAINT.list() : [])) {
    let script = '';
    try { script = MAINT.run(t.id); } catch (_) { continue; }
    parseReg(script).forEach(r => add(r.key, r.name, 'maintenance'));
  }

  return writes;
}

function checkOwnership() {
  const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'reg-ownership.json'), 'utf8'));
  const entries = Array.isArray(table.entries) ? table.entries : [];
  const writes = collectWrites();

  const violations = []; // 越界写入：声明的 owner 之外还有模块在写
  const missing = [];    // 表里声明了、但代码里已无人写入（归属表过期）

  for (const e of entries) {
    const id = normKey(e.key) + '::' + String(e.name).toUpperCase();
    const actual = writes.get(id);
    const label = `${e.key} :: ${e.name}`;
    if (!actual || !actual.size) { missing.push(`${label}（声明归属 ${e.owner}，但当前无任何模块写入该值）`); continue; }
    const others = [...actual].filter(m => m !== e.owner);
    if (others.length) {
      violations.push(`${label} 应仅由 ${e.owner} 写入，实际还有 [${others.join(', ')}] 在写`);
    }
  }

  return { ok: !violations.length && !missing.length, entries: entries.length, violations, missing };
}

module.exports = { checkOwnership, normKey, parseReg };

if (require.main === module) {
  const r = checkOwnership();
  console.log(`注册表键归属校验：检查 ${r.entries} 条共享键声明`);
  r.violations.forEach(v => console.error('  FAIL  越界写入  ' + v));
  r.missing.forEach(v => console.error('  FAIL  归属表过期  ' + v));
  if (r.ok) console.log('  PASS  全部共享键均由唯一模块写入');
  process.exit(r.ok ? 0 : 1);
}
