# 🤖 AI Email Agent

A fully autonomous email assistant that reads, analyses, and replies to emails intelligently — **no OpenAI required**. Built with Node.js, PostgreSQL, and Gmail API using a pure rule-based heuristic engine.

---

## ✨ What It Does

| Feature | Description |
|---|---|
| **Auto Reply** | Varied, natural-sounding replies — 3–4 templates per intent, no two emails get identical responses |
| **Spam Detection** | Detects and deletes spam/promotional emails with 90%+ confidence |
| **Meeting Scheduling** | Parses exact dates (DD/MM/YYYY, "Friday", "today"), checks Google Calendar for conflicts, creates events at the correct IST time |
| **Calendar Conflict Detection** | If a slot is taken, apologises and offers next 3 free slots |
| **Approval Queue** | Unknown high-priority senders routed to human review with approve/reject buttons |
| **Reminders** | Auto-creates follow-up reminders after replying to task/meeting emails — with snooze & dismiss |
| **No-Reply Detection** | Never replies to noreply@, mailer-daemon@, notifications@, alerts@ etc. |
| **Contact Management** | Add, delete, change trust level (trusted/known/blocked) directly from UI |
| **Light/Dark Mode** | Theme toggle button — preference saved to localStorage |
| **Audit Log** | Full table view — Time, Event, Intent, Tone, Priority, Decision, Confidence, Sender/Subject |
| **Web Dashboard** | App-style UI — Dashboard · Reminders · Approvals · Contacts · Audit Log |
| **Zero OpenAI** | 100% rule-based heuristic engine — no API costs ever |

---

## 🧠 Decision Pipeline

```
Gmail Inbox (unread)
       ↓
  No-reply check ─── matches pattern ──→ 🚫 IGNORE
       ↓
  Spam Check ──────── confidence ≥ 0.90 → 🗑️  DELETE
       ↓
  Heuristic Analysis
  (intent · tone · priority · confidence)
       ↓
  ┌────────────────────────────────────────────────────┐
  │ meeting_request → check Google Calendar conflicts  │
  │                   → confirm date/time OR apologise  │
  │                   → offer next 3 free slots if busy │
  │ task_request    → urgent or normal reply            │
  │ question        → contextual acknowledgement reply  │
  │ personal        → warm, varied personal reply       │
  │ informational   → IGNORE (no reply needed)          │
  └────────────────────────────────────────────────────┘
       ↓
  Known contact OR unknown + low/medium priority + safe tone
       ├── YES → ✅ AUTO_REPLY + create reminder (if task/meeting)
       └── NO  → 🟡 NEEDS_APPROVAL (queued for human review)
```

### Decision Rules

| Condition | Action |
|---|---|
| Known / trusted contact | ✅ AUTO_REPLY |
| Unknown sender + low or medium priority | ✅ AUTO_REPLY |
| Unknown sender + **high priority** | 🟡 NEEDS_APPROVAL |
| Angry or negative tone | 🟡 NEEDS_APPROVAL |
| Spam / promotional | 🗑️ DELETE |
| No-reply / automated sender | 🚫 IGNORE |
| Informational only | ℹ️ IGNORE |
| Blocked contact | 🚫 IGNORE |

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

### 2. Configure `.env`
```env
# Gmail OAuth (no OpenAI needed)
GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your-client-secret
GMAIL_REDIRECT_URI=http://localhost:3000/auth/gmail/callback
GMAIL_REFRESH_TOKEN=your-refresh-token

# Google Calendar
GOOGLE_CALENDAR_ID=primary

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=ai_email_agent
DB_USER=postgres
DB_PASSWORD=your-password

# Agent settings
AUTO_REPLY_ENABLED=true
DELETION_CONFIDENCE_THRESHOLD=0.90
EMAIL_POLL_INTERVAL=*/5 * * * *
BATCH_SIZE=20
API_SECRET_KEY=any-random-string
LOG_LEVEL=info
```

### 3. Database
```bash
createdb ai_email_agent
node src/models/migrate.js
```

Create the reminders table:
```bash
psql -U postgres -d ai_email_agent -c "
CREATE TABLE IF NOT EXISTS reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  subject TEXT,
  sender VARCHAR(255),
  sender_name VARCHAR(255),
  intent VARCHAR(100),
  priority VARCHAR(50) DEFAULT 'medium',
  remind_at TIMESTAMP NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);"
```

### 4. Gmail OAuth
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project → enable **Gmail API** + **Google Calendar API**
3. OAuth Consent Screen → External → add your Gmail as test user
4. Create **OAuth 2.0 credentials** (Web Application)
5. Add redirect URI: `http://localhost:3000/auth/gmail/callback`
6. Paste `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` into `.env`
7. Start server → visit `http://localhost:3000/auth/gmail` → authorize → copy `refresh_token` to `.env`

### 5. Add a trusted contact
```bash
psql -U postgres -d ai_email_agent -c "
INSERT INTO known_contacts (email, name, domain, trust_level)
VALUES ('your@gmail.com', 'Your Name', 'gmail.com', 'trusted')
ON CONFLICT (email) DO UPDATE SET trust_level = 'trusted';"
```

### 6. Start
```bash
npm run dev     # Development with hot reload
npm start       # Production
```

Open **http://localhost:3000**

The agent checks for new emails **every 5 minutes automatically**. Click **Sync Now** to trigger it manually.

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
│   │   ├── migrate.js            # DB schema creation
│   │   └── seed.js               # Sample data (optional)
│   ├── routes/
│   │   ├── index.js              # All API routes
│   │   └── auth.js               # Gmail OAuth flow
│   └── services/
│       ├── autonomousAgent.js    ⭐ Main pipeline orchestrator
│       ├── fallbackAnalysis.js   ⭐ Rule-based intent/tone/priority engine
│       ├── replyEngine.js        ⭐ Varied reply generator (3–4 templates per intent)
│       ├── spamDetector.js       ⭐ Spam & promo detector
│       ├── meetingScheduler.js   ⭐ Date parser + Calendar conflict checker
│       ├── reminderService.js    ⭐ Auto-reminder service
│       ├── emailService.js       # Gmail fetch & send
│       ├── aiService.js          # OpenAI wrapper (optional, falls back gracefully)
│       ├── approvalService.js    # Human approval queue
│       └── cleanupService.js     # Inbox cleanup
├── utils/
│   └── scheduler.js              # Cron-based polling every 5 min
├── public/
│   └── index.html                # Web dashboard (app-style, mobile-friendly)
├── tests/
│   ├── fallbackAnalysis.test.js  # Full rule engine test suite
│   └── services.test.js
└── .env.example
```

> ⭐ = built as part of the rule-based engine (no OpenAI required)

---

## 🔌 API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | System health check |
| POST | `/api/run-agent` | Manually trigger one agent cycle |
| POST | `/api/agent/analyze` | Analyse a single email (no send) |
| GET | `/api/agent/status` | Agent config and engine info |
| GET | `/api/stats` | Dashboard statistics |
| GET | `/api/pending-approvals` | List emails queued for review |
| POST | `/api/approve/:id` | Approve and send a queued reply |
| POST | `/api/reject/:id` | Reject a queued reply |
| GET | `/api/reminders` | List all reminders |
| POST | `/api/reminders/:id/dismiss` | Dismiss a reminder |
| POST | `/api/reminders/:id/snooze` | Snooze reminder by 1 hour |
| GET | `/api/contacts` | List known contacts |
| POST | `/api/contacts` | Add or update a contact |
| DELETE | `/api/contacts/:email` | Delete a contact |
| PATCH | `/api/contacts/:email` | Update trust level |
| GET | `/api/audit-log` | Full audit trail with enriched fields |

---

## ⚙️ Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `AUTO_REPLY_ENABLED` | `true` | Enable live auto-sending |
| `DELETION_CONFIDENCE_THRESHOLD` | `0.90` | Min confidence to delete spam |
| `EMAIL_POLL_INTERVAL` | `*/5 * * * *` | How often to check email (cron) |
| `BATCH_SIZE` | `20` | Emails processed per cycle |
| `GOOGLE_CALENDAR_ID` | `primary` | Calendar for meeting events |
| `LOG_LEVEL` | `info` | Logging verbosity |

---

## 📊 Dashboard Pages

| Page | What it shows |
|---|---|
| **Dashboard** | Auto replied count · Pending approvals · Spam deleted · Intent chart · Decision chart · Recent activity |
| **Reminders** | Auto-created follow-ups for tasks/meetings · Due now badges · Snooze/Dismiss buttons |
| **Approvals** | Emails queued for review · Intent/tone/priority badges · Approve & Send / Reject |
| **Contacts** | All known contacts · Trust level dropdown · Delete button · Add new contact |
| **Audit Log** | Every agent action · Intent · Tone · Priority · Decision · Confidence · Sender/Subject |

---

## 🧪 Sample Emails for Testing

Send these to your Gmail from a trusted contact email:

| Test | Subject | Body |
|---|---|---|
| Meeting with date | `Meeting Request` | `Can we schedule a Zoom call on 25/4/2026 at 3pm to discuss the project?` |
| Urgent task | `Report Submission` | `Hello, please send me the final report by today evening. Regards, Anita` |
| Question | `Project Update` | `Hi, can you share the latest status of the AI email agent project? Thanks` |
| Personal | `Congratulations!` | `Hey, congratulations on completing the project! Really impressive work.` |
| Spam test | `🎉 You Won a Free iPhone!!!` | `You have been selected. Click here to claim. Unsubscribe below.` |
| Complaint | `Very Disappointed` | `I am not happy with the service at all. This is unacceptable. I want this resolved.` |

---

## 📱 Mobile Access

```bash
npm install -g ngrok
ngrok http 3000
```

Open the `https://xxxxx.ngrok.io` URL on any phone or tablet.

---

## 🧪 Tests

```bash
npm test
```

Covers intent detection, tone detection, confidence scoring, spam detection, decision routing, and edge cases.

---

## 🔐 Security

- OAuth 2.0 only — no email passwords ever stored
- All credentials via environment variables
- Deletion requires 90%+ confidence — trusted contacts never auto-deleted
- No-reply senders always ignored — no accidental replies to automated mail
- Calendar events created with `sendNotifications: false` — no invites sent to senders
- Full audit trail for every single agent action

---

© 2026 Dilipan. All rights reserved. Built for educational purposes.