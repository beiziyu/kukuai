const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const db = require('../db');
const { agentAuthMiddleware } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'kami-system-secret-2026';
// 导出的领取链接: 按请求动态生成, 指向客户端端口 3010
const claimPageUrl = (req) =>
  process.env.CLAIM_PAGE_URL ||
  `${req.protocol}://${req.hostname}:${process.env.CLIENT_PORT || 3010}/claim`;

const router = express.Router();

// 代理登录
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const agent = db.prepare('SELECT * FROM agents WHERE username = ?').get(username);
  if (!agent) return res.status(401).json({ error: '用户名或密码错误' });
  if (!bcrypt.compareSync(password, agent.password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  if (agent.status !== 1) return res.status(403).json({ error: '账号已被禁用' });
  const token = jwt.sign({ id: agent.id, role: 'agent' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: agent.id, username: agent.username, quota: agent.quota, used: agent.used } });
});

// ==================== 代理修改自己的密码 ====================
router.post('/change-password', agentAuthMiddleware, (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!old_password || !new_password) {
    return res.status(400).json({ error: '请填写原密码和新密码' });
  }
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.agent.id);
  if (!agent) return res.status(404).json({ error: '代理不存在' });
  if (!bcrypt.compareSync(old_password, agent.password)) {
    return res.status(400).json({ error: '原密码错误' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE agents SET password = ? WHERE id = ?').run(hash, req.agent.id);
  res.json({ ok: true });
});

// 生成卡密
router.post('/generate', agentAuthMiddleware, (req, res) => {
  const { count = 1 } = req.body;
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.agent.id);
  if (!agent || agent.status !== 1) return res.status(400).json({ error: '账号不可用' });
  const remaining = agent.quota - agent.used;
  if (remaining <= 0) return res.status(400).json({ error: '额度不足' });
  const canGenerate = Math.min(Number(count), remaining);
  const crypto = require('crypto');
  const cards = [];
  const insertCard = db.prepare('INSERT INTO cards (card_key, agent_id, status) VALUES (?, ?, 0)');
  for (let i = 0; i < canGenerate; i++) {
    const key = 'KAMI-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    insertCard.run(key, agent.id);
    cards.push(key);
  }
  db.prepare('UPDATE agents SET used = used + ? WHERE id = ?').run(canGenerate, agent.id);
  const freshAgent = db.prepare('SELECT quota, used FROM agents WHERE id = ?').get(agent.id);
  res.json({ cards, used: freshAgent.used, quota: freshAgent.quota });
});

// 我的卡密列表（分页，与管理端 /admin/cards 对齐）
// 不传 page/size 默认第 1 页、每页 20 条；size 上限 500（与前端可选的最大每页条数一致）
router.get('/cards', agentAuthMiddleware, (req, res) => {
  const agent = db.prepare('SELECT id, username, quota, used FROM agents WHERE id = ?').get(req.agent.id);
  if (!agent) return res.status(404).json({ error: '代理不存在' });
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  let size = parseInt(req.query.size, 10) || 20;
  if (size < 1) size = 20;
  if (size > 500) size = 500;
  // 卡密搜索 + 状态筛选（用户 2026-10-20 要求）
  const kw = String(req.query.q || '').trim();
  const status = req.query.status;
  const conds = ['c.agent_id = ?'];
  const condParams = [req.agent.id];
  if (status !== undefined && status !== '') {
    conds.push('c.status = ?');
    condParams.push(Number(status));
  }
  if (kw) {
    conds.push('c.card_key LIKE ?');
    condParams.push(`%${kw}%`);
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  // claim_status：最新一条领取订单状态。用子查询取最新一条，
  // 不要直接 LEFT JOIN claim_orders —— 一卡多单会产生重复行。
  const cards = db.prepare(`
    SELECT c.*,
           (SELECT o.status FROM claim_orders o WHERE o.card_id = c.id
            ORDER BY o.id DESC LIMIT 1) AS claim_status,
           (SELECT o.member_expire_at FROM claim_orders o WHERE o.card_id = c.id
            ORDER BY o.id DESC LIMIT 1) AS member_expire_at
    FROM cards c
    ${where}
    ORDER BY c.id DESC
    LIMIT ? OFFSET ?
  `).all(...condParams, size, (page - 1) * size);
  const { total } = db.prepare(`SELECT COUNT(*) as total FROM cards c ${where}`).get(...condParams);
  res.json({ agent, cards, total, page, size });
});

// 代理端数据总览（只统计该代理自己的卡密/领取记录）
// 返回的字段名与 /admin/stats 保持一致，便于前端复用同一套统计卡片和图表
router.get('/stats', agentAuthMiddleware, (req, res) => {
  const agentId = req.agent.id;

  const agent = db.prepare('SELECT id, username, quota, used FROM agents WHERE id = ?').get(agentId);
  if (!agent) return res.status(404).json({ error: '代理不存在' });

  const total = db.prepare('SELECT COUNT(*) as cnt FROM cards WHERE agent_id = ?').get(agentId).cnt;
  const used = db.prepare('SELECT COUNT(*) as cnt FROM cards WHERE agent_id = ? AND status = 1').get(agentId).cnt;
  const unused = db.prepare('SELECT COUNT(*) as cnt FROM cards WHERE agent_id = ? AND status = 0').get(agentId).cnt;

  // 领取结果：只统计属于本代理卡密产生的订单
  const claimCount = statusClause => db
    .prepare(
      `SELECT COUNT(*) as cnt FROM claim_orders o
       JOIN cards c ON c.id = o.card_id
       WHERE c.agent_id = ? AND ${statusClause}`
    )
    .get(agentId).cnt;

  const claimSuccess = claimCount("o.status = 'success'");
  const claimFailed = claimCount("o.status = 'failed'");
  const claimPending = claimCount("o.status IN ('pending','running')");

  res.json({
    total,
    used,
    unused,
    claimSuccess,
    claimFailed,
    claimPending,
    pie: [
      { name: '卡密未使用', value: unused },
      { name: '卡密已使用', value: used }
    ],
    claimPie: [
      { name: '领取成功', value: claimSuccess },
      { name: '领取失败', value: claimFailed },
      { name: '进行中', value: claimPending }
    ],
    // 额度信息单独放，和上面的卡密统计区分开
    agent: {
      id: agent.id,
      username: agent.username,
      quota: agent.quota,
      used: agent.used,
      remaining: agent.quota - agent.used
    }
  });
});

// 批量删除卡密（只能删自己的；任何状态都能删；只有未使用的返还额度）
router.post('/cards/batch-delete', agentAuthMiddleware, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids 不能为空' });
  }
  const idList = ids.map(Number).filter(n => Number.isFinite(n) && n > 0);
  if (idList.length === 0) return res.status(400).json({ error: 'ids 不合法' });

  let deleted = 0;
  let skipped = 0;
  let refund = 0;
  const delOrders = db.prepare('DELETE FROM claim_orders WHERE card_id = ?');
  const delCard = db.prepare('DELETE FROM cards WHERE id = ? AND agent_id = ?');

  for (const id of idList) {
    const card = db.prepare('SELECT * FROM cards WHERE id = ? AND agent_id = ?').get(id, req.agent.id);
    if (!card) { skipped++; continue; }          // 不是自己的卡密，跳过
    // 任何状态都能删；只有「未使用」的才返还额度
    if (card.status === 0) refund++;
    delOrders.run(card.id);
    delCard.run(card.id, req.agent.id);
    deleted++;
  }

  // 返还额度（只算未使用的）
  if (refund > 0) {
    db.prepare('UPDATE agents SET used = MAX(used - ?, 0) WHERE id = ?').run(refund, req.agent.id);
  }
  res.json({ ok: true, deleted, skipped });
});

// 导出卡密 Excel（只能导出自己的；ids=1,2,3 只导选中的，不传导全部/按状态过滤）
router.get('/cards/export', agentAuthMiddleware, (req, res) => {
  const { ids, status } = req.query;
  let sql = 'SELECT c.* FROM cards c WHERE c.agent_id = ?';
  const params = [req.agent.id];

  if (ids) {
    const idList = String(ids).split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
    if (idList.length === 0) return res.status(400).json({ error: 'ids 参数不合法' });
    sql += ` AND c.id IN (${idList.map(() => '?').join(',')})`;
    params.push(...idList);
  } else if (status !== undefined && status !== '') {
    sql += ' AND c.status = ?';
    params.push(Number(status));
  }
  sql += ' ORDER BY c.id DESC';
  const cards = db.prepare(sql).all(...params);

  const rows = cards.map(c => ({
    'ID': c.id,
    '卡密': c.card_key,
    '领取链接': `${claimPageUrl(req)}?kami=${encodeURIComponent(c.card_key)}`,
    '状态': c.status === 1 ? '已使用' : '未使用',
    '备注': c.note || '',
    '创建时间': c.created_at,
    '使用时间': c.used_at || ''
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 6 }, { wch: 20 }, { wch: 52 }, { wch: 10 }, { wch: 18 }, { wch: 20 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '我的卡密');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `kami_agent_${req.agent.id}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(buf));
});

// 删除卡密（仅未使用的）
router.delete('/cards/:id', agentAuthMiddleware, (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND agent_id = ?').get(req.params.id, req.agent.id);
  if (!card) return res.status(404).json({ error: '卡密不存在' });
  // 用户要求（2026-10-20）：任何状态都能删；只有「未使用」的才返还额度
  if (card.status === 0) {
    db.prepare('UPDATE agents SET used = MAX(used - 1, 0) WHERE id = ?').run(req.agent.id);
  }
  db.prepare('DELETE FROM claim_orders WHERE card_id = ?').run(card.id);
  db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
