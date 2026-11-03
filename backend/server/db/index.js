const path = require('path');
const bcrypt = require('bcryptjs');
const { openDatabase } = require('./driver');

// 驱动可切换：默认 better-sqlite3；KAMI_DB_DRIVER=node-sqlite 时用 Node 内置实现
// （某些服务器上 better-sqlite3 原生二进制不兼容，见 db/driver.js 注释）
const db = openDatabase(path.join(__dirname, '../kami.db'));
db.pragma('journal_mode = WAL');

// 初始化表
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    quota INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_key TEXT UNIQUE NOT NULL,
    status INTEGER NOT NULL DEFAULT 0,
    agent_id INTEGER,
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at DATETIME,
    expire_at DATETIME,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS claim_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    phone TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    result TEXT,
    member_expire_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME
  );
`);

// 老库迁移：补 note 列（CREATE TABLE IF NOT EXISTS 不会改已存在的表）
try {
  const cols = db.prepare('PRAGMA table_info(cards)').all();
  if (!cols.some(c => c.name === 'note')) {
    db.exec("ALTER TABLE cards ADD COLUMN note TEXT DEFAULT ''");
    console.log('[db] migrated: cards.note added');
  }
} catch (e) {
  console.error('[db] migration failed:', e.message);
}

// 老库迁移：补 member_expire_at 列（会员到期时间，2026-10-20）
try {
  const cols = db.prepare('PRAGMA table_info(claim_orders)').all();
  if (!cols.some(c => c.name === 'member_expire_at')) {
    db.exec('ALTER TABLE claim_orders ADD COLUMN member_expire_at TEXT');
    console.log('[db] migrated: claim_orders.member_expire_at added');
  }
} catch (e) {
  console.error('[db] migration failed:', e.message);
}

// 插入默认管理员（admin / admin123）
const adminExists = db.prepare('SELECT id FROM admins WHERE username = ?').get('admin');
if (!adminExists) {
  const hashed = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').run('admin', hashed);
}

// 插入默认代理（agent01 / agent01，额度 100）
const agentExists = db.prepare('SELECT id FROM agents WHERE username = ?').get('agent01');
if (!agentExists) {
  const hashed = bcrypt.hashSync('agent01', 10);
  db.prepare('INSERT INTO agents (username, password, quota, used) VALUES (?, ?, ?, ?)')
    .run('agent01', hashed, 100, 0);
}

module.exports = db;
