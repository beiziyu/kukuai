require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

// 初始化数据库
const db = require('./db');

const adminRoutes = require('./routes/admin');
const agentRoutes = require('./routes/agent');
const clientRoutes = require('./routes/client');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'kami-system-secret-2026';


app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dist')));

// ==================== 统一登录（自动识别管理员/代理）====================
// 管理端和代理端同一个登录地址，后端按用户名自动判断身份，
// 返回 role: 'admin' | 'agent'，前端按 role 显示不同菜单和页面。
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  // 1) 先试管理员
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (admin && bcrypt.compareSync(password, admin.password)) {
    const token = jwt.sign({ id: admin.id, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({
      token,
      user: { id: admin.id, username: admin.username, role: 'admin' },
    });
  }

  // 2) 再试代理
  const agent = db.prepare('SELECT * FROM agents WHERE username = ?').get(username);
  if (agent && bcrypt.compareSync(password, agent.password)) {
    if (agent.status !== 1) return res.status(403).json({ error: '账号已被禁用' });
    const token = jwt.sign({ id: agent.id, role: 'agent' }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({
      token,
      user: {
        id: agent.id, username: agent.username, role: 'agent',
        quota: agent.quota, used: agent.used,
      },
    });
  }

  return res.status(401).json({ error: '用户名或密码错误' });
});

// API 路由
app.use('/api/admin', adminRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/client', clientRoutes);

// 健康检查
app.get('/health', (req, res) => res.json({ ok: true }));

// 前端 SPA 回退（非 API 请求）
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path === '/health') {
    return res.status(404).json({ error: 'Not Found' });
  }
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// 订单状态兜底对账：回调丢失时也能把 pending/running 拉回终态（避免后台一直「进行中」）
try {
  require('./reconcile').start();
} catch (e) {
  console.log('reconcile start failed:', e.message);
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
