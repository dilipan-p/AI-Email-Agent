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
const { runAgentCycle } = require('../services/autonomousAgent');
const { fallbackAnalysis } = require('../services/fallbackAnalysis');
const { detectSpam } = require('../services/spamDetector');
const { generateReply } = require('../services/replyEngine');

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
router.post('/approve/:id',
  param('id').isUUID(),
  body('approvedBy').optional().isString(),
  body('editedReply').optional().isString(),
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { approvedBy = 'human', editedReply } = req.body;
      const result = await approvalService.approveReply(id, approvedBy, editedReply);
      res.json({ success: true, result });
    } catch (err) {
      logger.error(`POST /approve/${req.params.id} error`, { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// POST /reject/:id - Reject a queued reply
// ============================================================
router.post('/reject/:id',
  param('id').isUUID(),
  body('reason').optional().isString(),
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { reason = '', rejectedBy = 'human' } = req.body;
      const result = await approvalService.rejectReply(id, rejectedBy, reason);
      res.json({ success: true, result });
    } catch (err) {
      logger.error(`POST /reject/${req.params.id} error`, { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

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
    const [emailStats, approvalStats, cleanupStats, auditStats] = await Promise.all([
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
      query(`
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'auto_reply_sent') as auto_replied,
          COUNT(*) FILTER (WHERE event_type = 'queued_for_approval') as queued,
          COUNT(*) FILTER (WHERE event_type = 'reply_sent') as manual_replied
        FROM audit_log
      `),
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
        emails: {
          ...emailStats.rows[0],
          auto_replied: parseInt(auditStats.rows[0]?.auto_replied || 0),
        },
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
// DELETE /contacts/:email - Delete a contact
// ============================================================
router.delete('/contacts/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    await query('DELETE FROM known_contacts WHERE LOWER(email) = LOWER($1)', [email]);
    res.json({ success: true, message: `Contact ${email} deleted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /audit-log - View system audit trail
// ============================================================
router.get('/audit-log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const result = await query(
      'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    res.json({ success: true, log: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// AUTONOMOUS AGENT ROUTES
// ============================================================

// POST /api/run-agent — manually trigger one agent cycle
router.post('/run-agent', async (req, res) => {
  try {
    logger.info('Manual agent cycle triggered via API');
    const result = await runAgentCycle();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Agent cycle failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/agent/analyze — analyse a single email with rule-based engine
router.post('/agent/analyze', async (req, res) => {
  try {
    const { sender, subject, body, isKnownContact } = req.body;
    if (!sender) return res.status(400).json({ error: 'sender is required' });

    const spamResult   = detectSpam({ sender, subject, body });
    const analysis     = fallbackAnalysis({ sender, subject, body, isKnownContact: !!isKnownContact });
    const reply        = generateReply({ sender, subject, body }, analysis);

    res.json({
      success: true,
      spam:     spamResult,
      analysis,
      suggestedReply: reply,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/agent/status — show agent config and last-run info
router.get('/agent/status', (req, res) => {
  res.json({
    autoReplyEnabled:    process.env.AUTO_REPLY_ENABLED === 'true',
    deletionThreshold:   parseFloat(process.env.DELETION_CONFIDENCE_THRESHOLD) || 0.90,
    pollInterval:        process.env.EMAIL_POLL_INTERVAL || '*/5 * * * *',
    batchSize:           parseInt(process.env.BATCH_SIZE) || 20,
    engine:              'rule-based-heuristic-v1',
    openAiRequired:      false,
  });
});

module.exports = router;