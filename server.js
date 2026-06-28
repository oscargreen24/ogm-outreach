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
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL
    )
  `);
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
  app.post('/api/jarvis/memory', async (req, res) => {
    try {
      const { role, content } = req.body;
      await query(`INSERT INTO jarvis_memory (role, content, "createdAt") VALUES ($1,$2,$3)`,
        [role, content, new Date().toISOString()]);
      await query(`DELETE FROM jarvis_memory WHERE id NOT IN (SELECT id FROM jarvis_memory ORDER BY id DESC LIMIT 40)`);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/jarvis/memory', async (req, res) => {
    try {
      await query('DELETE FROM jarvis_memory');
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────
const AUTH_USER      = process.env.AUTH_USER      || 'oscar@oscargreenmedia.com';
const AUTH_PASS      = process.env.AUTH_PASS      || 'Chucky24';
const SESSION_SECRET = process.env.SESSION_SECRET || 'ogm-default-secret-change-me';
const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expires: Date.now() + 1 * 24 * 60 * 60 * 1000 });
  return token;
}
function isValidSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expires) { sessions.delete(token); return false; }
  return true;
}
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
  if (isValidSession(parseCookies(req).ogm_session)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login');
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
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
<label>Email</label><input type="email" id="u" placeholder="oscar@oscargreenmedia.com" autocomplete="username"/>
<label>Password</label><input type="password" id="p" placeholder="••••••••" autocomplete="current-password"/>
<button type="submit" id="btn">Sign in</button>
</form></div>
<script>async function login(e){e.preventDefault();const btn=document.getElementById('btn');btn.textContent='Signing in...';btn.disabled=true;document.getElementById('err').style.display='none';const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})});const d=await r.json();if(d.ok){window.location.href='/';}else{document.getElementById('err').style.display='block';btn.textContent='Sign in';btn.disabled=false;}}</script>
</body></html>`);
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === AUTH_USER && password === AUTH_PASS) {
    const token = createSession();
    res.setHeader('Set-Cookie', `ogm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${1 * 24 * 60 * 60}`);
    return res.json({ ok: true });
  }
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

app.post('/api/leads', async (req, res) => {
  try {
    const l = req.body;
    await query(`
      INSERT INTO leads (id,"firstName","lastName",company,website,industry,channel,contact,
        "hunterEmail",notes,"researchNotes","companyDesc",status,"reelId","monthlyValue",
        timeline,"contactedDate","followup1SentDate","followup2SentDate","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT (id) DO NOTHING
    `, [l.id,l.firstName||'',l.lastName||'',l.company||'',l.website||'',l.industry||'',
        l.channel||'email',l.contact||'',l.hunterEmail||'',l.notes||'',l.researchNotes||'',
        l.companyDesc||'',l.status||'new',l.reelId||'',l.monthlyValue||0,
        l.timeline||'[]',l.contactedDate||null,l.followup1SentDate||null,
        l.followup2SentDate||null,l.createdAt||now(),now()]);
    res.json({ ok: true, id: l.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/leads/:id', async (req, res) => {
  try {
    const l = req.body;
    const r = await query(`
      UPDATE leads SET "firstName"=$1,"lastName"=$2,company=$3,website=$4,industry=$5,
        channel=$6,contact=$7,"hunterEmail"=$8,notes=$9,"researchNotes"=$10,"companyDesc"=$11,
        status=$12,"reelId"=$13,"monthlyValue"=$14,timeline=$15,"contactedDate"=$16,
        "followup1SentDate"=$17,"followup2SentDate"=$18,"updatedAt"=$19
      WHERE id=$20
    `, [l.firstName||'',l.lastName||'',l.company||'',l.website||'',l.industry||'',
        l.channel||'email',l.contact||'',l.hunterEmail||'',l.notes||'',l.researchNotes||'',
        l.companyDesc||'',l.status||'new',l.reelId||'',l.monthlyValue||0,
        l.timeline||'[]',l.contactedDate||null,l.followup1SentDate||null,
        l.followup2SentDate||null,now(),req.params.id]);
    if (r.rowCount === 0) {
      await query(`
        INSERT INTO leads (id,"firstName","lastName",company,website,industry,channel,contact,
          "hunterEmail",notes,"researchNotes","companyDesc",status,"reelId","monthlyValue",
          timeline,"contactedDate","followup1SentDate","followup2SentDate","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      `, [req.params.id,l.firstName||'',l.lastName||'',l.company||'',l.website||'',l.industry||'',
          l.channel||'email',l.contact||'',l.hunterEmail||'',l.notes||'',l.researchNotes||'',
          l.companyDesc||'',l.status||'new',l.reelId||'',l.monthlyValue||0,
          l.timeline||'[]',l.contactedDate||null,l.followup1SentDate||null,
          l.followup2SentDate||null,l.createdAt||now(),now()]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    await query('DELETE FROM leads WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads/bulk', async (req, res) => {
  try {
    const { leads } = req.body;
    let added = 0;
    for (const l of leads || []) {
      const r = await query(`
        INSERT INTO leads (id,"firstName","lastName",company,website,industry,channel,contact,
          "hunterEmail",notes,"researchNotes","companyDesc",status,"reelId","monthlyValue",
          timeline,"contactedDate","followup1SentDate","followup2SentDate","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        ON CONFLICT (id) DO NOTHING
      `, [l.id,l.firstName||'',l.lastName||'',l.company||'',l.website||'',l.industry||'',
          l.channel||'email',l.contact||'',l.hunterEmail||'',l.notes||'',l.researchNotes||'',
          l.companyDesc||'',l.status||'new',l.reelId||'',l.monthlyValue||0,
          l.timeline||'[]',l.contactedDate||null,l.followup1SentDate||null,
          l.followup2SentDate||null,l.createdAt||now(),now()]);
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

// ── EMAIL ─────────────────────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
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

app.put('/api/config', async (req, res) => {
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

app.post('/api/bookings', async (req, res) => {
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

app.delete('/api/bookings/:id', async (req, res) => {
  try {
    await query('DELETE FROM bookings WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AUTO LEAD GENERATION ──────────────────────────────────────────────────────
const COMPANIES = {
  corporate: [
    {name:'Barrenjoey',domain:'barrenjoey.com'},{name:'Pitcher Partners Sydney',domain:'pitcher.com.au'},
    {name:'Wilsons Advisory',domain:'wilsonsadvisory.com.au'},{name:'Prime Financial Group',domain:'primefinancial.com.au'},
    {name:'Shaw and Partners',domain:'shaw.com.au'},{name:'Morgans Financial',domain:'morgans.com.au'},
    {name:'Perpetual',domain:'perpetual.com.au'},{name:'Equity Trustees',domain:'eqt.com.au'},
    {name:'Clime Investment Management',domain:'clime.com.au'},{name:'FIIG Securities',domain:'fiig.com.au'},
    {name:'Centennial Asset Management',domain:'centennial.com.au'},{name:'Macquarie Group',domain:'macquarie.com'},
  ],
  realestate: [
    {name:'Ray White Sydney',domain:'raywhite.com'},{name:'McGrath Estate Agents',domain:'mcgrath.com.au'},
    {name:'Belle Property',domain:'belleproperty.com'},{name:'LJ Hooker',domain:'ljhooker.com.au'},
    {name:'Stone Real Estate',domain:'stonerealestategroup.com.au'},{name:'The Agency',domain:'theagency.com.au'},
    {name:'Raine & Horne',domain:'raineandhorne.com.au'},{name:'Century 21',domain:'century21.com.au'},
    {name:'Laing+Simmons',domain:'laingandsimmons.com.au'},{name:'Domain',domain:'domain.com.au'},
  ],
  construction: [
    {name:'Multiplex',domain:'multiplex.global'},{name:'Lendlease',domain:'lendlease.com'},
    {name:'John Holland',domain:'johnholland.com.au'},{name:'Buildcorp',domain:'buildcorp.com.au'},
    {name:'Hansen Yuncken',domain:'hansenyuncken.com.au'},{name:'Mirvac',domain:'mirvac.com'},
    {name:'Richard Crookes Constructions',domain:'richardcrookes.com.au'},{name:'Probuild',domain:'probuild.com.au'},
    {name:'Watpac',domain:'watpac.com.au'},{name:'Built',domain:'built.com.au'},
  ],
  automotive: [
    {name:'Eagers Automotive',domain:'eagersautomotive.com.au'},{name:'Peter Warren Automotive',domain:'peterwarren.com.au'},
    {name:'Trivett',domain:'trivett.com.au'},{name:'Dutton Garage',domain:'duttongarage.com.au'},
    {name:'Autopact',domain:'autopact.com.au'},{name:'Inchcape Australia',domain:'inchcape.com.au'},
    {name:'Melbourne City Motors',domain:'melbournecitymotors.com.au'},{name:'Giltrap Group',domain:'giltrap.co.nz'},
    {name:'CMI Toyota',domain:'cmitoyota.com.au'},{name:'Ateco Automotive',domain:'ateco.com.au'},
  ],
};

const RELEVANT_TITLES = {
  corporate:    ['marketing','brand','communications','content','social','digital','media','director','cmo','head of'],
  realestate:   ['principal','director','agent','marketing','brand','sales','head of','manager'],
  construction: ['marketing','communications','brand','business development','director','cmo','head of'],
  automotive:   ['marketing','brand','digital','social','dealer','principal','sales','director','head of'],
};

function isRelevantTitle(position, industry) {
  if (!position) return true;
  const p = position.toLowerCase();
  return (RELEVANT_TITLES[industry] || []).some(t => p.includes(t));
}

async function generateLeads() {
  const key = hunterKey();
  if (!key) { console.log('[scheduler] No Hunter key.'); return 0; }
  let totalAdded = 0;
  for (const [industry, companies] of Object.entries(COMPANIES)) {
    for (const co of companies) {
      try {
        await new Promise(r => setTimeout(r, 400));
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
              timeline,"contactedDate","followup1SentDate","followup2SentDate","createdAt","updatedAt")
            VALUES ($1,$2,$3,$4,$5,$6,'email',$7,$7,$8,'','','new','',0,'[]',null,null,null,$9,$9)
          `, [uid(),e.first_name||'',e.last_name||'',co.name,co.domain,industry,e.value,
              e.position?`Title: ${e.position}`:'',now()]);
          totalAdded++;
        }
      } catch(e) { console.error(`[scheduler] Error on ${co.name}:`, e.message); }
    }
  }
  console.log(`[scheduler] Added ${totalAdded} leads.`);
  return totalAdded;
}

app.post('/api/generate-leads', async (req, res) => {
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

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  res.json({ ok: true, ts: now(), hunterConfigured: !!hunterKey(), db: 'postgres' });
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

app.get('/debug-files', (req, res) => {
  res.json({ files: fs.readdirSync(__dirname), cwd: __dirname });
});

// ── START ─────────────────────────────────────────────────────────────────────
setupSchema().then(() => {
  addJarvisEndpoints(app);
  app.listen(PORT, () => console.log(`OGM backend running on port ${PORT}`));
}).catch(e => {
  console.error('Failed to set up schema:', e.message);
  process.exit(1);
});
