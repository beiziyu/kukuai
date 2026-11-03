const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'kami-system-secret-2026';

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.admin = { id: payload.id, role: payload.role };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'token 无效' });
  }
}

function adminAuthMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // 管理端接口必须校验角色，否则代理 token 也能读全量卡密/代理列表并生成卡密
    if (payload.role !== 'admin') return res.status(403).json({ error: '无权限' });
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'token 无效' });
  }
}

function agentAuthMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'agent') return res.status(403).json({ error: '无权限' });
    req.agent = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'token 无效' });
  }
}

module.exports = { authMiddleware, adminAuthMiddleware, agentAuthMiddleware };
