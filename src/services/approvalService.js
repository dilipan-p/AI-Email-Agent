// src/services/approvalService.js
// Manages the human approval workflow for AI-generated replies

const { query, withTransaction } = require('../config/database');
const emailService = require('./emailService');
const logger = require('../config/logger');

class ApprovalService {
  // ============================================================
  // Store a generated reply for approval
  // ============================================================
  async queueForApproval(emailId, analysisId, generatedReply) {
    try {
      const result = await query(
        `INSERT INTO email_replies (email_id, analysis_id, generated_reply, approval_status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING id`,
        [emailId, analysisId, generatedReply]
      );

      const replyId = result.rows[0].id;
      logger.info(`Reply queued for approval`, { replyId, emailId });

      // Audit log
      await this._audit('reply_queued', 'email_reply', replyId, {
        emailId, analysisId,
      });

      return { success: true, replyId };
    } catch (err) {
      logger.error('Failed to queue reply for approval', { error: err.message });
      throw err;
    }
  }

  // ============================================================
  // Get all pending approvals with email details
  // ============================================================
  async getPendingApprovals(limit = 50, offset = 0) {
    const result = await query(
      `SELECT
         r.id as reply_id,
         r.generated_reply,
         r.final_reply,
         r.approval_status,
         r.created_at as queued_at,
         e.id as email_id,
         e.sender_email,
         e.sender_name,
         e.subject,
         e.body,
         e.provider,
         e.thread_id,
         e.message_id,
         e.received_at,
         a.intent,
         a.tone,
         a.priority,
         a.confidence,
         a.reasoning,
         a.decision
       FROM email_replies r
       JOIN emails e ON r.email_id = e.id
       LEFT JOIN email_analyses a ON r.analysis_id = a.id
       WHERE r.approval_status = 'pending'
       ORDER BY
         CASE a.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         r.created_at ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return {
      items: result.rows,
      total: result.rows.length,
      offset,
    };
  }

  // ============================================================
  // Approve a reply (optionally with edited text)
  // ============================================================
  async approveReply(replyId, approvedBy = 'human', editedReply = null) {
    return withTransaction(async (client) => {
      // Get the reply and its linked email
      const replyResult = await client.query(
        `SELECT r.*, e.provider, e.message_id, e.thread_id, e.sender_email, e.subject
         FROM email_replies r
         JOIN emails e ON r.email_id = e.id
         WHERE r.id = $1 AND r.approval_status = 'pending'`,
        [replyId]
      );

      if (replyResult.rows.length === 0) {
        throw new Error(`Reply ${replyId} not found or not in pending status`);
      }

      const reply = replyResult.rows[0];
      const textToSend = editedReply || reply.generated_reply;

      // Send the reply via the correct email provider
      await emailService.sendReply(
        reply.provider,
        reply.message_id,
        reply.thread_id,
        reply.sender_email,
        reply.subject,
        textToSend
      );

      // Update reply status
      await client.query(
        `UPDATE email_replies
         SET approval_status = 'sent',
             final_reply = $1,
             approved_by = $2,
             approved_at = NOW(),
             sent_at = NOW()
         WHERE id = $3`,
        [textToSend, approvedBy, replyId]
      );

      // Update email status
      await client.query(
        `UPDATE emails SET status = 'replied' WHERE id = $1`,
        [reply.email_id]
      );

      // Audit
      await this._audit('reply_approved_and_sent', 'email_reply', replyId, {
        approvedBy, wasEdited: !!editedReply,
      });

      logger.info(`Reply ${replyId} approved and sent`, { approvedBy });
      return { success: true, replyId, sentTo: reply.sender_email };
    });
  }

  // ============================================================
  // Reject a reply
  // ============================================================
  async rejectReply(replyId, rejectedBy = 'human', reason = '') {
    const result = await query(
      `UPDATE email_replies
       SET approval_status = 'rejected',
           approved_by = $1,
           approved_at = NOW(),
           rejection_reason = $2
       WHERE id = $3 AND approval_status = 'pending'
       RETURNING id, email_id`,
      [rejectedBy, reason, replyId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Reply ${replyId} not found or not pending`);
    }

    // Update email status back to processed
    await query(
      `UPDATE emails SET status = 'ignored' WHERE id = $1`,
      [result.rows[0].email_id]
    );

    await this._audit('reply_rejected', 'email_reply', replyId, {
      rejectedBy, reason,
    });

    logger.info(`Reply ${replyId} rejected`, { reason });
    return { success: true, replyId };
  }

  // ============================================================
  // Auto-send without approval (for AUTO_REPLY decisions)
  // ============================================================
  async autoSendReply(emailId, analysisId, generatedReply, emailData) {
    if (process.env.AUTO_REPLY_ENABLED !== 'true') {
      logger.info('AUTO_REPLY disabled in config - routing to approval queue');
      return this.queueForApproval(emailId, analysisId, generatedReply);
    }

    return withTransaction(async (client) => {
      // Send immediately
      await emailService.sendReply(
        emailData.provider,
        emailData.messageId,
        emailData.threadId,
        emailData.sender,
        emailData.subject,
        generatedReply
      );

      // Store with auto_sent status
      await client.query(
        `INSERT INTO email_replies
           (email_id, analysis_id, generated_reply, final_reply, approval_status, sent_at)
         VALUES ($1, $2, $3, $3, 'auto_sent', NOW())`,
        [emailId, analysisId, generatedReply]
      );

      // Update email status
      await client.query(
        `UPDATE emails SET status = 'replied' WHERE id = $1`,
        [emailId]
      );

      await this._audit('reply_auto_sent', 'email', emailId, {
        to: emailData.sender,
      });

      logger.info(`Auto-sent reply for email ${emailId}`);
      return { success: true, autoSent: true };
    });
  }

  // Get approval stats
  async getStats() {
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE approval_status = 'pending') as pending_count,
         COUNT(*) FILTER (WHERE approval_status = 'sent') as sent_count,
         COUNT(*) FILTER (WHERE approval_status = 'auto_sent') as auto_sent_count,
         COUNT(*) FILTER (WHERE approval_status = 'rejected') as rejected_count
       FROM email_replies`
    );
    return result.rows[0];
  }

  async _audit(eventType, entityType, entityId, details) {
    try {
      await query(
        `INSERT INTO audit_log (event_type, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4)`,
        [eventType, entityType, entityId, JSON.stringify(details)]
      );
    } catch {
      // Audit failures are non-fatal
    }
  }
}

module.exports = new ApprovalService();
