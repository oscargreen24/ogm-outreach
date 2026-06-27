const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const Database   = require('better-sqlite3');
const nodemailer = require('nodemailer');
const cron       = require('node-cron');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Database setup ────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'ogm.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id                TEXT PRIMARY KEY,
    firstName         TEXT NOT NULL DEFAULT '',
    lastName          TEXT NOT NULL DEFAULT '',
    company           TEXT NOT NULL DEFAULT '',
    website           TEXT DEFAULT '',
    industry          TEXT DEFAULT '',
    channel           TEXT DEFAULT 'email',
    contact           TEXT DEFAULT '',
    hunterEmail       TEXT DEFAULT '',
    notes             TEXT DEFAULT '',
    researchNotes     TEXT DEFAULT '',
    companyDesc       TEXT DEFAULT '',
    status            TEXT DEFAULT 'new',
    reelId            TEXT DEFAULT '',
    contactedDate     TEXT DEFAULT NULL,
    followup1SentDate TEXT DEFAULT NULL,
    followup2SentDate TEXT DEFAULT NULL,
    createdAt         TEXT NOT NULL,
    updatedAt         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS send_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    leadId    TEXT NOT NULL,
    touch     INTEGER NOT NULL,
    channel   TEXT NOT NULL,
    sentAt    TEXT NOT NULL,
    subject   TEXT DEFAULT '',
    preview   TEXT DEFAULT ''
  );
`);

// ── Helpers ───────────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();

const hunterKey = () => process.env.HUNTER_API_KEY || '';

// ── LEADS ─────────────────────────────────────────────────────────────────────

// GET all leads
app.get('/api/leads', (req, res) => {
  try {
    const leads = db.prepare('SELECT * FROM leads ORDER BY createdAt DESC').all();
    res.json({ leads });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST create lead
app.post('/api/leads', (req, res) => {
  try {
    const l = req.body;
    db.prepare(`
      INSERT INTO leads (id,firstName,lastName,company,website,industry,channel,contact,
        hunterEmail,notes,researchNotes,companyDesc,status,reelId,contactedDate,
        followup1SentDate,followup2SentDate,createdAt,updatedAt)
      VALUES (@id,@firstName,@lastName,@company,@website,@industry,@channel,@contact,
        @hunterEmail,@notes,@researchNotes,@companyDesc,@status,@reelId,@contactedDate,
        @followup1SentDate,@followup2SentDate,@createdAt,@updatedAt)
    `).run({ ...l, updatedAt: now(), createdAt: l.createdAt || now() });
    res.json({ ok: true, id: l.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT update lead
app.put('/api/leads/:id', (req, res) => {
  try {
    const l = { ...req.body, id: req.params.id, updatedAt: now() };
    db.prepare(`
      UPDATE leads SET
        firstName=@firstName, lastName=@lastName, company=@company, website=@website,
        industry=@industry, channel=@channel, contact=@contact, hunterEmail=@hunterEmail,
        notes=@notes, researchNotes=@researchNotes, companyDesc=@companyDesc,
        status=@status, reelId=@reelId, contactedDate=@contactedDate,
        followup1SentDate=@followup1SentDate, followup2SentDate=@followup2SentDate,
        updatedAt=@updatedAt
      WHERE id=@id
    `).run(l);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE lead
app.delete('/api/leads/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM leads WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST bulk upsert (for CSV import)
app.post('/api/leads/bulk', (req, res) => {
  try {
    const { leads } = req.body;
    const upsert = db.prepare(`
      INSERT INTO leads (id,firstName,lastName,company,website,industry,channel,contact,
        hunterEmail,notes,researchNotes,companyDesc,status,reelId,contactedDate,
        followup1SentDate,followup2SentDate,createdAt,updatedAt)
      VALUES (@id,@firstName,@lastName,@company,@website,@industry,@channel,@contact,
        @hunterEmail,@notes,@researchNotes,@companyDesc,@status,@reelId,@contactedDate,
        @followup1SentDate,@followup2SentDate,@createdAt,@updatedAt)
      ON CONFLICT(id) DO NOTHING
    `);
    const insertMany = db.transaction((rows) => {
      let added = 0;
      for (const l of rows) {
        const info = upsert.run({ ...l, updatedAt: now(), createdAt: l.createdAt || now() });
        if (info.changes) added++;
      }
      return added;
    });
    const added = insertMany(leads || []);
    res.json({ ok: true, added });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HUNTER PROXY ──────────────────────────────────────────────────────────────
// Key never leaves the server

// Domain search (Find Leads)
app.get('/api/hunter/domain', async (req, res) => {
  try {
    const key = hunterKey();
    if (!key) return res.status(400).json({ error: 'Hunter API key not configured on server.' });
    const { domain, limit = 10 } = req.query;
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${key}&limit=${limit}`;
    const r = await fetch(url);
    const d = await r.json();
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Email finder (single lead lookup)
app.get('/api/hunter/find', async (req, res) => {
  try {
    const key = hunterKey();
    if (!key) return res.status(400).json({ error: 'Hunter API key not configured on server.' });
    const { domain, first_name, last_name } = req.query;
    const url = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first_name||'')}&last_name=${encodeURIComponent(last_name||'')}&api_key=${key}`;
    const r = await fetch(url);
    const d = await r.json();
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Hunter account info (quota check)
app.get('/api/hunter/account', async (req, res) => {
  try {
    const key = hunterKey();
    if (!key) return res.status(400).json({ error: 'Hunter API key not configured on server.' });
    const r = await fetch(`https://api.hunter.io/v2/account?api_key=${key}`);
    const d = await r.json();
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── EMAIL SENDING ─────────────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  try {
    const { to, subject, body, leadId, touch } = req.body;

    // Validate env vars
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    if (!smtpUser || !smtpPass) {
      return res.status(400).json({ error: 'SMTP credentials not configured. Add SMTP_USER and SMTP_PASS to Railway environment variables.' });
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: smtpUser, pass: smtpPass }
    });

    await transporter.sendMail({
      from: `"${process.env.SENDER_NAME || 'Oscar Green'}" <${smtpUser}>`,
      to,
      subject,
      text: body,
    });

    // Log the send
    db.prepare(`
      INSERT INTO send_log (leadId, touch, channel, sentAt, subject, preview)
      VALUES (?, ?, 'email', ?, ?, ?)
    `).run(leadId, touch, now(), subject, body.slice(0, 120));

    // Auto-update lead status
    if (leadId) {
      const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
      if (lead) {
        const updates = { id: leadId, updatedAt: now() };
        if (touch === 1 && !lead.contactedDate) {
          db.prepare('UPDATE leads SET status=?, contactedDate=?, updatedAt=? WHERE id=?')
            .run('contacted', now().slice(0,10), now(), leadId);
        } else if (touch === 2) {
          db.prepare('UPDATE leads SET status=?, followup1SentDate=?, updatedAt=? WHERE id=?')
            .run('followup1_sent', now().slice(0,10), now(), leadId);
        } else if (touch === 3) {
          db.prepare('UPDATE leads SET status=?, followup2SentDate=?, updatedAt=? WHERE id=?')
            .run('followup2_sent', now().slice(0,10), now(), leadId);
        }
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send log for a lead
app.get('/api/send_log/:leadId', (req, res) => {
  try {
    const logs = db.prepare('SELECT * FROM send_log WHERE leadId=? ORDER BY sentAt DESC').all(req.params.leadId);
    res.json({ logs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CONFIG (reels, portfolios, settings) ──────────────────────────────────────
app.get('/api/config', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM config').all();
    const cfg = {};
    rows.forEach(r => { try { cfg[r.key] = JSON.parse(r.value); } catch { cfg[r.key] = r.value; } });
    res.json({ config: cfg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/config', (req, res) => {
  try {
    const upsert = db.prepare('INSERT INTO config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    const saveMany = db.transaction((obj) => {
      for (const [k, v] of Object.entries(obj)) {
        upsert.run(k, JSON.stringify(v));
      }
    });
    saveMany(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: now(), hunterConfigured: !!hunterKey() });
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
  if (!position) return true; // include if no title info
  const p = position.toLowerCase();
  return (RELEVANT_TITLES[industry] || []).some(t => p.includes(t));
}

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36).slice(-4);

async function generateLeads() {
  const key = hunterKey();
  if (!key) { console.log('[scheduler] No Hunter key — skipping.'); return; }

  let totalAdded = 0;
  const runAt = new Date().toISOString();
  console.log(`[scheduler] Starting lead generation run at ${runAt}`);

  for (const [industry, companies] of Object.entries(COMPANIES)) {
    for (const co of companies) {
      try {
        await new Promise(r => setTimeout(r, 400)); // rate limit
        const r = await fetch(
          `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(co.domain)}&api_key=${key}&limit=10`
        );
        const d = await r.json();
        if (!d.data || !d.data.emails) continue;

        for (const e of d.data.emails) {
          if (!isRelevantTitle(e.position, industry)) continue;
          if (!e.value) continue;

          // Deduplicate by email address
          const exists = db.prepare(
            'SELECT id FROM leads WHERE contact=? OR hunterEmail=?'
          ).get(e.value, e.value);
          if (exists) continue;

          const lead = {
            id:               uid(),
            firstName:        e.first_name  || '',
            lastName:         e.last_name   || '',
            company:          co.name,
            website:          co.domain,
            industry,
            channel:          'email',
            contact:          e.value,
            hunterEmail:      e.value,
            notes:            e.position ? `Title: ${e.position}` : '',
            researchNotes:    '',
            companyDesc:      '',
            status:           'new',
            reelId:           '',
            contactedDate:    null,
            followup1SentDate:null,
            followup2SentDate:null,
            createdAt:        new Date().toISOString(),
            updatedAt:        new Date().toISOString(),
          };

          db.prepare(`
            INSERT INTO leads (id,firstName,lastName,company,website,industry,channel,contact,
              hunterEmail,notes,researchNotes,companyDesc,status,reelId,contactedDate,
              followup1SentDate,followup2SentDate,createdAt,updatedAt)
            VALUES (@id,@firstName,@lastName,@company,@website,@industry,@channel,@contact,
              @hunterEmail,@notes,@researchNotes,@companyDesc,@status,@reelId,@contactedDate,
              @followup1SentDate,@followup2SentDate,@createdAt,@updatedAt)
          `).run(lead);
          totalAdded++;
        }
      } catch (e) {
        console.error(`[scheduler] Error on ${co.name}:`, e.message);
      }
    }
  }

  console.log(`[scheduler] Run complete — ${totalAdded} new leads added.`);
  return totalAdded;
}

// ── Manual trigger endpoint (so you can also run it on demand) ────────────────
app.post('/api/generate-leads', async (req, res) => {
  try {
    const added = await generateLeads();
    res.json({ ok: true, added });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Last run status
app.get('/api/generate-leads/status', (req, res) => {
  try {
    const count = db.prepare('SELECT COUNT(*) as n FROM leads').get();
    res.json({ totalLeads: count.n, hunterConfigured: !!hunterKey() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cron schedule: 7am and 7pm Sydney time (AEDT = UTC+11, AEST = UTC+10) ────
// Using UTC: 8pm and 8am UTC covers both AEST (UTC+10) and AEDT (UTC+11)
// 7am AEST = 9pm UTC previous day  → cron: 0 21 * * *
// 7pm AEST = 9am UTC               → cron: 0 9 * * *
cron.schedule('0 21 * * *', () => {
  console.log('[cron] 7am Sydney — running lead generation...');
  generateLeads();
});
cron.schedule('0 9 * * *', () => {
  console.log('[cron] 7pm Sydney — running lead generation...');
  generateLeads();
});

console.log('[scheduler] Lead generation scheduled for 7am and 7pm Sydney time.');

// ── SERVE THE OUTREACH TOOL ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  // Try several possible locations
  const candidates = [
    path.join(__dirname, 'OGM_Outreach.html'),
    path.join(__dirname, 'ogm_outreach.html'),
    path.join(__dirname, 'public', 'OGM_Outreach.html'),
    path.join(__dirname, 'client', 'OGM_Outreach.html'),
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (found) {
    res.sendFile(found);
  } else {
    // List what IS in the directory to help debug
    const files = fs.readdirSync(__dirname).join(', ');
    res.status(404).send(`OGM_Outreach.html not found. Files in root: ${files}`);
  }
});

// Debug: list all files in root (remove after confirming it works)
app.get('/debug-files', (req, res) => {
  const files = fs.readdirSync(__dirname);
  res.json({ files, cwd: __dirname });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`OGM backend running on port ${PORT}`));
