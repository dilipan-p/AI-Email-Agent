// src/models/migrate.js
// Run: node src/models/migrate.js
// Creates all database tables for the AI Email Agent

require('dotenv').config();
const { pool, connectDB } = require('../config/database');
const logger = require('../config/logger');

const migrations = [
  // ----- KNOWN CONTACTS -----
  `CREATE TABLE IF NOT EXISTS known_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    domain VARCHAR(255),
    trust_level VARCHAR(20) DEFAULT 'known'  -- known | trusted | blocked
      CHECK (trust_level IN ('known', 'trusted', 'blocked')),
    interaction_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ----- RAW EMAILS (normalized from all providers) -----
  `CREATE TABLE IF NOT EXISTS emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(20) NOT NULL CHECK (provider IN ('gmail', 'outlook', 'imap')),
    message_id VARCHAR(500) UNIQUE NOT NULL,
    thread_id VARCHAR(500),
    sender_email VARCHAR(255) NOT NULL,
    sender_name VARCHAR(255),
    recipient_email VARCHAR(255),
    subject TEXT,
    body TEXT,
    html_body TEXT,
    received_at TIMESTAMPTZ,
    status VARCHAR(30) DEFAULT 'pending'
      CHECK (status IN ('pending', 'processed', 'replied', 'ignored', 'deleted', 'trashed')),
    raw_headers JSONB,
    attachments JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ----- AI ANALYSIS RESULTS -----
  `CREATE TABLE IF NOT EXISTS email_analyses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_id UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    intent VARCHAR(50)
      CHECK (intent IN ('meeting_request','question','task_request','spam',
                        'promotional','personal','informational','other')),
    tone VARCHAR(30)
      CHECK (tone IN ('formal','informal','friendly','humorous','neutral','urgent','angry','unknown')),
    priority VARCHAR(10)
      CHECK (priority IN ('high','medium','low')),
    decision VARCHAR(20) NOT NULL
      CHECK (decision IN ('AUTO_REPLY','NEEDS_APPROVAL','IGNORE','DELETE')),
    confidence FLOAT NOT NULL DEFAULT 0.0,
    reasoning TEXT,
    key_points JSONB DEFAULT '[]',
    extracted_datetime TEXT,
    extracted_participants JSONB DEFAULT '[]',
    ai_model VARCHAR(50),
    tokens_used INT,
    analysis_duration_ms INT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ----- PENDING/APPROVED REPLIES -----
  `CREATE TABLE IF NOT EXISTS email_replies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_id UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    analysis_id UUID REFERENCES email_analyses(id),
    generated_reply TEXT NOT NULL,
    final_reply TEXT,        -- modified by human if needed
    approval_status VARCHAR(20) DEFAULT 'pending'
      CHECK (approval_status IN ('pending','approved','rejected','sent','auto_sent')),
    approved_by VARCHAR(255),
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    sent_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ----- CALENDAR EVENTS -----
  `CREATE TABLE IF NOT EXISTS calendar_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_id UUID REFERENCES emails(id),
    google_event_id VARCHAR(255),
    title TEXT,
    description TEXT,
    start_datetime TIMESTAMPTZ,
    end_datetime TIMESTAMPTZ,
    timezone VARCHAR(100),
    participants JSONB DEFAULT '[]',
    status VARCHAR(20) DEFAULT 'proposed'
      CHECK (status IN ('proposed','created','declined','cancelled')),
    available_slots JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ----- DELETION / CLEANUP LOG -----
  `CREATE TABLE IF NOT EXISTS deletion_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_id UUID REFERENCES emails(id),
    message_id VARCHAR(500),
    sender_email VARCHAR(255),
    subject TEXT,
    reason VARCHAR(100),
    confidence FLOAT,
    action VARCHAR(30),   -- trashed | deleted | moved_to_spam | moved_to_promotions
    recovered BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ----- AUDIT TRAIL -----
  `CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    actor VARCHAR(255) DEFAULT 'system',
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ----- INDEXES -----
  `CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status)`,
  `CREATE INDEX IF NOT EXISTS idx_emails_sender ON emails(sender_email)`,
  `CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_analyses_email ON email_analyses(email_id)`,
  `CREATE INDEX IF NOT EXISTS idx_replies_status ON email_replies(approval_status)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id)`,
];

async function runMigrations() {
  const connected = await connectDB();
  if (!connected) {
    logger.error('Cannot run migrations - database not connected');
    process.exit(1);
  }

  logger.info('Running database migrations...');

  for (let i = 0; i < migrations.length; i++) {
    try {
      await pool.query(migrations[i]);
      logger.info(`  ✅ Migration ${i + 1}/${migrations.length} completed`);
    } catch (err) {
      logger.error(`  ❌ Migration ${i + 1} failed`, { error: err.message });
      throw err;
    }
  }

  logger.info('✅ All migrations completed successfully');
  await pool.end();
}

runMigrations().catch((err) => {
  logger.error('Migration failed', { error: err.message });
  process.exit(1);
});
