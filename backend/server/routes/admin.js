const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const db = require('../db');
const { adminAuthMiddleware } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'kami-system-secret-2026';
const crypto = require('crypto');

const router = express.Router();

// 客户端领取页地址（导出卡密时拼接）
// 导出/复制的领取链接: 按请求的协议+主机名动态生成, 指向客户端端口 3010
// (可用环境变量 CLAIM_PAGE_URL 完全覆盖, 如绑定了独立域名)
const claimPageUrl = (req) =>
  process.env.CLAIM_PAGE_URL ||
  `${req.protocol}://${req.hostname}:${process.env.CLIENT_PORT || 3010}/claim`;

// ==================== 管理员修改自己的密码 ====================
// 协议执行日志 (管理端自查看)
const CLAIM_API_LOG = process.env.CLAIM_API_URL || 'http://127.0.0.1:8899';
router.get('/logs', adminAuthMiddleware, async (req, res) => {
  const lines = parseInt(req.query.lines, 10) || 300;
  try {
    const r = await fetch(`${CLAIM_API_LOG}/api/v1/logs?lines=${lines}`,
                          { signal: AbortSignal.timeout(5000) });
    res.json(await r.json());
  } catch (e) {
    res.json({ ok: false, lines: ['协议层不可达: ' + e.message] });
  }
});
router.get('/logs/view', adminAuthMiddleware, (req, res) => {
  res.sendFile(require('path').join(__dirname, '../public/logs.html'));
});

router.post('/change-password', adminAuthMiddleware, (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!old_password || !new_password) {
    return res.status(400).json({ error: '请填写原密码和新密码' });
  }
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
  if (!admin) return res.status(404).json({ error: '管理员不存在' });
  if (!bcrypt.compareSync(old_password, admin.password)) {
    return res.status(400).json({ error: '原密码错误' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE admins SET password = ? WHERE id = ?').run(hash, req.admin.id);
  res.json({ ok: true });
});

// ==================== 管理员认证 ====================
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin) return res.status(401).json({ error: '用户名或密码错误' });
  if (!bcrypt.compareSync(password, admin.password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = jwt.sign({ id: admin.id, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: admin.id, username: admin.username, role: 'admin' } });
});

// ==================== 卡密管理 ====================
router.get('/cards', adminAuthMiddleware, (req, res) => {
  const { page = 1, size = 20, status, agent_id, q } = req.query;
  // claim_status：该卡密最新一条领取订单的状态（success/failed/running/pending），
  // 未领取过的卡为 NULL。用子查询而不是 LEFT JOIN，避免一卡多单时出现重复行。
  let sql = `SELECT c.*, a.username as agent_name,
             (SELECT o.status FROM claim_orders o WHERE o.card_id = c.id
              ORDER BY o.id DESC LIMIT 1) AS claim_status,
             (SELECT o.member_expire_at FROM claim_orders o WHERE o.card_id = c.id
              ORDER BY o.id DESC LIMIT 1) AS member_expire_at
             FROM cards c LEFT JOIN agents a ON c.agent_id = a.id WHERE 1=1`;
  const params = [];
  if (status !== undefined && status !== '') { sql += ' AND c.status = ?'; params.push(Number(status)); }
  if (agent_id) { sql += ' AND c.agent_id = ?'; params.push(Number(agent_id)); }
  // 卡密搜索：模糊匹配 card_key（用户 2026-10-20 要求）
  const kw = String(q || '').trim();
  if (kw) { sql += ' AND c.card_key LIKE ?'; params.push(`%${kw}%`); }
  sql += ' ORDER BY c.id DESC LIMIT ? OFFSET ?';
  params.push(Number(size), (Number(page) - 1) * Number(size));
  const cards = db.prepare(sql).all(...params);
  // ⚠️ 必须是 let：下面要按筛选条件追加 WHERE 子句（原来是 const，
  //    一筛选就 TypeError: Assignment to constant variable → 500，2026-10-14 修）
  let countSql = 'SELECT COUNT(*) as total FROM cards c WHERE 1=1';
  const countParams = [];
  if (status !== undefined && status !== '') { countSql += ' AND c.status = ?'; countParams.push(Number(status)); }
  if (agent_id) { countSql += ' AND c.agent_id = ?'; countParams.push(Number(agent_id)); }
  if (kw) { countSql += ' AND c.card_key LIKE ?'; countParams.push(`%${kw}%`); }
  const { total } = db.prepare(countSql).get(...countParams);
  res.json({ cards, total, page: Number(page), size: Number(size) });
});

router.post('/cards/generate', adminAuthMiddleware, (req, res) => {
  const { count = 1, agent_id, note = '' } = req.body;
  const cards = [];
  const insert = db.prepare('INSERT INTO cards (card_key, agent_id, note, status) VALUES (?, ?, ?, 0)');
  for (let i = 0; i < count; i++) {
    const key = generateCardKey();
    const info = insert.run(key, agent_id || null, String(note || ''));
    cards.push({ id: info.lastInsertRowid, card_key: key, status: 0 });
  }
  if (agent_id) {
    db.prepare('UPDATE agents SET used = used + ? WHERE id = ?').run(count, agent_id);
  }
  res.json({ cards });
});

function generateCardKey() {
  return 'KAMI-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

router.delete('/cards/:id', adminAuthMiddleware, (req, res) => {
  const { id } = req.params;
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!card) return res.status(404).json({ error: '卡密不存在' });
  // 用户要求（2026-10-20）：任何状态都能删；只有「未使用」的才返还代理额度
  if (card.status === 0 && card.agent_id) {
    db.prepare('UPDATE agents SET used = MAX(used - 1, 0) WHERE id = ?').run(card.agent_id);
  }
  db.prepare('DELETE FROM claim_orders WHERE card_id = ?').run(card.id);
  db.prepare('DELETE FROM cards WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ==================== 卡密导出 Excel（拼接好 URL）====================
// ids=1,2,3 只导出选中的；不传 ids 导出全部（可按 status/agent_id 过滤）
router.get('/cards/export', adminAuthMiddleware, (req, res) => {
  const { status, agent_id, ids } = req.query;
  let sql = 'SELECT c.*, a.username as agent_name FROM cards c LEFT JOIN agents a ON c.agent_id = a.id WHERE 1=1';
  const params = [];
  if (ids) {
    const idList = String(ids).split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
    if (idList.length === 0) return res.status(400).json({ error: 'ids 参数不合法' });
    sql += ` AND c.id IN (${idList.map(() => '?').join(',')})`;
    params.push(...idList);
  } else {
    if (status !== undefined && status !== '') { sql += ' AND c.status = ?'; params.push(Number(status)); }
    if (agent_id) { sql += ' AND c.agent_id = ?'; params.push(Number(agent_id)); }
  }
  sql += ' ORDER BY c.id DESC';
  const cards = db.prepare(sql).all(...params);

  const rows = cards.map(c => ({
    'ID': c.id,
    '卡密': c.card_key,
    '领取链接': `${claimPageUrl(req)}?kami=${encodeURIComponent(c.card_key)}`,
    '状态': c.status === 1 ? '已使用' : '未使用',
    '备注': c.note || '',
    '所属代理': c.agent_name || '平台自营',
    '创建时间': c.created_at,
    '使用时间': c.used_at || '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 6 }, { wch: 20 }, { wch: 52 }, { wch: 10 }, { wch: 18 },
    { wch: 14 }, { wch: 20 }, { wch: 20 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '卡密');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `kami_export_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(buf));
});

// ==================== 批量删除卡密 ====================
// body: { ids: [1,2,3] }  只删未使用的；已使用的跳过并报告
router.post('/cards/batch-delete', adminAuthMiddleware, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids 不能为空' });
  }
  const idList = ids.map(Number).filter(n => Number.isFinite(n) && n > 0);
  if (idList.length === 0) return res.status(400).json({ error: 'ids 不合法' });

  let deleted = 0;
  let skipped = 0;
  const refund = new Map();  // agent_id -> 返还数量

  const delOrders = db.prepare('DELETE FROM claim_orders WHERE card_id = ?');
  const delCard = db.prepare('DELETE FROM cards WHERE id = ?');

  for (const id of idList) {
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
    if (!card) { skipped++; continue; }
    // 任何状态都能删；只有「未使用」的才返还额度
    if (card.status === 0 && card.agent_id) {
      refund.set(card.agent_id, (refund.get(card.agent_id) || 0) + 1);
    }
    delOrders.run(card.id);
    delCard.run(card.id);
    deleted++;
  }
  // 返还代理额度
  for (const [agentId, cnt] of refund) {
    db.prepare('UPDATE agents SET used = MAX(used - ?, 0) WHERE id = ?').run(cnt, agentId);
  }
  res.json({ ok: true, deleted, skipped });
});

// ==================== 统计数据（含饼图数据）====================
router.get('/stats', adminAuthMiddleware, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM cards').get().cnt;
  const used = db.prepare('SELECT COUNT(*) as cnt FROM cards WHERE status = 1').get().cnt;
  const unused = db.prepare('SELECT COUNT(*) as cnt FROM cards WHERE status = 0').get().cnt;

  // 领取订单统计
  const claimSuccess = db.prepare("SELECT COUNT(*) as cnt FROM claim_orders WHERE status='success'").get().cnt;
  const claimFailed = db.prepare("SELECT COUNT(*) as cnt FROM claim_orders WHERE status='failed'").get().cnt;
  const claimPending = db.prepare("SELECT COUNT(*) as cnt FROM claim_orders WHERE status IN ('pending','running')").get().cnt;

  const agents = db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM cards c WHERE c.agent_id = a.id) AS card_count
    FROM agents a ORDER BY a.id
  `).all();
  const claims = db.prepare(`
    SELECT o.*, c.card_key FROM claim_orders o
    LEFT JOIN cards c ON c.id = o.card_id
    ORDER BY o.id DESC LIMIT 20
  `).all();

  res.json({
    total, used, unused,
    claimSuccess, claimFailed, claimPending,
    pie: [
      { name: '卡密未使用', value: unused },
      { name: '卡密已使用', value: used },
    ],
    claimPie: [
      { name: '领取成功', value: claimSuccess },
      { name: '领取失败', value: claimFailed },
      { name: '进行中', value: claimPending },
    ],
    agents, claims,
  });
});

// ==================== 代理管理 ====================
// 代理列表
router.get('/agents', adminAuthMiddleware, (req, res) => {
  const agents = db.prepare(`
    SELECT a.id, a.username, a.quota, a.used, a.status, a.created_at,
           (a.quota - a.used) AS remaining,
           (SELECT COUNT(*) FROM cards c WHERE c.agent_id = a.id) AS card_count
    FROM agents a ORDER BY a.id
  `).all();
  res.json({ agents });
});

// 新增代理
router.post('/agents', adminAuthMiddleware, (req, res) => {
  const { username, password, quota = 0 } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  const exists = db.prepare('SELECT id FROM agents WHERE username = ?').get(username);
  if (exists) return res.status(400).json({ error: '用户名已存在' });
  const hashed = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO agents (username, password, quota, used, status) VALUES (?, ?, ?, 0, 1)'
  ).run(username, hashed, Number(quota) || 0);
  res.json({ ok: true, id: info.lastInsertRowid });
});

// 设置代理额度
router.put('/agents/:id/quota', adminAuthMiddleware, (req, res) => {
  const { quota } = req.body || {};
  if (quota === undefined || Number(quota) < 0) {
    return res.status(400).json({ error: '额度不合法' });
  }
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: '代理不存在' });
  db.prepare('UPDATE agents SET quota = ? WHERE id = ?').run(Number(quota), req.params.id);
  res.json({ ok: true });
});

// 启用/禁用代理
router.put('/agents/:id/status', adminAuthMiddleware, (req, res) => {
  const { status } = req.body || {};
  if (![0, 1].includes(Number(status))) {
    return res.status(400).json({ error: '状态不合法' });
  }
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: '代理不存在' });
  db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(Number(status), req.params.id);
  res.json({ ok: true });
});

// 重置代理密码
router.put('/agents/:id/password', adminAuthMiddleware, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: '密码不能为空' });
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: '代理不存在' });
  db.prepare('UPDATE agents SET password = ? WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});

// 删除代理（名下无未使用卡密才可删）
router.delete('/agents/:id', adminAuthMiddleware, (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: '代理不存在' });
  const cnt = db.prepare('SELECT COUNT(*) as cnt FROM cards WHERE agent_id = ? AND status = 0')
    .get(req.params.id).cnt;
  if (cnt > 0) {
    return res.status(400).json({ error: `该代理名下还有 ${cnt} 个未使用卡密，不能删除` });
  }
  db.prepare('DELETE FROM agents WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ==================== 系统设置 (代理IP / 打码Token) ====================
// 配置存 settings 表; claim-api 每次领取时实时读取 (改完即时生效, 无需重启)
router.get('/settings', adminAuthMiddleware, (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  res.json({
    proxy_extract_url: s.proxy_extract_url || '',
    jfbym_token: s.jfbym_token || '',
    proxy_enabled: s.proxy_enabled !== '0',
    proxy_keepalive: parseInt(s.proxy_keepalive || '0', 10) || 0,
    proxy_ttl: parseInt(s.proxy_ttl || '0', 10) || 0,
  });
});

router.post('/settings', adminAuthMiddleware, (req, res) => {
  const { proxy_extract_url, jfbym_token, proxy_enabled, proxy_keepalive, proxy_ttl } = req.body || {};
  const up = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')");
  const tx = db.transaction(() => {
    if (proxy_extract_url !== undefined) up.run('proxy_extract_url', String(proxy_extract_url || '').trim());
    if (jfbym_token !== undefined) up.run('jfbym_token', String(jfbym_token || '').trim());
    if (proxy_enabled !== undefined) up.run('proxy_enabled', proxy_enabled ? '1' : '0');
    if (proxy_keepalive !== undefined) up.run('proxy_keepalive', String(Math.max(0, parseInt(proxy_keepalive, 10) || 0)));
    if (proxy_ttl !== undefined) up.run('proxy_ttl', String(Math.max(0, parseInt(proxy_ttl, 10) || 0)));
  });
  tx();
  res.json({ ok: true });
});

// 测试代理提取链接 (拉一条线路验证)
router.post('/settings/test-proxy', adminAuthMiddleware, async (req, res) => {
  const url = (req.body && req.body.proxy_extract_url) ||
    db.prepare("SELECT value FROM settings WHERE key = 'proxy_extract_url'").get()?.value;
  if (!url) return res.json({ ok: false, msg: '未配置提取链接' });
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let line = '';
    if (text.trim().startsWith('{')) {
      const d = JSON.parse(text);
      const it = (d.data || [])[0] || {};
      line = it.proxy_ip ? `${it.proxy_ip}:${it.proxy_port}` : '';
    } else {
      line = (text.split('\n').find(l => l.trim()) || '').trim();
    }
    if (!line) return res.json({ ok: false, msg: '提取返回为空: ' + text.slice(0, 80) });
    res.json({ ok: true, msg: '提取成功: ' + line.split(':').slice(0, 2).join(':') });
  } catch (e) {
    res.json({ ok: false, msg: '提取失败: ' + e.message });
  }
});

// 测试打码 Token (查图鉴余额)
router.post('/settings/test-captcha', adminAuthMiddleware, async (req, res) => {
  const token = (req.body && req.body.jfbym_token) ||
    db.prepare("SELECT value FROM settings WHERE key = 'jfbym_token'").get()?.value;
  if (!token) return res.json({ ok: false, msg: '未配置打码Token' });
  try {
    const r = await fetch('http://api.jfbym.com/api/YmServer/getUserInfoApi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, type: 'score' }),
      signal: AbortSignal.timeout(20000),
    });
    const d = await r.json();
    if (d.code === 10001 || d.data?.score !== undefined) {
      return res.json({ ok: true, msg: `Token有效, 余额: ${d.data.score}` });
    }
    res.json({ ok: false, msg: d.msg || 'Token无效' });
  } catch (e) {
    res.json({ ok: false, msg: '查询失败: ' + e.message });
  }
});

// ==================== 兑换记录 (手机号/CK/到期/头像/用户名) ====================
router.get('/claim-records', adminAuthMiddleware, (req, res) => {
  const { page = 1, size = 20, phone = '', kami = '' } = req.query;
  const where = [];
  const args = [];
  if (phone) { where.push('o.phone LIKE ?'); args.push(`%${phone}%`); }
  if (kami) { where.push('c.card_key LIKE ?'); args.push(`%${kami}%`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM claim_orders o
    LEFT JOIN cards c ON c.id = o.card_id ${w}`).get(...args).c;
  const rows = db.prepare(`
    SELECT o.id, o.phone, o.status, o.result, o.member_expire_at, o.avatar,
           o.username, o.ck_before, o.ck_after, o.created_at, o.finished_at,
           c.card_key, a.username AS agent_username
    FROM claim_orders o
    LEFT JOIN cards c ON c.id = o.card_id
    LEFT JOIN agents a ON a.id = c.agent_id
    ${w} ORDER BY o.id DESC LIMIT ? OFFSET ?`)
    .all(...args, Number(size), (Number(page) - 1) * Number(size));
  res.json({ total, rows });
});

router.get('/claim-records/export', adminAuthMiddleware, (req, res) => {
  const { phone = '', kami = '' } = req.query;
  const where = [];
  const args = [];
  if (phone) { where.push('o.phone LIKE ?'); args.push(`%${phone}%`); }
  if (kami) { where.push('c.card_key LIKE ?'); args.push(`%${kami}%`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT o.id, o.phone, c.card_key, a.username AS agent_username, o.username,
           o.member_expire_at, o.status, o.result, o.ck_before, o.ck_after,
           o.created_at, o.finished_at
    FROM claim_orders o
    LEFT JOIN cards c ON c.id = o.card_id
    LEFT JOIN agents a ON a.id = c.agent_id
    ${w} ORDER BY o.id DESC`).all(...args);
  const data = rows.map(r => ({
    'ID': r.id, '手机号': r.phone, '卡密': r.card_key, '代理': r.agent_username || '-',
    '用户名': r.username || '-', '会员到期': r.member_expire_at || '-',
    '状态': r.status, '结果': r.result || '',
    '未转换CK': r.ck_before || '-', '转换后CK': r.ck_after || '-',
    '创建时间': r.created_at, '完成时间': r.finished_at || '-',
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '兑换记录');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=claim-records.xlsx');
  res.send(buf);
});

module.exports = router;
