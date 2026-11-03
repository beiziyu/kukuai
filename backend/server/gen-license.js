#!/usr/bin/env node
/**
 * 生成授权文件 license.key
 * 用法：
 *   node gen-license.js [机器码] [天数]
 *   例：node gen-license.js               # 给本机生成，默认 365 天
 *       node gen-license.js ABCDEF1234567890 30   # 给指定机器码生成 30 天
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { machineCode, sign } = require('./license');

const [codeArg, daysArg] = process.argv.slice(2);
const code = codeArg || machineCode();
const days = Number(daysArg || 365);
if (!Number.isFinite(days) || days <= 0) {
  console.error('天数需为正数');
  process.exit(1);
}
const expiry = Date.now() + Math.round(days * 86400 * 1000);
const key = { code, expiry, sign: sign(code, expiry) };
fs.writeFileSync(path.join(__dirname, 'license.key'), JSON.stringify(key, null, 2));
console.log('本机机器码:', machineCode());
console.log('授权机器码:', code);
console.log('到期时间  :', new Date(expiry).toISOString());
console.log('已写入 license.key');
