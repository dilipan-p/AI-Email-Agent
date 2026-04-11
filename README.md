# 🤖 AI Email Agent

A production-ready autonomous email assistant that reads, analyzes, and responds to emails intelligently across Gmail, Outlook, and any IMAP-compatible provider.

---

## ✨ Features

| Feature | Description |
|---|---|
| **Multi-Provider** | Gmail (API), Outlook (Graph API), Yahoo / custom (IMAP/SMTP) |
| **AI Analysis** | Intent, tone, priority detection via GPT-4o |
| **Decision Engine** | AUTO_REPLY, NEEDS_APPROVAL, IGNORE, DELETE |
| **Reply Generation** | Tone-matched, context-aware replies |
| **Meeting Scheduling** | Google Calendar integration with slot finding |
| **Human Approval** | Review queue with edit-before-send |
| **Smart Cleanup** | Spam/promo detection with 90%+ confidence gate |
| **Audit Trail** | Full logging of every system action |
| **Web Dashboard** | Real-time monitoring and control UI |

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- OpenAI API key
- Google Cloud project (for Gmail + Calendar)

### 1. Install

```bash
git clone <repo>
cd ai-email-agent
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env — minimum required:
# OPENAI_API_KEY
# DB_HOST, DB_USER, DB_PASSWORD, DB_NAME
# Plus at least one email provider
```

### 3. Database

```bash
createdb ai_email_agent
node src/models/migrate.js    # Create tables
node src/models/seed.js       # Sample data (optional)
```

### 4. OAuth Setup

**Gmail:**
1. Create project at https://console.cloud.google.com
2. Enable Gmail API + Google Calendar API
3. Create OAuth 2.0 credentials (Web Application)
4. Add `http://localhost:3000/auth/gmail/callback` as redirect URI
5. Set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` in `.env`
6. Visit `http://localhost:3000/auth/gmail` → authorize → copy `refresh_token` to `.env`

**Outlook:**
1. Register app at https://portal.azure.com → Azure AD → App Registrations
2. Add redirect URI: `http://localhost:3000/auth/outlook/callback`
3. Add permissions: `Mail.ReadWrite`, `Mail.Send`
4. Set `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_TENANT_ID`
5. Visit `http://localhost:3000/auth/outlook` → authorize → copy token

**IMAP/SMTP (Yahoo, custom):**
```env
IMAP_HOST=imap.mail.yahoo.com
IMAP_PORT=993
IMAP_USER=you@yahoo.com
IMAP_PASSWORD=your-app-password    # Use app passwords, not your main password
SMTP_HOST=smtp.mail.yahoo.com
SMTP_PORT=587
SMTP_USER=you@yahoo.com
SMTP_PASSWORD=your-app-password
```

### 5. Start

```bash
npm run dev     # Development (hot reload)
npm start       # Production
```

Open: **http://localhost:3000**

---

## 📁 Project Structure

```
ai-email-agent/
├── src/
│   ├── index.js              # Entry point
│   ├── app.js                # Express app
│   ├── config/
│   │   ├── database.js       # PostgreSQL connection
│   │   └── logger.js         # Winston logger
│   ├── models/
│   │   ├── migrate.js        # DB schema
│   │   └── seed.js           # Test data
│   ├── routes/
│   │   ├── index.js          # All API routes
│   │   └── auth.js           # OAuth flows
│   ├── services/
│   │   ├── emailService.js   # Gmail + Outlook + IMAP (unified)
│   │   ├── aiService.js      # OpenAI analysis + reply generation
│   │   ├── decisionEngine.js # AUTO_REPLY / NEEDS_APPROVAL / IGNORE / DELETE
│   │   ├── calendarService.js# Google Calendar scheduling
│   │   ├── approvalService.js# Human review queue
│   │   ├── cleanupService.js # Inbox cleaning with safety guards
│   │   └── processorService.js # Full pipeline orchestrator
│   └── utils/
│       └── scheduler.js      # Cron-based email polling
├── public/
│   └── index.html            # Web dashboard
├── tests/
│   └── services.test.js      # Unit tests
├── logs/                     # Auto-created log files
├── .env.example
└── package.json
```

---

## 🔌 API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | System health check |
| GET | `/api/emails` | List emails from DB |
| GET | `/api/emails?live=true` | Fetch live from providers |
| POST | `/api/process-email` | Process a single email |
| POST | `/api/process-all` | Process all inboxes |
| POST | `/api/analyze-email` | Analyze without storing |
| POST | `/api/send-reply` | Send reply manually |
| GET | `/api/pending-approvals` | List queued replies |
| POST | `/api/approve/:id` | Approve & send reply |
| POST | `/api/reject/:id` | Reject a reply |
| POST | `/api/cleanup` | Run inbox cleanup |
| GET | `/api/deletion-log` | View deleted emails |
| POST | `/api/recover/:id` | Recover deleted email |
| GET | `/api/calendar/slots` | Get available time slots |
| GET | `/api/stats` | Dashboard statistics |
| GET | `/api/contacts` | List known contacts |
| POST | `/api/contacts` | Add/update contact |
| GET | `/api/audit-log` | System audit trail |

---

## 🛡️ Safety Rules

The system is **safety-first**. When in doubt, it escalates to human approval.

### Deletion Safety Gates
- Confidence must be **≥ 90%** (configurable)
- Intent must be **spam** or **promotional**
- Priority must be **low**
- **Never** deletes from known/trusted contacts
- Every deletion is logged for recovery

### Auto-Reply Requirements (ALL must pass)
- Sender is a **known contact**
- Tone is **not emotional** (no angry/urgent)
- Confidence is **≥ 60%**
- Intent is **question, meeting_request, task_request, or personal**
- `AUTO_REPLY_ENABLED=true` in environment

### Always NEEDS_APPROVAL
- Unknown senders with action-required emails
- Any angry or emotional tone
- Low-confidence analysis
- Complex or unclear requests

---

## 🧪 Testing

```bash
npm test
```

Tests cover:
- Decision engine rules (including edge cases)
- Safety check bypass prevention
- Known contact override behavior
- Confidence threshold enforcement

---

## ⚙️ Key Configuration

| Variable | Default | Description |
|---|---|---|
| `AUTO_REPLY_ENABLED` | `false` | Enable live auto-sending |
| `DELETION_CONFIDENCE_THRESHOLD` | `0.90` | Min confidence for deletion |
| `EMAIL_POLL_INTERVAL` | `*/5 * * * *` | How often to check email |
| `BATCH_SIZE` | `20` | Emails per processing cycle |
| `OPENAI_MODEL` | `gpt-4o` | AI model to use |
| `TRUSTED_DOMAINS` | `` | Comma-separated trusted domains |

---

## 🔐 Security

- OAuth 2.0 for Gmail and Outlook (no password storage)
- IMAP passwords should be **app passwords**, never main account passwords
- Rate limiting: 100 requests per 15 minutes per IP
- All sensitive values via environment variables
- Full audit trail for every system action

---

## 📝 License

MIT
