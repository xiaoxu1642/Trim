'use strict';

const fs = require('fs');
const path = require('path');

const SECRET_PREFIX = 'dpapi:v1:';

function atomicWriteFile(filePath, contents, encoding = 'utf8') {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, 'w');
    fs.writeFileSync(fd, contents, { encoding });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
  }
}

function atomicWriteJson(filePath, value) {
  atomicWriteFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function encryptSecret(value, safeStorage) {
  const plain = String(value || '');
  if (!plain) return '';
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统暂不可用安全密钥存储，拒绝明文保存 API 密钥');
  }
  return SECRET_PREFIX + safeStorage.encryptString(plain).toString('base64');
}

function decryptSecret(value, safeStorage) {
  const raw = String(value || '');
  if (!raw.startsWith(SECRET_PREFIX)) return raw;
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(raw.slice(SECRET_PREFIX.length), 'base64'));
  } catch (_) {
    return '';
  }
}

const SECRET_FIELDS = new Set(['apiKey', 'aiApiKey', 'baiduApiKey', 'metasoApiKey', 'zhihuApiKey', 'zhihuAccessSecret']);

function transformSecrets(value, transform) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => transformSecrets(item, transform));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_FIELDS.has(key) && typeof item === 'string'
      ? transform(item)
      : transformSecrets(item, transform);
  }
  return out;
}

function encryptSettings(settings, safeStorage) {
  return transformSecrets(settings, value => encryptSecret(value, safeStorage));
}

function decryptSettings(settings, safeStorage) {
  return transformSecrets(settings, value => decryptSecret(value, safeStorage));
}

module.exports = {
  SECRET_PREFIX,
  atomicWriteFile,
  atomicWriteJson,
  encryptSecret,
  decryptSecret,
  encryptSettings,
  decryptSettings
};
