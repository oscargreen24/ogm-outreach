# OGM Outreach — Backend

Node.js/Express backend for the OGM Outreach tool.

## Environment variables (set in Railway dashboard)

| Variable | Description |
|---|---|
| `HUNTER_API_KEY` | Your Hunter.io API key — never exposed to the browser |
| `SMTP_USER` | Gmail address to send outreach emails from |
| `SMTP_PASS` | Gmail App Password (not your regular password) |
| `SENDER_NAME` | Display name on sent emails (default: Oscar Green) |
| `PORT` | Set automatically by Railway — do not override |

## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | /api/health | Health check + Hunter key status |
| GET | /api/leads | All leads |
| POST | /api/leads | Create lead |
| PUT | /api/leads/:id | Update lead |
| DELETE | /api/leads/:id | Delete lead |
| POST | /api/leads/bulk | Bulk import |
| GET | /api/hunter/domain | Hunter domain search (key hidden) |
| GET | /api/hunter/find | Hunter email finder (key hidden) |
| GET | /api/hunter/account | Hunter quota check |
| POST | /api/send | Send email + auto-log |
| GET | /api/send_log/:leadId | Send history for a lead |
| GET | /api/config | Load settings/reels/portfolios |
| PUT | /api/config | Save settings/reels/portfolios |
