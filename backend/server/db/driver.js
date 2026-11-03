/**
 * 统一的数据库驱动层。
 *
 * 默认用 better-sqlite3（快）；但**某些服务器上 better-sqlite3 的原生二进制
 * 与系统不兼容**——`require` 正常、`new Database()` 直接段错误，
 * 连源码重编译都救不回来（2026-10-13 用户服务器实测）。
 *
 * 所以提供第二个驱动：Node 22+ **内置**的 `node:sqlite`，
 * 不依赖任何第三方 .node 二进制，从根上绕开兼容性问题。
 *
 * 切换方式：环境变量 `KAMI_DB_DRIVER=node-sqlite`
 * （安装脚本会自动探测：better-sqlite3 能跑就用它，跑不了就自动切过来）
 *
 * 适配出来的接口和 better-sqlite3 对齐：
 *   db.exec(sql)
 *   db.pragma('journal_mode = WAL')
 *   db.prepare(sql).run(...args) / .get(...args) / .all(...args)
 *   run() 返回 { changes, lastInsertRowid }
 */
'use strict';

function openDatabase(file) {
  const useNodeSqlite = (process.env.KAMI_DB_DRIVER || '').toLowerCase() === 'node-sqlite';

  if (!useNodeSqlite) {
    const Database = require('better-sqlite3');
    return new Database(file);
  }

  // ---------- Node 内置 node:sqlite 适配 ----------
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch (e) {
    throw new Error(
      '当前 Node 不支持 node:sqlite（需要 Node 22+，老版本要加 --experimental-sqlite）。' +
      ' 原始错误：' + e.message
    );
  }
  const raw = new sqlite.DatabaseSync(file);

  // node:sqlite 的 lastInsertRowid / changes 可能是 BigInt，统一转成 Number，
  // 否则拼进 SQL 参数或做算术时会出问题
  const num = v => (typeof v === 'bigint' ? Number(v) : v);

  return {
    __driver: 'node-sqlite',

    exec(sql) {
      raw.exec(sql);
    },

    pragma(str) {
      // better-sqlite3 的 db.pragma('journal_mode = WAL') → 这里用 PRAGMA 语句
      raw.exec('PRAGMA ' + str);
    },

    prepare(sql) {
      const st = raw.prepare(sql);
      return {
        run(...args) {
          const r = st.run(...args);
          return { changes: num(r.changes), lastInsertRowid: num(r.lastInsertRowid) };
        },
        get(...args) {
          return st.get(...args);
        },
        all(...args) {
          return st.all(...args);
        }
      };
    },

    close() {
      try { raw.close(); } catch (_) { /* ignore */ }
    }
  };
}

module.exports = { openDatabase };
