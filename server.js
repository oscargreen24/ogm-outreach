const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const Database   = require('better-sqlite3');
const nodemailer = require('nodemailer');
const cron       = require('node-cron');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Auth config (set these in Railway environment variables) ──────────────────
const AUTH_USER     = process.env.AUTH_USER     || 'oscar@oscargreenmedia.com';
const AUTH_PASS     = process.env.AUTH_PASS     || 'Chucky24';
const SESSION_SECRET = process.env.SESSION_SECRET || 'ogm-default-secret-change-me';

// In-memory session store (simple, works for single-user)
const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 1 * 24 * 60 * 60 * 1000; // 1 day
  sessions.set(token, { expires });
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expires) { sessions.delete(token); return false; }
  return true;
}

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) rc.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    list[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('=').trim());
  });
  return list;
}

// Auth middleware — protects all routes except /login and /api/login
function requireAuth(req, res, next) {
  // Always allow login endpoints
  if (req.path === '/login' || req.path === '/api/login') return next();
  // Allow health check without auth
  if (req.path === '/api/health') return next();
  // Check session cookie
  const cookies = parseCookies(req);
  if (isValidSession(cookies.ogm_session)) return next();
  // Not authenticated — redirect to login for HTML, 401 for API
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(requireAuth);

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
    monthlyValue      REAL DEFAULT 0,
    timeline          TEXT DEFAULT '[]',
    contactedDate     TEXT DEFAULT NULL,
    followup1SentDate TEXT DEFAULT NULL,
    followup2SentDate TEXT DEFAULT NULL,
    createdAt         TEXT NOT NULL,
    updatedAt         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id            TEXT PRIMARY KEY,
    googleEventId TEXT UNIQUE,
    firstName     TEXT DEFAULT '',
    lastName      TEXT DEFAULT '',
    email         TEXT DEFAULT '',
    company       TEXT DEFAULT '',
    shootType     TEXT DEFAULT '',
    budget        TEXT DEFAULT '',
    startTime     TEXT DEFAULT '',
    endTime       TEXT DEFAULT '',
    notes         TEXT DEFAULT '',
    status        TEXT DEFAULT 'confirmed',
    leadId        TEXT DEFAULT '',
    createdAt     TEXT NOT NULL
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
        hunterEmail,notes,researchNotes,companyDesc,status,reelId,monthlyValue,timeline,contactedDate,
        followup1SentDate,followup2SentDate,createdAt,updatedAt)
      VALUES (@id,@firstName,@lastName,@company,@website,@industry,@channel,@contact,
        @hunterEmail,@notes,@researchNotes,@companyDesc,@status,@reelId,@monthlyValue,@timeline,@contactedDate,
        @followup1SentDate,@followup2SentDate,@createdAt,@updatedAt)
    `).run({ ...l, updatedAt: now(), createdAt: l.createdAt || now() });
    res.json({ ok: true, id: l.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT update lead (upserts — creates if doesn't exist)
app.put('/api/leads/:id', (req, res) => {
  try {
    const l = { ...req.body, id: req.params.id, updatedAt: now() };
    // Try update first
    const info = db.prepare(`
      UPDATE leads SET
        firstName=@firstName, lastName=@lastName, company=@company, website=@website,
        industry=@industry, channel=@channel, contact=@contact, hunterEmail=@hunterEmail,
        notes=@notes, researchNotes=@researchNotes, companyDesc=@companyDesc,
        status=@status, reelId=@reelId, monthlyValue=@monthlyValue, timeline=@timeline,
        contactedDate=@contactedDate,
        followup1SentDate=@followup1SentDate, followup2SentDate=@followup2SentDate,
        updatedAt=@updatedAt
      WHERE id=@id
    `).run(l);
    // If nothing was updated, insert it
    if (info.changes === 0) {
      db.prepare(`
        INSERT INTO leads (id,firstName,lastName,company,website,industry,channel,contact,
          hunterEmail,notes,researchNotes,companyDesc,status,reelId,monthlyValue,timeline,contactedDate,
          followup1SentDate,followup2SentDate,createdAt,updatedAt)
        VALUES (@id,@firstName,@lastName,@company,@website,@industry,@channel,@contact,
          @hunterEmail,@notes,@researchNotes,@companyDesc,@status,@reelId,@monthlyValue,@timeline,@contactedDate,
          @followup1SentDate,@followup2SentDate,@createdAt,@updatedAt)
      `).run({ ...l, createdAt: l.createdAt || now() });
    }
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
        hunterEmail,notes,researchNotes,companyDesc,status,reelId,monthlyValue,timeline,contactedDate,
        followup1SentDate,followup2SentDate,createdAt,updatedAt)
      VALUES (@id,@firstName,@lastName,@company,@website,@industry,@channel,@contact,
        @hunterEmail,@notes,@researchNotes,@companyDesc,@status,@reelId,@monthlyValue,@timeline,@contactedDate,
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

// ── BOOKINGS ──────────────────────────────────────────────────────────────────

// GET all bookings
app.get('/api/bookings', (req, res) => {
  try {
    const bookings = db.prepare('SELECT * FROM bookings ORDER BY startTime ASC').all();
    res.json({ bookings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST create booking manually
app.post('/api/bookings', (req, res) => {
  try {
    const b = req.body;
    const id = b.id || uid();
    db.prepare(`
      INSERT INTO bookings (id,googleEventId,firstName,lastName,email,company,shootType,
        budget,startTime,endTime,notes,status,leadId,createdAt)
      VALUES (@id,@googleEventId,@firstName,@lastName,@email,@company,@shootType,
        @budget,@startTime,@endTime,@notes,@status,@leadId,@createdAt)
      ON CONFLICT(googleEventId) DO UPDATE SET
        firstName=excluded.firstName, lastName=excluded.lastName,
        email=excluded.email, company=excluded.company,
        startTime=excluded.startTime, endTime=excluded.endTime,
        status=excluded.status
    `).run({
      id, googleEventId: b.googleEventId||null, firstName: b.firstName||'',
      lastName: b.lastName||'', email: b.email||'', company: b.company||'',
      shootType: b.shootType||'', budget: b.budget||'',
      startTime: b.startTime||'', endTime: b.endTime||'',
      notes: b.notes||'', status: b.status||'confirmed',
      leadId: b.leadId||'', createdAt: b.createdAt||now()
    });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE booking
app.delete('/api/bookings/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM bookings WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GOOGLE CALENDAR WEBHOOK ───────────────────────────────────────────────────
// Google sends a push notification when a calendar event changes.
// We register this endpoint as the webhook URL in Google Cloud Console.
//
// HOW TO SET THIS UP (one-time, takes 5 minutes):
// 1. Go to console.cloud.google.com → APIs & Services → Enable "Google Calendar API"
// 2. Create credentials → Service Account → download JSON key
// 3. Share your Google Calendar with the service account email (view only)
// 4. Set GOOGLE_WEBHOOK_TOKEN in Railway env vars (any random string you choose)
// 5. Register the watch by hitting POST /api/calendar/register once
// 6. Google will then push to /api/calendar/webhook on every new booking

app.post('/api/calendar/webhook', (req, res) => {
  try {
    // Verify the token matches what we set
    const token = req.headers['x-goog-channel-token'];
    const expectedToken = process.env.GOOGLE_WEBHOOK_TOKEN;
    if (expectedToken && token !== expectedToken) {
      console.log('[webhook] Invalid token — ignoring.');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Google just sends a "something changed" ping — we need to fetch the event
    // The resource state tells us what happened
    const state = req.headers['x-goog-resource-state'];
    console.log(`[webhook] Google Calendar push: ${state}`);

    // Acknowledge immediately (Google requires < 2s response)
    res.status(200).json({ ok: true });

    // Process async — fetch the changed event using the service account
    if (state === 'exists') {
      processCalendarChange().catch(e => console.error('[webhook] Processing error:', e.message));
    }
  } catch (e) {
    console.error('[webhook] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function processCalendarChange() {
  try {
    const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || '/app/google-service-account.json';
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

    if (!fs.existsSync(keyPath)) {
      console.log('[calendar] No service account key found — skipping event fetch.');
      return;
    }

    // Use JWT to authenticate
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const token = await getGoogleToken(key);

    // Fetch events created in the last 10 minutes (new bookings)
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?orderBy=updated&singleEvents=true&updatedMin=${encodeURIComponent(since)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();

    if (!d.items || !d.items.length) return;

    for (const event of d.items) {
      if (event.status === 'cancelled') continue;
      processGoogleEvent(event);
    }
  } catch (e) {
    console.error('[calendar] Failed to fetch events:', e.message);
  }
}

function processGoogleEvent(event) {
  // Parse attendee info from the appointment booking
  const attendees = event.attendees || [];
  const client = attendees.find(a => !a.organizer) || {};
  const email = client.email || '';
  const displayName = client.displayName || event.summary || '';
  const nameParts = displayName.split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Parse custom questions from event description
  const desc = event.description || '';
  const company = extractField(desc, 'Company') || extractField(desc, 'Organisation') || '';
  const shootType = extractField(desc, 'Shoot type') || extractField(desc, 'Type') || '';
  const budget = extractField(desc, 'Budget') || '';
  const notes = desc;

  // Infer industry from shoot type
  const industryMap = {
    'real estate': 'realestate', 'listing': 'realestate', 'property': 'realestate',
    'automotive': 'automotive', 'car': 'automotive', 'vehicle': 'automotive',
    'construction': 'construction', 'build': 'construction',
    'corporate': 'corporate', 'finance': 'corporate', 'professional': 'corporate',
  };
  const shootLower = (shootType + ' ' + company).toLowerCase();
  const industry = Object.entries(industryMap).find(([k]) => shootLower.includes(k))?.[1] || 'corporate';

  // Save booking
  const bookingId = uid();
  try {
    db.prepare(`
      INSERT INTO bookings (id,googleEventId,firstName,lastName,email,company,
        shootType,budget,startTime,endTime,notes,status,leadId,createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'confirmed','',?)
      ON CONFLICT(googleEventId) DO UPDATE SET
        firstName=excluded.firstName, status='confirmed'
    `).run(
      bookingId, event.id, firstName, lastName, email, company,
      shootType, budget,
      event.start?.dateTime || event.start?.date || '',
      event.end?.dateTime || event.end?.date || '',
      notes, now()
    );
    console.log(`[calendar] Booking saved: ${firstName} ${lastName} from ${company}`);
  } catch (e) {
    console.error('[calendar] Failed to save booking:', e.message);
    return;
  }

  // Auto-create a lead if email not already in pipeline
  if (email) {
    const exists = db.prepare('SELECT id FROM leads WHERE contact=? OR hunterEmail=?').get(email, email);
    if (!exists) {
      const leadId = uid();
      const timeline = JSON.stringify([{
        ts: now(), type: 'note',
        text: `Booked via Google Calendar — ${shootType||'shoot'} on ${new Date(event.start?.dateTime||event.start?.date).toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'})}`
      }]);
      db.prepare(`
        INSERT INTO leads (id,firstName,lastName,company,website,industry,channel,
          contact,hunterEmail,notes,researchNotes,companyDesc,status,reelId,
          monthlyValue,timeline,contactedDate,followup1SentDate,followup2SentDate,createdAt,updatedAt)
        VALUES (?,?,?,?,'',?,'email',?,?,?,?,'','contacted','',0,?,?,null,null,?,?)
      `).run(
        leadId, firstName, lastName, company, industry, email, email,
        [shootType&&`Shoot type: ${shootType}`, budget&&`Budget: ${budget}`].filter(Boolean).join(' · '),
        notes, timeline, now().slice(0,10), now(), now()
      );
      // Link booking to lead
      db.prepare('UPDATE bookings SET leadId=? WHERE id=?').run(leadId, bookingId);
      console.log(`[calendar] Lead created for ${firstName} ${lastName} (${email})`);
    }
  }
}

function extractField(text, fieldName) {
  const regex = new RegExp(fieldName + '[:\\s]+([^\\n]+)', 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

async function getGoogleToken(key) {
  const now2 = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now2 + 3600, iat: now2
  })).toString('base64url');

  const crypto = require('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(key.private_key).toString('base64url');
  const jwt = `${header}.${payload}.${sig}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Failed to get Google token: ' + JSON.stringify(d));
  return d.access_token;
}

// One-time endpoint to register the webhook with Google Calendar
// Hit this once after deploying: POST /api/calendar/register
app.post('/api/calendar/register', async (req, res) => {
  try {
    const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || '/app/google-service-account.json';
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    const webhookUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/calendar/webhook`
      : req.body.webhookUrl;

    if (!webhookUrl) return res.status(400).json({ error: 'Set RAILWAY_PUBLIC_DOMAIN env var or pass webhookUrl in body.' });
    if (!fs.existsSync(keyPath)) return res.status(400).json({ error: 'Google service account key not found at ' + keyPath });

    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const token = await getGoogleToken(key);

    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: uid(),
        type: 'web_hook',
        address: webhookUrl,
        token: process.env.GOOGLE_WEBHOOK_TOKEN || '',
        expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
      })
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message, detail: d });
    res.json({ ok: true, channelId: d.id, expiry: new Date(parseInt(d.expiration)).toISOString(), message: 'Webhook registered. Expires in 7 days — re-hit this endpoint to renew.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LOGIN PAGE ────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const cookies = parseCookies(req);
  if (isValidSession(cookies.ogm_session)) return res.redirect('/');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OGM — Sign in</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e5e5e5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #0f0f0f; border: 1px solid #1a1a1a; border-radius: 16px; padding: 40px; width: 100%; max-width: 380px; }
  .logo { font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #fff; margin-bottom: 4px; }
  .logo-sub { font-size: 9px; letter-spacing: 3px; color: #3f3f46; text-transform: uppercase; margin-bottom: 36px; }
  label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #52525b; display: block; margin-bottom: 6px; }
  input { width: 100%; background: #1a1a1a; border: 1px solid #262626; color: #fff; font-size: 14px; padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; outline: none; }
  input:focus { border-color: #3f3f46; }
  button { width: 100%; background: #fff; color: #000; border: none; padding: 11px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 4px; }
  button:hover { background: #e5e5e5; }
  .error { color: #f87171; font-size: 13px; margin-bottom: 16px; display: none; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">OGM</div>
  <div class="logo-sub">Oscar Green Media</div>
  <div class="error" id="err">Incorrect email or password.</div>
  <form onsubmit="login(event)">
    <label>Email</label>
    <input type="email" id="u" placeholder="oscar@oscargreenmedia.com" autocomplete="username" />
    <label>Password</label>
    <input type="password" id="p" placeholder="••••••••" autocomplete="current-password" />
    <button type="submit" id="btn">Sign in</button>
  </form>
</div>
<script>
async function login(e) {
  e.preventDefault();
  const btn = document.getElementById('btn');
  btn.textContent = 'Signing in...'; btn.disabled = true;
  document.getElementById('err').style.display = 'none';
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: document.getElementById('u').value, password: document.getElementById('p').value })
  });
  const d = await r.json();
  if (d.ok) { window.location.href = '/'; }
  else { document.getElementById('err').style.display = 'block'; btn.textContent = 'Sign in'; btn.disabled = false; }
}
</script>
</body>
</html>`);
});

// ── LOGIN API ─────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === AUTH_USER && password === AUTH_PASS) {
    const token = createSession();
    res.setHeader('Set-Cookie', `ogm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${1 * 24 * 60 * 60}`);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'Invalid credentials' });
});

// ── LOGOUT ────────────────────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.ogm_session) sessions.delete(cookies.ogm_session);
  res.setHeader('Set-Cookie', 'ogm_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
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
  const filePath = path.join(__dirname, 'OGM_Outreach.html');
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('OGM_Outreach.html not found.');
  }
  try {
    const html = fs.readFileSync(filePath, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(html);
  } catch (e) {
    res.status(500).send('Error reading file: ' + e.message);
  }
});

// Debug: list all files in root (remove after confirming it works)
app.get('/debug-files', (req, res) => {
  const files = fs.readdirSync(__dirname);
  res.json({ files, cwd: __dirname });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`OGM backend running on port ${PORT}`));
