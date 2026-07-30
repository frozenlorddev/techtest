const express = require('express');
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'blacklord-secret-2024';
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

// Paystack
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

// M‑Pesa (for real integration – set these in Vercel env)
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '174379';
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_CALLBACK_URL = `${BASE_URL}/api/mpesa-callback`;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL missing');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

// ─── DATABASE INITIALIZATION ──────────────────────────────────────────────
async function initDatabase() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        firstname TEXT,
        lastname TEXT,
        email TEXT UNIQUE,
        password TEXT,
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
      CREATE TABLE IF NOT EXISTS vouchers (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE,
        sd_amount INTEGER,
        used_by INTEGER REFERENCES users(id),
        used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS voucher_redemptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        voucher_id INTEGER REFERENCES vouchers(id),
        sd_amount INTEGER,
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
    console.log('✅ Database initialized');
  } catch (e) {
    console.error('❌ DB init error:', e.message);
  }
}
initDatabase();

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
  const [user] = await sql`SELECT * FROM users WHERE id = ${userId}`;
  if (!user) return null;
  const [wallet] = await sql`SELECT sd_balance FROM wallet WHERE user_id = ${userId}`;
  return { ...user, sdBalance: wallet ? wallet.sd_balance : 0 };
}

function generateRandomCode(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── MPESA STK PUSH (simulated + real) ──────────────────────────────────
async function initiateMpesaStkPush(phone, amount, reference, userId) {
  // Normalise phone number: remove leading 0 or +254
  let phoneNumber = phone.replace(/^\+/, '').replace(/^0/, '');
  if (phoneNumber.startsWith('254')) phoneNumber = phoneNumber.slice(3);
  const fullPhone = '254' + phoneNumber;

  // SD amount = KSH / 1.6 (same as Paystack)
  const sdAmount = Math.floor(amount / 1.6);

  // ── REAL MPESA INTEGRATION ──
  if (MPESA_CONSUMER_KEY && MPESA_CONSUMER_SECRET && MPESA_PASSKEY) {
    try {
      // Get OAuth token
      const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
      const tokenRes = await axios.get(
        'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
        { headers: { Authorization: `Basic ${auth}` } }
      );
      const accessToken = tokenRes.data.access_token;

      // STK Push payload
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
        // Save pending M-Pesa transaction
        await sql`
          INSERT INTO mpesa_transactions (reference, user_id, phone, amount, sd_amount, status, checkout_request_id)
          VALUES (${reference}, ${userId}, ${phone}, ${Math.round(amount)}, ${sdAmount}, 'pending', ${stkRes.data.CheckoutRequestID})
        `;
        await sql`
          INSERT INTO pending_topups (reference, user_id, sd_amount, payment_method, mpesa_phone)
          VALUES (${reference}, ${userId}, ${sdAmount}, 'mpesa', ${phone})
        `;
        return {
          success: true,
          checkoutRequestId: stkRes.data.CheckoutRequestID,
          message: 'STK Push sent to your phone. Please enter your PIN to confirm.'
        };
      } else {
        return {
          success: false,
          message: stkRes.data.ResponseDescription || 'M-Pesa request failed'
        };
      }
    } catch (e) {
      console.error('M-Pesa STK error:', e.message);
      // Fall through to mock
    }
  }

  // ── MOCK MPESA (demo mode) ──
  const mockCheckoutId = 'ws_CO_' + Date.now() + '_' + generateRandomCode(6);
  await sql`
    INSERT INTO mpesa_transactions (reference, user_id, phone, amount, sd_amount, status, checkout_request_id)
    VALUES (${reference}, ${userId}, ${phone}, ${Math.round(amount)}, ${sdAmount}, 'pending', ${mockCheckoutId})
  `;
  await sql`
    INSERT INTO pending_topups (reference, user_id, sd_amount, payment_method, mpesa_phone)
    VALUES (${reference}, ${userId}, ${sdAmount}, 'mpesa', ${phone})
  `;

  // Simulate callback after 5 seconds (in real app, this comes from Safaricom)
  setTimeout(async () => {
    try {
      await sql`UPDATE wallet SET sd_balance = sd_balance + ${sdAmount} WHERE user_id = ${userId}`;
      await sql`
        INSERT INTO transactions (user_id, type, amount, description)
        VALUES (${userId}, 'credit', ${sdAmount}, 'M-Pesa top-up ${amount} KSH')
      `;
      await sql`UPDATE mpesa_transactions SET status = 'success' WHERE reference = ${reference}`;
      await sql`DELETE FROM pending_topups WHERE reference = ${reference}`;
      console.log(`✅ Mock M-Pesa: ${sdAmount} SD credited to user ${userId}`);
    } catch (e) {
      console.error('Mock M-Pesa callback error:', e);
    }
  }, 5000);

  return {
    success: true,
    checkoutRequestId: mockCheckoutId,
    message: 'STK Push sent (demo mode). You will be credited in 5 seconds.',
    mock: true
  };
}

// ─── MPESA CALLBACK ENDPOINT (for real Safaricom) ──────────────────────
app.post('/api/mpesa-callback', async (req, res) => {
  try {
    const body = req.body;
    const resultCode = body?.Body?.stkCallback?.ResultCode;
    const checkoutId = body?.Body?.stkCallback?.CheckoutRequestID;

    if (resultCode === '0') {
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
      await sql`UPDATE mpesa_transactions SET status = 'failed' WHERE checkout_request_id = ${checkoutId}`;
    }
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (e) {
    console.error('M-Pesa callback error:', e);
    res.json({ ResultCode: 1, ResultDesc: 'Error' });
  }
});

// ─── SERVE HTML ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  res.send(html);
});

// ─── PAYMENT SUCCESS (Paystack callback) ──────────────────────────────
app.get('/payment-success', async (req, res) => {
  const { reference, sd } = req.query;
  if (!reference) return res.redirect('/?error=missing_reference');
  try {
    const [topup] = await sql`SELECT * FROM pending_topups WHERE reference = ${reference}`;
    if (!topup) return res.redirect('/?error=invalid_reference');
    await sql`UPDATE wallet SET sd_balance = sd_balance + ${topup.sd_amount} WHERE user_id = ${topup.user_id}`;
    await sql`
      INSERT INTO transactions (user_id, type, amount, description)
      VALUES (${topup.user_id}, 'credit', ${topup.sd_amount}, 'Paystack top-up')
    `;
    await sql`DELETE FROM pending_topups WHERE reference = ${reference}`;
    res.redirect(`/?topup_success=1&sd=${topup.sd_amount}`);
  } catch (e) {
    console.error(e);
    res.redirect('/?error=payment_failed');
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
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    const hashed = await bcrypt.hash(password, 10);
    const [user] = await sql`
      INSERT INTO users (firstname, lastname, email, password)
      VALUES (${firstName}, ${lastName}, ${email}, ${hashed})
      RETURNING id, firstname, lastname, email
    `;
    await sql`INSERT INTO wallet (user_id, sd_balance) VALUES (${user.id}, 50) ON CONFLICT (user_id) DO NOTHING`;
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({
      token,
      user: { id: user.id, firstName: user.firstname, lastName: user.lastname, email: user.email, sdBalance: 50 }
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
    const [user] = await sql`SELECT * FROM users WHERE email = ${email}`;
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    const [wallet] = await sql`SELECT sd_balance FROM wallet WHERE user_id = ${user.id}`;
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

// ─── API: GET /api/me ──────────────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const user = await getUserWithBalance(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const panels = await sql`SELECT * FROM panels WHERE user_id = ${userId}`;
    const bots = await sql`SELECT * FROM bots WHERE user_id = ${userId}`;
    const redemptions = await sql`SELECT * FROM voucher_redemptions WHERE user_id = ${userId}`;
    res.json({
      user: {
        id: user.id,
        firstName: user.firstname,
        lastName: user.lastname,
        email: user.email,
        sdBalance: user.sdBalance,
        totalServers: panels.length + bots.length,
        activeServers: panels.filter(p => p.status === 'active').length + bots.filter(b => b.status === 'active').length,
        panels: panels.map(p => ({ username: p.username, plan: p.plan, domain: p.domain, status: p.status, createdAt: p.created_at, sdPrice: p.sd_price })),
        bots: bots.map(b => ({ name: b.name, token: b.token, type: b.type, status: b.status, createdAt: b.created_at })),
        voucherRedemptions: redemptions.map(r => ({ amount: r.sd_amount, redeemedAt: r.created_at }))
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── API: BUY PANEL / ADMIN ────────────────────────────────────────────
app.post('/api/buy', async (req, res) => {
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

  const [wallet] = await sql`SELECT sd_balance FROM wallet WHERE user_id = ${userId}`;
  const balance = wallet ? wallet.sd_balance : 0;
  if (balance < sdPrice) {
    return res.status(402).json({ error: 'Insufficient SD', sdBalance: balance, sdRequired: sdPrice });
  }

  await sql`UPDATE wallet SET sd_balance = sd_balance - ${sdPrice} WHERE user_id = ${userId}`;
  await sql`INSERT INTO transactions (user_id, type, amount, description) VALUES (${userId}, 'debit', ${sdPrice}, 'Bought ' + planName)`;

  const domain = `https://panel-${username}.blacklord.tech`;
  const [panel] = await sql`
    INSERT INTO panels (user_id, username, password, plan, domain, status, sd_price)
    VALUES (${userId}, ${username}, ${password}, ${planName}, ${domain}, 'active', ${sdPrice})
    RETURNING id, username, password, plan, domain, status
  `;
  res.json({ panel });
});

// ─── API: TOP-UP (Paystack + M-Pesa) ──────────────────────────────────
app.post('/api/topup', async (req, res) => {
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
    const result = await initiateMpesaStkPush(phone, amountKsh, 'MP-' + Date.now() + '-' + generateRandomCode(4), userId);
    if (result.success) {
      return res.json({
        method: 'mpesa',
        message: result.message,
        checkoutRequestId: result.checkoutRequestId,
        mock: result.mock || false
      });
    } else {
      return res.status(500).json({ error: result.message });
    }
  } else {
    if (!PAYSTACK_SECRET) {
      await sql`UPDATE wallet SET sd_balance = sd_balance + ${sdAmount} WHERE user_id = ${userId}`;
      await sql`INSERT INTO transactions (user_id, type, amount, description) VALUES (${userId}, 'credit', ${sdAmount}, 'Top-up ${amountKsh} KSH (mock)')`;
      return res.json({
        authorization_url: `${BASE_URL}/payment-success?reference=mock-${Date.now()}&sd=${sdAmount}`,
        mock: true
      });
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
        await sql`INSERT INTO pending_topups (reference, user_id, sd_amount, payment_method) VALUES (${reference}, ${userId}, ${sdAmount}, 'paystack')`;
        return res.json({ authorization_url: response.data.data.authorization_url });
      } else {
        throw new Error('Paystack initialization failed');
      }
    } catch (e) {
      console.error('Paystack error:', e.message);
      return res.status(500).json({ error: 'Payment initialization failed. Please try again.' });
    }
  }
});

// ─── API: CHECK MPESA STATUS ──────────────────────────────────────────
app.get('/api/mpesa-status', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { reference } = req.query;
  if (!reference) return res.status(400).json({ error: 'Reference required' });

  const [txn] = await sql`SELECT * FROM mpesa_transactions WHERE reference = ${reference} AND user_id = ${userId}`;
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });

  res.json({ status: txn.status, sdAmount: txn.sd_amount });
});

// ─── API: REDEEM VOUCHER ──────────────────────────────────────────────
app.post('/api/redeem-voucher', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Voucher code required' });

  const [voucher] = await sql`
    SELECT * FROM vouchers WHERE code = ${code.toUpperCase()} AND used_by IS NULL
  `;
  if (!voucher) return res.status(404).json({ error: 'Invalid or already used voucher' });

  await sql`UPDATE vouchers SET used_by = ${userId}, used_at = NOW() WHERE id = ${voucher.id}`;
  await sql`UPDATE wallet SET sd_balance = sd_balance + ${voucher.sd_amount} WHERE user_id = ${userId}`;
  await sql`
    INSERT INTO transactions (user_id, type, amount, description)
    VALUES (${userId}, 'credit', ${voucher.sd_amount}, 'Voucher ' + code)
  `;
  await sql`
    INSERT INTO voucher_redemptions (user_id, voucher_id, sd_amount)
    VALUES (${userId}, ${voucher.id}, ${voucher.sd_amount})
  `;
  res.json({ message: `Redeemed ${voucher.sd_amount} SD`, sdAmount: voucher.sd_amount });
});

// ─── API: ADMIN VOUCHERS ──────────────────────────────────────────────
app.get('/api/admin/vouchers', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const [user] = await sql`SELECT email FROM users WHERE id = ${userId}`;
  if (user.email !== 'admin@blacklordtech.com') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const vouchers = await sql`SELECT * FROM vouchers ORDER BY created_at DESC`;
  res.json({
    vouchers: vouchers.map(v => ({
      code: v.code,
      sdAmount: v.sd_amount,
      usedBy: v.used_by,
      usedAt: v.used_at
    }))
  });
});

app.post('/api/admin/generate-voucher', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const [user] = await sql`SELECT email FROM users WHERE id = ${userId}`;
  if (user.email !== 'admin@blacklordtech.com') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { sdAmount } = req.body;
  if (!sdAmount || sdAmount < 1) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  const code = generateRandomCode(8);
  await sql`INSERT INTO vouchers (code, sd_amount) VALUES (${code}, ${sdAmount})`;
  res.json({ code, sdAmount });
});

// ─── API: PANEL ACTIONS ────────────────────────────────────────────────
app.post('/api/toggle-panel', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });

  const [panel] = await sql`SELECT * FROM panels WHERE user_id = ${userId} AND username = ${username}`;
  if (!panel) return res.status(404).json({ error: 'Panel not found' });
  const newStatus = panel.status === 'active' ? 'paused' : 'active';
  await sql`UPDATE panels SET status = ${newStatus} WHERE id = ${panel.id}`;
  res.json({ status: newStatus });
});

app.post('/api/delete-panel', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  await sql`DELETE FROM panels WHERE user_id = ${userId} AND username = ${username}`;
  res.json({ success: true });
});

// ─── API: BOT ACTIONS ──────────────────────────────────────────────────
app.post('/api/deploy-bot', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Bot name required' });

  const botToken = 'bot' + generateRandomCode(8) + ':' + generateRandomCode(8);
  const [bot] = await sql`
    INSERT INTO bots (user_id, name, token, type, status)
    VALUES (${userId}, ${name}, ${botToken}, 'Telegram', 'active')
    RETURNING id, name, token, type, status
  `;
  res.json({ bot });
});

app.post('/api/toggle-bot', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const [bot] = await sql`SELECT * FROM bots WHERE user_id = ${userId} AND token = ${token}`;
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  const newStatus = bot.status === 'active' ? 'paused' : 'active';
  await sql`UPDATE bots SET status = ${newStatus} WHERE id = ${bot.id}`;
  res.json({ status: newStatus });
});

app.post('/api/delete-bot', async (req, res) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  await sql`DELETE FROM bots WHERE user_id = ${userId} AND token = ${token}`;
  res.json({ success: true });
});

// ─── START SERVER ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Blacklord Tech server running on port ${PORT}`);
});

module.exports = app;