// ============================================
// NexusCPA Network - Backend Server v3.0
// Delaware, USA
// Features: MySQL DB + Email + Crypto Payouts
// ============================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const PORT = process.env.PORT || 3000;
const POSTBACK_SECRET = process.env.POSTBACK_SECRET || 'nexus_secret_2026';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const IPQS_KEY = process.env.IPQS_API_KEY || '';

// ============================================
// MYSQL DATABASE CONNECTION
// ============================================
let pool = null;

async function initDB() {
  try {
    pool = await mysql.createPool({
      host:     process.env.DB_HOST,
      user:     process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      port:     process.env.DB_PORT || 3306,
      ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      waitForConnections: true,
      connectionLimit: 10,
    });

    // Test connection
    await pool.query('SELECT 1');
    console.log('✅ MySQL connected');

    // Create tables
    await createTables();
    console.log('✅ Tables ready');

  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
    console.log('⚠️  Falling back to in-memory database');
    pool = null;
  }
}

async function createTables() {
  const queries = [
    `CREATE TABLE IF NOT EXISTS publishers (
      id VARCHAR(20) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      password_hash VARCHAR(64) NOT NULL,
      traffic_source VARCHAR(50),
      status ENUM('pending','active','suspended') DEFAULT 'pending',
      balance DECIMAL(10,2) DEFAULT 0.00,
      total_earned DECIMAL(10,2) DEFAULT 0.00,
      total_clicks INT DEFAULT 0,
      total_conversions INT DEFAULT 0,
      device_fp VARCHAR(64),
      ip VARCHAR(45),
      referral_code VARCHAR(20),
      referred_by VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS offers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      category VARCHAR(50),
      payout DECIMAL(8,2) NOT NULL,
      geo VARCHAR(200),
      access_type ENUM('open','locked') DEFAULT 'open',
      status ENUM('active','paused') DEFAULT 'active',
      tracking_url TEXT,
      daily_cap INT DEFAULT 500,
      total_conversions INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS clicks (
      id VARCHAR(40) PRIMARY KEY,
      offer_id INT,
      publisher_id VARCHAR(20),
      sub1 VARCHAR(100),
      sub2 VARCHAR(100),
      ip VARCHAR(45),
      user_agent TEXT,
      fraud_score INT DEFAULT 0,
      fraud_reason TEXT,
      is_blocked TINYINT DEFAULT 0,
      converted TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS conversions (
      id VARCHAR(40) PRIMARY KEY,
      click_id VARCHAR(40),
      offer_id INT,
      publisher_id VARCHAR(20),
      payout DECIMAL(8,2),
      status ENUM('pending','approved','rejected') DEFAULT 'approved',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS payout_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      publisher_id VARCHAR(20),
      amount DECIMAL(10,2),
      coin VARCHAR(10),
      wallet_address TEXT,
      status ENUM('pending','approved','rejected') DEFAULT 'pending',
      tx_hash VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS offer_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      publisher_id VARCHAR(20),
      offer_id INT,
      status ENUM('pending','approved','rejected') DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS announcements (
      id INT AUTO_INCREMENT PRIMARY KEY,
      message TEXT,
      type VARCHAR(20),
      target_audience VARCHAR(20) DEFAULT 'all',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS blocked_ips (
      ip VARCHAR(45) PRIMARY KEY,
      reason VARCHAR(200),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
  ];

  for (const q of queries) {
    await pool.query(q);
  }

  // Seed default offers if empty
  const [rows] = await pool.query('SELECT COUNT(*) as cnt FROM offers');
  if (rows[0].cnt === 0) {
    await pool.query(`INSERT INTO offers (name, category, payout, geo, access_type, status, tracking_url, daily_cap) VALUES
      ('$50 Amazon Gift Card', 'Gift Cards', 2.80, 'US, CA, UK', 'open', 'active', 'https://advertiser.com/lp?clickid={clickid}', 500),
      ('$100 Visa Gift Card', 'Gift Cards', 4.00, 'US Only', 'open', 'active', 'https://advertiser.com/visa?clickid={clickid}', 200),
      ('Email Submit CPL', 'Survey/CPL', 1.20, 'US, CA, AU', 'open', 'active', 'https://advertiser.com/cpl?clickid={clickid}', 1000),
      ('Free Credit Score', 'Finance', 3.50, 'US Only', 'locked', 'active', 'https://advertiser.com/finance?clickid={clickid}', 100),
      ('Consumer Survey', 'Survey/CPL', 1.80, 'US, CA', 'locked', 'paused', 'https://advertiser.com/survey?clickid={clickid}', 300)
    `);
    // Default announcement
    await pool.query(`INSERT INTO announcements (message, type) VALUES ('🎁 Welcome to NexusCPA! New high-paying offers available.', 'info')`);
    console.log('✅ Default data seeded');
  }
}

// ============================================
// IN-MEMORY FALLBACK (when no DB)
// ============================================
const memDB = {
  publishers: [],
  pendingPublishers: [],
  offers: [
    { id: 1, name: '$50 Amazon Gift Card', category: 'Gift Cards', payout: 2.80, geo: 'US, CA, UK', access_type: 'open', status: 'active', tracking_url: 'https://advertiser.com/lp?clickid={clickid}', daily_cap: 500, total_conversions: 18420 },
    { id: 2, name: '$100 Visa Gift Card', category: 'Gift Cards', payout: 4.00, geo: 'US Only', access_type: 'open', status: 'active', tracking_url: 'https://advertiser.com/visa?clickid={clickid}', daily_cap: 200, total_conversions: 5824 },
    { id: 3, name: 'Email Submit CPL', category: 'Survey/CPL', payout: 1.20, geo: 'US, CA, AU', access_type: 'open', status: 'active', tracking_url: 'https://advertiser.com/cpl?clickid={clickid}', daily_cap: 1000, total_conversions: 8240 },
    { id: 4, name: 'Free Credit Score', category: 'Finance', payout: 3.50, geo: 'US Only', access_type: 'locked', status: 'active', tracking_url: 'https://advertiser.com/finance?clickid={clickid}', daily_cap: 100, total_conversions: 2140 },
    { id: 5, name: 'Consumer Survey', category: 'Survey/CPL', payout: 1.80, geo: 'US, CA', access_type: 'locked', status: 'paused', tracking_url: 'https://advertiser.com/survey?clickid={clickid}', daily_cap: 300, total_conversions: 0 },
  ],
  clicks: [],
  conversions: [],
  payoutRequests: [],
  offerRequests: [],
  announcements: [{ id: 1, message: '🎁 Welcome to NexusCPA!', type: 'info', created_at: new Date() }],
  blockedIPs: new Set(['185.220.101.45', '198.54.117.200']),
  clickCounts: new Map(),
  recentClicks: new Map(),
};

// DB helper — works with MySQL or memory
const db = {
  async query(sql, params = []) {
    if (pool) {
      const [rows] = await pool.query(sql, params);
      return rows;
    }
    return null; // handled per-endpoint
  }
};

// ============================================
// EMAIL SERVICE (Gmail SMTP)
// ============================================
let mailer = null;

function initEmail() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('⚠️  Email not configured (set EMAIL_USER and EMAIL_PASS)');
    return;
  }
  mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS, // Gmail App Password
    },
  });
  console.log('✅ Email service ready');
}

async function sendEmail(to, subject, html) {
  if (!mailer) return false;
  try {
    await mailer.sendMail({
      from: `"NexusCPA Network" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log(`📧 Email sent to ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error('Email error:', err.message);
    return false;
  }
}

// Email templates
const emails = {
  welcomePending: (name) => ({
    subject: 'Your NexusCPA Application is Under Review',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#07090f;color:#dde2f2;padding:32px;border-radius:12px">
        <h2 style="color:#3b82f6;margin-bottom:8px">NexusCPA Network 🇺🇸</h2>
        <p style="color:#4e5878;font-size:12px;margin-bottom:24px">1234 Market St, Wilmington, Delaware 19801, USA</p>
        <h3>Hi ${name},</h3>
        <p>Your publisher application has been received and is currently under review.</p>
        <div style="background:#111520;border:1px solid #192036;border-radius:8px;padding:16px;margin:20px 0">
          <p style="margin:0;color:#3b82f6;font-weight:bold">⏳ Status: Under Review</p>
          <p style="margin:8px 0 0;font-size:13px;color:#4e5878">Our team will review your application within 24 hours.</p>
        </div>
        <p>Once approved, you can log in and start promoting offers right away.</p>
        <p style="color:#4e5878;font-size:12px;margin-top:32px">NexusCPA Network · support@nexuscpa.com</p>
      </div>`
  }),
  approved: (name) => ({
    subject: '✅ Your NexusCPA Account is Approved!',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#07090f;color:#dde2f2;padding:32px;border-radius:12px">
        <h2 style="color:#3b82f6">NexusCPA Network 🇺🇸</h2>
        <h3>Hi ${name}, you're approved! 🎉</h3>
        <p>Your publisher account has been approved. You can now log in and start earning.</p>
        <div style="background:#111520;border:1px solid rgba(34,197,94,.3);border-radius:8px;padding:16px;margin:20px 0">
          <p style="margin:0;color:#22c55e;font-weight:bold">✅ Account Status: Active</p>
        </div>
        <a href="${BASE_URL}/affiliate-portal.html" style="display:inline-block;background:#3b82f6;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin-top:8px">Login to Dashboard →</a>
        <p style="color:#4e5878;font-size:12px;margin-top:32px">NexusCPA Network · support@nexuscpa.com</p>
      </div>`
  }),
  rejected: (name) => ({
    subject: 'NexusCPA Application Update',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#07090f;color:#dde2f2;padding:32px;border-radius:12px">
        <h2 style="color:#3b82f6">NexusCPA Network 🇺🇸</h2>
        <h3>Hi ${name},</h3>
        <p>Thank you for your application. Unfortunately, we are unable to approve your account at this time.</p>
        <p>If you believe this is a mistake, please contact us at <a href="mailto:support@nexuscpa.com" style="color:#3b82f6">support@nexuscpa.com</a>.</p>
        <p style="color:#4e5878;font-size:12px;margin-top:32px">NexusCPA Network · support@nexuscpa.com</p>
      </div>`
  }),
  payoutReceived: (name, amount, coin) => ({
    subject: `Payout Request Received — $${amount} in ${coin}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#07090f;color:#dde2f2;padding:32px;border-radius:12px">
        <h2 style="color:#3b82f6">NexusCPA Network 🇺🇸</h2>
        <h3>Hi ${name},</h3>
        <p>We received your payout request:</p>
        <div style="background:#111520;border:1px solid #192036;border-radius:8px;padding:16px;margin:20px 0">
          <p style="margin:0">Amount: <strong style="color:#22c55e">$${amount} USD</strong></p>
          <p style="margin:8px 0 0">Coin: <strong>${coin}</strong></p>
          <p style="margin:8px 0 0;color:#4e5878;font-size:12px">Processing time: 24–48 hours</p>
        </div>
        <p style="color:#4e5878;font-size:12px;margin-top:32px">NexusCPA Network · support@nexuscpa.com</p>
      </div>`
  }),
  payoutSent: (name, amount, coin, txHash) => ({
    subject: `💸 Payout Sent — $${amount} in ${coin}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#07090f;color:#dde2f2;padding:32px;border-radius:12px">
        <h2 style="color:#3b82f6">NexusCPA Network 🇺🇸</h2>
        <h3>Hi ${name}, your payment is on the way! 💸</h3>
        <div style="background:#111520;border:1px solid rgba(34,197,94,.3);border-radius:8px;padding:16px;margin:20px 0">
          <p style="margin:0">Amount: <strong style="color:#22c55e">$${amount} USD</strong></p>
          <p style="margin:8px 0 0">Coin: <strong>${coin}</strong></p>
          ${txHash ? `<p style="margin:8px 0 0;font-size:12px;color:#4e5878">TX Hash: <code style="color:#3b82f6">${txHash}</code></p>` : ''}
        </div>
        <p style="color:#4e5878;font-size:12px;margin-top:32px">NexusCPA Network · support@nexuscpa.com</p>
      </div>`
  }),
};

// ============================================
// COINPAYMENTS CRYPTO PAYOUT
// ============================================
async function createCryptoPayment(amount, currency, address, note) {
  const CP_KEY = process.env.COINPAYMENTS_PUBLIC_KEY;
  const CP_SECRET = process.env.COINPAYMENTS_PRIVATE_KEY;

  if (!CP_KEY || !CP_SECRET) {
    console.log('⚠️  CoinPayments not configured');
    return { success: false, error: 'CoinPayments not configured', manual: true };
  }

  try {
    const params = new URLSearchParams({
      version: '1',
      cmd: 'create_withdrawal',
      key: CP_KEY,
      format: 'json',
      amount: amount.toFixed(2),
      currency: currency.toUpperCase(),
      currency2: 'USD',
      address: address,
      note: note,
    });

    const hmac = crypto.createHmac('sha512', CP_SECRET);
    hmac.update(params.toString());
    const sig = hmac.digest('hex');

    const resp = await fetch('https://www.coinpayments.net/api.php', {
      method: 'POST',
      headers: { 'HMAC': sig, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const data = await resp.json();
    if (data.error === 'ok') {
      return { success: true, txn_id: data.result.id, status: 'processing' };
    } else {
      return { success: false, error: data.error };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================
// FRAUD DETECTION ENGINE
// ============================================
class FraudEngine {
  static async check(ip, userAgent, offerId) {
    let score = 0;
    const reasons = [];

    // 1. IP Blocklist (DB)
    if (pool) {
      const rows = await db.query('SELECT ip FROM blocked_ips WHERE ip = ?', [ip]);
      if (rows.length > 0) return { blocked: true, score: 100, reason: 'Blacklisted IP' };
    } else {
      if (memDB.blockedIPs.has(ip)) return { blocked: true, score: 100, reason: 'Blacklisted IP' };
    }

    // 2. Bot User-Agent
    const botPatterns = /bot|crawler|spider|scraper|wget|curl|python|java|go-http|axios|postman/i;
    if (botPatterns.test(userAgent)) { score += 80; reasons.push('Bot UA'); }

    // 3. Click rate (in-memory tracking)
    const now = Date.now();
    const hourAgo = now - 3600000;
    if (!memDB.clickCounts.has(ip)) memDB.clickCounts.set(ip, []);
    const ipClicks = memDB.clickCounts.get(ip).filter(t => t > hourAgo);
    ipClicks.push(now);
    memDB.clickCounts.set(ip, ipClicks);
    if (ipClicks.length > 50) { score += 60; reasons.push(`High rate: ${ipClicks.length}/hr`); }

    // 4. Duplicate click same IP+offer 30min
    const dupKey = `${ip}_${offerId}`;
    const lastClick = memDB.recentClicks.get(dupKey);
    if (lastClick && (now - lastClick) < 1800000) { score += 50; reasons.push('Duplicate click'); }
    memDB.recentClicks.set(dupKey, now);

    // 5. IPQS API
    if (IPQS_KEY && score < 75) {
      try {
        const resp = await fetch(`https://ipqualityscore.com/api/json/ip/${IPQS_KEY}/${ip}?strictness=1`);
        const data = await resp.json();
        if (data.vpn) { score += 40; reasons.push('VPN'); }
        if (data.proxy) { score += 35; reasons.push('Proxy'); }
        if (data.tor) { score += 50; reasons.push('Tor'); }
        if (data.is_crawler) { score += 80; reasons.push('Crawler'); }
        if (data.fraud_score) score = Math.max(score, data.fraud_score * 0.8);
      } catch (e) {}
    }

    // 6. Datacenter ranges
    const dcRanges = ['104.21.', '172.67.', '198.54.', '45.147.', '194.165.'];
    if (dcRanges.some(r => ip.startsWith(r))) { score += 30; reasons.push('Datacenter IP'); }

    if (score >= 75) {
      if (pool) await db.query('INSERT IGNORE INTO blocked_ips (ip, reason) VALUES (?, ?)', [ip, reasons.join(', ')]);
      else memDB.blockedIPs.add(ip);
      return { blocked: true, score, reason: reasons.join(', ') };
    }
    return { blocked: false, score, reason: reasons.join(', ') || 'Clean' };
  }
}

// ============================================
// HELPER
// ============================================
function genId(prefix) {
  return prefix + '-' + Math.floor(10000 + Math.random() * 90000);
}
function hashPass(pw) {
  return crypto.createHash('sha256').update(pw + 'nexuscpa_salt_2026').digest('hex');
}

// ============================================
// PUBLISHER ROUTES
// ============================================

// REGISTER
app.post('/api/publisher/register', async (req, res) => {
  const { name, email, password, traffic_source, referral_code, device_fp } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '0.0.0.0';
  if (!name || !email || !password || !traffic_source) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  const newId = genId('AFF');
  const passHash = hashPass(password);

  if (pool) {
    // Check email
    const existing = await db.query('SELECT id FROM publishers WHERE email = ?', [email]);
    if (existing.length > 0) return res.status(400).json({ success: false, error: 'Email already registered' });

    // Check device fingerprint
    if (device_fp) {
      const fpMatch = await db.query('SELECT id FROM publishers WHERE device_fp = ?', [device_fp]);
      if (fpMatch.length > 0) return res.status(400).json({ success: false, error: 'DUPLICATE_DEVICE', code: 'DUPLICATE_DEVICE' });
    }

    await db.query(
      'INSERT INTO publishers (id, name, email, password_hash, traffic_source, status, device_fp, ip, referral_code) VALUES (?, ?, ?, ?, ?, "pending", ?, ?, ?)',
      [newId, name, email, passHash, traffic_source, device_fp || null, ip, referral_code || null]
    );
  } else {
    const exists = [...memDB.publishers, ...memDB.pendingPublishers].find(p => p.email === email);
    if (exists) return res.status(400).json({ success: false, error: 'Email already registered' });
    memDB.pendingPublishers.push({ id: newId, name, email, password_hash: passHash, traffic_source, status: 'pending', device_fp, ip, created_at: new Date() });
  }

  // Send welcome email
  const tmpl = emails.welcomePending(name);
  await sendEmail(email, tmpl.subject, tmpl.html);

  res.json({ success: true, status: 'pending', message: 'Application submitted! Under review.' });
});

// LOGIN
app.post('/api/publisher/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: 'Missing fields' });

  const passHash = hashPass(password);

  if (pool) {
    const rows = await db.query('SELECT * FROM publishers WHERE email = ? AND password_hash = ?', [email, passHash]);
    if (rows.length === 0) return res.status(401).json({ success: false, error: 'Wrong email or password' });
    const pub = rows[0];
    if (pub.status === 'pending') return res.status(403).json({ success: false, error: 'pending', status: 'pending' });
    if (pub.status === 'suspended') return res.status(403).json({ success: false, error: 'Account suspended' });
    const { password_hash, ...safe } = pub;
    return res.json({ success: true, publisher: safe });
  } else {
    const pending = memDB.pendingPublishers.find(p => p.email === email && p.password_hash === passHash);
    if (pending) return res.status(403).json({ success: false, error: 'pending', status: 'pending' });
    const pub = memDB.publishers.find(p => p.email === email && p.password_hash === passHash);
    if (!pub) return res.status(401).json({ success: false, error: 'Wrong email or password' });
    const { password_hash, ...safe } = pub;
    return res.json({ success: true, publisher: safe });
  }
});

// GET OFFERS (for publishers)
app.get('/api/publisher/offers', async (req, res) => {
  const { pub_id } = req.query;
  if (pool) {
    const offers = await db.query('SELECT * FROM offers WHERE status = "active"');
    // Mark which ones publisher has access to
    if (pub_id) {
      const approved = await db.query('SELECT offer_id FROM offer_requests WHERE publisher_id = ? AND status = "approved"', [pub_id]);
      const approvedIds = approved.map(r => r.offer_id);
      offers.forEach(o => { o.has_access = o.access_type === 'open' || approvedIds.includes(o.id); });
    }
    return res.json({ success: true, offers });
  }
  res.json({ success: true, offers: memDB.offers.filter(o => o.status === 'active') });
});

// PAYOUT REQUEST
app.post('/api/publisher/payout-request', async (req, res) => {
  const { publisher_id, amount, coin, wallet_address } = req.body;
  if (!publisher_id || !amount || !coin || !wallet_address) {
    return res.status(400).json({ success: false, error: 'Missing fields' });
  }
  if (parseFloat(amount) < 50) {
    return res.status(400).json({ success: false, error: 'Minimum payout is $50' });
  }

  if (pool) {
    // Check balance
    const pub = await db.query('SELECT name, email, balance FROM publishers WHERE id = ?', [publisher_id]);
    if (!pub.length) return res.status(404).json({ success: false, error: 'Publisher not found' });
    if (parseFloat(pub[0].balance) < parseFloat(amount)) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' });
    }
    await db.query(
      'INSERT INTO payout_requests (publisher_id, amount, coin, wallet_address) VALUES (?, ?, ?, ?)',
      [publisher_id, amount, coin, wallet_address]
    );
    // Send email
    const tmpl = emails.payoutReceived(pub[0].name, amount, coin);
    await sendEmail(pub[0].email, tmpl.subject, tmpl.html);
  } else {
    memDB.payoutRequests.push({ id: Date.now(), publisher_id, amount, coin, wallet_address, status: 'pending', created_at: new Date() });
  }

  res.json({ success: true, message: 'Payout request submitted! Processing in 24–48 hours.' });
});

// OFFER ACCESS REQUEST
app.post('/api/publisher/offer-request', async (req, res) => {
  const { publisher_id, offer_id } = req.body;
  if (pool) {
    const exists = await db.query('SELECT id FROM offer_requests WHERE publisher_id = ? AND offer_id = ?', [publisher_id, offer_id]);
    if (exists.length > 0) return res.status(400).json({ success: false, error: 'Already requested' });
    await db.query('INSERT INTO offer_requests (publisher_id, offer_id) VALUES (?, ?)', [publisher_id, offer_id]);
  } else {
    memDB.offerRequests.push({ publisher_id, offer_id, status: 'pending', created_at: new Date() });
  }
  res.json({ success: true, message: 'Access requested! Admin will review within 24 hours.' });
});

// ============================================
// CLICK TRACKING
// ============================================
app.get('/click', async (req, res) => {
  const { offer_id, aff_id, sub1, sub2 } = req.query;
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '0.0.0.0';
  const ua = req.headers['user-agent'] || '';

  if (!offer_id || !aff_id) return res.status(400).send('Missing parameters');

  const fraud = await FraudEngine.check(ip, ua, offer_id);
  const clickId = crypto.randomUUID();

  // Get offer
  let offer = null;
  if (pool) {
    const rows = await db.query('SELECT * FROM offers WHERE id = ? AND status = "active"', [offer_id]);
    if (rows.length > 0) offer = rows[0];
  } else {
    offer = memDB.offers.find(o => o.id == offer_id && o.status === 'active');
  }

  if (!offer) return res.status(404).send('Offer not found');
  if (fraud.blocked) return res.status(403).send('Traffic blocked: ' + fraud.reason);

  // Save click
  if (pool) {
    await db.query(
      'INSERT INTO clicks (id, offer_id, publisher_id, sub1, sub2, ip, user_agent, fraud_score, fraud_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [clickId, offer_id, aff_id, sub1 || null, sub2 || null, ip, ua.substring(0, 255), fraud.score, fraud.reason]
    );
    await db.query('UPDATE publishers SET total_clicks = total_clicks + 1 WHERE id = ?', [aff_id]);
  } else {
    memDB.clicks.push({ id: clickId, offer_id, publisher_id: aff_id, sub1, ip, fraud_score: fraud.score, created_at: new Date() });
  }

  // Redirect to offer URL
  const url = offer.tracking_url.replace('{clickid}', clickId).replace('{sub1}', sub1 || '');
  res.redirect(url);
});

// ============================================
// CONVERSION POSTBACK
// ============================================
app.get('/postback', async (req, res) => {
  const { click_id, payout, token, status: convStatus } = req.query;
  if (token !== POSTBACK_SECRET) return res.status(403).send('Invalid token');
  if (!click_id) return res.status(400).send('Missing click_id');

  const convId = crypto.randomUUID();
  const payoutAmt = parseFloat(payout) || 0;

  if (pool) {
    const clicks = await db.query('SELECT * FROM clicks WHERE id = ?', [click_id]);
    if (!clicks.length) return res.status(404).send('Click not found');
    const click = clicks[0];

    await db.query(
      'INSERT INTO conversions (id, click_id, offer_id, publisher_id, payout, status) VALUES (?, ?, ?, ?, ?, ?)',
      [convId, click_id, click.offer_id, click.publisher_id, payoutAmt, convStatus === 'rejected' ? 'rejected' : 'approved']
    );

    if (convStatus !== 'rejected') {
      await db.query('UPDATE publishers SET balance = balance + ?, total_earned = total_earned + ?, total_conversions = total_conversions + 1 WHERE id = ?',
        [payoutAmt, payoutAmt, click.publisher_id]);
      await db.query('UPDATE offers SET total_conversions = total_conversions + 1 WHERE id = ?', [click.offer_id]);
      await db.query('UPDATE clicks SET converted = 1 WHERE id = ?', [click_id]);
    }
  } else {
    const click = memDB.clicks.find(c => c.id === click_id);
    if (click) {
      memDB.conversions.push({ id: convId, click_id, offer_id: click.offer_id, publisher_id: click.publisher_id, payout: payoutAmt, status: 'approved', created_at: new Date() });
      const pub = memDB.publishers.find(p => p.id === click.publisher_id);
      if (pub) { pub.balance = (pub.balance || 0) + payoutAmt; }
    }
  }

  res.send('OK');
});

// ============================================
// ADMIN ROUTES
// ============================================

// GET pending publishers
app.get('/api/admin/publishers/pending', async (req, res) => {
  if (pool) {
    const rows = await db.query('SELECT id, name, email, traffic_source, ip, device_fp, created_at FROM publishers WHERE status = "pending" ORDER BY created_at DESC');
    return res.json({ success: true, publishers: rows });
  }
  res.json({ success: true, publishers: memDB.pendingPublishers });
});

// GET all publishers
app.get('/api/admin/publishers', async (req, res) => {
  if (pool) {
    const rows = await db.query('SELECT id, name, email, traffic_source, status, balance, total_earned, total_clicks, total_conversions, created_at FROM publishers WHERE status != "pending" ORDER BY created_at DESC');
    return res.json({ success: true, publishers: rows });
  }
  res.json({ success: true, publishers: memDB.publishers });
});

// APPROVE publisher
app.post('/api/admin/publisher/approve/:id', async (req, res) => {
  const { id } = req.params;
  if (pool) {
    await db.query('UPDATE publishers SET status = "active" WHERE id = ?', [id]);
    const pub = await db.query('SELECT name, email FROM publishers WHERE id = ?', [id]);
    if (pub.length > 0) {
      const tmpl = emails.approved(pub[0].name);
      await sendEmail(pub[0].email, tmpl.subject, tmpl.html);
    }
  } else {
    const idx = memDB.pendingPublishers.findIndex(p => p.id === id);
    if (idx !== -1) {
      const pub = memDB.pendingPublishers.splice(idx, 1)[0];
      pub.status = 'active';
      memDB.publishers.push(pub);
      const tmpl = emails.approved(pub.name);
      await sendEmail(pub.email, tmpl.subject, tmpl.html);
    }
  }
  res.json({ success: true, message: 'Publisher approved. Email sent.' });
});

// REJECT publisher
app.post('/api/admin/publisher/reject/:id', async (req, res) => {
  const { id } = req.params;
  if (pool) {
    const pub = await db.query('SELECT name, email FROM publishers WHERE id = ?', [id]);
    await db.query('DELETE FROM publishers WHERE id = ?', [id]);
    if (pub.length > 0) {
      const tmpl = emails.rejected(pub[0].name);
      await sendEmail(pub[0].email, tmpl.subject, tmpl.html);
    }
  } else {
    const idx = memDB.pendingPublishers.findIndex(p => p.id === id);
    if (idx !== -1) {
      const pub = memDB.pendingPublishers.splice(idx, 1)[0];
      const tmpl = emails.rejected(pub.name);
      await sendEmail(pub.email, tmpl.subject, tmpl.html);
    }
  }
  res.json({ success: true, message: 'Publisher rejected. Email sent.' });
});

// OFFERS CRUD
app.get('/api/admin/offers', async (req, res) => {
  if (pool) {
    const rows = await db.query('SELECT * FROM offers ORDER BY id');
    return res.json({ success: true, offers: rows });
  }
  res.json({ success: true, offers: memDB.offers });
});

app.post('/api/admin/offers', async (req, res) => {
  const { name, category, payout, geo, access_type, status, tracking_url, daily_cap } = req.body;
  if (pool) {
    const result = await db.query(
      'INSERT INTO offers (name, category, payout, geo, access_type, status, tracking_url, daily_cap) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, category, payout, geo, access_type || 'open', status || 'active', tracking_url, daily_cap || 500]
    );
    return res.json({ success: true, id: result.insertId });
  }
  const newOffer = { id: memDB.offers.length + 1, name, category, payout: parseFloat(payout), geo, access_type: access_type || 'open', status: status || 'active', tracking_url, daily_cap: daily_cap || 500, total_conversions: 0 };
  memDB.offers.push(newOffer);
  res.json({ success: true, offer: newOffer });
});

app.put('/api/admin/offers/:id', async (req, res) => {
  const { id } = req.params;
  const { name, payout, geo, access_type, status } = req.body;
  if (pool) {
    await db.query('UPDATE offers SET name=?, payout=?, geo=?, access_type=?, status=? WHERE id=?', [name, payout, geo, access_type, status, id]);
  } else {
    const o = memDB.offers.find(x => x.id == id);
    if (o) Object.assign(o, { name, payout, geo, access_type, status });
  }
  res.json({ success: true });
});

app.delete('/api/admin/offers/:id', async (req, res) => {
  const { id } = req.params;
  if (pool) await db.query('DELETE FROM offers WHERE id = ?', [id]);
  else memDB.offers = memDB.offers.filter(o => o.id != id);
  res.json({ success: true });
});

// OFFER REQUESTS (admin)
app.get('/api/admin/offer-requests', async (req, res) => {
  if (pool) {
    const rows = await db.query(`
      SELECT or2.*, p.name as pub_name, p.total_clicks, p.total_conversions, o.name as offer_name, o.payout
      FROM offer_requests or2
      JOIN publishers p ON or2.publisher_id = p.id
      JOIN offers o ON or2.offer_id = o.id
      WHERE or2.status = 'pending'
    `);
    return res.json({ success: true, requests: rows });
  }
  res.json({ success: true, requests: memDB.offerRequests });
});

app.post('/api/admin/offer-request/approve/:id', async (req, res) => {
  if (pool) await db.query('UPDATE offer_requests SET status = "approved" WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

app.post('/api/admin/offer-request/reject/:id', async (req, res) => {
  if (pool) await db.query('UPDATE offer_requests SET status = "rejected" WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// PAYOUT REQUESTS (admin)
app.get('/api/admin/payouts', async (req, res) => {
  if (pool) {
    const rows = await db.query(`
      SELECT pr.*, p.name as pub_name, p.email as pub_email
      FROM payout_requests pr
      JOIN publishers p ON pr.publisher_id = p.id
      WHERE pr.status = 'pending'
      ORDER BY pr.created_at DESC
    `);
    return res.json({ success: true, payouts: rows });
  }
  res.json({ success: true, payouts: memDB.payoutRequests });
});

app.post('/api/admin/payout/approve/:id', async (req, res) => {
  const { id } = req.params;
  if (pool) {
    const rows = await db.query('SELECT * FROM payout_requests WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    const pr = rows[0];

    // Try CoinPayments
    const cpResult = await createCryptoPayment(parseFloat(pr.amount), pr.coin, pr.wallet_address, `NexusCPA payout #${id}`);

    let txHash = cpResult.txn_id || null;
    await db.query('UPDATE payout_requests SET status = "approved", tx_hash = ? WHERE id = ?', [txHash, id]);
    await db.query('UPDATE publishers SET balance = balance - ? WHERE id = ?', [pr.amount, pr.publisher_id]);

    // Get publisher info for email
    const pub = await db.query('SELECT name, email FROM publishers WHERE id = ?', [pr.publisher_id]);
    if (pub.length > 0) {
      const tmpl = emails.payoutSent(pub[0].name, pr.amount, pr.coin, txHash);
      await sendEmail(pub[0].email, tmpl.subject, tmpl.html);
    }

    return res.json({ success: true, coinpayments: cpResult, tx_hash: txHash });
  }
  res.json({ success: true });
});

app.post('/api/admin/payout/reject/:id', async (req, res) => {
  if (pool) await db.query('UPDATE payout_requests SET status = "rejected" WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ANNOUNCEMENTS
app.post('/api/admin/announcement', async (req, res) => {
  const { message, type, target_audience } = req.body;
  if (pool) {
    await db.query('INSERT INTO announcements (message, type, target_audience) VALUES (?, ?, ?)', [message, type || 'info', target_audience || 'all']);
  } else {
    memDB.announcements.unshift({ message, type, target_audience, created_at: new Date() });
  }
  res.json({ success: true });
});

app.get('/api/announcements', async (req, res) => {
  if (pool) {
    const rows = await db.query('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 5');
    return res.json({ success: true, announcements: rows });
  }
  res.json({ success: true, announcements: memDB.announcements.slice(0, 5) });
});

// FRAUD: Block IP manually
app.post('/api/admin/fraud/block-ip', async (req, res) => {
  const { ip, reason } = req.body;
  if (pool) await db.query('INSERT IGNORE INTO blocked_ips (ip, reason) VALUES (?, ?)', [ip, reason || 'Manual block']);
  else memDB.blockedIPs.add(ip);
  res.json({ success: true });
});

// STATS
app.get('/api/stats', async (req, res) => {
  if (pool) {
    const [pubs] = await pool.query('SELECT COUNT(*) as cnt FROM publishers WHERE status = "active"');
    const [pending] = await pool.query('SELECT COUNT(*) as cnt FROM publishers WHERE status = "pending"');
    const [offers] = await pool.query('SELECT COUNT(*) as cnt FROM offers WHERE status = "active"');
    const [todayConv] = await pool.query('SELECT COUNT(*) as cnt, COALESCE(SUM(payout),0) as rev FROM conversions WHERE DATE(created_at) = CURDATE()');
    const [todayClicks] = await pool.query('SELECT COUNT(*) as cnt FROM clicks WHERE DATE(created_at) = CURDATE()');
    const [anns] = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 3');
    return res.json({
      today: { clicks: todayClicks[0].cnt, conversions: todayConv[0].cnt, revenue: parseFloat(todayConv[0].rev).toFixed(2) },
      total: { publishers: pubs[0].cnt, pending: pending[0].cnt, offers: offers[0].cnt },
      announcements: anns,
    });
  }
  res.json({
    today: { clicks: 0, conversions: 0, revenue: '0.00' },
    total: { publishers: memDB.publishers.length, pending: memDB.pendingPublishers.length, offers: memDB.offers.length },
    announcements: memDB.announcements.slice(0, 3),
  });
});

// ============================================
// START SERVER
// ============================================
async function start() {
  await initDB();
  initEmail();
  app.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════╗
  ║  NexusCPA Network Server v3.0        ║
  ║  Delaware, USA                       ║
  ║  Port: ${PORT}                           ║
  ╚══════════════════════════════════════╝
  Database : ${pool ? '✅ MySQL Connected' : '⚠️  In-Memory Mode'}
  Email    : ${mailer ? '✅ Gmail Ready' : '⚠️  Not Configured'}
  CoinPay  : ${process.env.COINPAYMENTS_PUBLIC_KEY ? '✅ Configured' : '⚠️  Not Configured'}
  `);
  });
}

start();
