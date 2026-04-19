// src/routes/index.js
// All API routes for the AI Email Agent

const express = require('express');
const router = express.Router();
const { body, param, query: queryValidator, validationResult } = require('express-validator');

const { query } = require('../config/database');
const emailService = require('../services/emailService');
const aiService = require('../services/aiService');
const processorService = require('../services/processorService');
const approvalService = require('../services/approvalService');
const cleanupService = require('../services/cleanupService');
const calendarService = require('../services/calendarService');
const logger = require('../config/logger');
const reminderService = require('../services/reminderService');

// Validation middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

// ============================================================
// HEALTH CHECK
// ============================================================
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    providers: emailService.getActiveProviders(),
  });
});

// ============================================================
// GET /emails - Fetch and return normalized emails
// ============================================================
router.get('/emails',
  queryValidator('status').optional().isIn(['pending', 'processed', 'replied', 'ignored', 'deleted', 'trashed']),
  queryValidator('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  queryValidator('offset').optional().isInt({ min: 0 }).toInt(),
  validate,
  async (req, res) => {
    try {
      const { status, limit = 20, offset = 0, live } = req.query;

      // Option A: Fetch live from email providers
      if (live === 'true') {
        const { emails, errors } = await emailService.fetchAllEmails(parseInt(limit));
        return res.json({ emails, errors, source: 'live' });
      }

      // Option B: Return from database
      let sql = `
        SELECT e.*, a.intent, a.tone, a.priority, a.decision, a.confidence
        FROM emails e
        LEFT JOIN email_analyses a ON a.email_id = e.id
        WHERE 1=1
      `;
      const params = [];

      if (status) {
        params.push(status);
        sql += ` AND e.status = $${params.length}`;
      }

      sql += ` ORDER BY e.received_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const result = await query(sql, params);

      // Get total count
      const countResult = await query(
        `SELECT COUNT(*) FROM emails ${status ? 'WHERE status = $1' : ''}`,
        status ? [status] : []
      );

      res.json({
        emails: result.rows,
        total: parseInt(countResult.rows[0].count),
        limit,
        offset,
        source: 'database',
      });
    } catch (err) {
      logger.error('GET /emails error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// POST /process-email - Analyze a single email
// ============================================================
router.post('/process-email',
  body('messageId').notEmpty().withMessage('messageId is required'),
  body('sender').isEmail().withMessage('Valid sender email required'),
  body('subject').optional().isString(),
  body('body').optional().isString(),
  body('provider').optional().isIn(['gmail', 'outlook', 'imap']),
  validate,
  async (req, res) => {
    try {
      const emailData = {
        messageId: req.body.messageId,
        threadId: req.body.threadId || req.body.messageId,
        provider: req.body.provider || 'imap',
        sender: req.body.sender,
        senderName: req.body.senderName || '',
        subject: req.body.subject || '',
        body: req.body.body || '',
        htmlBody: req.body.htmlBody || '',
        receivedAt: req.body.receivedAt ? new Date(req.body.receivedAt) : new Date(),
        rawHeaders: req.body.rawHeaders || {},
      };

      const result = await processorService.processEmail(emailData);
      res.json({ success: true, result });
    } catch (err) {
      logger.error('POST /process-email error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// POST /process-all - Trigger batch processing of all inboxes
// ============================================================
router.post('/process-all', async (req, res) => {
  try {
    const maxPerProvider = parseInt(req.body?.maxPerProvider) || 20;
    const result = await processorService.processAllIncoming(maxPerProvider);
    res.json({ success: true, result });
  } catch (err) {
    logger.error('POST /process-all error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /analyze-email - Just analyze, don't store or act
// ============================================================
router.post('/analyze-email',
  body('sender').isEmail(),
  body('subject').optional().isString(),
  body('body').optional().isString(),
  validate,
  async (req, res) => {
    try {
      const emailData = {
        sender: req.body.sender,
        senderName: req.body.senderName || '',
        subject: req.body.subject || '',
        body: req.body.body || '',
        isKnownContact: req.body.isKnownContact || false,
      };

      const analysis = await aiService.analyzeEmail(emailData);
      res.json({ success: true, analysis });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// POST /send-reply - Manually send a reply
// ============================================================
router.post('/send-reply',
  body('provider').isIn(['gmail', 'outlook', 'imap']),
  body('messageId').notEmpty(),
  body('toEmail').isEmail(),
  body('subject').notEmpty(),
  body('replyText').notEmpty(),
  validate,
  async (req, res) => {
    try {
      const { provider, messageId, threadId, toEmail, subject, replyText } = req.body;
      const result = await emailService.sendReply(
        provider, messageId, threadId || messageId, toEmail, subject, replyText
      );

      // Log in audit trail
      await query(
        `INSERT INTO audit_log (event_type, entity_type, details)
         VALUES ('manual_reply_sent', 'email', $1)`,
        [JSON.stringify({ to: toEmail, subject, provider })]
      );

      res.json({ success: true, result });
    } catch (err) {
      logger.error('POST /send-reply error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// GET /pending-approvals - List all replies awaiting human review
// ============================================================
router.get('/pending-approvals',
  queryValidator('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  queryValidator('offset').optional().isInt({ min: 0 }).toInt(),
  validate,
  async (req, res) => {
    try {
      const { limit = 50, offset = 0 } = req.query;
      const result = await approvalService.getPendingApprovals(limit, offset);
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error('GET /pending-approvals error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// POST /approve/:id - Approve and send a reply
// ============================================================
router.post('/approve/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { approvedBy = 'human', editedReply } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const result = await approvalService.approveReply(id, approvedBy, editedReply);
    res.json({ success: true, result });
  } catch (err) {
    logger.error(`POST /approve/${req.params.id} error`, { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// POST /reject/:id - Reject a queued reply
// ============================================================
router.post('/reject/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = '', rejectedBy = 'human' } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const result = await approvalService.rejectReply(id, rejectedBy, reason);
    res.json({ success: true, result });
  } catch (err) {
    logger.error(`POST /reject/${req.params.id} error`, { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// POST /cleanup - Trigger inbox cleaning
// ============================================================
router.post('/cleanup', async (req, res) => {
  try {
    const limit = parseInt(req.body?.limit) || 50;
    const result = await cleanupService.runBulkCleanup(limit);
    res.json({ success: true, result });
  } catch (err) {
    logger.error('POST /cleanup error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /deletion-log - View deletion history
// ============================================================
router.get('/deletion-log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const includeRecovered = req.query.includeRecovered === 'true';
    const log = await cleanupService.getDeletionLog(limit, includeRecovered);
    res.json({ success: true, log, total: log.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /recover/:deletionId - Recover a deleted email
// ============================================================
router.post('/recover/:id', param('id').isUUID(), validate, async (req, res) => {
  try {
    const result = await cleanupService.recoverEmail(req.params.id);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /calendar/slots - Get available meeting slots
// ============================================================
router.get('/calendar/slots', async (req, res) => {
  try {
    const duration = parseInt(req.query.duration) || 60;
    const daysAhead = parseInt(req.query.days) || 7;
    const timezone = req.query.timezone || 'UTC';
    const slots = await calendarService.findAvailableSlots(duration, daysAhead, timezone);
    res.json({ success: true, slots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /stats - Dashboard statistics
// ============================================================
router.get('/stats', async (req, res) => {
  try {
    const [emailStats, approvalStats, cleanupStats] = await Promise.all([
      query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'processed') as processed,
          COUNT(*) FILTER (WHERE status = 'replied') as replied,
          COUNT(*) FILTER (WHERE status = 'ignored') as ignored,
          COUNT(*) FILTER (WHERE status = 'deleted' OR status = 'trashed') as deleted,
          COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '24 hours') as last_24h
        FROM emails
      `),
      approvalService.getStats(),
      cleanupService.getCleanupStats(),
    ]);

    const intentStats = await query(`
      SELECT intent, COUNT(*) as count
      FROM email_analyses
      GROUP BY intent ORDER BY count DESC
    `);

    const decisionStats = await query(`
      SELECT decision, COUNT(*) as count
      FROM email_analyses
      GROUP BY decision ORDER BY count DESC
    `);

    res.json({
      success: true,
      stats: {
        emails: emailStats.rows[0],
        approvals: approvalStats,
        cleanup: cleanupStats,
        byIntent: intentStats.rows,
        byDecision: decisionStats.rows,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error('GET /stats error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /contacts - List known contacts
// ============================================================
router.get('/contacts', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM known_contacts ORDER BY interaction_count DESC LIMIT 100'
    );
    res.json({ success: true, contacts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /contacts - Add/update a contact
// ============================================================
router.post('/contacts',
  body('email').isEmail(),
  body('trustLevel').optional().isIn(['known', 'trusted', 'blocked']),
  validate,
  async (req, res) => {
    try {
      const { email, name, trustLevel = 'known' } = req.body;
      const domain = email.split('@')[1];

      await query(
        `INSERT INTO known_contacts (email, name, domain, trust_level)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name, trust_level = EXCLUDED.trust_level, updated_at = NOW()`,
        [email.toLowerCase(), name || '', domain, trustLevel]
      );

      res.json({ success: true, message: `Contact ${email} saved with trust_level: ${trustLevel}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// GET /audit-log - View system audit trail
// ============================================================
router.get('/audit-log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    // Join with email_analyses to enrich audit log with intent/tone/priority/decision
    const result = await query(`
      SELECT
        al.id, al.event_type, al.entity_type, al.created_at,
        al.details,
        -- Pull from details JSON first
        al.details->>'intent'     AS d_intent,
        al.details->>'tone'       AS d_tone,
        al.details->>'priority'   AS d_priority,
        al.details->>'decision'   AS d_decision,
        al.details->>'confidence' AS d_confidence,
        al.details->>'sender'     AS d_sender,
        al.details->>'subject'    AS d_subject,
        al.details->>'reason'     AS d_reason,
        -- Enrich from email_analyses by matching sender + subject
        ea.intent      AS ea_intent,
        ea.tone        AS ea_tone,
        ea.priority    AS ea_priority,
        ea.decision    AS ea_decision,
        ea.confidence  AS ea_confidence
      FROM audit_log al
      LEFT JOIN emails e
        ON LOWER(e.sender_email) = LOWER(al.details->>'sender')
        AND e.subject = al.details->>'subject'
      LEFT JOIN email_analyses ea
        ON ea.email_id = e.id
      ORDER BY al.created_at DESC
      LIMIT $1
    `, [limit]);

    // Merge: prefer details JSON, fallback to email_analyses join
    const log = result.rows.map(row => {
      let details = {};
      try { details = typeof row.details === 'object' ? row.details : JSON.parse(row.details || '{}'); } catch {}
      return {
        id:         row.id,
        event_type: row.event_type,
        entity_type:row.entity_type,
        created_at: row.created_at,
        intent:     row.d_intent     || row.ea_intent                     || details.intent     || null,
        tone:       row.d_tone       || row.ea_tone                       || details.tone       || null,
        priority:   row.d_priority   || row.ea_priority                   || details.priority   || null,
        decision:   row.d_decision   || row.ea_decision                   || details.decision   || details.suggestedDecision || null,
        confidence: row.d_confidence || (row.ea_confidence != null ? String(row.ea_confidence) : null) || details.confidence || null,
        sender:     row.d_sender     || details.sender  || details.to     || null,
        subject:    row.d_subject    || details.subject                   || null,
        reason:     row.d_reason     || details.reason                    || null,
      };
    });

    res.json({ success: true, log });
  } catch (err) {
    logger.error('GET /audit-log error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DELETE /contacts/:email
// ============================================================
router.delete('/contacts/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    await query('DELETE FROM known_contacts WHERE LOWER(email) = LOWER($1)', [email]);
    res.json({ success: true, message: `Contact ${email} deleted` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// PATCH /contacts/:email - Update trust level
// ============================================================
router.patch('/contacts/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const { trust_level } = req.body;
    await query(
      'UPDATE known_contacts SET trust_level = $1, updated_at = NOW() WHERE LOWER(email) = LOWER($2)',
      [trust_level, email]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// REMINDERS
// ============================================================
router.get('/reminders', async (req, res) => {
  try {
    const status = req.query.status || null;
    const reminders = await reminderService.getReminders(status);
    res.json({ success: true, reminders });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/reminders/:id/dismiss', async (req, res) => {
  try {
    await reminderService.dismissReminder(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/reminders/:id/snooze', async (req, res) => {
  try {
    await reminderService.snoozeReminder(req.params.id, 1);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// AUTONOMOUS AGENT ROUTES
// ============================================================
router.post('/run-agent', async (req, res) => {
  try {
    const { runAgentCycle } = require('../services/autonomousAgent');
    const result = await runAgentCycle();
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/agent/analyze', async (req, res) => {
  try {
    const { fallbackAnalysis } = require('../services/fallbackAnalysis');
    const { generateReply } = require('../services/replyEngine');
    const { detectSpam } = require('../services/spamDetector');
    const { sender, subject, body, isKnownContact } = req.body;
    if (!sender) return res.status(400).json({ error: 'sender is required' });
    const spam     = detectSpam({ sender, subject, body });
    const analysis = fallbackAnalysis({ sender, subject, body, isKnownContact: !!isKnownContact });
    const reply    = generateReply({ sender, subject, body }, analysis);
    res.json({ success: true, spam, analysis, suggestedReply: reply });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/agent/status', (req, res) => {
  res.json({
    autoReplyEnabled: process.env.AUTO_REPLY_ENABLED === 'true',
    engine: 'rule-based-heuristic-v1',
    openAiRequired: false,
  });
});

module.exports = router;