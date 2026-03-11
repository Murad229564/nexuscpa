// ============================================
// NexusCPA Network - Backend Server
// Delaware, USA | v2.0
// ============================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const POSTBACK_SECRET = process.env.POSTBACK_SECRET || 'nexus_secret_2026';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const IPQS_KEY = process.env.IPQS_API_KEY || '';

// ============================================
// IN-MEMORY DATABASE (Replace with MySQL later)
// ============================================
const db = {
  publishers: [
    { id: 'AFF-00123', name: 'John Smith', email: 'john@email.com', status: 'active', traffic: 'Social', balance: 318.40, device_fp: 'abc123', ip: '203.0.113.10', created: '2025-01-01' },
    { id: 'AFF-00189', name: 'Karim Hossain', email: 'karim@gmail.com', status: 'active', traffic: 'Social', balance: 525.00, device_fp: 'def456', ip: '203.0.113.20', created: '2025-01-15' },
  ],
  pendingPublishers: [
    { id: 'AFF-0284', name: 'Ali Hassan', email: 'ali@gmail.com', traffic: 'Social Media', device_fp: 'abc123', ip: '203.0.113.50', applied: new Date().toISOString() },
    { id: 'AFF-0285', name: 'Sara Khan', email: 'sara@outlook.com', traffic: 'Blog/SEO', device_fp: 'xyz789', ip: '203.0.113.60', applied: new Date().toISOString() },
  ],
  offers: [
    { id: 1, name: '$50 Amazon Gift Card', category: 'Gift Cards', payout: 2.80, geo: 'US, CA, UK', access: 'open', status: 'active', tracking_url: 'https://advertiser.com/lp?clickid={clickid}', daily_cap: 500, conversions: 18420 },
    { id: 2, name: '$100 Visa Gift Card', category: 'Gift Cards', payout: 4.00, geo: 'US Only', access: 'open', status: 'active', tracking_url: 'https://advertiser.com/visa?clickid={clickid}', daily_cap: 200, conversions: 5824 },
    { id: 3, name: 'Email Submit CPL', category: 'Survey/CPL', payout: 1.20, geo: 'US, CA, AU', access: 'open', status: 'active', tracking_url: 'https://advertiser.com/cpl?clickid={clickid}', daily_cap: 1000, conversions: 8240 },
    { id: 4, name: 'Free Credit Score', category: 'Finance', payout: 3.50, geo: 'US Only', access: 'locked', status: 'active', tracking_url: 'https://advertiser.com/finance?clickid={clickid}', daily_cap: 100, conversions: 2140 },
    { id: 5, name: 'Mobile App CPI', category: 'App Install', payout: 0.80, geo: 'Global', access: 'open', status: 'active', tracking_url: 'https://advertiser.com/app?clickid={clickid}', daily_cap: 2000, conversions: 4120 },
    { id: 6, name: 'Consumer Survey', category: 'Survey/CPL', payout: 1.80, geo: 'US, CA', access: 'locked', status: 'paused', tracking_url: 'https://advertiser.com/survey?clickid={clickid}', daily_cap: 300, conversions: 0 },
  ],
  clicks: [],
  conversions: [],
  blockedIPs: new Set(['185.220.101.45', '198.54.117.200', '45.147.228.80']),
  clickCounts: new Map(),   // IP -> [timestamps]
  recentClicks: new Map(),  // `${ip}_${offer_id}` -> timestamp
  offerRequests: [],
  payoutRequests: [],
  announcements: [
    { msg: '🎁 New offers: $50 Amazon Gift Card payout raised to $2.80!', type: 'offer', date: new Date().toISOString() }
  ],
  chatMessages: new Map(), // pub_id -> [messages]
};

// ============================================
// FRAUD DETECTION ENGINE
// ============================================
class FraudEngine {
  static async check(ip, userAgent, offerId) {
    let score = 0;
    const reasons = [];

    // 1. IP Blocklist
    if (db.blockedIPs.has(ip)) {
      return { blocked: true, score: 100, reason: 'Blacklisted IP' };
    }

    // 2. Bot User-Agent detection
    const botPatterns = /bot|crawler|spider|scraper|wget|curl|python|java|go-http|axios|postman/i;
    if (botPatterns.test(userAgent)) {
      score += 80; reasons.push('Bot User-Agent');
    }

    // 3. Click rate limiting (>50 clicks/IP/hour)
    const now = Date.now();
    const hourAgo = now - 3600000;
    if (!db.clickCounts.has(ip)) db.clickCounts.set(ip, []);
    const clicks = db.clickCounts.get(ip).filter(t => t > hourAgo);
    clicks.push(now);
    db.clickCounts.set(ip, clicks);
    if (clicks.length > 50) {
      score += 60; reasons.push(`High click rate: ${clicks.length}/hour`);
    }

    // 4. Duplicate click (same IP + offer within 30min)
    const dupKey = `${ip}_${offerId}`;
    const lastClick = db.recentClicks.get(dupKey);
    if (lastClick && (now - lastClick) < 1800000) {
      score += 50; reasons.push('Duplicate click (30min window)');
    }
    db.recentClicks.set(dupKey, now);

    // 5. IPQS API (if key available)
    if (IPQS_KEY && score < 75) {
      try {
        const resp = await fetch(`https://ipqualityscore.com/api/json/ip/${IPQS_KEY}/${ip}?strictness=1&allow_public_access_points=false`);
        const data = await resp.json();
        if (data.vpn) { score += 40; reasons.push('VPN detected'); }
        if (data.proxy) { score += 35; reasons.push('Proxy detected'); }
        if (data.tor) { score += 50; reasons.push('Tor exit node'); }
        if (data.is_crawler) { score += 80; reasons.push('Crawler'); }
        if (data.fraud_score) score = Math.max(score, data.fraud_score * 0.8);
      } catch (e) { /* continue without IPQS */ }
    }

    // 6. Datacenter/Hosting IP ranges
    const datacenterRanges = ['104.21.', '172.67.', '198.54.', '45.147.', '194.165.'];
    if (datacenterRanges.some(r => ip.startsWith(r))) {
      score += 30; reasons.push('Datacenter IP');
    }

    // Block if score >= 75
    if (score >= 75) {
      db.blockedIPs.add(ip);
      return { blocked: true, score, reason: reasons.join(', ') };
    }

    return { blocked: false, score, reason: reasons.join(', ') || 'Clean' };
  }
}

// ============================================
// DEVICE FINGERPRINT CHECK (Same device = same account)
// ============================================
function checkDeviceFingerprint(deviceFp, email) {
  const existing = db.publishers.find(p => p.device_fp === deviceFp);
  if (existing) {
    return { duplicate: true, existing_id: existing.id, existing_email: existing.email };
  }
  const pendingMatch = db.pendingPublishers.find(p => p.device_fp === deviceFp);
  if (pendingMatch) {
    return { duplicate: true, existing_id: pendingMatch.id, existing_email: pendingMatch.email, pending: true };
  }
  return { duplicate: false };
}

// ============================================
// PUBLISHER REGISTRATION
// ============================================
app.post('/api/publisher/register', async (req, res) => {
  const { name, email, password, traffic_source, referral_code, device_fp } = req.body;
  const ip = req.ip || req.headers['x-forwarded-for'] || '0.0.0.0';

  if (!name || !email || !password || !traffic_source) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  // Check email exists
  const emailExists = [...db.publishers, ...db.pendingPublishers].find(p => p.email === email);
  if (emailExists) {
    return res.status(400).json({ success: false, error: 'Email already registered' });
  }

  // Device fingerprint check
  if (device_fp) {
    const fpCheck = checkDeviceFingerprint(device_fp, email);
    if (fpCheck.duplicate) {
      return res.status(400).json({
        success: false,
        error: 'Multiple accounts from same device are not allowed',
        flag: 'DUPLICATE_DEVICE'
      });
    }
  }

  // Create pending publisher
  const newPub = {
    id: 'AFF-' + String(db.publishers.length + db.pendingPublishers.length + 100).padStart(5, '0'),
    name, email,
    password_hash: crypto.createHash('sha256').update(password).digest('hex'),
    traffic: traffic_source,
    referral_code: referral_code || null,
    device_fp: device_fp || null,
    ip,
    status: 'pending',
    balance: 0,
    applied: new Date().toISOString()
  };

  db.pendingPublishers.push(newPub);

  res.json({
    success: true,
    message: 'Application submitted! You will be notified within 24 hours.',
    id: newPub.id
  });
});

// ============================================
// PUBLISHER LOGIN
// ============================================
app.post('/api/publisher/login', (req, res) => {
  const { email, password } = req.body;
  const hash = crypto.createHash('sha256').update(password).digest('hex');

  // Check pending first
  const pending = db.pendingPublishers.find(p => p.email === email);
  if (pending) {
    return res.status(403).json({ success: false, error: 'Your account is pending approval. Please wait for our team to review.', status: 'pending' });
  }

  const pub = db.publishers.find(p => p.email === email);
  if (!pub) {
    return res.status(401).json({ success: false, error: 'Invalid email or password' });
  }

  if (pub.status === 'suspended') {
    return res.status(403).json({ success: false, error: 'Your account has been suspended. Contact support.', status: 'suspended' });
  }

  res.json({ success: true, publisher: { id: pub.id, name: pub.name, email: pub.email, balance: pub.balance } });
});

// ============================================
// ADMIN: APPROVE/REJECT PUBLISHER
// ============================================
app.post('/api/admin/publisher/approve/:id', (req, res) => {
  const idx = db.pendingPublishers.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });

  const pub = db.pendingPublishers.splice(idx, 1)[0];
  pub.status = 'active';
  pub.balance = 0;
  db.publishers.push(pub);

  // TODO: Send approval email here
  res.json({ success: true, message: 'Publisher approved', publisher: pub });
});

app.post('/api/admin/publisher/reject/:id', (req, res) => {
  const idx = db.pendingPublishers.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });

  const pub = db.pendingPublishers.splice(idx, 1)[0];
  res.json({ success: true, message: 'Publisher rejected', id: pub.id });
});

app.post('/api/admin/publisher/suspend/:id', (req, res) => {
  const pub = db.publishers.find(p => p.id === req.params.id);
  if (!pub) return res.status(404).json({ success: false });
  pub.status = pub.status === 'suspended' ? 'active' : 'suspended';
  res.json({ success: true, status: pub.status });
});

// ============================================
// CLICK TRACKING
// ============================================
app.get('/click', async (req, res) => {
  const { offer_id, aff_id, sub1, sub2, sub3 } = req.query;
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '0.0.0.0';
  const userAgent = req.headers['user-agent'] || '';

  if (!offer_id || !aff_id) {
    return res.status(400).send('Missing parameters');
  }

  const offer = db.offers.find(o => o.id == offer_id);
  if (!offer) return res.status(404).send('Offer not found');
  if (offer.status !== 'active') return res.status(403).send('Offer paused');

  // Fraud check
  const fraud = await FraudEngine.check(ip, userAgent, offer_id);

  const clickId = crypto.randomBytes(12).toString('hex');
  const click = {
    id: clickId,
    offer_id: parseInt(offer_id),
    aff_id,
    sub1: sub1 || '',
    sub2: sub2 || '',
    sub3: sub3 || '',
    ip,
    user_agent: userAgent,
    fraud_score: fraud.score,
    blocked: fraud.blocked,
    time: new Date().toISOString()
  };

  db.clicks.push(click);

  if (fraud.blocked) {
    return res.status(403).send('Access denied');
  }

  // Redirect to offer URL
  const redirectUrl = offer.tracking_url.replace('{clickid}', clickId).replace('{aff_id}', aff_id);
  res.redirect(redirectUrl);
});

// ============================================
// POSTBACK (Conversion)
// ============================================
app.get('/postback', (req, res) => {
  const { click_id, payout, token } = req.query;

  if (token !== POSTBACK_SECRET) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  const click = db.clicks.find(c => c.id === click_id);
  if (!click) return res.status(404).json({ error: 'Click not found' });
  if (click.blocked) return res.status(400).json({ error: 'Click was fraud' });

  const conv = {
    id: 'CONV-' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    click_id,
    offer_id: click.offer_id,
    aff_id: click.aff_id,
    payout: parseFloat(payout) || db.offers.find(o => o.id === click.offer_id)?.payout || 0,
    status: 'pending',
    time: new Date().toISOString()
  };

  db.conversions.push(conv);

  // Add to publisher balance (pending)
  const pub = db.publishers.find(p => p.id === click.aff_id);
  if (pub) pub.balance = (pub.balance || 0) + conv.payout;

  res.json({ success: true, conversion_id: conv.id, payout: conv.payout });
});

// ============================================
// CRYPTO PAYOUT REQUEST
// ============================================
app.post('/api/publisher/payout-request', (req, res) => {
  const { aff_id, crypto_type, wallet_address, amount_usd } = req.body;

  const pub = db.publishers.find(p => p.id === aff_id);
  if (!pub) return res.status(404).json({ error: 'Publisher not found' });
  if ((pub.balance || 0) < 50) return res.status(400).json({ error: 'Minimum payout is $50' });
  if (!wallet_address) return res.status(400).json({ error: 'Wallet address required' });

  const supported = ['BTC', 'ETH', 'USDT', 'BNB', 'LTC', 'SOL'];
  if (!supported.includes(crypto_type)) {
    return res.status(400).json({ error: 'Unsupported cryptocurrency' });
  }

  const req_id = 'PAY-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  db.payoutRequests.push({
    id: req_id,
    aff_id,
    pub_name: pub.name,
    amount_usd: pub.balance,
    crypto_type,
    wallet_address,
    status: 'pending',
    requested: new Date().toISOString()
  });

  res.json({ success: true, request_id: req_id, message: 'Payout request submitted. Processed every Monday.' });
});

// ============================================
// OFFER REQUEST (Locked offer access)
// ============================================
app.post('/api/publisher/offer-request', (req, res) => {
  const { aff_id, offer_id } = req.body;

  const offer = db.offers.find(o => o.id == offer_id);
  if (!offer || offer.access !== 'locked') {
    return res.status(400).json({ error: 'Offer not found or not locked' });
  }

  const existing = db.offerRequests.find(r => r.aff_id === aff_id && r.offer_id == offer_id && r.status === 'pending');
  if (existing) return res.status(400).json({ error: 'Request already pending' });

  db.offerRequests.push({
    id: 'REQ-' + crypto.randomBytes(5).toString('hex').toUpperCase(),
    aff_id,
    offer_id: parseInt(offer_id),
    offer_name: offer.name,
    status: 'pending',
    requested: new Date().toISOString()
  });

  res.json({ success: true, message: 'Access request submitted. We will review within 24 hours.' });
});

// ============================================
// ADMIN: OFFER MANAGEMENT
// ============================================
app.get('/api/admin/offers', (req, res) => {
  res.json(db.offers);
});

app.post('/api/admin/offers', (req, res) => {
  const { name, category, payout, geo, access, status, tracking_url, daily_cap } = req.body;
  if (!name) return res.status(400).json({ error: 'Offer name required' });

  const offer = {
    id: Math.max(...db.offers.map(o => o.id)) + 1,
    name, category, payout: parseFloat(payout), geo,
    access: access || 'open',
    status: status || 'active',
    tracking_url, daily_cap: parseInt(daily_cap) || 0,
    conversions: 0,
    created: new Date().toISOString()
  };

  db.offers.push(offer);
  res.json({ success: true, offer });
});

app.put('/api/admin/offers/:id', (req, res) => {
  const offer = db.offers.find(o => o.id == req.params.id);
  if (!offer) return res.status(404).json({ error: 'Not found' });

  Object.assign(offer, req.body);
  res.json({ success: true, offer });
});

app.delete('/api/admin/offers/:id', (req, res) => {
  const idx = db.offers.findIndex(o => o.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.offers.splice(idx, 1);
  res.json({ success: true });
});

app.post('/api/admin/offers/:id/toggle', (req, res) => {
  const offer = db.offers.find(o => o.id == req.params.id);
  if (!offer) return res.status(404).json({ error: 'Not found' });
  offer.status = offer.status === 'active' ? 'paused' : 'active';
  res.json({ success: true, status: offer.status });
});

// ============================================
// ADMIN: OFFER REQUESTS
// ============================================
app.post('/api/admin/offer-request/approve/:id', (req, res) => {
  const req2 = db.offerRequests.find(r => r.id === req.params.id);
  if (!req2) return res.status(404).json({ error: 'Not found' });
  req2.status = 'approved';
  res.json({ success: true });
});

app.post('/api/admin/offer-request/reject/:id', (req, res) => {
  const req2 = db.offerRequests.find(r => r.id === req.params.id);
  if (!req2) return res.status(404).json({ error: 'Not found' });
  req2.status = 'rejected';
  res.json({ success: true });
});

// ============================================
// ADMIN: PAYOUT MANAGEMENT
// ============================================
app.get('/api/admin/payouts', (req, res) => {
  res.json({ pending: db.payoutRequests.filter(p => p.status === 'pending'), all: db.payoutRequests });
});

app.post('/api/admin/payout/approve/:id', (req, res) => {
  const p = db.payoutRequests.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.status = 'sent';
  p.processed = new Date().toISOString();
  const pub = db.publishers.find(x => x.id === p.aff_id);
  if (pub) pub.balance = 0;
  res.json({ success: true });
});

// ============================================
// ANNOUNCEMENT
// ============================================
app.post('/api/admin/announcement', (req, res) => {
  const { message, type, target } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  const ann = { id: Date.now(), message, type, target, date: new Date().toISOString() };
  db.announcements.unshift(ann);
  res.json({ success: true, announcement: ann });
});

app.get('/api/announcements', (req, res) => {
  res.json(db.announcements.slice(0, 5));
});

// ============================================
// FRAUD: BLOCK IP
// ============================================
app.post('/api/admin/fraud/block-ip', (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP required' });
  db.blockedIPs.add(ip);
  res.json({ success: true, message: `IP ${ip} blocked` });
});

app.get('/api/admin/fraud/stats', (req, res) => {
  const today = new Date().toDateString();
  const todayClicks = db.clicks.filter(c => new Date(c.time).toDateString() === today);
  res.json({
    blocked_today: todayClicks.filter(c => c.blocked).length,
    total_blocked_ips: db.blockedIPs.size,
    total_clicks: db.clicks.length,
  });
});

// ============================================
// STATS APIs
// ============================================
app.get('/api/stats', (req, res) => {
  const today = new Date().toDateString();
  const todayClicks = db.clicks.filter(c => new Date(c.time).toDateString() === today);
  const todayConvs = db.conversions.filter(c => new Date(c.time).toDateString() === today);
  res.json({
    today: { clicks: todayClicks.length, conversions: todayConvs.length, revenue: todayConvs.reduce((s, c) => s + c.payout, 0).toFixed(2) },
    total: { publishers: db.publishers.length, pending: db.pendingPublishers.length, offers: db.offers.filter(o => o.status === 'active').length },
    announcements: db.announcements.slice(0, 3)
  });
});

app.get('/api/publisher/stats/:id', (req, res) => {
  const pub = db.publishers.find(p => p.id === req.params.id);
  if (!pub) return res.status(404).json({ error: 'Not found' });

  const today = new Date().toDateString();
  const myClicks = db.clicks.filter(c => c.aff_id === pub.id);
  const myConvs = db.conversions.filter(c => c.aff_id === pub.id);
  const todayClicks = myClicks.filter(c => new Date(c.time).toDateString() === today);
  const todayConvs = myConvs.filter(c => new Date(c.time).toDateString() === today);

  res.json({
    publisher: { id: pub.id, name: pub.name, balance: pub.balance },
    today: { clicks: todayClicks.length, conversions: todayConvs.length, earnings: todayConvs.reduce((s, c) => s + c.payout, 0).toFixed(2) },
    all_time: { clicks: myClicks.length, conversions: myConvs.length }
  });
});

app.get('/api/offers', (req, res) => {
  res.json(db.offers.filter(o => o.status === 'active').map(o => ({ ...o, tracking_url: undefined })));
});

// ============================================
// GENERATE TRACKING LINK
// ============================================
app.post('/api/tracking-link', (req, res) => {
  const { aff_id, offer_id, sub1 } = req.body;
  const link = `${BASE_URL}/click?offer_id=${offer_id}&aff_id=${aff_id}&sub1=${sub1 || ''}`;
  res.json({ success: true, link });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║  NexusCPA Network Server Started     ║');
  console.log('  ║  Delaware, USA                       ║');
  console.log(`  ║  Port: ${PORT}                           ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log('  Endpoints:');
  console.log(`  → Landing Page   : ${BASE_URL}/`);
  console.log(`  → Publisher API  : ${BASE_URL}/api/publisher`);
  console.log(`  → Admin API      : ${BASE_URL}/api/admin`);
  console.log(`  → Click Track    : ${BASE_URL}/click?offer_id=1&aff_id=AFF-00123&sub1=test`);
  console.log(`  → Postback       : ${BASE_URL}/postback?click_id=xxx&payout=2.50&token=${POSTBACK_SECRET}`);
  console.log('');
});

module.exports = app;
