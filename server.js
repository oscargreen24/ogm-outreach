const express      = require('express');
const cors         = require('cors');
const fetch        = require('node-fetch');
const { Pool }     = require('pg');
const nodemailer   = require('nodemailer');
const cron         = require('node-cron');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Postgres ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

// ── Schema setup ──────────────────────────────────────────────────────────────
async function setupSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      "firstName" TEXT NOT NULL DEFAULT '',
      "lastName" TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      website TEXT DEFAULT '',
      industry TEXT DEFAULT '',
      channel TEXT DEFAULT 'email',
      contact TEXT DEFAULT '',
      "hunterEmail" TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      "researchNotes" TEXT DEFAULT '',
      "companyDesc" TEXT DEFAULT '',
      status TEXT DEFAULT 'new',
      "reelId" TEXT DEFAULT '',
      "monthlyValue" REAL DEFAULT 0,
      timeline TEXT DEFAULT '[]',
      "contactedDate" TEXT DEFAULT NULL,
      "followup1SentDate" TEXT DEFAULT NULL,
      "followup2SentDate" TEXT DEFAULT NULL,
      suburb TEXT DEFAULT '',
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL
    )
  `);
  await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS suburb TEXT DEFAULT ''`).catch(()=>{});
  await query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      "googleEventId" TEXT UNIQUE,
      "firstName" TEXT DEFAULT '',
      "lastName" TEXT DEFAULT '',
      email TEXT DEFAULT '',
      company TEXT DEFAULT '',
      "shootType" TEXT DEFAULT '',
      budget TEXT DEFAULT '',
      "startTime" TEXT DEFAULT '',
      "endTime" TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'confirmed',
      "leadId" TEXT DEFAULT '',
      "createdAt" TEXT NOT NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS send_log (
      id SERIAL PRIMARY KEY,
      "leadId" TEXT NOT NULL,
      touch INTEGER NOT NULL,
      channel TEXT NOT NULL,
      "sentAt" TEXT NOT NULL,
      subject TEXT DEFAULT '',
      preview TEXT DEFAULT ''
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS jarvis_memory (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      "createdAt" TEXT NOT NULL
    )
  `);
  console.log('[db] Schema ready.');
}

// ── JARVIS MEMORY ─────────────────────────────────────────────────────────────
async function addJarvisEndpoints(app) {
  app.get('/api/jarvis/memory', async (req, res) => {
    try {
      const r = await query(`SELECT role, content FROM jarvis_memory ORDER BY id DESC LIMIT 40`);
      res.json({ messages: r.rows.reverse() });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/jarvis/memory', requireWrite, async (req, res) => {
    try {
      const { role, content } = req.body;
      await query(`INSERT INTO jarvis_memory (role, content, "createdAt") VALUES ($1,$2,$3)`,
        [role, content, new Date().toISOString()]);
      await query(`DELETE FROM jarvis_memory WHERE id NOT IN (SELECT id FROM jarvis_memory ORDER BY id DESC LIMIT 40)`);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/jarvis/memory', requireWrite, async (req, res) => {
    try {
      await query('DELETE FROM jarvis_memory');
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────
const AUTH_USER      = process.env.AUTH_USER      || 'oscar@oscargreenmedia.com';
const AUTH_PASS      = process.env.AUTH_PASS      || 'Chucky24';
const GUEST_USER     = process.env.GUEST_USER     || 'guest@oscargreenmedia.com';
const GUEST_PASS     = process.env.GUEST_PASS     || 'ViewOnly2026';
const SESSION_SECRET = process.env.SESSION_SECRET || 'ogm-default-secret-change-me';
const sessions = new Map();

function createSession(role = 'admin') {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expires: Date.now() + 1 * 24 * 60 * 60 * 1000, role });
  return token;
}
function isValidSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expires) { sessions.delete(token); return false; }
  return true;
}
function getSessionRole(token) {
  const s = sessions.get(token);
  return s ? s.role : null;
}
function isGuestSession(req) {
  const token = parseCookies(req).ogm_session;
  return getSessionRole(token) === 'guest';
}

// Write methods that guests cannot use
const WRITE_PATHS = [
  '/api/leads', '/api/leads/bulk', '/api/bookings',
  '/api/config', '/api/jarvis/memory', '/api/generate-leads',
  '/api/morning-brief', '/api/send', '/api/gmail/scan',
  '/api/gmail/auth', '/api/logout'
];
function requireWrite(req, res, next) {
  if (isGuestSession(req)) {
    return res.status(403).json({ error: 'Read-only access — you are logged in as a guest.' });
  }
  next();
}

// Clean up expired sessions every hour to prevent memory buildup
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions.entries()) {
    if (now > s.expires) sessions.delete(token);
  }
}, 60 * 60 * 1000);
function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) rc.split(';').forEach(c => {
    const p = c.split('=');
    list[p[0].trim()] = decodeURIComponent(p.slice(1).join('=').trim());
  });
  return list;
}
function requireAuth(req, res, next) {
  if (req.path === '/login' || req.path === '/api/login') return next();
  if (req.path === '/api/health') return next();
  if (req.path === '/api/gmail/callback') return next(); // Google OAuth callback
  if (isValidSession(parseCookies(req).ogm_session)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login');
}

// ── Middleware ─────────────────────────────────────────────────────────────────
// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
// Lock CORS to same-origin only (the app is served from this same server)
const ALLOWED_ORIGIN = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : true;
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(requireAuth);

// ── Helpers ───────────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();
const uid = () => crypto.randomBytes(8).toString('hex');
const hunterKey = () => process.env.HUNTER_API_KEY || '';

// ── LOGIN ─────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (isValidSession(parseCookies(req).ogm_session)) return res.redirect('/');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OGM — Sign in</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e5e5e5;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:#0f0f0f;border:1px solid #1a1a1a;border-radius:16px;padding:40px;width:100%;max-width:380px}.logo{font-size:28px;font-weight:700;letter-spacing:6px;color:#fff;margin-bottom:4px}.logo-sub{font-size:9px;letter-spacing:3px;color:#3f3f46;text-transform:uppercase;margin-bottom:36px}label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#52525b;display:block;margin-bottom:6px}input{width:100%;background:#1a1a1a;border:1px solid #262626;color:#fff;font-size:14px;padding:10px 14px;border-radius:8px;margin-bottom:16px;outline:none}input:focus{border-color:#3f3f46}button{width:100%;background:#fff;color:#000;border:none;padding:11px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;margin-top:4px}button:hover{background:#e5e5e5}.error{color:#f87171;font-size:13px;margin-bottom:16px;display:none}</style>
</head><body><div class="card">
<div class="logo">OGM</div><div class="logo-sub">Oscar Green Media</div>
<div class="error" id="err">Incorrect email or password.</div>
<form onsubmit="login(event)">
<label>Username</label><input type="text" id="u" placeholder="Username" autocomplete="username"/>
<label>Password</label><input type="password" id="p" placeholder="Password" autocomplete="current-password"/>
<button type="submit" id="btn">Sign in</button>
</form></div>
<script>async function login(e){e.preventDefault();const btn=document.getElementById('btn');btn.textContent='Signing in...';btn.disabled=true;document.getElementById('err').style.display='none';const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})});const d=await r.json();if(d.ok){window.location.href='/';}else{document.getElementById('err').style.display='block';btn.textContent='Sign in';btn.disabled=false;}}</script>
</body></html>`);
});

// Track failed login attempts per-IP to slow brute force
const loginAttempts = new Map();
function checkLoginAttempts(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };
  if (now < record.lockUntil) return false; // locked out
  return true;
}
function recordFailedLogin(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };
  record.count++;
  // After 5 failed attempts, lock for 15 minutes
  if (record.count >= 5) { record.lockUntil = now + 15 * 60 * 1000; record.count = 0; }
  loginAttempts.set(ip, record);
}
function clearLoginAttempts(ip) { loginAttempts.delete(ip); }

// Timing-safe string comparison to prevent timing attacks
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.post('/api/login', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkLoginAttempts(ip)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in 15 minutes.' });
  }
  const { username, password } = req.body || {};
  // Admin login
  if (safeEqual(username, AUTH_USER) && safeEqual(password, AUTH_PASS)) {
    clearLoginAttempts(ip);
    const token = createSession('admin');
    res.setHeader('Set-Cookie', `ogm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${1 * 24 * 60 * 60}`);
    return res.json({ ok: true, role: 'admin' });
  }
  // Guest login
  if (safeEqual(username, GUEST_USER) && safeEqual(password, GUEST_PASS)) {
    clearLoginAttempts(ip);
    const token = createSession('guest');
    res.setHeader('Set-Cookie', `ogm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${1 * 24 * 60 * 60}`);
    return res.json({ ok: true, role: 'guest' });
  }
  recordFailedLogin(ip);
  res.status(401).json({ ok: false, error: 'Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.ogm_session) sessions.delete(cookies.ogm_session);
  res.setHeader('Set-Cookie', 'ogm_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

// ── LEADS ─────────────────────────────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  try {
    const r = await query('SELECT * FROM leads ORDER BY "createdAt" DESC');
    res.json({ leads: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Diagnostic: see suburb distribution across all leads
app.get('/api/leads/suburb-breakdown', async (req, res) => {
  try {
    const r = await query(`SELECT suburb, COUNT(*) as count FROM leads GROUP BY suburb ORDER BY count DESC`);
    res.json({ breakdown: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// One-time cleanup: remove leads whose suburb is a known non-Sydney city
const NON_SYDNEY_SUBURBS = ['Melbourne','Brisbane','Boston','Adelaide','Docklands','Southbank','Mooloolaba'];
app.post('/api/leads/remove-non-sydney', requireWrite, async (req, res) => {
  try {
    const r = await query(
      `DELETE FROM leads WHERE suburb = ANY($1::text[]) RETURNING id, company, suburb`,
      [NON_SYDNEY_SUBURBS]
    );
    res.json({ ok: true, removed: r.rowCount, leads: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads', requireWrite, async (req, res) => {
  try {
    const l = req.body;
    await query(`
      INSERT INTO leads (id,"firstName","lastName",company,website,industry,channel,contact,
        "hunterEmail",notes,"researchNotes","companyDesc",status,"reelId","monthlyValue",
        timeline,"contactedDate","followup1SentDate","followup2SentDate",suburb,"createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      ON CONFLICT (id) DO NOTHING
    `, [l.id,l.firstName||'',l.lastName||'',l.company||'',l.website||'',l.industry||'',
        l.channel||'email',l.contact||'',l.hunterEmail||'',l.notes||'',l.researchNotes||'',
        l.companyDesc||'',l.status||'new',l.reelId||'',l.monthlyValue||0,
        l.timeline||'[]',l.contactedDate||null,l.followup1SentDate||null,
        l.followup2SentDate||null,l.suburb||'',l.createdAt||now(),now()]);
    res.json({ ok: true, id: l.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/leads/:id', requireWrite, async (req, res) => {
  try {
    const l = req.body;
    const r = await query(`
      UPDATE leads SET "firstName"=$1,"lastName"=$2,company=$3,website=$4,industry=$5,
        channel=$6,contact=$7,"hunterEmail"=$8,notes=$9,"researchNotes"=$10,"companyDesc"=$11,
        status=$12,"reelId"=$13,"monthlyValue"=$14,timeline=$15,"contactedDate"=$16,
        "followup1SentDate"=$17,"followup2SentDate"=$18,suburb=COALESCE(NULLIF($19,''),suburb),"updatedAt"=$20
      WHERE id=$21
    `, [l.firstName||'',l.lastName||'',l.company||'',l.website||'',l.industry||'',
        l.channel||'email',l.contact||'',l.hunterEmail||'',l.notes||'',l.researchNotes||'',
        l.companyDesc||'',l.status||'new',l.reelId||'',l.monthlyValue||0,
        l.timeline||'[]',l.contactedDate||null,l.followup1SentDate||null,
        l.followup2SentDate||null,l.suburb||'',now(),req.params.id]);
    if (r.rowCount === 0) {
      await query(`
        INSERT INTO leads (id,"firstName","lastName",company,website,industry,channel,contact,
          "hunterEmail",notes,"researchNotes","companyDesc",status,"reelId","monthlyValue",
          timeline,"contactedDate","followup1SentDate","followup2SentDate",suburb,"createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      `, [req.params.id,l.firstName||'',l.lastName||'',l.company||'',l.website||'',l.industry||'',
          l.channel||'email',l.contact||'',l.hunterEmail||'',l.notes||'',l.researchNotes||'',
          l.companyDesc||'',l.status||'new',l.reelId||'',l.monthlyValue||0,
          l.timeline||'[]',l.contactedDate||null,l.followup1SentDate||null,
          l.followup2SentDate||null,l.suburb||'',l.createdAt||now(),now()]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leads/:id', requireWrite, async (req, res) => {
  try {
    await query('DELETE FROM leads WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads/bulk', requireWrite, async (req, res) => {
  try {
    const { leads } = req.body;
    let added = 0;
    for (const l of leads || []) {
      const r = await query(`
        INSERT INTO leads (id,"firstName","lastName",company,website,industry,channel,contact,
          "hunterEmail",notes,"researchNotes","companyDesc",status,"reelId","monthlyValue",
          timeline,"contactedDate","followup1SentDate","followup2SentDate",suburb,"createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
        ON CONFLICT (id) DO NOTHING
      `, [l.id,l.firstName||'',l.lastName||'',l.company||'',l.website||'',l.industry||'',
          l.channel||'email',l.contact||'',l.hunterEmail||'',l.notes||'',l.researchNotes||'',
          l.companyDesc||'',l.status||'new',l.reelId||'',l.monthlyValue||0,
          l.timeline||'[]',l.contactedDate||null,l.followup1SentDate||null,
          l.followup2SentDate||null,l.suburb||'',l.createdAt||now(),now()]);
      if (r.rowCount) added++;
    }
    res.json({ ok: true, added });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── HUNTER PROXY ──────────────────────────────────────────────────────────────
app.get('/api/hunter/domain', async (req, res) => {
  try {
    const key = hunterKey();
    if (!key) return res.status(400).json({ error: 'Hunter API key not configured.' });
    const { domain, limit = 10 } = req.query;
    const r = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${key}&limit=${limit}`);
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hunter/find', async (req, res) => {
  try {
    const key = hunterKey();
    if (!key) return res.status(400).json({ error: 'Hunter API key not configured.' });
    const { domain, first_name, last_name } = req.query;
    const r = await fetch(`https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first_name||'')}&last_name=${encodeURIComponent(last_name||'')}&api_key=${key}`);
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hunter/account', async (req, res) => {
  try {
    const key = hunterKey();
    if (!key) return res.status(400).json({ error: 'Hunter API key not configured.' });
    const r = await fetch(`https://api.hunter.io/v2/account?api_key=${key}`);
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── COMPANY ENRICHMENT (suburb/city lookup for grouping) ──────────────────────
app.get('/api/hunter/company-location', async (req, res) => {
  try {
    const key = hunterKey();
    if (!key) return res.status(400).json({ error: 'Hunter API key not configured.' });
    const { domain } = req.query;
    if (!domain) return res.status(400).json({ error: 'Domain required.' });
    const r = await fetch(`https://api.hunter.io/v2/companies/find?domain=${encodeURIComponent(domain)}&api_key=${key}`);
    const d = await r.json();
    if (d.errors) return res.json({ suburb: '' });
    const geo = d.data?.geo;
    const suburb = geo?.city || geo?.state || '';
    res.json({ suburb });
  } catch(e) { res.json({ suburb: '' }); }
});

// Backfill suburbs for existing leads missing one, deduped by website to save credits
app.post('/api/leads/backfill-suburbs', requireWrite, async (req, res) => {
  try {
    const key = hunterKey();
    if (!key) return res.status(400).json({ error: 'Hunter API key not configured.' });

    const r = await query(`SELECT id, website FROM leads WHERE (suburb IS NULL OR suburb='') AND website != ''`);
    const rows = r.rows;
    if (!rows.length) return res.json({ ok: true, updated: 0, checked: 0 });

    // Dedupe by website to avoid repeat lookups
    const domainCache = {};
    let updated = 0;

    for (const row of rows) {
      const domain = row.website;
      if (!domain) continue;
      if (!(domain in domainCache)) {
        try {
          await new Promise(r2 => setTimeout(r2, 300));
          const cr = await fetch(`https://api.hunter.io/v2/companies/find?domain=${encodeURIComponent(domain)}&api_key=${key}`);
          const cd = await cr.json();
          domainCache[domain] = cd.errors ? '' : (cd.data?.geo?.city || cd.data?.geo?.state || '');
        } catch(e) { domainCache[domain] = ''; }
      }
      const suburb = domainCache[domain] || 'Sydney';
      await query(`UPDATE leads SET suburb=$1, "updatedAt"=$2 WHERE id=$3`, [suburb, now(), row.id]);
      updated++;
    }

    res.json({ ok: true, updated, checked: rows.length, uniqueCompanies: Object.keys(domainCache).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── HUNTER DISCOVER (location-filtered company search, Sydney NSW only) ───────
app.post('/api/hunter/discover', async (req, res) => {
  try {
    const key = hunterKey();
    if (!key) return res.status(400).json({ error: 'Hunter API key not configured.' });
    const { industry, keywords, limit } = req.body;

    const body = {
      headquarters_location: {
        include: [{ city: 'Sydney', state: 'AU-NSW', country: 'AU' }]
      },
      limit: limit || 20
    };
    if (industry) body.industry = { include: [industry] };
    if (keywords) body.keywords = { include: [keywords], match: 'any' };

    const r = await fetch(`https://api.hunter.io/v2/discover?api_key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.errors) return res.status(400).json({ error: d.errors[0]?.details || 'Discover search failed.' });
    res.json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EMAIL ─────────────────────────────────────────────────────────────────────
app.post('/api/send', requireWrite, async (req, res) => {
  try {
    const { to, subject, body, leadId, touch } = req.body;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    if (!smtpUser || !smtpPass) return res.status(400).json({ error: 'SMTP not configured.' });
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: smtpUser, pass: smtpPass } });
    await transporter.sendMail({ from: `"${process.env.SENDER_NAME||'Oscar Green'}" <${smtpUser}>`, to, subject, text: body });
    await query(`INSERT INTO send_log ("leadId",touch,channel,"sentAt",subject,preview) VALUES ($1,$2,'email',$3,$4,$5)`,
      [leadId, touch, now(), subject, (body||'').slice(0,120)]);
    if (leadId) {
      if (touch === 1) await query(`UPDATE leads SET status='contacted',"contactedDate"=$1,"updatedAt"=$2 WHERE id=$3 AND "contactedDate" IS NULL`, [now().slice(0,10),now(),leadId]);
      if (touch === 2) await query(`UPDATE leads SET status='followup1_sent',"followup1SentDate"=$1,"updatedAt"=$2 WHERE id=$3`, [now().slice(0,10),now(),leadId]);
      if (touch === 3) await query(`UPDATE leads SET status='followup2_sent',"followup2SentDate"=$1,"updatedAt"=$2 WHERE id=$3`, [now().slice(0,10),now(),leadId]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/send_log/:leadId', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM send_log WHERE "leadId"=$1 ORDER BY "sentAt" DESC`, [req.params.leadId]);
    res.json({ logs: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CONFIG ────────────────────────────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
  try {
    const r = await query('SELECT key, value FROM config');
    const cfg = {};
    r.rows.forEach(row => { try { cfg[row.key] = JSON.parse(row.value); } catch { cfg[row.key] = row.value; } });
    res.json({ config: cfg });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/config', requireWrite, async (req, res) => {
  try {
    for (const [k, v] of Object.entries(req.body)) {
      await query(`INSERT INTO config (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [k, JSON.stringify(v)]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── BOOKINGS ──────────────────────────────────────────────────────────────────
app.get('/api/bookings', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM bookings ORDER BY "startTime" ASC`);
    res.json({ bookings: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bookings', requireWrite, async (req, res) => {
  try {
    const b = req.body;
    const id = b.id || uid();
    await query(`
      INSERT INTO bookings (id,"googleEventId","firstName","lastName",email,company,"shootType",
        budget,"startTime","endTime",notes,status,"leadId","createdAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT ("googleEventId") DO UPDATE SET
        "firstName"=EXCLUDED."firstName","lastName"=EXCLUDED."lastName",
        email=EXCLUDED.email,company=EXCLUDED.company,
        "startTime"=EXCLUDED."startTime","endTime"=EXCLUDED."endTime",status=EXCLUDED.status
    `, [id,b.googleEventId||null,b.firstName||'',b.lastName||'',b.email||'',b.company||'',
        b.shootType||'',b.budget||'',b.startTime||'',b.endTime||'',b.notes||'',
        b.status||'confirmed',b.leadId||'',b.createdAt||now()]);
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/bookings/:id', requireWrite, async (req, res) => {
  try {
    await query('DELETE FROM bookings WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AUTO LEAD GENERATION ──────────────────────────────────────────────────────
const RELEVANT_TITLES = {
  corporate:    ['marketing','brand','communications','content','social','digital','media','director','cmo','head of'],
  realestate:   ['principal','director','agent','marketing','brand','sales','head of','manager'],
  construction: ['marketing','communications','brand','business development','director','cmo','head of'],
  automotive:   ['marketing','brand','digital','social','dealer','principal','sales','director','head of'],
};

// Industry keywords used to drive Hunter Discover, scoped to Sydney NSW headquarters only
const DISCOVER_KEYWORDS = {
  corporate:    'financial services',
  realestate:   'real estate agency',
  construction: 'construction company',
  automotive:   'car dealership',
};

function isRelevantTitle(position, industry) {
  if (!position) return true;
  const p = position.toLowerCase();
  return (RELEVANT_TITLES[industry] || []).some(t => p.includes(t));
}

// Find Sydney-headquartered companies for an industry via Hunter Discover
async function discoverSydneyCompanies(industry, limit = 12) {
  const key = hunterKey();
  if (!key) return [];
  try {
    const body = {
      headquarters_location: {
        include: [{ city: 'Sydney', state: 'AU-NSW', country: 'AU' }]
      },
      keywords: { include: [DISCOVER_KEYWORDS[industry]], match: 'any' },
      limit
    };
    const r = await fetch(`https://api.hunter.io/v2/discover?api_key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.errors || !d.data) { console.error(`[discover] ${industry}:`, JSON.stringify(d.errors||d)); return []; }
    return d.data.map(c => ({ name: c.organization, domain: c.domain }));
  } catch(e) {
    console.error(`[discover] Error on ${industry}:`, e.message);
    return [];
  }
}

// Look up the suburb/city for a domain via Company Enrichment
async function lookupSuburb(domain) {
  const key = hunterKey();
  if (!key || !domain) return '';
  try {
    const r = await fetch(`https://api.hunter.io/v2/companies/find?domain=${encodeURIComponent(domain)}&api_key=${key}`);
    const d = await r.json();
    if (d.errors) return '';
    return d.data?.geo?.city || '';
  } catch(e) { return ''; }
}

async function generateLeads() {
  const key = hunterKey();
  if (!key) { console.log('[scheduler] No Hunter key.'); return 0; }
  let totalAdded = 0;
  for (const industry of Object.keys(DISCOVER_KEYWORDS)) {
    const companies = await discoverSydneyCompanies(industry, 12);
    console.log(`[scheduler] Discover found ${companies.length} Sydney companies for ${industry}.`);
    for (const co of companies) {
      if (!co.domain) continue;
      try {
        await new Promise(r => setTimeout(r, 400));
        const suburb = await lookupSuburb(co.domain);
        const r = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(co.domain)}&api_key=${key}&limit=10`);
        const d = await r.json();
        if (!d.data || !d.data.emails) continue;
        for (const e of d.data.emails) {
          if (!isRelevantTitle(e.position, industry) || !e.value) continue;
          const exists = await query('SELECT id FROM leads WHERE contact=$1 OR "hunterEmail"=$1', [e.value]);
          if (exists.rowCount) continue;
          await query(`
            INSERT INTO leads (id,"firstName","lastName",company,website,industry,channel,contact,
              "hunterEmail",notes,"researchNotes","companyDesc",status,"reelId","monthlyValue",
              timeline,"contactedDate","followup1SentDate","followup2SentDate",suburb,"createdAt","updatedAt")
            VALUES ($1,$2,$3,$4,$5,$6,'email',$7,$7,$8,'','','new','',0,'[]',null,null,null,$9,$10,$10)
          `, [uid(),e.first_name||'',e.last_name||'',co.name||co.domain,co.domain,industry,e.value,
              e.position?`Title: ${e.position}`:'',suburb||'Sydney',now()]);
          totalAdded++;
        }
      } catch(e) { console.error(`[scheduler] Error on ${co.name}:`, e.message); }
    }
  }
  console.log(`[scheduler] Added ${totalAdded} leads.`);
  return totalAdded;
}

app.post('/api/generate-leads', requireWrite, async (req, res) => {
  try { const added = await generateLeads(); res.json({ ok: true, added }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/generate-leads/status', async (req, res) => {
  try {
    const r = await query('SELECT COUNT(*) as n FROM leads');
    res.json({ totalLeads: parseInt(r.rows[0].n), hunterConfigured: !!hunterKey() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

cron.schedule('0 21 * * *', () => { console.log('[cron] 7am Sydney'); generateLeads(); });
cron.schedule('0 9 * * *',  () => { console.log('[cron] 7pm Sydney'); generateLeads(); });

// ── MORNING BRIEF ─────────────────────────────────────────────────────────────
async function sendMorningBrief() {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const toEmail  = process.env.AUTH_USER || 'oscar@oscargreenmedia.com';
  if (!smtpUser || !smtpPass) { console.log('[brief] SMTP not configured — skipping.'); return; }

  try {
    // Pull data from DB
    const leadsRes   = await query('SELECT * FROM leads ORDER BY "createdAt" DESC');
    const allLeads   = leadsRes.rows;
    const total      = allLeads.length;
    const won        = allLeads.filter(l => l.status === 'won');
    const meetings   = allLeads.filter(l => l.status === 'meeting');
    const replied    = allLeads.filter(l => l.status === 'replied').length;
    const contacted  = allLeads.filter(l => l.contactedDate).length;
    const mrr        = won.reduce((s,l)  => s + (l.monthlyValue||0), 0);
    const pipeline   = meetings.reduce((s,l) => s + (l.monthlyValue||0), 0);
    const fmt        = n => '$' + n.toLocaleString('en-AU');

    // Due for follow-up (simple check — contacted 5+ days ago, not yet followed up)
    const today = new Date().toISOString().slice(0,10);
    const due = allLeads.filter(l => {
      if (['won','not_interested','followup2_sent','replied','meeting'].includes(l.status)) return false;
      if (l.status === 'new') return false;
      if (l.status === 'contacted' && l.contactedDate) {
        const days = Math.floor((Date.now() - new Date(l.contactedDate).getTime()) / 86400000);
        return days >= 5;
      }
      if (l.status === 'followup1_sent' && l.followup1SentDate) {
        const days = Math.floor((Date.now() - new Date(l.followup1SentDate).getTime()) / 86400000);
        return days >= 5;
      }
      return false;
    }).slice(0, 5);

    // Top leads by score (simple scoring)
    const TITLE_SCORE = {'cmo':10,'director':7,'head of':8,'manager':5,'principal':7,'founder':8,'owner':7};
    const scoreL = l => {
      const t = (l.notes||'').replace('Title:','').trim().toLowerCase();
      let s = 20;
      for (const [k,v] of Object.entries(TITLE_SCORE)) if (t.includes(k)) { s += v*10; break; }
      if (l.hunterEmail || l.contact) s += 15;
      if (l.researchNotes) s += 10;
      return Math.min(100, s);
    };
    const topLeads = allLeads
      .filter(l => !['won','not_interested'].includes(l.status))
      .map(l => ({ ...l, score: scoreL(l) }))
      .sort((a,b) => b.score - a.score)
      .slice(0, 3);

    const date = new Date().toLocaleDateString('en-AU', {weekday:'long',day:'numeric',month:'long'});

    const html = `
<!DOCTYPE html><html><head><style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:20px;}
.wrap{max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5;}
.header{background:#0a0a0a;padding:24px 28px;color:#fff;}
.header h1{font-size:22px;font-weight:700;letter-spacing:4px;margin:0 0 4px;}
.header p{font-size:13px;color:#888;margin:0;}
.section{padding:20px 28px;border-bottom:1px solid #f0f0f0;}
.section h2{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#999;margin:0 0 12px;}
.stat-row{display:flex;gap:12px;flex-wrap:wrap;}
.stat{background:#f9f9f9;border-radius:8px;padding:12px 16px;flex:1;min-width:100px;}
.stat-val{font-size:22px;font-weight:700;color:#0a0a0a;}
.stat-lbl{font-size:11px;color:#999;margin-top:2px;}
.lead-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f5f5f5;}
.lead-row:last-child{border-bottom:none;}
.lead-name{font-size:13px;font-weight:500;}
.lead-co{font-size:11px;color:#999;margin-top:1px;}
.badge{font-size:10px;padding:2px 8px;border-radius:99px;font-weight:600;}
.badge-amber{background:#fef3c7;color:#92400e;}
.badge-green{background:#d1fae5;color:#065f46;}
.footer{padding:16px 28px;background:#f9f9f9;text-align:center;font-size:11px;color:#999;}
a{color:#0a0a0a;}
</style></head><body><div class="wrap">
<div class="header">
  <h1>OGM</h1>
  <p>Good morning, Oscar — here's your briefing for ${date}</p>
</div>
<div class="section">
  <h2>Revenue</h2>
  <div class="stat-row">
    <div class="stat"><div class="stat-val">${fmt(mrr)}</div><div class="stat-lbl">Monthly MRR</div></div>
    <div class="stat"><div class="stat-val">${fmt(pipeline)}</div><div class="stat-lbl">Pipeline</div></div>
    <div class="stat"><div class="stat-val">${fmt(mrr*12)}</div><div class="stat-lbl">ARR</div></div>
  </div>
</div>
<div class="section">
  <h2>Pipeline</h2>
  <div class="stat-row">
    <div class="stat"><div class="stat-val">${total}</div><div class="stat-lbl">Total leads</div></div>
    <div class="stat"><div class="stat-val">${contacted}</div><div class="stat-lbl">Contacted</div></div>
    <div class="stat"><div class="stat-val">${replied}</div><div class="stat-lbl">Replied</div></div>
    <div class="stat"><div class="stat-val">${meetings.length}</div><div class="stat-lbl">Meetings</div></div>
  </div>
</div>
${due.length ? `<div class="section">
  <h2>⚡ Follow up today (${due.length})</h2>
  ${due.map(l => `<div class="lead-row">
    <div><div class="lead-name">${l.firstName} ${l.lastName}</div><div class="lead-co">${l.company}</div></div>
    <span class="badge badge-amber">${l.status}</span>
  </div>`).join('')}
</div>` : ''}
${topLeads.length ? `<div class="section">
  <h2>🔥 Top leads today</h2>
  ${topLeads.map(l => `<div class="lead-row">
    <div><div class="lead-name">${l.firstName} ${l.lastName}</div><div class="lead-co">${l.company}</div></div>
    <span class="badge badge-green">Score ${l.score}</span>
  </div>`).join('')}
</div>` : ''}
<div class="footer">
  Oscar Green Media &nbsp;·&nbsp; <a href="https://ogm-outreach-production.up.railway.app">Open dashboard</a>
</div>
</div></body></html>`;

    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: smtpUser, pass: smtpPass } });
    await transporter.sendMail({
      from: `"Jarvis — OGM" <${smtpUser}>`,
      to: toEmail,
      subject: `☀️ Morning brief — ${date}`,
      html
    });
    console.log('[brief] Morning brief sent to', toEmail);
  } catch(e) {
    console.error('[brief] Failed to send morning brief:', e.message);
  }
}

// Morning brief at 7am Sydney time (9pm UTC)
cron.schedule('0 21 * * *', () => {
  console.log('[cron] Sending morning brief...');
  sendMorningBrief();
});

// Manual trigger
app.post('/api/morning-brief', requireWrite, async (req, res) => {
  try { await sendMorningBrief(); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GOOGLE CALENDAR ───────────────────────────────────────────────────────────
app.get('/api/calendar/events', async (req, res) => {
  try {
    const accessToken = await getGmailAccessToken();
    const { start, end } = req.query;
    const timeMin = start || new Date(Date.now() - 7 * 86400000).toISOString();
    const timeMax = end   || new Date(Date.now() + 60 * 86400000).toISOString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=100`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json({ events: d.items || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/calendar/events', requireWrite, async (req, res) => {
  try {
    const accessToken = await getGmailAccessToken();
    const event = req.body;
    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json({ ok: true, event: d });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/calendar/events/:eventId', requireWrite, async (req, res) => {
  try {
    const accessToken = await getGmailAccessToken();
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${req.params.eventId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json({ ok: true, event: d });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/calendar/events/:eventId', requireWrite, async (req, res) => {
  try {
    const accessToken = await getGmailAccessToken();
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${req.params.eventId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GOOGLE CALENDAR ───────────────────────────────────────────────────────────
app.get('/api/calendar/events', async (req, res) => {
  try {
    const accessToken = await getGmailAccessToken();
    const { start, end } = req.query;
    const calId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    const timeMin = start || new Date(Date.now() - 7 * 86400000).toISOString();
    const timeMax = end   || new Date(Date.now() + 60 * 86400000).toISOString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=50`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json({ events: d.items || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/calendar/events', async (req, res) => {
  try {
    const accessToken = await getGmailAccessToken();
    const calId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json({ ok: true, event: d });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/calendar/events/:eventId', async (req, res) => {
  try {
    const accessToken = await getGmailAccessToken();
    const calId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${req.params.eventId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── WEB SEARCH PROXY ─────────────────────────────────────────────────────────
// Uses DuckDuckGo instant answers API (free, no key needed)
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'No query provided' });

    // Use DuckDuckGo HTML search scraping via their API endpoint
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OGMOutreach/1.0)',
        'Accept': 'text/html'
      }
    });
    const html = await r.text();

    // Parse results from DuckDuckGo HTML
    const results = [];
    const resultRegex = /<a class="result__a" href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([^<]+)<\/a>/g;
    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < 8) {
      const url2 = match[1];
      const title = match[2].trim();
      const snippet = match[3].trim();
      if (url2 && title && !url2.includes('duckduckgo.com')) {
        results.push({ url: url2, title, snippet });
      }
    }

    // Fallback: try DuckDuckGo instant answer API
    if (!results.length) {
      const iaUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
      const iaR = await fetch(iaUrl);
      const iaD = await iaR.json();
      if (iaD.AbstractText) {
        results.push({ title: iaD.Heading || q, snippet: iaD.AbstractText, url: iaD.AbstractURL || '' });
      }
      if (iaD.RelatedTopics) {
        for (const t of iaD.RelatedTopics.slice(0, 4)) {
          if (t.Text && t.FirstURL) results.push({ title: t.Text.split(' - ')[0], snippet: t.Text, url: t.FirstURL });
        }
      }
    }

    res.json({ results, query: q });
  } catch(e) {
    console.error('[search] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ANTHROPIC PROXY (for Jarvis) ─────────────────────────────────────────────
// Simple in-memory rate limit: max 30 calls per minute
const jarvisRateLimit = { count: 0, resetAt: Date.now() + 60000 };
app.post('/api/jarvis/chat', async (req, res) => {
  try {
    // Rate limit check
    if (Date.now() > jarvisRateLimit.resetAt) {
      jarvisRateLimit.count = 0;
      jarvisRateLimit.resetAt = Date.now() + 60000;
    }
    if (jarvisRateLimit.count >= 30) {
      return res.status(429).json({ error: 'Rate limit reached — please wait a moment.' });
    }
    jarvisRateLimit.count++;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set in Railway environment variables.' });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const d = await r.json();
    if (d.error) console.error('[jarvis] Anthropic error:', JSON.stringify(d.error));
    res.json(d);
  } catch(e) {
    console.error('[jarvis] Proxy error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GMAIL OAUTH ───────────────────────────────────────────────────────────────
const GMAIL_CLIENT_ID     = process.env.GMAIL_CLIENT_ID     || '';
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const GMAIL_REDIRECT_URI  = process.env.GMAIL_REDIRECT_URI  || '';
const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar';

// Store tokens in DB
async function getGmailTokens() {
  try {
    const r = await query(`SELECT value FROM config WHERE key='gmail_tokens'`);
    if (r.rows.length) return JSON.parse(r.rows[0].value);
  } catch(e) {}
  return null;
}
async function saveGmailTokens(tokens) {
  await query(`INSERT INTO config (key,value) VALUES ('gmail_tokens',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(tokens)]);
}

// Refresh access token using refresh token
async function refreshGmailToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Failed to refresh token: ' + JSON.stringify(d));
  return d.access_token;
}

// Get a valid access token (refresh if needed)
async function getGmailAccessToken() {
  const tokens = await getGmailTokens();
  if (!tokens) throw new Error('Gmail not connected. Visit /api/gmail/auth to connect.');
  // Check if expired (with 5 min buffer)
  if (tokens.expires_at && Date.now() < tokens.expires_at - 300000) {
    return tokens.access_token;
  }
  // Refresh
  const newToken = await refreshGmailToken(tokens.refresh_token);
  tokens.access_token = newToken;
  tokens.expires_at = Date.now() + 3500 * 1000;
  await saveGmailTokens(tokens);
  return newToken;
}

// Step 1: Redirect to Google OAuth
app.get('/api/gmail/auth', (req, res) => {
  if (!GMAIL_CLIENT_ID) return res.status(400).send('GMAIL_CLIENT_ID not configured.');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
    client_id: GMAIL_CLIENT_ID,
    redirect_uri: GMAIL_REDIRECT_URI,
    response_type: 'code',
    scope: GMAIL_SCOPES,
    access_type: 'offline',
    prompt: 'consent'
  });
  res.redirect(url);
});

// Step 2: Handle OAuth callback
app.get('/api/gmail/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`OAuth error: ${error}`);
  if (!code) return res.send('No code received.');
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GMAIL_CLIENT_ID,
        client_secret: GMAIL_CLIENT_SECRET,
        redirect_uri: GMAIL_REDIRECT_URI,
        grant_type: 'authorization_code',
        code
      })
    });
    const tokens = await r.json();
    if (!tokens.access_token) return res.send('Failed to get tokens: ' + JSON.stringify(tokens));
    tokens.expires_at = Date.now() + (tokens.expires_in || 3500) * 1000;
    await saveGmailTokens(tokens);
    console.log('[gmail] OAuth connected successfully.');
    res.send(`<html><body style="font-family:sans-serif;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>✓ Gmail connected!</h2><p style="color:#71717a;">You can close this tab and return to your dashboard.</p><a href="/" style="color:#fff;">Return to dashboard →</a></div></body></html>`);
  } catch(e) {
    res.send('Error: ' + e.message);
  }
});

// Gmail connection status
app.get('/api/gmail/status', async (req, res) => {
  const tokens = await getGmailTokens();
  res.json({ connected: !!tokens });
});

// Core scan function (reused by endpoint and cron)
async function scanGmailForReplies() {
  const accessToken = await getGmailAccessToken();
  const leadsRes = await query(`SELECT id, "firstName", "lastName", company, contact, "hunterEmail", status FROM leads WHERE status NOT IN ('won','not_interested')`);
  const allLeads = leadsRes.rows;
  if (!allLeads.length) return { replies: [], updated: 0 };

  const leadEmails = new Map();
  for (const l of allLeads) {
    if (l.hunterEmail) leadEmails.set(l.hunterEmail.toLowerCase(), l);
    if (l.contact && l.contact.includes('@')) leadEmails.set(l.contact.toLowerCase(), l);
  }

  const since = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=after:${since} in:inbox&maxResults=50`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const listData = await listRes.json();
  if (!listData.messages) return { replies: [], updated: 0 };

  const replies = [];
  let updated = 0;

  for (const msg of listData.messages.slice(0, 20)) {
    const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const msgData = await msgRes.json();
    const headers = msgData.payload?.headers || [];
    const from    = headers.find(h => h.name === 'From')?.value    || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const date    = headers.find(h => h.name === 'Date')?.value    || '';

    const emailMatch = from.match(/<([^>]+)>/) || from.match(/([^\s]+@[^\s]+)/);
    const fromEmail  = emailMatch ? emailMatch[1].toLowerCase() : from.toLowerCase();
    const matchedLead = leadEmails.get(fromEmail);
    if (!matchedLead) continue;

    replies.push({ leadId: matchedLead.id, leadName: `${matchedLead.firstName} ${matchedLead.lastName}`, company: matchedLead.company, from, subject, date, messageId: msg.id });

    if (['contacted','followup1_sent','followup2_sent'].includes(matchedLead.status)) {
      await query(`UPDATE leads SET status='replied', "updatedAt"=$1 WHERE id=$2`, [now(), matchedLead.id]);
      const tRes = await query(`SELECT timeline FROM leads WHERE id=$1`, [matchedLead.id]);
      const timeline = JSON.parse(tRes.rows[0]?.timeline || '[]');
      timeline.push({ ts: new Date().toISOString(), type: 'reply', text: `Reply detected: "${subject}"` });
      await query(`UPDATE leads SET timeline=$1 WHERE id=$2`, [JSON.stringify(timeline), matchedLead.id]);
      updated++;
      console.log(`[gmail] Reply from ${matchedLead.firstName} ${matchedLead.lastName} — marked replied.`);
    }
  }
  return { replies, updated, scanned: listData.messages.length };
}

// Scan inbox for replies from leads
app.get('/api/gmail/scan', async (req, res) => {
  try {
    const result = await scanGmailForReplies();
    res.json(result);
  } catch(e) {
    console.error('[gmail] Scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Session role check (used by client to detect guest mode)
app.get('/api/session-role', (req, res) => {
  const token = parseCookies(req).ogm_session;
  const role = getSessionRole(token) || 'admin';
  res.json({ role });
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const tokens = await getGmailTokens().catch(() => null);
  res.json({ ok: true, ts: now(), hunterConfigured: !!hunterKey(), db: 'postgres', anthropicConfigured: !!process.env.ANTHROPIC_API_KEY, gmailConnected: !!tokens });
});

// Auto-scan Gmail for replies every hour
cron.schedule('0 * * * *', async () => {
  console.log('[cron] Scanning Gmail for replies...');
  try {
    const tokens = await getGmailTokens();
    if (!tokens) { console.log('[cron] Gmail not connected — skipping scan.'); return; }
    await scanGmailForReplies();
  } catch(e) { console.error('[cron] Gmail scan error:', e.message); }
});

// ── SERVE APP ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const filePath = path.join(__dirname, 'OGM_Outreach.html');
  if (!fs.existsSync(filePath)) return res.status(404).send('OGM_Outreach.html not found.');
  try {
    const html = fs.readFileSync(filePath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

// ── START ─────────────────────────────────────────────────────────────────────
setupSchema().then(() => {
  addJarvisEndpoints(app);
  app.listen(PORT, () => console.log(`OGM backend running on port ${PORT}`));
}).catch(e => {
  console.error('Failed to set up schema:', e.message);
  process.exit(1);
});
