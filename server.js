const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { neon } = require('@neondatabase/serverless');
require('dotenv').config();

const app = express();
const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'blacklord-secret-2024';

app.use(cors());
app.use(express.json());

// ─── Health Check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running!' });
});

// ─── Signup ──────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { firstname, lastname, email, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const result = await sql`
      INSERT INTO users (firstname, lastname, email, password)
      VALUES (${firstname}, ${lastname}, ${email}, ${hashed})
      RETURNING id, firstname, lastname, email
    `;
    const user = result[0];
    await sql`INSERT INTO wallet (user_id, balance) VALUES (${user.id}, 0)`;
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Login ──────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await sql`SELECT * FROM users WHERE email = ${email}`;
    const user = result[0];
    if (!user) throw new Error('Invalid credentials');
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) throw new Error('Invalid credentials');
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ─── Get User ────────────────────────────────────────────
app.get('/api/auth/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) throw new Error('No token');
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await sql`SELECT id, firstname, lastname, email FROM users WHERE id = ${decoded.userId}`;
    const user = result[0];
    const wallet = await sql`SELECT balance FROM wallet WHERE user_id = ${user.id}`;
    user.sdBalance = Math.round((wallet[0]?.balance || 0) / 1.6);
    res.json({ user });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ─── Wallet Balance ──────────────────────────────────────
app.get('/api/wallet/balance', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const wallet = await sql`SELECT balance FROM wallet WHERE user_id = ${decoded.userId}`;
    const transactions = await sql`
      SELECT * FROM wallet_transactions 
      WHERE user_id = ${decoded.userId} 
      ORDER BY created_at DESC LIMIT 10
    `;
    res.json({ balance: wallet[0]?.balance || 0, transactions });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ─── Deposit ─────────────────────────────────────────────
app.post('/api/wallet/deposit', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const { amount } = req.body;
    if (!amount || amount < 1) throw new Error('Invalid amount');
    await sql`
      UPDATE wallet SET balance = balance + ${amount}, updated_at = NOW()
      WHERE user_id = ${decoded.userId}
    `;
    await sql`
      INSERT INTO wallet_transactions (user_id, type, amount, description, status)
      VALUES (${decoded.userId}, 'deposit', ${amount}, 'Payment via Blacklord', 'success')
    `;
    const wallet = await sql`SELECT balance FROM wallet WHERE user_id = ${decoded.userId}`;
    res.json({ balance: wallet[0].balance, message: 'Deposit successful' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Redeem Voucher ──────────────────────────────────────
app.post('/api/vouchers/redeem', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const { code } = req.body;
    const voucher = await sql`SELECT * FROM voucher_codes WHERE code = ${code.toUpperCase()}`;
    if (!voucher[0]) throw new Error('Invalid voucher');
    if (voucher[0].status === 'used') throw new Error('Already used');
    const amount = parseFloat(voucher[0].amount);
    await sql`
      UPDATE voucher_codes SET status = 'used', used_by = ${decoded.userId}, used_at = NOW()
      WHERE id = ${voucher[0].id}
    `;
    await sql`
      UPDATE wallet SET balance = balance + ${amount}, updated_at = NOW()
      WHERE user_id = ${decoded.userId}
    `;
    await sql`
      INSERT INTO wallet_transactions (user_id, type, amount, description, status)
      VALUES (${decoded.userId}, 'deposit', ${amount}, 'Voucher: ' + ${code}, 'success')
    `;
    const wallet = await sql`SELECT balance FROM wallet WHERE user_id = ${decoded.userId}`;
    res.json({ message: 'Voucher redeemed', amount, newBalance: wallet[0].balance });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Panel List ────────────────────────────────────────────
app.get('/api/panel/list', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const panels = await sql`
      SELECT id, ptero_username, package_name, status, expires_at 
      FROM panels WHERE user_id = ${decoded.userId}
    `;
    res.json({ panels });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ─── Admin Users ──────────────────────────────────────────
app.get('/api/admin/users', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const adminCheck = await sql`SELECT email FROM users WHERE id = ${decoded.userId}`;
    if (!adminCheck[0]?.email?.includes('admin')) throw new Error('Admin only');
    const users = await sql`
      SELECT u.id, u.firstname, u.lastname, u.email, w.balance AS wallet_balance
      FROM users u LEFT JOIN wallet w ON u.id = w.user_id
      ORDER BY u.created_at DESC
    `;
    res.json({ users });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

// ─── Admin Vouchers ──────────────────────────────────────
app.get('/api/admin/vouchers', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const adminCheck = await sql`SELECT email FROM users WHERE id = ${decoded.userId}`;
    if (!adminCheck[0]?.email?.includes('admin')) throw new Error('Admin only');
    const vouchers = await sql`
      SELECT v.*, u.email AS used_by_email
      FROM voucher_codes v LEFT JOIN users u ON v.used_by = u.id
      ORDER BY v.created_at DESC
    `;
    res.json({ vouchers });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

// ─── Admin Vouchers Create ──────────────────────────────
app.post('/api/admin/vouchers', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const adminCheck = await sql`SELECT email FROM users WHERE id = ${decoded.userId}`;
    if (!adminCheck[0]?.email?.includes('admin')) throw new Error('Admin only');
    const { amount, count = 1 } = req.body;
    const codes = [];
    for (let i = 0; i < count; i++) {
      const code = 'BLK' + Math.random().toString(36).substring(2, 8).toUpperCase();
      await sql`
        INSERT INTO voucher_codes (code, amount, status, created_by)
        VALUES (${code}, ${amount}, 'active', ${adminCheck[0].email})
      `;
      codes.push(code);
    }
    res.json({ message: `${count} voucher(s) generated`, codes, count });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));