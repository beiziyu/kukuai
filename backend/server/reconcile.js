/**
 * 订单状态对账器（兜底）
 *
 * 为什么需要：
 *   claim-api 跑完任务后靠 HTTP 回调把结果写回 Node 的 claim_orders。
 *   一旦回调丢了（claim-api 进程没重启导致回调地址不对、网络抖动、
 *   claim-api 重启后内存任务丢失），订单就永远停在 pending/running，
 *   后台列表一直显示「进行中」——用户 2026-10-20 实测踩到。
 *
 * 做法：每 15 秒扫一遍 pending/running 的订单，主动向 claim-api 问状态，
 *       拿到 success/failed 立刻回写；任务丢失（unknown）超过 15 分钟判失败，
 *       避免订单永远挂起。
 */
const db = require('./db');

const CLAIM_API = process.env.CLAIM_API_URL || 'http://127.0.0.1:8888';
// claim-api 里查不到任务（unknown）超过这个时长就判失败（秒）
const STALE_SECONDS = 15 * 60;
// 失败次数上限（与 client.js 保持一致）：达到后锁卡，引导客户走退款
const MAX_FAIL = 2;

// 失败 +1；达到上限锁卡（与 client.js 的 bumpFailCount 同逻辑）
function bumpFailCount(cardId) {
  try {
    db.prepare("UPDATE cards SET fail_count = COALESCE(fail_count,0) + 1 WHERE id=?").run(cardId);
    const row = db.prepare("SELECT fail_count FROM cards WHERE id=?").get(cardId);
    const fc = Number(row && row.fail_count) || 0;
    if (fc >= MAX_FAIL) {
      db.prepare("UPDATE cards SET status=1, used_at=CURRENT_TIMESTAMP WHERE id=? AND status=0")
        .run(cardId);
      console.log(`[reconcile] fail_count=${fc} >= ${MAX_FAIL}, 卡密锁定 (card_id=${cardId})`);
    }
  } catch (e) {
    console.error('[reconcile] bumpFailCount 失败:', e.message);
  }
}

async function syncOnce() {
  let rows;
  try {
    rows = db.prepare(`
      SELECT o.id, o.status, o.created_at, c.id AS card_id, c.card_key
      FROM claim_orders o JOIN cards c ON c.id = o.card_id
      WHERE o.status IN ('pending','running')
      ORDER BY o.id DESC LIMIT 30
    `).all();
  } catch (e) {
    return;
  }

  for (const r of rows) {
    let t;
    try {
      const res = await fetch(
        `${CLAIM_API}/api/v1/claim/status?kami=${encodeURIComponent(r.card_key)}`,
        { signal: AbortSignal.timeout(4000) }
      );
      t = await res.json();
    } catch (e) {
      return; // claim-api 不可达，整轮放弃，下一轮再试
    }
    if (!t || !t.ok) continue;

    let next = t.status;
    if (next !== 'success' && next !== 'failed') {
      if (next !== 'unknown') continue; // running/pending/need_account：还在进行，等下一轮
      // claim-api 重启后内存任务没了 → 超过 15 分钟就判失败，别永远进行中
      let age = 0;
      try {
        age = db.prepare("SELECT (julianday('now') - julianday(?)) * 86400 AS age")
          .get(r.created_at)?.age ?? 0;
      } catch (e) {
        age = 0;
      }
      if (age < STALE_SECONDS) continue;
      next = 'failed';
    }

    try {
      // 会员到期时间在 claim-api 的 detail.watch.end_time_str 里
      const exp = ((t.detail || {}).watch || {}).end_time_str || '';
      const upd = db.prepare(
        "UPDATE claim_orders SET status=?, member_expire_at=COALESCE(NULLIF(?,''), member_expire_at), finished_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','running')"
      ).run(next, exp, r.id);
      if (upd.changes > 0 && next === 'success') {
        db.prepare("UPDATE cards SET status=1, used_at=CURRENT_TIMESTAMP WHERE id=? AND status=0")
          .run(r.card_id);
        try { db.prepare("UPDATE cards SET fail_count=0 WHERE id=?").run(r.card_id); } catch (e) {}
      } else if (upd.changes > 0) {
        // ★ 判失败: 不核销卡密, 但记一次失败 (达上限锁卡)
        bumpFailCount(r.card_id);
      }
    } catch (e) {
      // 单条失败不影响其他订单
    }
  }
}

function start() {
  try { syncOnce(); } catch (e) {}
  const timer = setInterval(() => { syncOnce().catch(() => {}); }, 15000);
  // 别让定时器拖住进程退出（node --check / 测试场景）
  if (timer.unref) timer.unref();
}

module.exports = { start, syncOnce };
