# 🤖 AI Email Agent

A fully autonomous email assistant that reads, analyses, and replies to emails intelligently — **no OpenAI required**. Built with Node.js, PostgreSQL, and Gmail API using a rule-based heuristic engine.

---

## ✨ What It Does

| Feature | Description |
|---|---|
| **Auto Reply** | Replies to emails automatically based on intent and tone |
| **Spam Detection** | Detects and deletes spam/promotional emails with 90%+ confidence |
| **Meeting Scheduling** | Extracts meeting requests and replies with available time slots |
| **Approval Queue** | Routes unknown high-priority senders to human review |
| **Smart Cleanup** | Automatically trashes spam and promotional emails |
| **Web Dashboard** | Real-time monitoring — works on mobile too |
| **Audit Trail** | Full log of every action the agent takes |
| **Zero OpenAI** | 100% rule-based heuristic engine — no API costs |

---

## 🧠 How the Agent Decides

Every incoming email goes through this pipeline:

```
Gmail Inbox (unread)
       ↓
  Spam Check ──── confidence ≥ 0.90 ──→ 🗑️ DELETE
       ↓
  Heuristic Analysis
  (intent + tone + priority + confidence)
       ↓
  ┌─────────────────────────────────────────┐
  │ meeting_request → slots + calendar reply │
  │ question / task → dynamic reply          │
  │ personal        → warm reply             │
  │ informational   → IGNORE (no reply)      │
  └─────────────────────────────────────────┘
       ↓
  Known contact OR unknown + low/medium priority + safe tone
       ├── YES → ✅ AUTO_REPLY (sends immediately)
       └── NO  → 🟡 NEEDS_APPROVAL (queued for review)
```

### Decision Rules

| Condition | Action |
|---|---|
| Known / trusted contact | ✅ AUTO_REPLY |
| Unknown sender + low or medium priority | ✅ AUTO_REPLY |
| Unknown sender + **high priority** | 🟡 NEEDS_APPROVAL |
| Angry or negative tone (anyone) | 🟡 NEEDS_APPROVAL |
| Spam or promotional | 🗑️ DELETE |
| Blocked sender | 🚫 IGNORE |
| Informational only | ℹ️ IGNORE |

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- Google Cloud project (Gmail API + Calendar API)

### 1. Install
```bash
git clone <repo>
cd ai-email-agent
npm install
```

### 2. Configure
```bash
cp .env.example .env
```

Open `.env` and fill in:
```env
# Required
GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your-client-secret
GMAIL_REDIRECT_URI=http://localhost:3000/auth/gmail/callback
GMAIL_REFRESH_TOKEN=your-refresh-token

GOOGLE_CALENDAR_ID=primary

DB_HOST=localhost
DB_PORT=5432
DB_NAME=ai_email_agent
DB_USER=postgres
DB_PASSWORD=your-db-password

AUTO_REPLY_ENABLED=true
DELETION_CONFIDENCE_THRESHOLD=0.90
EMAIL_POLL_INTERVAL=*/5 * * * *
```

> No `OPENAI_API_KEY` needed — the agent runs entirely on rule-based logic.

### 3. Database
```bash
createdb ai_email_agent
node src/models/migrate.js
```

### 4. Gmail OAuth Setup
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project → enable **Gmail API** + **Google Calendar API**
3. Go to **OAuth Consent Screen** → External → add your Gmail as a test user
4. Create **OAuth 2.0 credentials** (Web Application type)
5. Add redirect URI: `http://localhost:3000/auth/gmail/callback`
6. Paste `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` into `.env`
7. Start the server and visit `http://localhost:3000/auth/gmail`
8. Authorize → copy the `refresh_token` into `.env`

### 5. Start
```bash
npm run dev     # Development with hot reload
npm start       # Production
```

Open **http://localhost:3000** for the dashboard.

---

## 📁 Project Structure

```
ai-email-agent/
├── src/
│   ├── index.js                  # Entry point
│   ├── app.js                    # Express app setup
│   ├── config/
│   │   ├── database.js           # PostgreSQL connection pool
│   │   └── logger.js             # Winston logger
│   ├── models/
│   │   ├── migrate.js            # DB schema / table creation
│   │   └── seed.js               # Sample data (optional)
│   ├── routes/
│   │   ├── index.js              # All API routes
│   │   └── auth.js               # Gmail OAuth flow
│   ├── services/
│   │   ├── autonomousAgent.js    # Main pipeline orchestrator ⭐
│   │   ├── fallbackAnalysis.js   # Rule-based intent/tone/priority engine ⭐
│   │   ├── replyEngine.js        # Dynamic reply generator ⭐
│   │   ├── spamDetector.js       # Spam & promo detector ⭐
│   │   ├── meetingScheduler.js   # Meeting slot finder ⭐
│   │   ├── emailService.js       # Gmail fetch & send
│   │   ├── aiService.js          # OpenAI wrapper (optional, falls back)
│   │   ├── decisionEngine.js     # Legacy decision engine
│   │   ├── approvalService.js    # Human approval queue
│   │   └── cleanupService.js     # Inbox cleanup
│   └── utils/
│       └── scheduler.js          # Cron-based email polling (every 5 min)
├── public/
│   └── index.html                # Web dashboard (mobile friendly)
├── tests/
│   ├── fallbackAnalysis.test.js  # Rule engine tests
│   └── services.test.js          # Service tests
├── .env.example
└── package.json
```

> ⭐ = new files added as part of the rule-based engine

---

## 🔌 API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | System health check |
| GET | `/api/emails` | List processed emails from DB |
| GET | `/api/emails?live=true` | Fetch live unread emails from Gmail |
| POST | `/api/run-agent` | Manually trigger one agent cycle |
| POST | `/api/agent/analyze` | Analyse a single email (no send) |
| GET | `/api/agent/status` | Agent config and engine info |
| POST | `/api/process-email` | Process and store a single email |
| POST | `/api/process-all` | Process all inboxes |
| GET | `/api/pending-approvals` | List emails queued for review |
| POST | `/api/approve/:id` | Approve and send a queued reply |
| POST | `/api/reject/:id` | Reject a queued reply |
| POST | `/api/cleanup` | Run inbox spam cleanup |
| GET | `/api/deletion-log` | View all deleted emails |
| POST | `/api/recover/:id` | Recover a deleted email |
| GET | `/api/stats` | Dashboard statistics |
| GET | `/api/contacts` | List known contacts |
| POST | `/api/contacts` | Add or update a contact |
| DELETE | `/api/contacts/:email` | Delete a contact |
| PATCH | `/api/contacts/:email` | Update contact trust level |
| GET | `/api/audit-log` | Full system audit trail |

---

## ⚙️ Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `AUTO_REPLY_ENABLED` | `true` | Enable live auto-sending |
| `DELETION_CONFIDENCE_THRESHOLD` | `0.90` | Min confidence to delete spam |
| `EMAIL_POLL_INTERVAL` | `*/5 * * * *` | How often to check email (cron) |
| `BATCH_SIZE` | `20` | Emails processed per cycle |
| `GOOGLE_CALENDAR_ID` | `primary` | Calendar to create events on |
| `LOG_LEVEL` | `info` | Logging verbosity |
| `LOG_TO_FILE` | `true` | Save logs to `/logs` folder |

---

## 🧪 Testing

```bash
npm test
```

Tests cover the full rule-based engine — intent detection, tone detection, confidence scoring, spam detection, and all decision routing cases.

---

## 📱 Mobile Access

To view the dashboard on your phone while running locally:

```bash
# Install ngrok
npm install -g ngrok

# In a second terminal (keep server running)
ngrok http 3000
```

Open the generated `https://xxxxx.ngrok.io` URL on any device.

---

## 🔐 Security

- OAuth 2.0 for Gmail — no passwords stored
- All credentials via environment variables only
- Rate limiting: 100 requests per 15 minutes per IP
- Deletion requires 90%+ confidence — never deletes trusted contacts
- Full audit trail of every agent action

---

## 📝 License

© 2026 Dilipan. All rights reserved.
This project is private and not licensed for public use.