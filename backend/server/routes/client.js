const express = require('express');
const db = require('../db');

const router = express.Router();

// claim-api 地址（Python 豆包协议服务）
const CLAIM_API = process.env.CLAIM_API_URL || 'http://localhost:8888';

// 简单的 HTTP 请求封装（Node 18+ 原生 fetch）
async function httpJson(url, options = {}) {
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeout || 60000),
  });
  return res.json();
}

// 发送短信验证码（转发到 claim-api → 豆包真发短信）
router.post('/sms/send', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: '手机号不能为空' });
  try {
    const r = await httpJson(`${CLAIM_API}/api/v1/sms/send`, {
      method: 'POST',
      body: { phone },
    });
    if (!r.ok) return res.json({ ok: false, msg: r.msg || '发送失败' });
    res.json({ ok: true, phone, retry_time: r.retry_time });
  } catch (e) {
    res.json({ ok: false, msg: '验证码服务暂时不可用' });
  }
});

// 充值/领取（手机号 + 验证码 + 卡密）
router.post('/claim', async (req, res) => {
  const { phone, code, card_key } = req.body || {};
  if (!phone || !code || !card_key) {
    return res.status(400).json({ success: false, msg: '手机号/验证码/卡密不能为空' });
  }
  const card = db.prepare('SELECT * FROM cards WHERE card_key = ?').get(card_key);
  if (!card) return res.json({ success: false, msg: '卡密不存在' });
  if (card.status === 1) return res.json({ success: false, msg: '卡密已被使用' });

  // ⚠️ 上一次任务还没结束时**不能再建新订单**：
  //    claim-api 对同一个 kami 正在跑的任务会直接返回现有状态、不会重新跑，
  //    新订单就永远等不到回调 → 后台一直显示「进行中」（2026-10-20 用户实测踩到）。
  try {
    const st = await httpJson(
      `${CLAIM_API}/api/v1/claim/status?kami=${encodeURIComponent(card_key)}`,
      { timeout: 3000 }
    );
    if (st && st.ok && (st.status === 'running' || st.status === 'pending')) {
      return res.json({ success: false, msg: '上一次领取还在处理中，请稍候再试' });
    }
  } catch (e) { /* claim-api 不可达就继续，下面的启动失败分支会兜底 */ }

  // 创建领取订单（前端拿到 order_id 后轮询状态）
  const order = db.prepare(
    'INSERT INTO claim_orders (card_id, phone, status) VALUES (?, ?, ?)'
  ).run(card.id, phone, 'pending');

  // 异步触发 claim-api 跑协议链路
  httpJson(`${CLAIM_API}/api/v1/claim/run`, {
    method: 'POST',
    body: { kami: card_key, phone, code, country_code: '86' },
    timeout: 15000,
  }).then((r) => {
    if (!r.ok) {
      db.prepare("UPDATE claim_orders SET status='failed', result=?, finished_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(r.msg || '启动失败', order.lastInsertRowid);
      // ⚠️ 启动失败**不核销卡密**：允许用户刷新/重试（每次重试会换一台新设备）
    }
  }).catch(() => {
    db.prepare("UPDATE claim_orders SET status='failed', result='claim-api 不可达', finished_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(order.lastInsertRowid);
    // 同上：不可达也不核销，等服务恢复后可重试
  });

  res.json({ success: true, order_id: order.lastInsertRowid, kami: card_key });
});

// 扫码/设备池功能已按需求裁剪

// 查询领取状态（前端轮询用）
// ⚠️ 不能只读自己的库：订单要等 claim-api 回调才落终态，回调没到时前端会一直卡在
//    「排队中」。所以订单仍是 pending/running 时，实时向 claim-api 要进度并透传。
router.get('/claim/status', async (req, res) => {
  const { kami } = req.query;
  if (!kami) return res.status(400).json({ error: '参数缺失' });
  const card = db.prepare('SELECT * FROM cards WHERE card_key = ?').get(kami);
  if (!card) return res.json({ exist: false });
  const order = db.prepare(
    'SELECT * FROM claim_orders WHERE card_id = ? ORDER BY id DESC LIMIT 1'
  ).get(card.id);

  // ⚠️ 客户端接口不回传 result / progress：
  //    result 里是内部原因（如「登录成功，但该账号暂无可领取的会员活动」），
  //    progress 是协议层实时文案，都会在浏览器 Network 面板里裸奔，属于信息暴露。
  //    前端只依赖 exist / card_status / status / phone 四个字段即可完成展示。
  //    需要排查时去后台 /api/admin/stats 的 claims 里看（管理端才可见）。
  const out = {
    exist: true,
    kami,
    card_status: card.status,
    status: order?.status || 'pending',
    // 带上手机号：重新打开链接时直接展示结果页，成功页要显示打码手机号
    phone: order?.phone || '',
    // 会员到期时间（成功时才有，如 "2026-11-19 20:15"）
    member_expire_at: order?.member_expire_at || '',
  };

  if (out.status === 'pending' || out.status === 'running') {
    try {
      const t = await httpJson(
        `${CLAIM_API}/api/v1/claim/status?kami=${encodeURIComponent(String(kami))}`,
        { timeout: 5000 }
      );
      // 只认明确的状态。need_account = 一号多账号，等用户选登哪个号
      if (t && t.ok && ['pending', 'running', 'success', 'failed',
                        'need_account'].includes(t.status)) {
        out.status = t.status;
        // 会员到期时间在 detail.watch.end_time_str 里
        const exp = ((t.detail || {}).watch || {}).end_time_str;
        if (exp) out.member_expire_at = exp;
        if (t.status === 'need_account') {
          // 把账号列表带给前端，让用户选登哪个
          out.accounts = (t.detail && t.detail.accounts) || [];
        }
      }
    } catch (e) {
      // claim-api 不可达时维持库里的状态，不阻断轮询
    }
  }

  // ⚠️ 兜底回写：回调可能丢（claim-api 没重启导致回调地址不对 / 网络抖动），
  //    这里一旦从 claim-api 拿到终态，立刻写回数据库，
  //    否则后台列表会一直停在「进行中」（2026-10-20 用户实测踩到）。
  if (order && (out.status === 'success' || out.status === 'failed') && out.status !== order.status) {
    db.prepare("UPDATE claim_orders SET status=?, member_expire_at=COALESCE(NULLIF(?,''), member_expire_at), finished_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(out.status, out.member_expire_at || '', order.id);
    if (out.status === 'success') {
      db.prepare("UPDATE cards SET status=1, used_at=CURRENT_TIMESTAMP WHERE id=? AND status=0")
        .run(card.id);
      out.card_status = 1;
    }
  }

  res.json(out);
});

// claim-api 回调：把结果写回订单 + 卡密状态
// ⚠️ 用户要求（2026-10-20）：**只有成功才核销卡密**。
//    失败不核销 → 客户端失败页可以「重新充值」，重试会自动换一台新设备；
//    成功后卡密置为已使用，成功页固定不可再操作。
router.post('/claim/callback', (req, res) => {
  const { kami, status, phone, result_msg, member_expire_at } = req.body || {};
  if (!kami) return res.status(400).json({ error: 'kami 缺失' });
  const card = db.prepare('SELECT * FROM cards WHERE card_key = ?').get(kami);
  if (card) {
    // phone 用 COALESCE(NULLIF(?,''), phone)：回调带了真号（扫码流程给的脱敏号）就覆盖，
    // 空的话保留订单已有的，别把短信流程已存的手机号冲成空
    // member_expire_at 同理：有就更新，没有就保留
    db.prepare("UPDATE claim_orders SET status=?, result=?, phone=COALESCE(NULLIF(?,''), phone), member_expire_at=COALESCE(NULLIF(?,''), member_expire_at), finished_at=CURRENT_TIMESTAMP WHERE card_id=? AND status IN ('pending','running')")
      .run(status === 'success' ? 'success' : 'failed', result_msg || '', phone || '', member_expire_at || '', card.id);
    if (status === 'success' && card.status !== 1) {
      db.prepare("UPDATE cards SET status=1, used_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(card.id);
    }
  }
  res.json({ ok: true });
});

module.exports = router;
