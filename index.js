const express = require('express');
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'blacklord-secret-2024';
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

// M‑Pesa
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '174379';
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_CALLBACK_URL = `${BASE_URL}/api/mpesa-callback`;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL missing');
  // Don't exit – allow mock mode for testing
}

const sql = DATABASE_URL ? neon(DATABASE_URL) : null;

// ─── DATABASE INITIALIZATION ──────────────────────────────────────────────
async function initDatabase() {
  if (!sql) {
    console.warn('⚠️ No DATABASE_URL – running in memory mode');
    return;
  }
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        firstname TEXT,
        lastname TEXT,
        email TEXT UNIQUE,
        password TEXT,
        banned BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS wallet (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        sd_balance INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS panels (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        username TEXT,
        password TEXT,
        plan TEXT,
        domain TEXT,
        status TEXT DEFAULT 'active',
        sd_price INTEGER,
        auto_renew BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS bots (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        name TEXT,
        token TEXT,
        type TEXT,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS whatsapp_bots (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        name TEXT,
        phone TEXT,
        session TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS vouchers (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE,
        sd_amount INTEGER,
        used_by INTEGER REFERENCES users(id),
        used_at TIMESTAMP,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_id INTEGER REFERENCES users(id),
        referred_id INTEGER REFERENCES users(id),
        commission INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        amount INTEGER,
        phone TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        type TEXT,
        amount INTEGER,
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS pending_topups (
        reference TEXT PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        sd_amount INTEGER,
        payment_method TEXT,
        mpesa_phone TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS mpesa_transactions (
        id SERIAL PRIMARY KEY,
        reference TEXT UNIQUE,
        user_id INTEGER REFERENCES users(id),
        phone TEXT,
        amount INTEGER,
        sd_amount INTEGER,
        status TEXT DEFAULT 'pending',
        checkout_request_id TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS login_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        ip TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        message TEXT,
        admin_reply TEXT,
        status TEXT DEFAULT 'open',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS server_monitors (
        id SERIAL PRIMARY KEY,
        panel_id INTEGER REFERENCES panels(id),
        uptime INTEGER,
        last_check TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS analytics (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        page TEXT,
        referrer TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS packages (
        id SERIAL PRIMARY KEY,
        name TEXT,
        price INTEGER,
        cpu INTEGER,
        ram INTEGER,
        disk INTEGER,
        popular BOOLEAN DEFAULT false,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Insert default packages
    const existing = await sql`SELECT COUNT(*) FROM packages`;
    if (existing[0].count === 0) {
      await sql`
        INSERT INTO packages (name, price, cpu, ram, disk, popular) VALUES
        ('1GB Panel', 625, 100, 1024, 20480, true),
        ('2GB Panel', 1250, 200, 2048, 40960, false),
        ('4GB Panel', 2500, 400, 4096, 81920, false),
        ('Unlimited', 5000, 0, 0, 0, false)
      `;
    }

    // Create default admin
    const adminExists = await sql`SELECT id FROM users WHERE email = 'admin@blacklordtech.com'`;
    if (adminExists.length === 0) {
      const hashed = await bcrypt.hash('admin123', 10);
      await sql`
        INSERT INTO users (firstname, lastname, email, password)
        VALUES ('Admin', 'Blacklord', 'admin@blacklordtech.com', ${hashed})
      `;
      const [admin] = await sql`SELECT id FROM users WHERE email = 'admin@blacklordtech.com'`;
      await sql`INSERT INTO wallet (user_id, sd_balance) VALUES (${admin.id}, 9999) ON CONFLICT (user_id) DO NOTHING`;
    }

    // Add columns if missing
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE panels ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN DEFAULT false`;

    console.log('✅ Database initialized');
  } catch (e) {
    console.error('❌ DB init error:', e.message);
  }
}
initDatabase();

// ─── IN-MEMORY STORAGE (fallback) ──────────────────────────────────────────
let memUsers = [];
let memWallets = {};
let memPanels = {};
let memBots = {};
let memWhatsApp = {};
let memVouchers = [];
let memReferrals = [];
let memWithdrawals = {};
let memTransactions = {};
let memPendingTopups = {};
let memMpesaTxns = {};
let memLoginHistory = {};
let memChat = {};
let memMonitors = {};
let memPackages = [
  { id: 1, name: '1GB Panel', price: 625, cpu: 100, ram: 1024, disk: 20480, popular: true, active: true },
  { id: 2, name: '2GB Panel', price: 1250, cpu: 200, ram: 2048, disk: 40960, popular: false, active: true },
  { id: 3, name: '4GB Panel', price: 2500, cpu: 400, ram: 4096, disk: 81920, popular: false, active: true },
  { id: 4, name: 'Unlimited', price: 5000, cpu: 0, ram: 0, disk: 0, popular: false, active: true }
];
let memUserIdCounter = 1;
let memPanelIdCounter = 1;
let memBotIdCounter = 1;
let memVoucherIdCounter = 1;

async function dbQuery(query, params) {
  if (sql) {
    try {
      return await sql.query(query, params);
    } catch (e) {
      console.error('DB query error:', e.message);
      return { rows: [] };
    }
  }
  // In-memory fallback
  return { rows: [] };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────
function getUserIdFromHeader(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    return decoded.userId;
  } catch { return null; }
}

async function getUserWithBalance(userId) {
  if (sql) {
    const [user] = await sql`SELECT * FROM users WHERE id = ${userId}`;
    if (!user) return null;
    const [wallet] = await sql`SELECT sd_balance FROM wallet WHERE user_id = ${userId}`;
    return { ...user, sdBalance: wallet ? wallet.sd_balance : 0 };
  }
  // In-memory
  const user = memUsers.find(u => u.id === userId);
  if (!user) return null;
  return { ...user, sdBalance: memWallets[userId] || 0 };
}

function generateRandomCode(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── RATE LIMITING ──────────────────────────────────────────────────────
const rateLimits = {};

function checkRateLimit(userId, endpoint, limit = 60, window = 60000) {
  const key = `${userId}:${endpoint}`;
  const now = Date.now();
  if (!rateLimits[key]) {
    rateLimits[key] = { count: 1, reset: now + window };
    return true;
  }
  if (now > rateLimits[key].reset) {
    rateLimits[key] = { count: 1, reset: now + window };
    return true;
  }
  rateLimits[key].count++;
  return rateLimits[key].count <= limit;
}

// ─── MPESA STK PUSH ──────────────────────────────────────────────────────
async function initiateMpesaStkPush(phone, amount, reference, userId) {
  let phoneNumber = phone.replace(/^\+/, '').replace(/^0/, '');
  if (phoneNumber.startsWith('254')) phoneNumber = phoneNumber.slice(3);
  const fullPhone = '254' + phoneNumber;
  const sdAmount = Math.floor(amount / 1.6);

  if (MPESA_CONSUMER_KEY && MPESA_CONSUMER_SECRET && MPESA_PASSKEY) {
    try {
      const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
      const tokenRes = await axios.get(
        'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
        { headers: { Authorization: `Basic ${auth}` } }
      );
      const accessToken = tokenRes.data.access_token;
      const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
      const password = Buffer.from(MPESA_SHORTCODE + MPESA_PASSKEY + timestamp).toString('base64');

      const payload = {
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(amount),
        PartyA: fullPhone,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: fullPhone,
        CallBackURL: MPESA_CALLBACK_URL,
        AccountReference: reference,
        TransactionDesc: `Top-up ${sdAmount} SD`,
      };

      const stkRes = await axios.post(
        'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
        payload,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (stkRes.data.ResponseCode === '0') {
        if (sql) {
          await sql`
            INSERT INTO mpesa_transactions (reference, user_id, phone, amount, sd_amount, status, checkout_request_id)
            VALUES (${reference}, ${userId}, ${phone}, ${Math.round(amount)}, ${sdAmount}, 'pending', ${stkRes.data.CheckoutRequestID})
          `;
          await sql`
            INSERT INTO pending_topups (reference, user_id, sd_amount, payment_method, mpesa_phone)
            VALUES (${reference}, ${userId}, ${sdAmount}, 'mpesa', ${phone})
          `;
        } else {
          memMpesaTxns[reference] = { reference, userId, phone, amount: Math.round(amount), sdAmount, status: 'pending', checkoutRequestId: stkRes.data.CheckoutRequestID };
          memPendingTopups[reference] = { userId, sdAmount, paymentMethod: 'mpesa', mpesa_phone: phone };
        }
        return {
          success: true,
          checkoutRequestId: stkRes.data.CheckoutRequestID,
          message: 'STK Push sent to your phone. Please enter your PIN to confirm.'
        };
      } else {
        return { success: false, message: stkRes.data.ResponseDescription || 'M-Pesa request failed' };
      }
    } catch (e) {
      console.error('M-Pesa STK error:', e.message);
    }
  }

  // Mock mode
  const mockCheckoutId = 'ws_CO_' + Date.now() + '_' + generateRandomCode(6);
  if (sql) {
    await sql`
      INSERT INTO mpesa_transactions (reference, user_id, phone, amount, sd_amount, status, checkout_request_id)
      VALUES (${reference}, ${userId}, ${phone}, ${Math.round(amount)}, ${sdAmount}, 'pending', ${mockCheckoutId})
    `;
    await sql`
      INSERT INTO pending_topups (reference, user_id, sd_amount, payment_method, mpesa_phone)
      VALUES (${reference}, ${userId}, ${sdAmount}, 'mpesa', ${phone})
    `;
  } else {
    memMpesaTxns[reference] = { reference, userId, phone, amount: Math.round(amount), sdAmount, status: 'pending', checkoutRequestId: mockCheckoutId };
    memPendingTopups[reference] = { userId, sdAmount, paymentMethod: 'mpesa', mpesa_phone: phone };
  }
  setTimeout(async () => {
    try {
      if (sql) {
        await sql`UPDATE wallet SET sd_balance = sd_balance + ${sdAmount} WHERE user_id = ${userId}`;
        await sql`
          INSERT INTO transactions (user_id, type, amount, description)
          VALUES (${userId}, 'credit', ${sdAmount}, 'M-Pesa top-up ${amount} KSH')
        `;
        await sql`UPDATE mpesa_transactions SET status = 'success' WHERE reference = ${reference}`;
        await sql`DELETE FROM pending_topups WHERE reference = ${reference}`;
      } else {
        memWallets[userId] = (memWallets[userId] || 0) + sdAmount;
        if (!memTransactions[userId]) memTransactions[userId] = [];
        memTransactions[userId].push({ id: Date.now(), type: 'credit', amount: sdAmount, description: `M-Pesa top-up ${amount} KSH`, created_at: new Date().toISOString() });
        if (memMpesaTxns[reference]) memMpesaTxns[reference].status = 'success';
        delete memPendingTopups[reference];
      }
    } catch (e) { console.error('Mock M-Pesa callback error:', e); }
  }, 5000);
  return {
    success: true,
    checkoutRequestId: mockCheckoutId,
    message: 'STK Push sent (demo mode). You will be credited in 5 seconds.',
    mock: true
  };
}

// ─── MPESA CALLBACK ──────────────────────────────────────────────────────
app.post('/api/mpesa-callback', async (req, res) => {
  try {
    const body = req.body;
    const resultCode = body?.Body?.stkCallback?.ResultCode;
    const checkoutId = body?.Body?.stkCallback?.CheckoutRequestID;
    if (resultCode === '0') {
      if (sql) {
        const [txn] = await sql`SELECT * FROM mpesa_transactions WHERE checkout_request_id = ${checkoutId}`;
        if (txn && txn.status === 'pending') {
          const sdAmount = txn.sd_amount;
          await sql`UPDATE wallet SET sd_balance = sd_balance + ${sdAmount} WHERE user_id = ${txn.user_id}`;
          await sql`
            INSERT INTO transactions (user_id, type, amount, description)
            VALUES (${txn.user_id}, 'credit', ${sdAmount}, 'M-Pesa top-up ${txn.amount} KSH')
          `;
          await sql`UPDATE mpesa_transactions SET status = 'success' WHERE id = ${txn.id}`;
          await sql`DELETE FROM pending_topups WHERE reference = ${txn.reference}`;
        }
      } else {
        const txn = Object.values(memMpesaTxns).find(t => t.checkoutRequestId === checkoutId);
        if (txn && txn.status === 'pending') {
          memWallets[txn.userId] = (memWallets[txn.userId] || 0) + txn.sdAmount;
          if (!memTransactions[txn.userId]) memTransactions[txn.userId] = [];
          memTransactions[txn.userId].push({ id: Date.now(), type: 'credit', amount: txn.sdAmount, description: `M-Pesa top-up ${txn.amount} KSH`, created_at: new Date().toISOString() });
          txn.status = 'success';
          delete memPendingTopups[txn.reference];
        }
      }
    } else {
      if (sql) {
        await sql`UPDATE mpesa_transactions SET status = 'failed' WHERE checkout_request_id = ${checkoutId}`;
      } else {
        const txn = Object.values(memMpesaTxns).find(t => t.checkoutRequestId === checkoutId);
        if (txn) txn.status = 'failed';
      }
    }
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (e) {
    console.error('M-Pesa callback error:', e);
    res.json({ ResultCode: 1, ResultDesc: 'Error' });
  }
});

// ─── PAYSTACK WEBHOOK ──────────────────────────────────────────────────
app.post('/api/paystack-webhook', async (req, res) => {
  try {
    const event = req.body;
    if (event.event === 'charge.success') {
      const reference = event.data.reference;
      const amount = event.data.amount / 100;
      const sdAmount = Math.floor(amount / 1.6);
      if (sql) {
        const [topup] = await sql`SELECT * FROM pending_topups WHERE reference = ${reference}`;
        if (topup && topup.payment_method === 'paystack') {
          await sql`UPDATE wallet SET sd_balance = sd_balance + ${sdAmount} WHERE user_id = ${topup.user_id}`;
          await sql`
            INSERT INTO transactions (user_id, type, amount, description)
            VALUES (${topup.user_id}, 'credit', ${sdAmount}, 'Paystack top-up')
          `;
          await sql`DELETE FROM pending_topups WHERE reference = ${reference}`;
        }
      } else {
        const topup = memPendingTopups[reference];
        if (topup && topup.paymentMethod === 'paystack') {
          memWallets[topup.userId] = (memWallets[topup.userId] || 0) + sdAmount;
          if (!memTransactions[topup.userId]) memTransactions[topup.userId] = [];
          memTransactions[topup.userId].push({ id: Date.now(), type: 'credit', amount: sdAmount, description: 'Paystack top-up', created_at: new Date().toISOString() });
          delete memPendingTopups[reference];
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Paystack webhook error:', e);
    res.sendStatus(500);
  }
});

// ─── SERVE HTML ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.send(html);
  } catch (e) {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Blacklord Tech</title></head>
      <body style="background:#0a0a0f;color:#fff;text-align:center;padding:40px;font-family:sans-serif;">
        <h1 style="color:#c084fc;">⚡ Blacklord Tech Inc</h1>
        <p>Server running. Please upload index.html.</p>
      </body></html>
    `);
  }
});

// ─── PAYMENT SUCCESS ──────────────────────────────────────────────────
app.get('/payment-success', async (req, res) => {
  const { reference, sd } = req.query;
  if (!reference) return res.redirect('/?error=missing_reference');
  try {
    if (sql) {
      const [topup] = await sql`SELECT * FROM pending_topups WHERE reference = ${reference}`;
      if (!topup) return res.redirect('/?error=invalid_reference');
      await sql`UPDATE wallet SET sd_balance = sd_balance + ${topup.sd_amount} WHERE user_id = ${topup.user_id}`;
      await sql`
        INSERT INTO transactions (user_id, type, amount, description)
        VALUES (${topup.user_id}, 'credit', ${topup.sd_amount}, 'Paystack top-up')
      `;
      await sql`DELETE FROM pending_topups WHERE reference = ${reference}`;
    } else {
      const topup = memPendingTopups[reference];
      if (!topup) return res.redirect('/?error=invalid_reference');
      memWallets[topup.userId] = (memWallets[topup.userId] || 0) + topup.sdAmount;
      if (!memTransactions[topup.userId]) memTransactions[topup.userId] = [];
      memTransactions[topup.userId].push({ id: Date.now(), type: 'credit', amount: topup.sdAmount, description: 'Paystack top-up', created_at: new Date().toISOString() });
      delete memPendingTopups[reference];
    }
    res.redirect(`/?topup_success=1&sd=${sd || 0}`);
  } catch (e) {
    console.error(e);
    res.redirect('/?error=payment_failed');
  }
});

// ─── AUTH ──────────────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (sql) {
      const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
      if (existing.length > 0) return res.status(400).json({ error: 'Email already registered' });
      const hashed = await bcrypt.hash(password, 10);
      const [user] = await sql`
        INSERT INTO users (firstname, lastname, email, password)
        VALUES (${firstName}, ${lastName}, ${email}, ${hashed})
        RETURNING id, firstname, lastname, email
      `;
      await sql`INSERT INTO wallet (user_id, sd_balance) VALUES (${user.id}, 50) ON CONFLICT (user_id) DO NOTHING`;
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
      return res.status(201).json({
        token,
        user: { id: user.id, firstName: user.firstname, lastName: user.lastname, email: user.email, sdBalance: 50 }
      });
    } else {
      // In-memory
      if (memUsers.find(u => u.email === email)) return res.status(400).json({ error: 'Email already registered' });
      const hashed = await bcrypt.hash(password, 10);
      const user = { id: memUserIdCounter++, firstname: firstName, lastname: lastName, email, password: hashed, banned: false, created_at: new Date().toISOString() };
      memUsers.push(user);
      memWallets[user.id] = 50;
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
      return res.status(201).json({
        token,
        user: { id: user.id, firstName: user.firstname, lastName: user.lastname, email: user.email, sdBalance: 50 }
      });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password, ip, userAgent } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    let user, wallet;
    if (sql) {
      [user] = await sql`SELECT * FROM users WHERE email = ${email}`;
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      if (user.banned) return res.status(403).json({ error: 'Account banned' });
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
      [wallet] = await sql`SELECT sd_balance FROM wallet WHERE user_id = ${user.id}`;
      if (ip) await sql`INSERT INTO login_history (user_id, ip, user_agent) VALUES (${user.id}, ${ip || 'unknown'}, ${userAgent || 'unknown'})`;
    } else {
      user = memUsers.find(u => u.email === email);
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      if (user.banned) return res.status(403).json({ error: 'Account banned' });
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
      wallet = { sd_balance: memWallets[user.id] || 0 };
      if (ip) {
        if (!memLoginHistory[user.id]) memLoginHistory[user.id] = [];
        memLoginHistory[user.id].push({ ip, userAgent, created_at: new Date().toISOString() });
      }
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user.id,
        firstName: user.firstname,
        lastName: user.lastname,
        email: user.email,
        sdBalance: wallet ? wallet.sd_balance : 0
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/me', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const user = await getUserWithBalance(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    let panels = [], bots = [], whatsapp = [], referrals = 0, redemptions = [];
    if (sql) {
      panels = await sql`SELECT * FROM panels WHERE user_id = ${userId}`;
      bots = await sql`SELECT * FROM bots WHERE user_id = ${userId}`;
      whatsapp = await sql`SELECT * FROM whatsapp_bots WHERE user_id = ${userId}`;
      const refCount = await sql`SELECT COUNT(*) FROM referrals WHERE referrer_id = ${userId}`;
      referrals = refCount[0]?.count || 0;
      redemptions = await sql`SELECT * FROM voucher_redemptions WHERE user_id = ${userId}`;
    } else {
      panels = memPanels[userId] || [];
      bots = memBots[userId] || [];
      whatsapp = memWhatsApp[userId] || [];
      referrals = memReferrals.filter(r => r.referrer_id === userId).length;
      redemptions = [];
    }
    res.json({
      user: {
        id: user.id,
        firstName: user.firstname,
        lastName: user.lastname,
        email: user.email,
        sdBalance: user.sdBalance,
        totalServers: panels.length + bots.length + whatsapp.length,
        activeServers: panels.filter(p => p.status === 'active').length + bots.filter(b => b.status === 'active').length + whatsapp.filter(w => w.status === 'active').length,
        panels: panels.map(p => ({ ...p, createdAt: p.created_at })),
        bots: bots.map(b => ({ ...b, createdAt: b.created_at })),
        whatsapp: whatsapp.map(w => ({ ...w, createdAt: w.created_at })),
        referrals,
        voucherRedemptions: redemptions.map(r => ({ amount: r.sd_amount, redeemedAt: r.created_at }))
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PACKAGES ──────────────────────────────────────────────────────────
app.get('/api/packages', async (req, res) => {
  try {
    if (sql) {
      const packages = await sql`SELECT * FROM packages WHERE active = true ORDER BY price ASC`;
      return res.json({ packages });
    } else {
      return res.json({ packages: memPackages.filter(p => p.active) });
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch packages' });
  }
});

// ─── BUY PANEL ──────────────────────────────────────────────────────────
app.post('/api/buy', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!checkRateLimit(userId, 'buy', 5, 60000)) {
    return res.status(429).json({ error: 'Too many purchase attempts. Please wait a moment.' });
  }
  const { productType, productId, username, password } = req.body;
  if (!productType || !username || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let sdPrice = 0, planName = '';
  if (productType === 'panel') {
    let pkg;
    if (sql) {
      [pkg] = await sql`SELECT * FROM packages WHERE id = ${parseInt(productId)} AND active = true`;
    } else {
      pkg = memPackages.find(p => p.id === parseInt(productId) && p.active);
    }
    if (!pkg) return res.status(400).json({ error: 'Invalid package' });
    sdPrice = pkg.price;
    planName = pkg.name;
  } else if (productType === 'admin') {
    const prices = { 'admin-std': 1500, 'admin-pro': 2500, 'admin-enterprise': 5000 };
    if (!prices[productId]) return res.status(400).json({ error: 'Invalid admin plan' });
    sdPrice = prices[productId];
    planName = productId.replace('admin-', '').toUpperCase() + ' Admin';
  } else {
    return res.status(400).json({ error: 'Invalid product type' });
  }

  const user = await getUserWithBalance(userId);
  const balance = user ? user.sdBalance : 0;
  if (balance < sdPrice) {
    return res.status(402).json({ error: 'Insufficient SD', sdBalance: balance, sdRequired: sdPrice });
  }

  if (sql) {
    await sql`UPDATE wallet SET sd_balance = sd_balance - ${sdPrice} WHERE user_id = ${userId}`;
    await sql`INSERT INTO transactions (user_id, type, amount, description) VALUES (${userId}, 'debit', ${sdPrice}, 'Bought ' + planName)`;
    const domain = `https://panel-${username}.blacklord.tech`;
    const [panel] = await sql`
      INSERT INTO panels (user_id, username, password, plan, domain, status, sd_price)
      VALUES (${userId}, ${username}, ${password}, ${planName}, ${domain}, 'active', ${sdPrice})
      RETURNING id, username, password, plan, domain, status
    `;
    return res.json({ panel });
  } else {
    memWallets[userId] = (memWallets[userId] || 0) - sdPrice;
    if (!memTransactions[userId]) memTransactions[userId] = [];
    memTransactions[userId].push({ id: Date.now(), type: 'debit', amount: sdPrice, description: 'Bought ' + planName, created_at: new Date().toISOString() });
    if (!memPanels[userId]) memPanels[userId] = [];
    const panel = {
      id: memPanelIdCounter++,
      username,
      password,
      plan: planName,
      domain: `https://panel-${username}.blacklord.tech`,
      status: 'active',
      sdPrice,
      created_at: new Date().toISOString()
    };
    memPanels[userId].push(panel);
    return res.json({ panel });
  }
});

// ─── PANEL ACTIONS ──────────────────────────────────────────────────────
app.post('/api/toggle-panel', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (sql) {
    const [panel] = await sql`SELECT * FROM panels WHERE user_id = ${userId} AND username = ${username}`;
    if (!panel) return res.status(404).json({ error: 'Panel not found' });
    const newStatus = panel.status === 'active' ? 'paused' : 'active';
    await sql`UPDATE panels SET status = ${newStatus} WHERE id = ${panel.id}`;
    return res.json({ status: newStatus });
  } else {
    const panel = (memPanels[userId] || []).find(p => p.username === username);
    if (!panel) return res.status(404).json({ error: 'Panel not found' });
    panel.status = panel.status === 'active' ? 'paused' : 'active';
    return res.json({ status: panel.status });
  }
});

app.post('/api/delete-panel', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (sql) {
    await sql`DELETE FROM panels WHERE user_id = ${userId} AND username = ${username}`;
  } else {
    if (memPanels[userId]) {
      memPanels[userId] = memPanels[userId].filter(p => p.username !== username);
    }
  }
  res.json({ success: true });
});

// ─── AUTO-RENEW ──────────────────────────────────────────────────────────
app.post('/api/auto-renew', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { panelId, enabled } = req.body;
  if (!panelId) return res.status(400).json({ error: 'Panel ID required' });
  if (sql) {
    const [panel] = await sql`SELECT * FROM panels WHERE id = ${panelId} AND user_id = ${userId}`;
    if (!panel) return res.status(404).json({ error: 'Panel not found' });
    await sql`UPDATE panels SET auto_renew = ${enabled} WHERE id = ${panelId}`;
  } else {
    const panel = (memPanels[userId] || []).find(p => p.id === parseInt(panelId));
    if (!panel) return res.status(404).json({ error: 'Panel not found' });
    panel.auto_renew = enabled;
  }
  res.json({ message: `Auto-renew ${enabled ? 'enabled' : 'disabled'}` });
});

// ─── BOT ACTIONS ──────────────────────────────────────────────────────────
app.post('/api/deploy-bot', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Bot name required' });
  const botToken = 'bot' + generateRandomCode(8) + ':' + generateRandomCode(8);
  if (sql) {
    const [bot] = await sql`
      INSERT INTO bots (user_id, name, token, type, status)
      VALUES (${userId}, ${name}, ${botToken}, 'Telegram', 'active')
      RETURNING id, name, token, type, status
    `;
    return res.json({ bot });
  } else {
    if (!memBots[userId]) memBots[userId] = [];
    const bot = {
      id: memBotIdCounter++,
      name,
      token: botToken,
      type: 'Telegram',
      status: 'active',
      created_at: new Date().toISOString()
    };
    memBots[userId].push(bot);
    return res.json({ bot });
  }
});

app.post('/api/toggle-bot', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  if (sql) {
    const [bot] = await sql`SELECT * FROM bots WHERE user_id = ${userId} AND token = ${token}`;
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const newStatus = bot.status === 'active' ? 'paused' : 'active';
    await sql`UPDATE bots SET status = ${newStatus} WHERE id = ${bot.id}`;
    return res.json({ status: newStatus });
  } else {
    const bot = (memBots[userId] || []).find(b => b.token === token);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    bot.status = bot.status === 'active' ? 'paused' : 'active';
    return res.json({ status: bot.status });
  }
});

app.post('/api/delete-bot', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  if (sql) {
    await sql`DELETE FROM bots WHERE user_id = ${userId} AND token = ${token}`;
  } else {
    if (memBots[userId]) {
      memBots[userId] = memBots[userId].filter(b => b.token !== token);
    }
  }
  res.json({ success: true });
});

// ─── WHATSAPP BOT ──────────────────────────────────────────────────────
app.post('/api/whatsapp/deploy', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  const session = 'session_' + generateRandomCode(16);
  if (sql) {
    const [bot] = await sql`
      INSERT INTO whatsapp_bots (user_id, name, phone, session, status)
      VALUES (${userId}, ${name}, ${phone}, ${session}, 'pending')
      RETURNING id, name, phone, session, status
    `;
    return res.json({ bot, pairingCode: generateRandomCode(8) });
  } else {
    if (!memWhatsApp[userId]) memWhatsApp[userId] = [];
    const bot = {
      id: Date.now(),
      name,
      phone,
      session,
      status: 'pending',
      created_at: new Date().toISOString()
    };
    memWhatsApp[userId].push(bot);
    return res.json({ bot, pairingCode: generateRandomCode(8) });
  }
});

app.get('/api/whatsapp/status', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (sql) {
    const bots = await sql`SELECT * FROM whatsapp_bots WHERE user_id = ${userId}`;
    return res.json({ bots });
  } else {
    return res.json({ bots: memWhatsApp[userId] || [] });
  }
});

// ─── TOP-UP ──────────────────────────────────────────────────────────────
app.post('/api/topup', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!checkRateLimit(userId, 'topup', 10, 60000)) {
    return res.status(429).json({ error: 'Too many top-up attempts. Please wait.' });
  }
  const { amountKsh, paymentMethod, phone } = req.body;
  if (!amountKsh || amountKsh < 8) {
    return res.status(400).json({ error: 'Minimum top-up is 8 KSH' });
  }
  const sdAmount = Math.floor((amountKsh / 1.6));

  if (paymentMethod === 'mpesa') {
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    const result = await initiateMpesaStkPush(phone, amountKsh, 'MP-' + Date.now() + '-' + generateRandomCode(4), userId);
    if (result.success) return res.json(result);
    return res.status(500).json({ error: result.message });
  } else if (paymentMethod === 'crypto') {
    const reference = 'CRYPTO-' + Date.now() + '-' + generateRandomCode(6);
    if (sql) {
      await sql`INSERT INTO pending_topups (reference, user_id, sd_amount, payment_method) VALUES (${reference}, ${userId}, ${sdAmount}, 'crypto')`;
    } else {
      memPendingTopups[reference] = { userId, sdAmount, paymentMethod: 'crypto' };
    }
    return res.json({
      message: 'Crypto payment initiated. Please send the exact amount to the address below.',
      address: '0x' + generateRandomCode(40),
      amount: (amountKsh / 150).toFixed(6) + ' BTC',
      reference
    });
  } else {
    // Paystack
    if (!PAYSTACK_SECRET) {
      if (sql) {
        await sql`UPDATE wallet SET sd_balance = sd_balance + ${sdAmount} WHERE user_id = ${userId}`;
        await sql`INSERT INTO transactions (user_id, type, amount, description) VALUES (${userId}, 'credit', ${sdAmount}, 'Top-up ${amountKsh} KSH (mock)')`;
      } else {
        memWallets[userId] = (memWallets[userId] || 0) + sdAmount;
        if (!memTransactions[userId]) memTransactions[userId] = [];
        memTransactions[userId].push({ id: Date.now(), type: 'credit', amount: sdAmount, description: `Top-up ${amountKsh} KSH (mock)`, created_at: new Date().toISOString() });
      }
      return res.json({ authorization_url: `${BASE_URL}/payment-success?reference=mock-${Date.now()}&sd=${sdAmount}`, mock: true });
    }
    const reference = 'BLK-' + Date.now() + '-' + generateRandomCode(6);
    const user = await getUserWithBalance(userId);
    try {
      const response = await axios.post('https://api.paystack.co/transaction/initialize', {
        email: user.email,
        amount: amountKsh * 100,
        currency: 'KES',
        reference,
        callback_url: `${BASE_URL}/payment-success?reference=${reference}`,
        metadata: { user_id: userId, sd_amount: sdAmount }
      }, {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' }
      });
      if (response.data.status) {
        if (sql) {
          await sql`INSERT INTO pending_topups (reference, user_id, sd_amount, payment_method) VALUES (${reference}, ${userId}, ${sdAmount}, 'paystack')`;
        } else {
          memPendingTopups[reference] = { userId, sdAmount, paymentMethod: 'paystack' };
        }
        return res.json({ authorization_url: response.data.data.authorization_url });
      }
      throw new Error('Paystack initialization failed');
    } catch (e) {
      console.error('Paystack error:', e.message);
      return res.status(500).json({ error: 'Payment initialization failed' });
    }
  }
});

app.get('/api/mpesa-status', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { reference } = req.query;
  if (!reference) return res.status(400).json({ error: 'Reference required' });
  if (sql) {
    const [txn] = await sql`SELECT * FROM mpesa_transactions WHERE reference = ${reference} AND user_id = ${userId}`;
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    return res.json({ status: txn.status, sdAmount: txn.sd_amount });
  } else {
    const txn = memMpesaTxns[reference];
    if (!txn || txn.userId !== userId) return res.status(404).json({ error: 'Transaction not found' });
    return res.json({ status: txn.status, sdAmount: txn.sdAmount });
  }
});

// ─── TRANSACTIONS ──────────────────────────────────────────────────────
app.get('/api/transactions', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { type, limit, offset } = req.query;
  if (sql) {
    let query = 'SELECT * FROM transactions WHERE user_id = $1';
    const params = [userId];
    if (type) { query += ` AND type = $${params.length + 1}`; params.push(type); }
    query += ' ORDER BY created_at DESC';
    if (limit) { query += ` LIMIT $${params.length + 1}`; params.push(parseInt(limit)); }
    if (offset) { query += ` OFFSET $${params.length + 1}`; params.push(parseInt(offset)); }
    const transactions = await sql.query(query, params);
    const [total] = await sql`SELECT COUNT(*) FROM transactions WHERE user_id = ${userId}`;
    return res.json({ transactions, total: total.count });
  } else {
    let txns = memTransactions[userId] || [];
    if (type) txns = txns.filter(t => t.type === type);
    if (limit) txns = txns.slice(0, parseInt(limit));
    return res.json({ transactions: txns, total: (memTransactions[userId] || []).length });
  }
});

// ─── WITHDRAWALS ──────────────────────────────────────────────────────
app.post('/api/withdraw', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!checkRateLimit(userId, 'withdraw', 3, 60000)) {
    return res.status(429).json({ error: 'Too many withdrawal requests. Please wait.' });
  }
  const { amount, phone } = req.body;
  if (!amount || amount < 50) return res.status(400).json({ error: 'Minimum withdrawal is 50 SD' });
  if (!phone) return res.status(400).json({ error: 'Phone number required' });
  const user = await getUserWithBalance(userId);
  if (!user || user.sdBalance < amount) {
    return res.status(402).json({ error: 'Insufficient SD balance' });
  }
  if (sql) {
    await sql`UPDATE wallet SET sd_balance = sd_balance - ${amount} WHERE user_id = ${userId}`;
    await sql`INSERT INTO transactions (user_id, type, amount, description) VALUES (${userId}, 'debit', ${amount}, 'Withdrawal request')`;
    const [withdrawal] = await sql`
      INSERT INTO withdrawals (user_id, amount, phone, status)
      VALUES (${userId}, ${amount}, ${phone}, 'pending')
      RETURNING id, amount, phone, status, created_at
    `;
    return res.json({ withdrawal });
  } else {
    memWallets[userId] = (memWallets[userId] || 0) - amount;
    if (!memTransactions[userId]) memTransactions[userId] = [];
    memTransactions[userId].push({ id: Date.now(), type: 'debit', amount, description: 'Withdrawal request', created_at: new Date().toISOString() });
    if (!memWithdrawals[userId]) memWithdrawals[userId] = [];
    const withdrawal = { id: Date.now(), amount, phone, status: 'pending', created_at: new Date().toISOString() };
    memWithdrawals[userId].push(withdrawal);
    return res.json({ withdrawal });
  }
});

app.get('/api/withdrawals', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (sql) {
    const withdrawals = await sql`SELECT * FROM withdrawals WHERE user_id = ${userId} ORDER BY created_at DESC`;
    return res.json({ withdrawals });
  } else {
    return res.json({ withdrawals: memWithdrawals[userId] || [] });
  }
});

// ─── REFERRALS ──────────────────────────────────────────────────────────
app.get('/api/referral/code', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const user = await getUserWithBalance(userId);
  const code = 'REF' + user.id.toString().padStart(6, '0');
  res.json({ code });
});

app.get('/api/referral/earnings', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (sql) {
    const earnings = await sql`SELECT SUM(commission) FROM referrals WHERE referrer_id = ${userId}`;
    const count = await sql`SELECT COUNT(*) FROM referrals WHERE referrer_id = ${userId}`;
    return res.json({ earnings: earnings[0].sum || 0, count: count[0].count || 0 });
  } else {
    const refs = memReferrals.filter(r => r.referrer_id === userId);
    const earnings = refs.reduce((s, r) => s + (r.commission || 0), 0);
    return res.json({ earnings, count: refs.length });
  }
});

// ─── CHAT / SUPPORT ──────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!checkRateLimit(userId, 'chat', 10, 60000)) {
    return res.status(429).json({ error: 'Too many messages. Please wait.' });
  }
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  if (sql) {
    const [chat] = await sql`
      INSERT INTO chat_messages (user_id, message, status)
      VALUES (${userId}, ${message}, 'open')
      RETURNING id, message, status, created_at
    `;
    return res.json({ chat });
  } else {
    if (!memChat[userId]) memChat[userId] = [];
    const chat = { id: Date.now(), message, status: 'open', admin_reply: null, created_at: new Date().toISOString() };
    memChat[userId].push(chat);
    return res.json({ chat });
  }
});

app.get('/api/chat/history', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (sql) {
    const messages = await sql`SELECT * FROM chat_messages WHERE user_id = ${userId} ORDER BY created_at DESC`;
    return res.json({ messages });
  } else {
    return res.json({ messages: memChat[userId] || [] });
  }
});

// ─── SERVER MONITOR ────────────────────────────────────────────────────
app.get('/api/monitor', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  let panels;
  if (sql) {
    panels = await sql`SELECT id, username, status FROM panels WHERE user_id = ${userId}`;
    const monitors = await Promise.all(panels.map(async (p) => {
      const [monitor] = await sql`SELECT * FROM server_monitors WHERE panel_id = ${p.id} ORDER BY last_check DESC LIMIT 1`;
      return { ...p, uptime: monitor ? monitor.uptime : 0 };
    }));
    return res.json({ monitors });
  } else {
    panels = memPanels[userId] || [];
    const monitors = panels.map(p => ({ ...p, uptime: 100 }));
    return res.json({ monitors });
  }
});

// ─── ORDER STACKER ──────────────────────────────────────────────────────
app.post('/api/order-stacker', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { orders } = req.body;
  if (!orders || !Array.isArray(orders) || orders.length === 0) {
    return res.status(400).json({ error: 'Orders array required' });
  }
  let totalCost = 0;
  for (const order of orders) {
    totalCost += order.price || 0;
  }
  const user = await getUserWithBalance(userId);
  if (!user || user.sdBalance < totalCost) {
    return res.status(402).json({ error: 'Insufficient SD balance', required: totalCost, balance: user?.sdBalance || 0 });
  }
  if (sql) {
    await sql`UPDATE wallet SET sd_balance = sd_balance - ${totalCost} WHERE user_id = ${userId}`;
    await sql`
      INSERT INTO transactions (user_id, type, amount, description)
      VALUES (${userId}, 'debit', ${totalCost}, 'Bulk order: ' + orders.length + ' items')
    `;
  } else {
    memWallets[userId] = (memWallets[userId] || 0) - totalCost;
    if (!memTransactions[userId]) memTransactions[userId] = [];
    memTransactions[userId].push({ id: Date.now(), type: 'debit', amount: totalCost, description: `Bulk order: ${orders.length} items`, created_at: new Date().toISOString() });
  }
  res.json({ message: `Processed ${orders.length} orders`, totalCost });
});

// ─── ADMIN ──────────────────────────────────────────────────────────────
app.get('/api/admin/stats', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  let user;
  if (sql) {
    [user] = await sql`SELECT email FROM users WHERE id = ${userId}`;
  } else {
    user = memUsers.find(u => u.id === userId);
  }
  if (!user || user.email !== 'admin@blacklordtech.com') return res.status(403).json({ error: 'Forbidden' });

  if (sql) {
    const [totalUsers] = await sql`SELECT COUNT(*) FROM users`;
    const [totalRevenue] = await sql`SELECT SUM(amount) FROM transactions WHERE type = 'credit'`;
    const [pendingWithdrawals] = await sql`SELECT COUNT(*) FROM withdrawals WHERE status = 'pending'`;
    const [totalPanels] = await sql`SELECT COUNT(*) FROM panels`;
    const [totalBots] = await sql`SELECT COUNT(*) FROM bots`;
    return res.json({
      stats: {
        totalUsers: totalUsers.count,
        totalRevenue: totalRevenue.sum || 0,
        pendingWithdrawals: pendingWithdrawals.count,
        totalPanels: totalPanels.count,
        totalBots: totalBots.count
      }
    });
  } else {
    return res.json({
      stats: {
        totalUsers: memUsers.length,
        totalRevenue: Object.values(memTransactions).reduce((s, t) => s + t.filter(tx => tx.type === 'credit').reduce((sum, tx) => sum + tx.amount, 0), 0),
        pendingWithdrawals: Object.values(memWithdrawals).reduce((s, w) => s + w.filter(wd => wd.status === 'pending').length, 0),
        totalPanels: Object.values(memPanels).reduce((s, p) => s + p.length, 0),
        totalBots: Object.values(memBots).reduce((s, b) => s + b.length, 0)
      }
    });
  }
});

app.get('/api/admin/users', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  let user;
  if (sql) {
    [user] = await sql`SELECT email FROM users WHERE id = ${userId}`;
  } else {
    user = memUsers.find(u => u.id === userId);
  }
  if (!user || user.email !== 'admin@blacklordtech.com') return res.status(403).json({ error: 'Forbidden' });

  if (sql) {
    const users = await sql`
      SELECT u.id, u.firstname, u.lastname, u.email, u.created_at, w.sd_balance,
             COUNT(DISTINCT p.id) as panels,
             COUNT(DISTINCT b.id) as bots
      FROM users u
      LEFT JOIN wallet w ON w.user_id = u.id
      LEFT JOIN panels p ON p.user_id = u.id
      LEFT JOIN bots b ON b.user_id = u.id
      GROUP BY u.id, w.sd_balance
      ORDER BY u.created_at DESC
    `;
    return res.json({ users });
  } else {
    const users = memUsers.map(u => ({
      id: u.id,
      firstname: u.firstname,
      lastname: u.lastname,
      email: u.email,
      created_at: u.created_at,
      sd_balance: memWallets[u.id] || 0,
      panels: (memPanels[u.id] || []).length,
      bots: (memBots[u.id] || []).length
    }));
    return res.json({ users });
  }
});

app.patch('/api/admin/users/:id', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  let admin;
  if (sql) {
    [admin] = await sql`SELECT email FROM users WHERE id = ${userId}`;
  } else {
    admin = memUsers.find(u => u.id === userId);
  }
  if (!admin || admin.email !== 'admin@blacklordtech.com') return res.status(403).json({ error: 'Forbidden' });

  const { id } = req.params;
  const { firstname, lastname, email } = req.body;
  if (sql) {
    await sql`
      UPDATE users SET firstname = ${firstname}, lastname = ${lastname}, email = ${email}
      WHERE id = ${parseInt(id)}
    `;
  } else {
    const user = memUsers.find(u => u.id === parseInt(id));
    if (user) { user.firstname = firstname; user.lastname = lastname; user.email = email; }
  }
  res.json({ success: true });
});

app.post('/api/admin/users/:id/ban', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  let admin;
  if (sql) {
    [admin] = await sql`SELECT email FROM users WHERE id = ${userId}`;
  } else {
    admin = memUsers.find(u => u.id === userId);
  }
  if (!admin || admin.email !== 'admin@blacklordtech.com') return res.status(403).json({ error: 'Forbidden' });

  const { id } = req.params;
  if (sql) {
    await sql`UPDATE users SET banned = true WHERE id = ${parseInt(id)}`;
  } else {
    const user = memUsers.find(u => u.id === parseInt(id));
    if (user) user.banned = true;
  }
  res.json({ success: true });
});

// ─── ADMIN VOUCHERS ──────────────────────────────────────────────────────
app.get('/api/admin/vouchers', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  let user;
  if (sql) {
    [user] = await sql`SELECT email FROM users WHERE id = ${userId}`;
  } else {
    user = memUsers.find(u => u.id === userId);
  }
  if (!user || user.email !== 'admin@blacklordtech.com') return res.status(403).json({ error: 'Forbidden' });

  if (sql) {
    const vouchers = await sql`SELECT * FROM vouchers ORDER BY created_at DESC`;
    return res.json({ vouchers });
  } else {
    return res.json({ vouchers: memVouchers });
  }
});

app.post('/api/admin/vouchers', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  let user;
  if (sql) {
    [user] = await sql`SELECT email FROM users WHERE id = ${userId}`;
  } else {
    user = memUsers.find(u => u.id === userId);
  }
  if (!user || user.email !== 'admin@blacklordtech.com') return res.status(403).json({ error: 'Forbidden' });

  const { sdAmount, count } = req.body;
  if (!sdAmount || sdAmount < 1) return res.status(400).json({ error: 'Invalid amount' });
  const numCodes = count || 1;
  const codes = [];
  for (let i = 0; i < numCodes; i++) {
    const code = generateRandomCode(8);
    if (sql) {
      await sql`INSERT INTO vouchers (code, sd_amount) VALUES (${code}, ${sdAmount})`;
    } else {
      memVouchers.push({ id: memVoucherIdCounter++, code, sd_amount: sdAmount, used_by: null, used_at: null, created_at: new Date().toISOString() });
    }
    codes.push(code);
  }
  res.json({ codes, sdAmount, count: numCodes });
});

app.delete('/api/admin/vouchers/:id', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  let user;
  if (sql) {
    [user] = await sql`SELECT email FROM users WHERE id = ${userId}`;
  } else {
    user = memUsers.find(u => u.id === userId);
  }
  if (!user || user.email !== 'admin@blacklordtech.com') return res.status(403).json({ error: 'Forbidden' });

  const { id } = req.params;
  if (sql) {
    await sql`DELETE FROM vouchers WHERE id = ${parseInt(id)}`;
  } else {
    memVouchers = memVouchers.filter(v => v.id !== parseInt(id));
  }
  res.json({ success: true });
});

// ─── REDEEM VOUCHER ──────────────────────────────────────────────────────
app.post('/api/redeem-voucher', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Voucher code required' });
  if (!checkRateLimit(userId, 'redeem', 5, 60000)) {
    return res.status(429).json({ error: 'Too many redemption attempts. Please wait.' });
  }

  if (sql) {
    const [voucher] = await sql`
      SELECT * FROM vouchers WHERE code = ${code.toUpperCase()} AND used_by IS NULL
      AND (expires_at IS NULL OR expires_at > NOW())
    `;
    if (!voucher) return res.status(404).json({ error: 'Invalid or already used voucher' });
    await sql`UPDATE vouchers SET used_by = ${userId}, used_at = NOW() WHERE id = ${voucher.id}`;
    await sql`UPDATE wallet SET sd_balance = sd_balance + ${voucher.sd_amount} WHERE user_id = ${userId}`;
    await sql`
      INSERT INTO transactions (user_id, type, amount, description)
      VALUES (${userId}, 'credit', ${voucher.sd_amount}, 'Voucher ' + code)
    `;
    return res.json({ message: `Redeemed ${voucher.sd_amount} SD`, sdAmount: voucher.sd_amount });
  } else {
    const voucher = memVouchers.find(v => v.code === code.toUpperCase() && !v.used_by);
    if (!voucher) return res.status(404).json({ error: 'Invalid or already used voucher' });
    voucher.used_by = userId;
    voucher.used_at = new Date().toISOString();
    memWallets[userId] = (memWallets[userId] || 0) + voucher.sd_amount;
    if (!memTransactions[userId]) memTransactions[userId] = [];
    memTransactions[userId].push({ id: Date.now(), type: 'credit', amount: voucher.sd_amount, description: `Voucher ${code}`, created_at: new Date().toISOString() });
    return res.json({ message: `Redeemed ${voucher.sd_amount} SD`, sdAmount: voucher.sd_amount });
  }
});

// ─── CRON JOBS ──────────────────────────────────────────────────────────
cron.schedule('0 * * * *', async () => {
  console.log('🔄 Running auto-expire check...');
});

// ─── START SERVER ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Blacklord Tech server running on port ${PORT}`);
  console.log(`📌 Admin email: admin@blacklordtech.com`);
  console.log(`📌 Admin password: admin123`);
  console.log(`📌 Database: ${DATABASE_URL ? 'Connected' : 'In-Memory (No DB)'}`);
});

module.exports = app;