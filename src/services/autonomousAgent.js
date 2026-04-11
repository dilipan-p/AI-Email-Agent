// src/services/autonomousAgent.js
// Fully autonomous email agent — rule-based, zero OpenAI dependency.
// Pipeline: Fetch → Spam Check → Analyse → Decide → Reply / Queue / Delete
//
// Decisions:
//   AUTO_REPLY      — known contact, clear intent, safe tone
//   NEEDS_APPROVAL  — unknown sender, negative/angry/complex
//   IGNORE          — informational only, no action needed
//   DELETE          — spam or promotional
//
// Scheduling:
//   Runs every EMAIL_POLL_INTERVAL (default: every 5 minutes via cron)

'use strict';

const logger            = require('../config/logger');
const { query }         = require('../config/database');
const { fallbackAnalysis } = require('./fallbackAnalysis');
const { generateReply } = require('./replyEngine');
const { detectSpam }    = require('./spamDetector');
const { extractMeetingDetails, buildMeetingReply, createCalendarEvent } = require('./meetingScheduler');

// ─── Constants ────────────────────────────────────────────────────────────────

const AUTO_REPLY_ENABLED        = process.env.AUTO_REPLY_ENABLED === 'true';
const DELETION_THRESHOLD        = parseFloat(process.env.DELETION_CONFIDENCE_THRESHOLD) || 0.90;
const AUTO_REPLY_CONFIDENCE_MIN = 0.65; // Lowered — trusted contacts need less confidence

// ─── Gmail send helper ────────────────────────────────────────────────────────

async function sendGmailReply(gmail, originalEmail, replyText, replySubject) {
  // Build RFC-2822 message
  const to      = originalEmail.sender;
  const subject = replySubject;
  const threadId = originalEmail.threadId;
  const messageId = originalEmail.messageId;

  const rawMessage = [
    `To: ${to}`,
    `Subject: ${subject}`,
    messageId ? `In-Reply-To: ${messageId}` : '',
    messageId ? `References: ${messageId}` : '',
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    replyText,
  ].filter(Boolean).join('\r\n');

  const encoded = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded, threadId },
  });

  logger.info(`Reply sent to ${to} | subject: ${subject}`);
}

// ─── Contact lookup ───────────────────────────────────────────────────────────

async function getContactInfo(senderEmail) {
  try {
    const result = await query(
      'SELECT * FROM known_contacts WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [senderEmail],
    );
    return result.rows[0] || null;
  } catch (err) {
    logger.warn('getContactInfo failed', { error: err.message });
    return null;
  }
}

async function recordSender(senderEmail, senderName) {
  try {
    const domain = senderEmail.split('@')[1] || '';
    await query(
      `INSERT INTO known_contacts (email, name, domain, trust_level, interaction_count)
       VALUES ($1, $2, $3, 'known', 1)
       ON CONFLICT (email) DO UPDATE
         SET interaction_count = known_contacts.interaction_count + 1,
             updated_at = NOW()`,
      [senderEmail, senderName || '', domain],
    );
  } catch (err) {
    logger.warn('Could not record sender', { error: err.message });
  }
}

async function saveToApprovalQueue(email, analysis, replyText, replySubject, reason) {
  try {
    // First upsert the email record
    const emailResult = await query(
      `INSERT INTO emails
         (message_id, thread_id, provider, sender_email, sender_name, subject, body, status, received_at)
       VALUES ($1,$2,'gmail',$3,$4,$5,$6,'pending',$7)
       ON CONFLICT (message_id) DO UPDATE SET status='pending'
       RETURNING id`,
      [
        email.messageId, email.threadId || '',
        email.sender, email.senderName || '',
        email.subject, (email.body || '').substring(0, 2000),
        email.receivedAt || new Date(),
      ],
    );
    const emailId = emailResult.rows[0]?.id;
    if (!emailId) return;

    // Save analysis
    const analysisResult = await query(
      `INSERT INTO email_analyses
         (email_id, intent, tone, priority, decision, confidence, reasoning, ai_model)
       VALUES ($1,$2,$3,$4,'NEEDS_APPROVAL',$5,$6,'heuristic-fallback-v1')
       RETURNING id`,
      [emailId, analysis.intent, analysis.tone, analysis.priority,
       analysis.confidence, reason],
    );
    const analysisId = analysisResult.rows[0]?.id;

    // Save to reply queue
    await query(
      `INSERT INTO email_replies
         (email_id, analysis_id, generated_reply, approval_status)
       VALUES ($1,$2,$3,'pending')`,
      [emailId, analysisId, replyText],
    );
  } catch (err) {
    logger.warn('Could not save to approval queue', { error: err.message });
  }
}

async function markEmailProcessed(messageId, decision) {
  try {
    const statusMap = {
      AUTO_REPLY: 'replied',
      NEEDS_APPROVAL: 'pending',
      DELETE: 'trashed',
      IGNORE: 'ignored',
    };
    const status = statusMap[decision] || 'processed';
    await query(
      `UPDATE emails SET status = $1 WHERE message_id = $2`,
      [status, messageId],
    );
  } catch {
    // silent fail — email row may not exist yet
  }
}

async function wasAlreadyProcessed(messageId) {
  try {
    const r = await query(
      "SELECT 1 FROM emails WHERE message_id = $1 AND status NOT IN ('pending')",
      [messageId],
    );
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

// ─── Single email processor ───────────────────────────────────────────────────

/**
 * processEmail — run one email through the full pipeline.
 *
 * @param {object} gmail  — googleapis gmail client
 * @param {object} email  — normalized email object
 * @returns {{ decision, intent, confidence, replyType }}
 */
async function processEmail(gmail, email) {
  const logCtx = { sender: email.sender, subject: email.subject };

  // ── 0. Dedup ─────────────────────────────────────────────────────────────
  if (await wasAlreadyProcessed(email.messageId)) {
    logger.debug('Email already processed — skipping', logCtx);
    return { decision: 'SKIPPED' };
  }

  // ── 1. Spam check (fast path) ────────────────────────────────────────────
  const spam = detectSpam(email);
  if (spam.action === 'DELETE' && spam.confidence >= DELETION_THRESHOLD) {
    logger.info(`SPAM/PROMO detected — deleting (conf: ${spam.confidence})`, logCtx);
    try {
      await gmail.users.messages.trash({ userId: 'me', id: email.messageId });
    } catch (err) {
      logger.warn('Gmail trash failed', { error: err.message });
    }
    await markEmailProcessed(email.messageId, 'DELETE');
    return { decision: 'DELETE', reason: spam.reason, confidence: spam.confidence };
  }

  // ── 2. Heuristic analysis ────────────────────────────────────────────────
  const contactInfo = await getContactInfo(email.sender);
  const analysis    = fallbackAnalysis({
    ...email,
    isKnownContact: !!contactInfo && contactInfo.trust_level !== 'blocked',
  });

  logger.info(`Analysis: intent=${analysis.intent} tone=${analysis.tone} conf=${analysis.confidence} decision=${analysis.suggestedDecision}`, logCtx);

  // ── 3. Record sender ─────────────────────────────────────────────────────
  await recordSender(email.sender, email.senderName);

  // ── 4. Meeting scheduling path ───────────────────────────────────────────
  let replyText, replySubject, replyType;

  if (analysis.intent === 'meeting_request') {
    const meetingDetails = extractMeetingDetails(email);
    const firstName = (email.senderName || email.sender.split('@')[0]).split(/\s+/)[0];
    replyText    = buildMeetingReply(meetingDetails, firstName);
    replySubject = email.subject?.startsWith('Re:') ? email.subject : `Re: ${email.subject}`;
    replyType    = 'meeting_request';

    // Optionally create calendar event for high-confidence known contacts
    if (analysis.confidence >= AUTO_REPLY_CONFIDENCE_MIN && contactInfo) {
      const slots = require('./meetingScheduler').generateSlots(1, meetingDetails.durationMinutes);
      await createCalendarEvent(meetingDetails, email.sender, slots[0]);
    }
  } else {
    // ── 5. Standard reply generation ────────────────────────────────────────
    const reply  = generateReply(email, analysis);
    replyText    = reply.body;
    replySubject = reply.subject;
    replyType    = reply.replyType;
  }

  // ── 6. Decision routing ───────────────────────────────────────────────────
  const isBlocked        = contactInfo?.trust_level === 'blocked';
  const isKnown          = !!contactInfo && !isBlocked;
  const safeTone         = !['angry', 'negative'].includes(analysis.tone);
  const isHighPriority   = analysis.priority === 'high';
  const isUnknown        = !contactInfo;

  // NEEDS_APPROVAL only when: unknown sender + high priority, OR angry/negative tone
  const needsApproval = (isUnknown && isHighPriority) || !safeTone;

  // Auto-reply everything else (known contacts, unknown+low/medium priority, safe tone)
  const autoReplyOk = AUTO_REPLY_ENABLED && !isBlocked && !needsApproval;

  if (analysis.suggestedDecision === 'IGNORE') {
    logger.info('Informational email — ignoring (no reply needed)', logCtx);
    await markEmailProcessed(email.messageId, 'IGNORE');
    return { decision: 'IGNORE', intent: analysis.intent, confidence: analysis.confidence };
  }

  if (isBlocked) {
    logger.info('Blocked sender — ignoring', logCtx);
    await markEmailProcessed(email.messageId, 'IGNORE');
    return { decision: 'IGNORE', reason: 'blocked sender' };
  }

  if (autoReplyOk) {
    // ── AUTO-REPLY ──────────────────────────────────────────────────────────
    try {
      await sendGmailReply(gmail, email, replyText, replySubject);
      await markEmailProcessed(email.messageId, 'AUTO_REPLY');
      logger.info(`AUTO_REPLY sent | intent=${analysis.intent} conf=${analysis.confidence}`, logCtx);
      return { decision: 'AUTO_REPLY', intent: analysis.intent, confidence: analysis.confidence, replyType };
    } catch (err) {
      logger.error('Failed to send auto-reply — falling back to approval queue', { error: err.message });
      // fall through to approval queue
    }
  }

  // ── NEEDS_APPROVAL ─────────────────────────────────────────────────────
  const queueReason =
    !AUTO_REPLY_ENABLED  ? 'AUTO_REPLY_ENABLED=false in config' :
    isBlocked            ? 'Sender is blocked' :
    !safeTone            ? `Tone is ${analysis.tone} — requires human review` :
    (isUnknown && isHighPriority) ? `Unknown sender with high priority — requires human review` :
    'Routed to approval queue';

  await saveToApprovalQueue(email, analysis, replyText, replySubject, queueReason);
  await markEmailProcessed(email.messageId, 'NEEDS_APPROVAL');

  logger.info(`NEEDS_APPROVAL — queued for review | reason: ${queueReason}`, logCtx);
  return { decision: 'NEEDS_APPROVAL', intent: analysis.intent, confidence: analysis.confidence, replyType, reason: queueReason };
}

// ─── Batch processor ──────────────────────────────────────────────────────────

/**
 * runAgentCycle — fetch unread Gmail messages and process each one.
 * Called by the scheduler (cron) or manually via POST /api/run-agent.
 */
async function runAgentCycle() {
  const startTime = Date.now();
  logger.info('=== Agent cycle started ===');

  const { google } = require('googleapis');
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI,
  );
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  // Pull unread inbox emails (exclude those we sent)
  let messageList;
  try {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread in:inbox -from:me',
      maxResults: parseInt(process.env.BATCH_SIZE) || 20,
    });
    messageList = res.data.messages || [];
  } catch (err) {
    logger.error('Failed to fetch Gmail messages', { error: err.message });
    return { success: false, error: err.message };
  }

  if (messageList.length === 0) {
    logger.info('No unread messages — cycle complete');
    return { success: true, processed: 0 };
  }

  logger.info(`Fetched ${messageList.length} unread message(s)`);

  const results = { AUTO_REPLY: 0, NEEDS_APPROVAL: 0, DELETE: 0, IGNORE: 0, SKIPPED: 0, ERROR: 0 };

  for (const msg of messageList) {
    try {
      // Fetch full message
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      // Normalise into our email schema
      const headers    = full.data.payload?.headers || [];
      const getHeader  = (n) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || '';
      const decodeBody = (data) => data ? Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8') : '';

      let body = '';
      const extractText = (parts) => {
        for (const p of (parts || [])) {
          if (p.mimeType === 'text/plain' && p.body?.data) { body = decodeBody(p.body.data); return; }
          if (p.parts) extractText(p.parts);
        }
      };
      if (full.data.payload?.mimeType === 'text/plain') {
        body = decodeBody(full.data.payload.body?.data);
      } else {
        extractText(full.data.payload?.parts);
      }

      const email = {
        messageId:  msg.id,
        threadId:   full.data.threadId,
        sender:     getHeader('from').match(/<(.+)>/)?.[1] || getHeader('from'),
        senderName: getHeader('from').match(/^([^<]+)/)?.[1]?.trim() || '',
        subject:    getHeader('subject'),
        body:       body.substring(0, 3000),
        receivedAt: new Date(parseInt(full.data.internalDate)),
        provider:   'gmail',
      };

      const result = await processEmail(gmail, email);
      results[result.decision] = (results[result.decision] || 0) + 1;

      // Mark as read after processing
      try {
        await gmail.users.messages.modify({
          userId: 'me', id: msg.id,
          requestBody: { removeLabelIds: ['UNREAD'] },
        });
      } catch { /* non-critical */ }

    } catch (err) {
      logger.error(`Failed to process message ${msg.id}`, { error: err.message });
      results.ERROR++;
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`=== Agent cycle complete in ${duration}ms ===`, results);
  return { success: true, duration, results };
}

module.exports = { runAgentCycle, processEmail };