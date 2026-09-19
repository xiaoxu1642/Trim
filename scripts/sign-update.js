#!/usr/bin/env node
// sign-update.js — 自动更新通道的发布侧签名工具（v3.6.5 M1-1，仅发布机使用，不参与应用打包）
// 用法：
//   node scripts/sign-update.js gen                   生成更新专用 ed25519 密钥对
//   node scripts/sign-update.js sign                  从 GitHub 拉 latest.yml 签名并上传 latest.yml.sig
//   node scripts/sign-update.js verify <yml> <sig>    离线验签（排查用）
// 密钥目录：~/.trim-signing/update-ed25519-{private,public}.pem
//
// 密钥轮换顺序（硬约束，弄错会锁死老用户）：
//   ① 内置 [旧, 新] 两把公钥发一版应用 → ② 等用户升级 → ③ 再用新私钥签名发布
//   → ④ 稳定后再发一版收敛为 [新]。
//   反序（先换私钥再发新版）会让只认旧公钥的老用户永久验签失败。
//
// 为什么与规则库密钥分开：用途隔离。规则库私钥泄露的影响面是「清理规则被改写」，
// 更新链私钥泄露的影响面是「任意代码执行」。分开后一处泄露不等于两条链路同时失守，成本为零。
//
// 发布纪律：v3.6.5 起每次 release 都必须带 latest.yml.sig。本脚本幂等（重跑会先删旧 asset）。
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SIGNING_DIR = path.join(os.homedir(), '.trim-signing');
const PRIV_KEY = path.join(SIGNING_DIR, 'update-ed25519-private.pem');
const PUB_KEY = path.join(SIGNING_DIR, 'update-ed25519-public.pem');
const SIGNATURE_MODULE = path.join(__dirname, '..', 'src', 'main', 'update-signature.js');
const PKG = path.join(__dirname, '..', 'package.json');

function repoInfo() {
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const pub = (pkg.build && pkg.build.publish && pkg.build.publish[0]) || {};
  const owner = pub.owner || '';
  const repo = pub.repo || '';
  if (!owner || !repo) throw new Error('package.json 的 build.publish[0] 缺少 owner/repo');
  return { owner, repo, version: pkg.version };
}

// ———————————————————————————— gen ————————————————————————————
function gen() {
  if (fs.existsSync(PRIV_KEY) && !process.argv.includes('--force')) {
    console.error('私钥已存在: ' + PRIV_KEY);
    console.error('如确需重新生成（会使已发布签名全部失效，须按轮换顺序先发内置 [旧,新] 公钥的版本），加 --force。');
    process.exit(1);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(SIGNING_DIR, { recursive: true });
  fs.writeFileSync(PRIV_KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(PUB_KEY, publicKey.export({ type: 'spki', format: 'pem' }));
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).trim();

  // 自动回填公钥到验签模块（与 sign-rules.js:31-39 同范式）
  let mod = fs.readFileSync(SIGNATURE_MODULE, 'utf8');
  const re = /-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/;
  if (!re.test(mod)) {
    console.error('未在 update-signature.js 找到公钥占位块，请手动替换');
    process.exit(1);
  }
  mod = mod.replace(re, pubPem);
  fs.writeFileSync(SIGNATURE_MODULE, mod, 'utf8');

  console.log('更新签名密钥对已生成：');
  console.log('  私钥（保管好，勿入仓库/勿打包）: ' + PRIV_KEY);
  console.log('  公钥（已自动内置到 update-signature.js）');
}

// ———————————————————————————— verify（离线） ————————————————————————————
function verify(yamlPath, sigPath) {
  const { verifyUpdateInfoSignature, extractUpdateAnchor } = require(SIGNATURE_MODULE);
  const rawBuf = fs.readFileSync(yamlPath);
  const sigText = fs.readFileSync(sigPath, 'utf8');
  const v = verifyUpdateInfoSignature(rawBuf, sigText);
  console.log('验签结果: ' + JSON.stringify(v));
  if (!v.ok) process.exit(1);
  const anchor = extractUpdateAnchor(rawBuf.toString('utf8'));
  console.log('锚点抽取: ' + JSON.stringify(anchor));
  if (!anchor) { console.error('锚点抽取失败'); process.exit(1); }
  console.log('通过：签名有效且锚点结构正常');
}

// ———————————————————————————— sign ————————————————————————————
function token() {
  const t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!t) {
    console.error('缺少 GitHub token：请设置 GH_TOKEN 或 GITHUB_TOKEN（需 contents:write 权限）。');
    console.error('本脚本走 GitHub REST API；本机无 gh CLI，故不依赖它。');
    process.exit(1);
  }
  return t; // 绝不打印 token 本身
}

async function gh(pathname, opts = {}) {
  const res = await fetch('https://api.github.com' + pathname, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token(), Accept: 'application/vnd.github+json', 'User-Agent': 'trim-sign-update', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`GitHub API ${pathname} → ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function fetchRaw(url, label) {
  const res = await fetch(url, { headers: { 'User-Agent': 'trim-sign-update' } });
  if (!res.ok) throw new Error(`${label} 拉取失败: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function sign() {
  if (!fs.existsSync(PRIV_KEY)) {
    console.error('未找到私钥，请先执行: node scripts/sign-update.js gen');
    process.exit(1);
  }
  const { owner, repo, version } = repoInfo();
  const tag = 'v' + version;
  const { verifyUpdateInfoSignature, extractUpdateAnchor } = require(SIGNATURE_MODULE);
  console.log(`目标发布: ${owner}/${repo} @ ${tag}`);

  // 1) 定位 release（electron-builder 的 tag 约定为 v{version}；找不到再退 releases/latest）
  const releases = await gh(`/repos/${owner}/${repo}/releases?per_page=30`);
  let rel = releases.find((r) => r.tag_name === tag);
  if (!rel) {
    console.log(`未找到 tag ${tag}，改用 releases/latest`);
    rel = await gh(`/repos/${owner}/${repo}/releases/latest`);
  }
  console.log(`已定位 release: ${rel.tag_name} (id=${rel.id})`);

  // 2) 幂等：已存在 latest.yml.sig 先删除
  const assets = await gh(`/repos/${owner}/${repo}/releases/${rel.id}/assets?per_page=100`);
  for (const a of assets) {
    if (a.name === 'latest.yml.sig') {
      console.log('发现已存在的 latest.yml.sig，先删除（保证可重跑幂等）');
      const del = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${a.id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token(), Accept: 'application/vnd.github+json', 'User-Agent': 'trim-sign-update' },
      });
      if (!del.ok && del.status !== 404) throw new Error(`删除旧签名失败: HTTP ${del.status}`);
    }
  }

  // 3) 拉取**远端已发布**的 latest.yml 原始字节（不是签本地文件——绕开「上传字节是否等于本地字节」的不可判定问题）
  const dl = `https://github.com/${owner}/${repo}/releases/download/${rel.tag_name}/latest.yml`;
  const raw = await fetchRaw(dl, 'latest.yml');
  console.log(`已拉取 latest.yml（${raw.length} 字节）`);

  // 4) 签名
  const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIV_KEY, 'utf8'));
  const sigB64 = crypto.sign(null, raw, privateKey).toString('base64');

  // 5) 上传前先用内置公钥自验（防「私钥与内置公钥不配对」导致发布出去的签名永远验不过）
  const self = verifyUpdateInfoSignature(raw, sigB64);
  if (!self.ok) {
    console.error('自验失败（内置公钥与本私钥不配对？）: ' + JSON.stringify(self));
    process.exit(1);
  }
  console.log('自验通过（内置公钥与本私钥配对）');

  // 6) 上传
  const up = await fetch(
    `https://uploads.github.com/repos/${owner}/${repo}/releases/${rel.id}/assets?name=latest.yml.sig`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token(),
        'Content-Type': 'application/octet-stream',
        Accept: 'application/vnd.github+json',
        'User-Agent': 'trim-sign-update',
      },
      body: sigB64,
    }
  );
  if (!up.ok) throw new Error(`上传签名失败: HTTP ${up.status} ${(await up.text()).slice(0, 300)}`);
  console.log('latest.yml.sig 已上传');

  // 7) 回读校验（带 cache-buster，避开 CDN 缓存读到旧副本）
  const cb = Date.now();
  const raw2 = await fetchRaw(`${dl}?s=${cb}`, 'latest.yml(回读)');
  const sig2 = (await fetchRaw(`https://github.com/${owner}/${repo}/releases/download/${rel.tag_name}/latest.yml.sig?s=${cb}`, 'latest.yml.sig(回读)')).toString('utf8');
  const v2 = verifyUpdateInfoSignature(raw2, sig2);
  if (!v2.ok) { console.error('回读验签失败: ' + JSON.stringify(v2)); process.exit(1); }
  const anchor = extractUpdateAnchor(raw2.toString('utf8'));
  if (!anchor) { console.error('回读锚点抽取失败'); process.exit(1); }
  console.log(`回读校验通过：version=${anchor.version} file=${anchor.file}`);
}

const cmd = process.argv[2];
(async () => {
  try {
    if (cmd === 'gen') gen();
    else if (cmd === 'sign') { token(); await sign(); }
    else if (cmd === 'verify') verify(process.argv[3], process.argv[4]);
    else {
      console.log('用法: node scripts/sign-update.js gen | sign | verify <yml> <sig>');
      process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    console.error('失败: ' + (e && e.message));
    process.exit(1);
  }
})();
