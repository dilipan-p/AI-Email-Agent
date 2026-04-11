// src/services/processorService.js
// Orchestrates the full email processing pipeline:
// Fetch → Normalize → Store → Analyze → Decide → Act

const { query, withTransaction } = require('../config/database');
const emailService = require('./emailService');
const aiService = require('./aiService');
const decisionEngine = require('./decisionEngine');
const calendarService = require('./calendarService');
const approvalService = require('./approvalService');
const cleanupService = require('./cleanupService');
const logger = require('../config/logger');

class ProcessorService {
  // ============================================================
  // Process a single normalized email (full pipeline)
  // ============================================================
  async processEmail(normalizedEmail) {
    logger.info(`Processing email: "${normalizedEmail.subject}" from ${normalizedEmail.sender}`);

    // Step 1: Check if already processed (dedup)
    const existing = await query(
      'SELECT id, status FROM emails WHERE message_id = $1',
      [normalizedEmail.messageId]
    );

    let emailId;

    if (existing.rows.length > 0) {
      if (existing.rows[0].status !== 'pending') {
        logger.info(`Email ${normalizedEmail.messageId} already processed, skipping`);
        return { skipped: true, reason: 'Already processed' };
      }
      emailId = existing.rows[0].id;
    } else {
      // Step 2: Store normalized email
      const inserted = await query(
        `INSERT INTO emails
           (provider, message_id, thread_id, sender_email, sender_name, subject,
            body, html_body, received_at, status, raw_headers)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)
         RETURNING id`,
        [
          normalizedEmail.provider,
          normalizedEmail.messageId,
          normalizedEmail.threadId,
          normalizedEmail.sender,
          normalizedEmail.senderName,
          normalizedEmail.subject,
          normalizedEmail.body,
          normalizedEmail.htmlBody,
          normalizedEmail.receivedAt,
          JSON.stringify(normalizedEmail.rawHeaders || {}),
        ]
      );
      emailId = inserted.rows[0].id;
    }

    // Step 3: Check if sender is a known contact
    const contactCheck = await query(
      'SELECT * FROM known_contacts WHERE email = $1',
      [normalizedEmail.sender?.toLowerCase()]
    );
    normalizedEmail.isKnownContact = contactCheck.rows.length > 0 &&
      contactCheck.rows[0].trust_level !== 'blocked';

    // Step 4: AI analysis
    const analysis = await aiService.analyzeEmail(normalizedEmail);

    // Step 5: Run through decision engine
    const decision = await decisionEngine.computeDecision(normalizedEmail, analysis);

    // Step 6: Store analysis result
    const analysisResult = await query(
      `INSERT INTO email_analyses
         (email_id, intent, tone, priority, decision, confidence, reasoning,
          key_points, extracted_datetime, extracted_participants, ai_model, tokens_used,
          analysis_duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        emailId,
        analysis.intent,
        analysis.tone,
        analysis.priority,
        decision.action,
        analysis.confidence,
        analysis.reasoning,
        JSON.stringify(analysis.keyPoints || []),
        analysis.extractedDatetime,
        JSON.stringify(analysis.extractedParticipants || []),
        analysis.aiModel,
        analysis.tokensUsed,
        analysis.analysisDurationMs,
      ]
    );
    const analysisId = analysisResult.rows[0].id;

    // Step 7: Execute the decision
    const outcome = await this._executeDecision(
      decision.action, emailId, analysisId, analysis, decision, normalizedEmail
    );

    logger.info(`Email processed`, {
      emailId,
      decision: decision.action,
      outcome: outcome.result,
    });

    return {
      emailId,
      analysisId,
      decision: decision.action,
      confidence: analysis.confidence,
      intent: analysis.intent,
      tone: analysis.tone,
      priority: analysis.priority,
      outcome,
    };
  }

  // ============================================================
  // Execute the final decision
  // ============================================================
  async _executeDecision(action, emailId, analysisId, analysis, decision, emailData) {
    switch (action) {
      case 'AUTO_REPLY': {
        // Generate a contextual reply
        const reply = await aiService.generateReply(emailData, analysis);

        // Handle meeting requests specially
        if (analysis.intent === 'meeting_request') {
          const meetingDetails = await aiService.extractMeetingDetails(emailData);
          if (meetingDetails.hasMeetingRequest) {
            // Try to schedule or suggest slots
            const calResult = await calendarService.scheduleMeetingFromEmail(
              emailData, meetingDetails, emailId
            ).catch((err) => {
              logger.warn('Calendar scheduling failed', { error: err.message });
              return null;
            });

            if (calResult?.suggestedSlots?.length > 0) {
              const slotsText = calResult.suggestedSlots
                .slice(0, 3)
                .map((s) => `- ${s.displayTime}`)
                .join('\n');
              const enhancedReply = `${reply}\n\nI have the following time slots available:\n${slotsText}\n\nPlease let me know which works best for you.`;

              return {
                result: 'queued_for_approval',
                replyId: (await approvalService.queueForApproval(emailId, analysisId, enhancedReply)).replyId,
                note: 'Meeting reply with calendar slots',
              };
            }
          }
        }

        // Try auto-send (respects AUTO_REPLY_ENABLED env flag)
        const sendResult = await approvalService.autoSendReply(
          emailId, analysisId, reply, emailData
        );

        return {
          result: sendResult.autoSent ? 'auto_sent' : 'queued_for_approval',
          replyId: sendResult.replyId,
        };
      }

      case 'NEEDS_APPROVAL': {
        const reply = await aiService.generateReply(emailData, analysis);
        const queueResult = await approvalService.queueForApproval(emailId, analysisId, reply);
        await query(`UPDATE emails SET status = 'processed' WHERE id = $1`, [emailId]);
        return { result: 'queued_for_approval', replyId: queueResult.replyId };
      }

      case 'IGNORE': {
        await query(`UPDATE emails SET status = 'ignored' WHERE id = $1`, [emailId]);
        return { result: 'ignored' };
      }

      case 'DELETE': {
        const emailRecord = {
          id: emailId,
          provider: emailData.provider,
          message_id: emailData.messageId,
          sender_email: emailData.sender,
          subject: emailData.subject,
        };
        const analysisRecord = {
          confidence: analysis.confidence,
          intent: analysis.intent,
          priority: analysis.priority,
          reasoning: analysis.reasoning,
        };
        const cleanupResult = await cleanupService.processDeleteDecision(
          emailRecord, analysisRecord, decision
        );
        return { result: 'deleted', details: cleanupResult };
      }

      default:
        logger.warn(`Unknown decision action: ${action}`);
        await query(`UPDATE emails SET status = 'processed' WHERE id = $1`, [emailId]);
        return { result: 'unknown_action' };
    }
  }

  // ============================================================
  // Process all incoming emails from all providers
  // ============================================================
  async processAllIncoming(maxPerProvider = 20) {
    logger.info('Starting email batch processing...');

    const { emails, errors } = await emailService.fetchAllEmails(maxPerProvider);

    if (errors.length > 0) {
      logger.warn(`Fetch errors from ${errors.length} provider(s)`, { errors });
    }

    const results = {
      total: emails.length,
      processed: 0,
      autoReplied: 0,
      queued: 0,
      ignored: 0,
      deleted: 0,
      errors: 0,
      skipped: 0,
    };

    for (const email of emails) {
      try {
        const outcome = await this.processEmail(email);

        if (outcome.skipped) {
          results.skipped++;
          continue;
        }

        results.processed++;
        const result = outcome.outcome?.result;

        if (result === 'auto_sent') results.autoReplied++;
        else if (result === 'queued_for_approval') results.queued++;
        else if (result === 'ignored') results.ignored++;
        else if (result === 'deleted') results.deleted++;
      } catch (err) {
        results.errors++;
        logger.error(`Failed to process email`, {
          error: err.message,
          subject: email.subject,
          sender: email.sender,
        });
      }
    }

    logger.info('Batch processing complete', results);
    return { ...results, fetchErrors: errors };
  }

  // ============================================================
  // Process a single email by database ID (for re-processing)
  // ============================================================
  async reprocessEmailById(emailId) {
    const result = await query(
      `SELECT * FROM emails WHERE id = $1`,
      [emailId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Email ${emailId} not found`);
    }

    const row = result.rows[0];
    const normalized = {
      messageId: row.message_id,
      threadId: row.thread_id,
      provider: row.provider,
      sender: row.sender_email,
      senderName: row.sender_name,
      subject: row.subject,
      body: row.body,
      htmlBody: row.html_body,
      receivedAt: row.received_at,
    };

    // Reset status to pending for reprocessing
    await query(`UPDATE emails SET status = 'pending' WHERE id = $1`, [emailId]);

    return this.processEmail(normalized);
  }
}

module.exports = new ProcessorService();
