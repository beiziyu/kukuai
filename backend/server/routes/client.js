const express = require('express');
const db = require('../db');

const router = express.Router();

// claim-api 地址（Python 豆包协议服务）
const CLAIM_API = process.env.CLAIM_API_URL || 'http://127.0.0.1:8888';

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

// ★ 失败次数管理 (2026-11-04)
//   失败【不核销卡密】→ 客户可以点「重新尝试」重新走一遍 (换新设备指纹 + 新 IP)
//   但要防止一张卡被无限重试刷多个号 → 记失败次数, 达到上限就锁卡引导退款。
//   上限: 2 次 (即第 2 次失败后锁定)
const MAX_FAIL = 2;

// 失败 +1; 达到上限则锁卡 (status=1)
function bumpFailCount(cardId) {
  try {
    db.prepare("UPDATE cards SET fail_count = COALESCE(fail_count,0) + 1 WHERE id=?").run(cardId);
    const row = db.prepare("SELECT fail_count FROM cards WHERE id=?").get(cardId);
    const fc = Number(row && row.fail_count) || 0;
    if (fc >= MAX_FAIL) {
      // 锁定: 卡密置为已用, 客户端会引导走退款流程
      db.prepare("UPDATE cards SET status=1, used_at=datetime('now','localtime') WHERE id=? AND status=0")
        .run(cardId);
      console.log(`[card] fail_count=${fc} >= ${MAX_FAIL}, 卡密锁定 (card_id=${cardId})`);
    }
    return fc;
  } catch (e) {
    console.error('[card] bumpFailCount 失败:', e.message);
    return 0;
  }
}

// 领取成功 → 失败计数清零 (这张卡已核销, 计数无意义)
function resetFailCount(cardId) {
  try {
    db.prepare("UPDATE cards SET fail_count=0 WHERE id=?").run(cardId);
  } catch (e) { /* 忽略 */ }
}

// 卡密预检 (客户端打开 ?card= 时自动校验)
router.get('/card/check', (req, res) => {
  const key = (req.query.card_key || '').trim().toUpperCase();
  if (!key) return res.json({ ok: false, msg: '缺少卡密' });
  const card = db.prepare(`
    SELECT c.*, a.username AS agent_username FROM cards c
    LEFT JOIN agents a ON a.id = c.agent_id
    WHERE c.card_key = ?`).get(key);
  if (!card) return res.json({ ok: false, msg: '卡密不存在' });
  // 该卡最近一次订单的终态 (打开链接直接展示成功/失败界面)
  const last = db.prepare(
    'SELECT status, result, member_expire_at, avatar, username FROM claim_orders WHERE card_id = ? ORDER BY id DESC LIMIT 1'
  ).get(card.id);
  if (card.status === 1) {
    const o = last || {};
    return res.json({ ok: false, msg: '卡密已被使用', used: true,
                      last_status: 'success',
                      member_expire_at: o.member_expire_at || null,
                      avatar: o.avatar || '', username: o.username || '' });
  }
  if (card.expire_at && new Date(card.expire_at) < new Date()) {
    return res.json({ ok: false, msg: '卡密已过期' });
  }
  res.json({ ok: true, msg: '卡密有效', note: card.note, agent: card.agent_username,
             last_status: last ? last.status : null,
             last_result: last ? (last.result || '') : '',
             // 失败次数 (>=2 表示已达重试上限, 客户端引导走退款)
             fail_count: Number(card.fail_count) || 0,
             member_expire_at: last ? last.member_expire_at : '',
             avatar: last ? (last.avatar || '') : '',
             username: last ? (last.username || '') : '' });
});

// 发送短信验证码（转发到 claim-api → 豆包真发短信）
router.post('/sms/send', async (req, res) => {
  const { phone, kami } = req.body || {};
  if (!phone) return res.status(400).json({ error: '手机号不能为空' });
  // 卡密前置校验 (避免无效卡消耗短信/打码资源)
  if (kami) {
    const card = db.prepare('SELECT * FROM cards WHERE card_key = ?').get(String(kami).trim().toUpperCase());
    if (!card) return res.json({ ok: false, msg: '卡密不存在' });
    if (card.status === 1) return res.json({ ok: false, msg: '卡密已被使用' });
  }
  try {
    const r = await httpJson(`${CLAIM_API}/api/v1/sms/send`, {
      method: 'POST',
      body: { phone, kami: kami || '' },
      timeout: 200000,   // 协议层最多 3 轮换 IP (~180s), Node 必须等它
    });
    if (!r.ok) {
      // 真实原因只进日志, 客户端统一话术 (不暴露后端细节)
      console.log(`[sms/send] ${phone} 失败: ${r.msg || '未知'}`);
      return res.json({ ok: false, msg: '获取验证码失败，请稍后重试' });
    }
    res.json({ ok: true, phone, retry_time: r.retry_time });
  } catch (e) {
    console.log(`[sms/send] ${phone} 异常: ${e.message || e}`);
    res.json({ ok: false, msg: '获取验证码失败，请稍后重试' });
  }
});

// 充值/领取（手机号 + 验证码 + 卡密）
router.post('/claim', async (req, res) => {
  const { phone, code, card_key } = req.body || {};
  // 严格类型校验: 防止前端传对象/DOM元素绕过 truthy 检查导致 SQL 参数错误
  if (typeof phone !== 'string' || !/^1\d{10}$/.test(phone)) {
    return res.status(400).json({ success: false, msg: '手机号格式不正确' });
  }
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ success: false, msg: '验证码不能为空' });
  }
  if (typeof card_key !== 'string' || !card_key.trim()) {
    return res.status(400).json({ success: false, msg: '卡密不能为空' });
  }
  const card = db.prepare('SELECT * FROM cards WHERE card_key = ?').get(card_key);
  if (!card) return res.json({ success: false, msg: '卡密不存在' });
  if (card.status === 1) return res.json({ success: false, msg: '卡密已被使用' });

  // ⚠️ 幂等防重: 同一张卡只允许一笔有效订单
  //    成功过 → 直接回显已有结果, 不再建单 (杜绝重复提交产生两条成功记录)
  const lastOrder = db.prepare(
    'SELECT * FROM claim_orders WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(card.id);
  if (lastOrder && lastOrder.status === 'success') {
    return res.json({
      success: true, order_id: lastOrder.id, kami: card_key, already: true,
      member_expire_at: lastOrder.member_expire_at || '',
      avatar: lastOrder.avatar || '', username: lastOrder.username || '',
      msg: '该卡密已兑换成功',
    });
  }
  //    处理中 → 拦截; 但卡住超过5分钟(无终态)视为失败, 放行重试
  if (lastOrder && (lastOrder.status === 'pending' || lastOrder.status === 'running')) {
    let ageSec = 999999;
    try {
      ageSec = (Date.now() - new Date(lastOrder.created_at.replace(' ', 'T')).getTime()) / 1000;
    } catch (e) { /* 时间解析失败按卡住处理 */ }
    if (ageSec < 300) {
      return res.json({ success: false, msg: '上一次领取还在处理中，请稍候再试' });
    }
    db.prepare("UPDATE claim_orders SET status='failed', result='处理超时', finished_at=datetime('now','localtime') WHERE id=?")
      .run(lastOrder.id);
  }

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
    "INSERT INTO claim_orders (card_id, phone, status, created_at) VALUES (?, ?, ?, datetime('now','localtime'))"
  ).run(card.id, phone, 'pending');

  // 异步触发 claim-api 跑协议链路
  httpJson(`${CLAIM_API}/api/v1/claim/run`, {
    method: 'POST',
    body: { kami: card_key, phone, code, country_code: '86' },
    timeout: 15000,
  }).then((r) => {
    if (!r.ok) {
      db.prepare("UPDATE claim_orders SET status='failed', result=?, finished_at=datetime('now','localtime') WHERE id=?")
        .run(r.msg || '启动失败', order.lastInsertRowid);
      // ⚠️ 启动失败**不核销卡密**：允许用户重试（每次重试会换一台新设备）
      bumpFailCount(card.id);
    }
  }).catch(() => {
    db.prepare("UPDATE claim_orders SET status='failed', result='claim-api 不可达', finished_at=datetime('now','localtime') WHERE id=?")
      .run(order.lastInsertRowid);
    // 同上：不可达也不核销，等服务恢复后可重试
    bumpFailCount(card.id);
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
    avatar: order?.avatar || '',
    username: order?.username || '',
  };

  if (out.status === 'pending' || out.status === 'running') {
    try {
      const t = await httpJson(
        `${CLAIM_API}/api/v1/claim/status?kami=${encodeURIComponent(String(kami))}`,
        { timeout: 5000 }
      );
      // 只认明确的状态。need_account = 一号多账号，等用户选登哪个号
      if (t && t.ok && ['pending', 'running', 'success', 'failed'].includes(t.status)) {
        out.status = t.status;
        // 会员到期时间: 库库执行层 detail.member_expire_at
        const exp = (t.detail || {}).member_expire_at;
        if (exp) out.member_expire_at = exp;
        // 失败原因: 执行层 detail.result_msg (如实透传)
        const d2 = t.detail || {};
        if (d2.result_msg) out.result = d2.result_msg;
        for (const k of ['avatar', 'username', 'ck_before', 'ck_after']) {
          if (d2[k]) out[k] = d2[k];
        }
        // 进度文案 (签到/补签/领取步骤, 无敏感信息)
        if (d2.progress) out.progress = d2.progress;
      }
    } catch (e) {
      // claim-api 不可达时维持库里的状态，不阻断轮询
    }
  }

  // ⚠️ 兜底回写：回调可能丢（claim-api 没重启导致回调地址不对 / 网络抖动），
  //    这里一旦从 claim-api 拿到终态，立刻写回数据库，
  //    否则后台列表会一直停在「进行中」（2026-10-20 用户实测踩到）。
  if (order && (out.status === 'success' || out.status === 'failed') && out.status !== order.status) {
    db.prepare("UPDATE claim_orders SET status=?, member_expire_at=COALESCE(NULLIF(?,''), member_expire_at), result=COALESCE(NULLIF(?,''), result), avatar=COALESCE(NULLIF(?,''), avatar), username=COALESCE(NULLIF(?,''), username), ck_before=COALESCE(NULLIF(?,''), ck_before), ck_after=COALESCE(NULLIF(?,''), ck_after), finished_at=datetime('now','localtime') WHERE id=?")
      .run(out.status, out.member_expire_at || '', out.result || '',
           out.avatar || '', out.username || '', out.ck_before || '', out.ck_after || '', order.id);
    if (out.status === 'success') {
      db.prepare("UPDATE cards SET status=1, used_at=datetime('now','localtime') WHERE id=? AND status=0")
        .run(card.id);
      resetFailCount(card.id);
      out.card_status = 1;
    } else {
      // ★ 失败: 不核销, 记一次失败 (达上限锁卡)
      bumpFailCount(card.id);
    }
  }

  // 失败统一友好文案 (不暴露后端原因, 也不显示"未知原因")
  if (out.status === 'failed' && !out.result) {
    out.result = '领取失败, 请重新尝试';
  }

  res.json(out);
});

// claim-api 回调：把结果写回订单 + 卡密状态
// ⚠️ 用户要求（2026-10-20）：**只有成功才核销卡密**。
//    失败不核销 → 客户端失败页可以「重新充值」，重试会自动换一台新设备；
//    成功后卡密置为已使用，成功页固定不可再操作。
router.post('/claim/callback', (req, res) => {
  const { kami, status, phone, result_msg, member_expire_at, avatar,
          username, ck_before, ck_after } = req.body || {};
  if (!kami) return res.status(400).json({ error: 'kami 缺失' });
  const card = db.prepare('SELECT * FROM cards WHERE card_key = ?').get(kami);
  if (card) {
    // phone 用 COALESCE(NULLIF(?,''), phone)：回调带了真号（扫码流程给的脱敏号）就覆盖，
    // 空的话保留订单已有的，别把短信流程已存的手机号冲成空
    // member_expire_at 同理：有就更新，没有就保留
    db.prepare("UPDATE claim_orders SET status=?, result=?, phone=COALESCE(NULLIF(?,''), phone), member_expire_at=COALESCE(NULLIF(?,''), member_expire_at), avatar=COALESCE(NULLIF(?,''), avatar), username=COALESCE(NULLIF(?,''), username), ck_before=COALESCE(NULLIF(?,''), ck_before), ck_after=COALESCE(NULLIF(?,''), ck_after), finished_at=datetime('now','localtime') WHERE card_id=? AND status IN ('pending','running')")
      .run(status === 'success' ? 'success' : 'failed', result_msg || '', phone || '',
           member_expire_at || '', avatar || '', username || '', ck_before || '', ck_after || '', card.id);
    if (status === 'success' && card.status !== 1) {
      db.prepare("UPDATE cards SET status=1, used_at=datetime('now','localtime') WHERE id=?")
        .run(card.id);
      resetFailCount(card.id);
    } else if (status !== 'success') {
      // ★ 失败: 不核销卡密, 但记一次失败。
      //   达到 MAX_FAIL(2) 次 → 锁卡, 客户端引导客户联系退款。
      const fc = bumpFailCount(card.id);
      if (fc >= MAX_FAIL) {
        console.log(`[callback] ${kami} 失败次数=${fc}, 卡密已锁定`);
      }
    }
  }
  res.json({ ok: true });
});

module.exports = router;
