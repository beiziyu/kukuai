'use strict';
/**
 * 授权校验：机器码绑定 + 过期时间 + HMAC 签名。
 * 只有拿到与机器码匹配、未过期、签名正确的 license.key 才会放行。
 */
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ⚠️ 发布前请替换成你自己的随机串（用于签名，配合代码混淆/单文件打包才有意义）
const SECRET = process.env.KAMI_LICENSE_SECRET || 'kami-license-secret-change-me-2026';

const LICENSE_FILE =
  process.env.KAMI_LICENSE_FILE || path.join(__dirname, 'license.key');

/** 机器码：主机名 + 网卡 MAC + CPU 型号 的指纹 */
function machineCode() {
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00')
    .map((n) => n.mac);
  const parts = [
    os.hostname(),
    [...new Set(macs)].sort().join(','),
    (os.cpus()[0] || {}).model || '',
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16).toUpperCase();
}

function sign(code, expiry) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${code}:${expiry}`)
    .digest('hex')
    .slice(0, 32);
}

/** 返回 { ok, reason } */
function verify() {
  if (!fs.existsSync(LICENSE_FILE)) {
    return { ok: false, reason: '缺少授权文件 license.key' };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
  } catch (_e) {
    return { ok: false, reason: 'license.key 格式错误' };
  }
  const { code, expiry, sign: s } = raw || {};
  if (!code || !expiry || !s) return { ok: false, reason: 'license.key 字段缺失' };
  if (s !== sign(String(code), String(expiry))) return { ok: false, reason: '授权签名无效' };
  if (Date.now() > Number(expiry)) return { ok: false, reason: '授权已过期' };
  if (String(code) !== machineCode()) return { ok: false, reason: '授权机器不匹配' };
  return { ok: true };
}

module.exports = { machineCode, verify, sign };
