const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_I08bQKJLwOkN@ep-billowing-darkness-aybn2tcg.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require',
});

// Helper to send JSON response
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Helper to parse JSON body
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  console.log(\`\${req.method} \${pathname}\`);

  try {
    // ─── AUTH ROUTES ──────────────────────────────────────────────────
    if (pathname === '/api/auth/signup' && req.method === 'POST') {
      const body = await parseBody(req);
      const { firstname, lastname, email, password } = body;
      if (!firstname || !lastname || !email || !password) {
        return sendJSON(res, 400, { error: 'All fields are required' });
      }
      
      const checkUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      if (checkUser.rows.length > 0) {
        return sendJSON(res, 400, { error: 'Email already registered' });
      }
      
      const result = await pool.query(
        'INSERT INTO users (firstname, lastname, email, password) VALUES ($1, $2, $3, $4) RETURNING id',
        [firstname, lastname, email, password]
      );
      
      // Initialize wallet
      await pool.query('INSERT INTO wallet (user_id, balance) VALUES ($1, 0)', [result.rows[0].id]);
      
      sendJSON(res, 201, { message: 'Account created', userId: result.rows[0].id });
      return;
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await parseBody(req);
      const { email, password } = body;
      const result = await pool.query('SELECT * FROM users WHERE email = $1 AND password = $2', [email, password]);
      
      if (result.rows.length === 0) {
        return sendJSON(res, 401, { error: 'Invalid credentials' });
      }
      
      const user = result.rows[0];
      sendJSON(res, 200, { message: 'Login successful', user: { id: user.id, email: user.email, firstname: user.firstname } });
      return;
    }

    // ─── PACKAGE ROUTES ──────────────────────────────────────────────
    if (pathname === '/api/packages' && req.method === 'GET') {
      const result = await pool.query('SELECT * FROM packages WHERE active = true ORDER BY sort_order ASC');
      sendJSON(res, 200, { packages: result.rows });
      return;
    }

    // ─── VOUCHER ROUTES ──────────────────────────────────────────────
    if (pathname === '/api/vouchers/redeem' && req.method === 'POST') {
      const body = await parseBody(req);
      const { code, user_id } = body;
      const result = await pool.query('SELECT * FROM voucher_codes WHERE code = $1 AND status = \'active\'', [code]);
      
      if (result.rows.length === 0) {
        return sendJSON(res, 404, { error: 'Invalid or used voucher code' });
      }
      
      const voucher = result.rows[0];
      await pool.query('BEGIN');
      await pool.query('UPDATE voucher_codes SET status = \'used\', used_by = $1, used_at = NOW() WHERE id = $2', [user_id, voucher.id]);
      await pool.query('UPDATE wallet SET balance = balance + $1 WHERE user_id = $2', [voucher.amount, user_id]);
      await pool.query('COMMIT');
      
      sendJSON(res, 200, { message: 'Voucher redeemed', amount: voucher.amount });
      return;
    }

    // ─── INQUIRY ROUTES ──────────────────────────────────────────────
    if (pathname === '/api/inquiries' && req.method === 'POST') {
      const body = await parseBody(req);
      const { subject, message, user_email, user_name, user_id } = body;
      if (!subject || !message) {
        return sendJSON(res, 400, { error: 'Subject and message required' });
      }
      
      const result = await pool.query(
        'INSERT INTO inquiries (user_id, user_email, user_name, subject, message) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [user_id || null, user_email, user_name, subject, message]
      );
      
      sendJSON(res, 201, { message: 'Inquiry sent', id: result.rows[0].id });
      return;
    }

    // ─── WALLET ROUTES ───────────────────────────────────────────────
    if (pathname === '/api/wallet/balance' && req.method === 'GET') {
      const user_id = parsedUrl.query.user_id;
      const balanceRes = await pool.query('SELECT balance FROM wallet WHERE user_id = $1', [user_id]);
      const transRes = await pool.query('SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [user_id]);
      
      sendJSON(res, 200, { 
        balance: balanceRes.rows[0] ? balanceRes.rows[0].balance : 0, 
        transactions: transRes.rows 
      });
      return;
    }

    // ─── ADMIN ROUTES ────────────────────────────────────────────────
    if (pathname === '/api/admin/users' && req.method === 'GET') {
      const result = await pool.query('SELECT id, firstname, lastname, email, created_at FROM users');
      sendJSON(res, 200, { users: result.rows });
      return;
    }

    // Serve Static Files for Vercel (Optional if handled by vercel.json)
    if (pathname === '/' || pathname === '/index.html') {
      const content = fs.readFileSync(path.join(__dirname, '1_index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
      return;
    }

    // Default 404
    sendJSON(res, 404, { error: 'Endpoint not found' });

  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(\`🚀 BLACKLORD API Server running on port \${PORT}\`);
});
