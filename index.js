const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// ─── CONFIG ──────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'blacklord-secret-2024';
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

// ─── IN‑MEMORY STORAGE ──────────────────────────────────────────────────
const users = [];
const wallets = {};
const panels = {};
const bots = {};
const vouchers = [];
const transactions = {};
const pendingTopups = {};
const mpesaTransactions = {};
let userIdCounter = 1;
let panelIdCounter = 1;
let botIdCounter = 1;
let voucherIdCounter = 1;

// ─── HELPERS ──────────────────────────────────────────────────────────────
function getUserIdFromHeader(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    return decoded.userId;
  } catch { return null; }
}

function getUserWithBalance(userId) {
  const user = users.find(u => u.id === userId);
  if (!user) return null;
  return { ...user, sdBalance: wallets[userId] || 0 };
}

function generateRandomCode(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── SERVE HTML ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.send(html);
  } catch (e) {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Blacklord Tech</title></head>
      <body style="background:#0a0a0f;color:#fff;font-family:sans-serif;text-align:center;padding:40px;">
        <h1 style="color:#c084fc;">⚡ Blacklord Tech Inc</h1>
        <p>Server is running but index.html not found. Please upload the HTML file.</p>
        <p style="color:#64748b;font-size:14px;">${e.message}</p>
      </body></html>
    `);
  }
});

// ─── PAYMENT SUCCESS (Paystack callback) ──────────────────────────────
app.get('/payment-success', (req, res) => {
  const { reference, sd } = req.query;
  if (!reference) return res.redirect('/?error=missing_reference');
  const topup = pendingTopups[reference];
  if (!topup) return res.redirect('/?error=invalid_reference');
  wallets[topup.userId] = (wallets[topup.userId] || 0) + topup.sdAmount;
  if (!transactions[topup.userId]) transactions[topup.userId] = [];
  transactions[topup.userId].push({
    id: Date.now(),
    type: 'credit',
    amount: topup.sdAmount,
    description: 'Paystack top-up',
    created_at: new Date().toISOString()
  });
  delete pendingTopups[reference];
  res.redirect(`/?topup_success=1&sd=${topup.sdAmount}`);
});

// ─── MPESA CALLBACK ──────────────────────────────────────────────────────
app.post('/api/mpesa-callback', (req, res) => {
  try {
    const body = req.body;
    const resultCode = body?.Body?.stkCallback?.ResultCode;
    const checkoutId = body?.Body?.stkCallback?.CheckoutRequestID;
    const txn = Object.values(mpesaTransactions).find(t => t.checkoutRequestId === checkoutId);
    if (txn && txn.status === 'pending' && resultCode === '0') {
      wallets[txn.userId] = (wallets[txn.userId] || 0) + txn.sdAmount;
      if (!transactions[txn.userId]) transactions[txn.userId] = [];
      transactions[txn.userId].push({
        id: Date.now(),
        type: 'credit',
        amount: txn.sdAmount,
        description: `M-Pesa top-up ${txn.amount} KSH`,
        created_at: new Date().toISOString()
      });
      txn.status = 'success';
      delete pendingTopups[txn.reference];
    } else if (txn) {
      txn.status = 'failed';
    }
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (e) {
    console.error('M-Pesa callback error:', e);
    res.json({ ResultCode: 1, ResultDesc: 'Error' });
  }
});

// ─── API: SIGNUP ────────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (users.find(u => u.email === email)) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    const hashed = await bcrypt.hash(password, 10);
    const user = {
      id: userIdCounter++,
      firstname: firstName,
      lastname: lastName,
      email,
      password: hashed,
      created_at: new Date().toISOString()
    };
    users.push(user);
    wallets[user.id] = 50; // Welcome bonus
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({
      token,
      user: {
        id: user.id,
        firstName: user.firstname,
        lastName: user.lastname,
        email: user.email,
        sdBalance: 50
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// ─── API: LOGIN ─────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const user = users.find(u => u.email === email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user.id,
        firstName: user.firstname,
        lastName: user.lastname,
        email: user.email,
        sdBalance: wallets[user.id] || 0
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── API: GET /api/me ──────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const userPanels = panels[userId] || [];
  const userBots = bots[userId] || [];
  const userTxns = transactions[userId] || [];
  res.json({
    user: {
      id: user.id,
      firstName: user.firstname,
      lastName: user.lastname,
      email: user.email,
      sdBalance: wallets[userId] || 0,
      totalServers: userPanels.length + userBots.length,
      activeServers: userPanels.filter(p => p.status === 'active').length + userBots.filter(b => b.status === 'active').length,
      panels: userPanels,
      bots: userBots,
      voucherRedemptions: []
    }
  });
});

// ─── API: BUY PANEL / ADMIN ────────────────────────────────────────────
app.post('/api/buy', (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { productType, productId, username, password } = req.body;
  if (!productType || !username || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let sdPrice = 0, planName = '';
  if (productType === 'panel') {
    const prices = { '1gb': 625, '2gb': 1250, '4gb': 2500, 'unlimited': 5000 };
    if (!prices[productId]) return res.status(400).json({ error: 'Invalid panel plan' });
    sdPrice = prices[productId];
    planName = productId + ' Panel';
  } else if (productType === 'admin') {
    const prices = { 'admin-std': 1500, 'admin-pro': 2500, 'admin-enterprise': 5000 };
    if (!prices[productId]) return res.status(400).json({ error: 'Invalid admin plan' });
    sdPrice = prices[productId];
    planName = productId.replace('admin-', '').toUpperCase() + ' Admin';
  } else {
    return res.status(400).json({ error: 'Invalid product type' });
  }

  const balance = wallets[userId] || 0;
  if (balance < sdPrice) {
    return res.status(402).json({ error: 'Insufficient SD', sdBalance: balance, sdRequired: sdPrice });
  }

  wallets[userId] = balance - sdPrice;
  if (!transactions[userId]) transactions[userId] = [];
  transactions[userId].push({
    id: Date.now(),
    type: 'debit',
    amount: sdPrice,
    description: `Bought ${planName}`,
    created_at: new Date().toISOString()
  });

  if (!panels[userId]) panels[userId] = [];
  const panel = {
    id: panelIdCounter++,
    username,
    password,
    plan: planName,
    domain: `https://panel-${username}.blacklord.tech`,
    status: 'active',
    sdPrice,
    created_at: new Date().toISOString()
  };
  panels[userId].push(panel);
  res.json({ panel });
});

// ─── API: TOP-UP (Paystack + M-Pesa) ──────────────────────────────────
app.post('/api/topup', (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { amountKsh, paymentMethod, phone } = req.body;

  if (!amountKsh || amountKsh < 8) {
    return res.status(400).json({ error: 'Minimum top-up is 8 KSH' });
  }
  const sdAmount = Math.floor((amountKsh / 1.6));

  if (paymentMethod === 'mpesa') {
    if (!phone) {
      return res.status(400).json({ error: 'Phone number required for M-Pesa' });
    }
    // Normalise phone
    let phoneNumber = phone.replace(/^\+/, '').replace(/^0/, '');
    if (phoneNumber.startsWith('254')) phoneNumber = phoneNumber.slice(3);
    const fullPhone = '254' + phoneNumber;

    const reference = 'MP-' + Date.now() + '-' + generateRandomCode(4);
    const checkoutId = 'ws_CO_' + Date.now() + '_' + generateRandomCode(6);

    mpesaTransactions[reference] = {
      reference,
      userId,
      phone: fullPhone,
      amount: Math.round(amountKsh),
      sdAmount,
      status: 'pending',
      checkoutRequestId: checkoutId,
      created_at: new Date().toISOString()
    };

    pendingTopups[reference] = { userId, sdAmount, paymentMethod: 'mpesa', mpesa_phone: phone };

    // Simulate callback after 5 seconds (demo mode)
    setTimeout(() => {
      const txn = mpesaTransactions[reference];
      if (txn && txn.status === 'pending') {
        wallets[userId] = (wallets[userId] || 0) + sdAmount;
        if (!transactions[userId]) transactions[userId] = [];
        transactions[userId].push({
          id: Date.now(),
          type: 'credit',
          amount: sdAmount,
          description: `M-Pesa top-up ${amountKsh} KSH`,
          created_at: new Date().toISOString()
        });
        txn.status = 'success';
        delete pendingTopups[reference];
        console.log(`✅ Mock M-Pesa: ${sdAmount} SD credited to user ${userId}`);
      }
    }, 5000);

    return res.json({
      method: 'mpesa',
      message: 'STK Push sent (demo mode). You will be credited in 5 seconds.',
      checkoutRequestId: checkoutId,
      mock: true
    });
  } else {
    // Paystack
    const reference = 'BLK-' + Date.now() + '-' + generateRandomCode(6);
    pendingTopups[reference] = { userId, sdAmount, paymentMethod: 'paystack' };

    // For demo, we'll simulate a redirect
    const mockUrl = `${BASE_URL}/payment-success?reference=${reference}&sd=${sdAmount}`;
    return res.json({
      authorization_url: mockUrl,
      mock: true
    });
  }
});

// ─── API: CHECK MPESA STATUS ──────────────────────────────────────────
app.get('/api/mpesa-status', (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { reference } = req.query;
  if (!reference) return res.status(400).json({ error: 'Reference required' });
  const txn = mpesaTransactions[reference];
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  res.json({ status: txn.status, sdAmount: txn.sdAmount });
});

// ─── API: REDEEM VOUCHER ──────────────────────────────────────────────
app.post('/api/redeem-voucher', (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Voucher code required' });
  const voucher = vouchers.find(v => v.code === code.toUpperCase() && !v.usedBy);
  if (!voucher) return res.status(404).json({ error: 'Invalid or already used voucher' });
  voucher.usedBy = userId;
  voucher.usedAt = new Date().toISOString();
  wallets[userId] = (wallets[userId] || 0) + voucher.sdAmount;
  if (!transactions[userId]) transactions[userId] = [];
  transactions[userId].push({
    id: Date.now(),
    type: 'credit',
    amount: voucher.sdAmount,
    description: `Voucher ${code}`,
    created_at: new Date().toISOString()
  });
  res.json({ message: `Redeemed ${voucher.sdAmount} SD`, sdAmount: voucher.sdAmount });
});

// ─── API: ADMIN VOUCHERS ──────────────────────────────────────────────
app.get('/api/admin/vouchers', (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const user = users.find(u => u.id === userId);
  if (user?.email !== 'admin@blacklordtech.com') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({
    vouchers: vouchers.map(v => ({
      code: v.code,
      sdAmount: v.sdAmount,
      usedBy: v.usedBy,
      usedAt: v.usedAt
    }))
  });
});

app.post('/api/admin/generate-voucher', (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const user = users.find(u => u.id === userId);
  if (user?.email !== 'admin@blacklordtech.com') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { sdAmount } = req.body;
  if (!sdAmount || sdAmount < 1) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  const code = generateRandomCode(8);
  vouchers.push({
    id: voucherIdCounter++,
    code,
    sdAmount,
    usedBy: null,
    usedAt: null,
    created_at: new Date().toISOString()
  });
  res.json({ code, sdAmount });
});

// ─── API: PANEL ACTIONS ────────────────────────────────────────────────
app.post('/api/toggle-panel', (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const userPanels = panels[userId] || [];
  const panel = userPanels.find(p => p.username === username);
  if (!panel) return res.status(404).json({ error: 'Panel not found' });
  panel.status = panel.status === 'active' ? 'paused' : 'active';
  res.json({ status: panel.status });
});

app.post('/api/delete-panel', (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (panels[userId]) {
    panels[userId] = panels[userId].filter(p => p.username !== username);
  }
  res.json({ success: true });
});

// ─── API: BOT ACTIONS ──────────────────────────────────────────────────
app.post('/api/deploy-bot', (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Bot name required' });
  const botToken = 'bot' + generateRandomCode(8) + ':' + generateRandomCode(8);
  if (!bots[userId]) bots[userId] = [];
  const bot = {
    id: botIdCounter++,
    name,
    token: botToken,
    type: 'Telegram',
    status: 'active',
    created_at: new Date().toISOString()
  };
  bots[userId].push(bot);
  res.json({ bot });
});

app.post('/api/toggle-bot', (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  const userBots = bots[userId] || [];
  const bot = userBots.find(b => b.token === token);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  bot.status = bot.status === 'active' ? 'paused' : 'active';
  res.json({ status: bot.status });
});

app.post('/api/delete-bot', (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  if (bots[userId]) {
    bots[userId] = bots[userId].filter(b => b.token !== token);
  }
  res.json({ success: true });
});

// ─── START SERVER ──────────────────────────────────────────────────────
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Blacklord Tech (in‑memory mode) running on port ${PORT}`);
    console.log(`📌 Admin email: admin@blacklordtech.com`);
    console.log(`📌 Admin password: admin123`);
    console.log(`📌 All data resets on restart`);
  });
}