#!/usr/bin/env node
// gen-fallback.js - 从 src/data/cleanup-rules.json 生成渲染层 FALLBACK 数据（审查 2-2）
// 彻底消除 cleanup.js 手工 FALLBACK 副本与规则 JSON 的双源漂移：cleanup.js 的
// CATEGORIES_FALLBACK 改为经 buildCategoriesFromRules 从本脚本产出的原始 JSON 构建。
// 用法：node scripts/gen-fallback.js（npm run build 前经 prebuild 钩子自动执行；
//       test-features.js 含双源一致性断言，generated 与源 JSON 不一致时测试失败）
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'data', 'cleanup-rules.json');
const OUT = path.join(__dirname, '..', 'src', 'scripts', 'cleanup-fallback.generated.js');

const raw = fs.readFileSync(SRC, 'utf8');
JSON.parse(raw); // 先校验源是合法 JSON，异常直接抛出终止构建
// 全量内联（含 _sig）：test 一致性断言按整段比对；渲染层构建分类只读 groups，多余字段无影响。
// 火眼眼审查 2026-09-14（LOW）：以 JSON.parse(字符串字面量) 而非对象字面量直拼——源文本经
// JSON.stringify 转义后不再作为 JS 代码解析，未来若数据源引入不可信内容也不会注入执行。
const out = `// 本文件由 scripts/gen-fallback.js 从 src/data/cleanup-rules.json 自动生成（审查 2-2）。
// 勿手改——修改规则 JSON 后运行 node scripts/gen-fallback.js 重新生成（npm run build 前自动执行）。
// 用途：cleanup.js 浏览器预览 / IPC 不可用时的分类兜底（经 buildCategoriesFromRules 构建）。
(function (root) {
  'use strict';
  root.CLEANUP_RULES_FALLBACK = JSON.parse(${JSON.stringify(raw.trim())});
})(typeof window !== 'undefined' ? window : globalThis);
`;
fs.writeFileSync(OUT, out, 'utf8');
console.log('已生成: ' + OUT);
