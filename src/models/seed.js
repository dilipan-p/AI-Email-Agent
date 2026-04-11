// src/models/seed.js
// Run: node src/models/seed.js
// Seeds the database with sample data for testing

require('dotenv').config();
const { pool, connectDB } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const logger = require('../config/logger');

async function seed() {
  await connectDB();
  logger.info('Seeding database with test data...');

  // --- Known Contacts ---
  const contacts = [
    { email: 'boss@yourcompany.com', name: 'The Boss', domain: 'yourcompany.com', trust_level: 'trusted' },
    { email: 'client@bigcorp.com', name: 'Important Client', domain: 'bigcorp.com', trust_level: 'known' },
    { email: 'friend@gmail.com', name: 'Old Friend', domain: 'gmail.com', trust_level: 'known' },
    { email: 'newsletter@marketingspam.com', name: 'Spammer', domain: 'marketingspam.com', trust_level: 'blocked' },
  ];

  for (const c of contacts) {
    await pool.query(
      `INSERT INTO known_contacts (email, name, domain, trust_level, interaction_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO NOTHING`,
      [c.email, c.name, c.domain, c.trust_level, Math.floor(Math.random() * 20)]
    );
  }

  // --- Sample Emails ---
  const emailId1 = uuidv4();
  const emailId2 = uuidv4();
  const emailId3 = uuidv4();
  const emailId4 = uuidv4();

  const emails = [
    {
      id: emailId1,
      provider: 'gmail',
      message_id: `msg-${Date.now()}-1@gmail.com`,
      thread_id: `thread-001`,
      sender_email: 'client@bigcorp.com',
      sender_name: 'Important Client',
      subject: 'Meeting Request - Q4 Review',
      body: 'Hi, I would like to schedule a meeting to discuss the Q4 performance review. Could we meet next Tuesday at 2pm or Wednesday at 3pm? Please let me know what works best. Best regards.',
      received_at: new Date(Date.now() - 3600000).toISOString(),
      status: 'pending',
    },
    {
      id: emailId2,
      provider: 'outlook',
      message_id: `msg-${Date.now()}-2@outlook.com`,
      thread_id: `thread-002`,
      sender_email: 'newsletter@marketingspam.com',
      sender_name: 'Marketing Blast',
      subject: '🔥 HUGE SALE! 80% OFF Everything! LIMITED TIME!!!',
      body: 'CLICK HERE NOW! Do not miss out on our BIGGEST SALE EVER! Buy now get 80% off all products. Unsubscribe below.',
      received_at: new Date(Date.now() - 7200000).toISOString(),
      status: 'pending',
    },
    {
      id: emailId3,
      provider: 'imap',
      message_id: `msg-${Date.now()}-3@yahoo.com`,
      thread_id: `thread-003`,
      sender_email: 'unknown@randomdomain.org',
      sender_name: 'Unknown Person',
      subject: 'Partnership Proposal',
      body: 'Dear Sir/Madam, I am writing to propose a partnership opportunity that could be mutually beneficial. I would appreciate your thoughts on this matter. Please review the attached proposal.',
      received_at: new Date(Date.now() - 1800000).toISOString(),
      status: 'pending',
    },
    {
      id: emailId4,
      provider: 'gmail',
      message_id: `msg-${Date.now()}-4@gmail.com`,
      thread_id: `thread-004`,
      sender_email: 'boss@yourcompany.com',
      sender_name: 'The Boss',
      subject: 'Quick Question About the Report',
      body: 'Hey, just wanted to check - did you finish the monthly report? If so, can you send it over? Thanks!',
      received_at: new Date(Date.now() - 900000).toISOString(),
      status: 'pending',
    },
  ];

  for (const e of emails) {
    await pool.query(
      `INSERT INTO emails (id, provider, message_id, thread_id, sender_email, sender_name,
        subject, body, received_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (message_id) DO NOTHING`,
      [e.id, e.provider, e.message_id, e.thread_id, e.sender_email, e.sender_name,
       e.subject, e.body, e.received_at, e.status]
    );
  }

  // --- Sample Analysis (for the meeting request) ---
  const analysisId = uuidv4();
  await pool.query(
    `INSERT INTO email_analyses
       (id, email_id, intent, tone, priority, decision, confidence, reasoning, key_points,
        extracted_datetime, extracted_participants)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      analysisId, emailId1,
      'meeting_request', 'formal', 'high', 'AUTO_REPLY', 0.92,
      'Sender is a known contact requesting a meeting. The email is formal, clear, and safe to auto-reply.',
      JSON.stringify(['Q4 performance review meeting', 'Two time options provided: Tuesday 2pm or Wednesday 3pm']),
      'Tuesday 2pm or Wednesday 3pm',
      JSON.stringify(['client@bigcorp.com']),
    ]
  );

  // --- Sample pending reply ---
  await pool.query(
    `INSERT INTO email_replies (email_id, analysis_id, generated_reply, approval_status)
     VALUES ($1, $2, $3, $4)`,
    [
      emailId1, analysisId,
      'Hi,\n\nThank you for reaching out regarding the Q4 performance review meeting.\n\nI would be happy to meet on Tuesday at 2:00 PM. Please send over a calendar invite and I will confirm.\n\nLooking forward to our discussion.\n\nBest regards',
      'pending',
    ]
  );

  logger.info('✅ Database seeded successfully');
  await pool.end();
}

seed().catch((err) => {
  logger.error('Seed failed', { error: err.message });
  process.exit(1);
});
