#!/usr/bin/env node
// sign-rules.js - 清理规则库签名工具（审查 1-1，仅发布机使用，不参与应用打包）
// 用法：
//   node scripts/sign-rules.js gen          生成 ed25519 密钥对（私钥默认 ~/.trim-signing/，绝不入仓库）
//   node scripts/sign-rules.js sign [file]  签名规则文件（默认 src/data/cleanup-rules.json）
// 发布流程：修改规则 → node scripts/sign-rules.js sign → 提交推送 → 应用内「更新规则库」验签通过。
// 注意：未签名的规则文件会被应用在线更新链路拒绝（缺少 _sig）；私钥丢失/更换后必须随新版应用更新内置公钥。
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SIGNING_DIR = path.join(os.homedir(), '.trim-signing');
const PRIV_KEY = path.join(SIGNING_DIR, 'rules-ed25519-private.pem');
const PUB_KEY = path.join(SIGNING_DIR, 'rules-ed25519-public.pem');
const SIGNATURE_MODULE = path.join(__dirname, '..', 'src', 'main', 'rules-signature.js');
const DEFAULT_RULES = path.join(__dirname, '..', 'src', 'data', 'cleanup-rules.json');

function gen() {
  if (fs.existsSync(PRIV_KEY) && !process.argv.includes('--force')) {
    console.error('私钥已存在: ' + PRIV_KEY);
    console.error('如确需重新生成（会使已发布签名全部失效，须同步发新版应用），加 --force。');
    process.exit(1);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(SIGNING_DIR, { recursive: true });
  fs.writeFileSync(PRIV_KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(PUB_KEY, publicKey.export({ type: 'spki', format: 'pem' }));
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).trim();
  // 自动回填公钥到验签模块（main.js 经该模块取公钥，无需改动）
  let mod = fs.readFileSync(SIGNATURE_MODULE, 'utf8');
  const re = /-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/;
  if (!re.test(mod)) {
    console.error('未在 rules-signature.js 找到公钥占位块，请手动替换');
    process.exit(1);
  }
  mod = mod.replace(re, pubPem);
  fs.writeFileSync(SIGNATURE_MODULE, mod, 'utf8');
  console.log('密钥对已生成：');
  console.log('  私钥（保管好，勿入仓库/勿打包）: ' + PRIV_KEY);
  console.log('  公钥（已自动内置）: ' + SIGNATURE_MODULE);
}

function sign(file) {
  const target = file || DEFAULT_RULES;
  if (!fs.existsSync(PRIV_KEY)) {
    console.error('未找到私钥，请先执行: node scripts/sign-rules.js gen');
    process.exit(1);
  }
  const raw = fs.readFileSync(target, 'utf8');
  const parsed = JSON.parse(raw); // 先解析，确保待签文件本身是合法 JSON
  const { canonicalBodyText, verifyRulesSignature } = require(SIGNATURE_MODULE);
  const bodyText = canonicalBodyText(parsed);
  const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIV_KEY, 'utf8'));
  const sig = crypto.sign(null, Buffer.from(bodyText, 'utf8'), privateKey).toString('base64');
  parsed._sig = { alg: 'ed25519', sig };
  fs.writeFileSync(target, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  console.log('已签名: ' + target);
  // 签完立即用内置公钥自验一遍，防止公钥/私钥不配对导致发布无效
  const check = verifyRulesSignature(fs.readFileSync(target, 'utf8'));
  if (!check.ok) {
    console.error('自验失败: ' + check.reason);
    process.exit(1);
  }
  console.log('自验通过（内置公钥与本私钥配对）');
}

const cmd = process.argv[2];
if (cmd === 'gen') gen();
else if (cmd === 'sign') sign(process.argv[3]);
else {
  console.log('用法: node scripts/sign-rules.js gen | sign [规则文件路径]');
  process.exit(cmd ? 1 : 0);
}
