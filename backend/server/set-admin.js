#!/usr/bin/env node
/**
 * 设置管理端账号密码（服务器首次部署 / 本地都可用）
 *
 * 用法：
 *   cd <项目>/kami-system/server
 *   node set-admin.js <用户名> <密码>
 *   例：node set-admin.js admin YourPass123
 *
 * 说明：
 *   - 会先 require('./db') 初始化数据库与表结构（含默认 admin/admin123），
 *     所以**不用等后端先跑起来**，也不会出现「no such table: admins」。
 *   - 只保留一个管理员：把第一条更新成新账号，多余的删掉。
 *   - ⚠️ 若这里报 Segmentation fault，是 better-sqlite3 预编译二进制与服务器
 *     不兼容（不是脚本问题），用源码重装：
 *       npm rebuild better-sqlite3 --build-from-source
 */
const path = require('path');
const bcrypt = require('bcryptjs');

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error('用法: node set-admin.js <用户名> <密码>');
  process.exit(1);
}

// 先初始化库（建表 + 落默认管理员），再改账号
const db = require('./db');

const hash = bcrypt.hashSync(password, 10);
let rows = [];
try {
  rows = db.prepare('SELECT id, username FROM admins ORDER BY id').all();
} catch (e) {
  console.error('读取 admins 表失败：', e.message);
  console.error('（正常不该出现；若报 no such table，说明 db/index.js 没跑通）');
  process.exit(1);
}

if (rows.length === 0) {
  db.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').run(username, hash);
  console.log(`[ok] 已创建管理员：${username}`);
} else {
  db.prepare('UPDATE admins SET username = ?, password = ? WHERE id = ?')
    .run(username, hash, rows[0].id);
  for (const r of rows.slice(1)) {
    db.prepare('DELETE FROM admins WHERE id = ?').run(r.id);
  }
  console.log(`[ok] 管理员已更新为：${username}（原 ${rows.length} 条，已清理多余）`);
}

const ok = bcrypt.compareSync(
  password,
  db.prepare('SELECT password FROM admins WHERE username = ?').get(username).password
);
console.log(`[check] 密码校验：${ok ? '通过' : '失败'}`);
console.log(`[db] ${path.join(__dirname, 'kami.db')}`);
