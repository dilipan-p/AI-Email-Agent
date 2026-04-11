// src/services/cleanupService.js
// Smart inbox cleaning with strict safety guards
// Maintains deletion logs for recovery

const { query, withTransaction } = require('../config/database');
const emailService = require('./emailService');
const logger = require('../config/logger');

const DELETION_THRESHOLD = parseFloat(process.env.DELETION_CONFIDENCE_THRESHOLD) || 0.90;

class CleanupService {
  // ============================================================
  // Process a DELETE decision - with all safety checks
  // ============================================================
  async processDeleteDecision(emailRecord, analysisRecord, decision) {
    logger.info(`Processing DELETE for email ${emailRecord.id}`);

    // SAFETY CHECKS - abort if any fail
    if (!this._isSafeToDelete(emailRecord, analysisRecord, decision)) {
      logger.warn(`DELETE aborted for safety reasons`, {
        emailId: emailRecord.id,
        confidence: analysisRecord.confidence,
      });

      // Downgrade to IGNORE
      await query(
        `UPDATE emails SET status = 'ignored' WHERE id = $1`,
        [emailRecord.id]
      );
      return { action: 'IGNORED', reason: 'Safety check failed - downgraded to ignore' };
    }

    // Determine action type
    const action = this._determineCleanupAction(analysisRecord);

    return withTransaction(async (client) => {
      let providerResult = { success: true };
      let errorMsg = null;

      try {
        if (action === 'trash') {
          providerResult = await emailService.trashMessage(
            emailRecord.provider,
            emailRecord.message_id
          );
        } else if (action === 'move_to_promotions') {
          providerResult = await emailService.moveToFolder(
            emailRecord.provider,
            emailRecord.message_id,
            'Promotions'
          );
        } else if (action === 'move_to_spam') {
          providerResult = await emailService.moveToFolder(
            emailRecord.provider,
            emailRecord.message_id,
            'Spam'
          );
        }
      } catch (err) {
        errorMsg = err.message;
        logger.error(`Provider action failed for ${emailRecord.id}`, { error: err.message });
      }

      // Log deletion for recovery regardless of provider success
      await client.query(
        `INSERT INTO deletion_log
           (email_id, message_id, sender_email, subject, reason, confidence, action)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          emailRecord.id,
          emailRecord.message_id,
          emailRecord.sender_email,
          emailRecord.subject,
          analysisRecord.reasoning || 'AI classification',
          analysisRecord.confidence,
          action,
        ]
      );

      // Update email status
      const newStatus = action === 'trash' ? 'deleted' : 'trashed';
      await client.query(
        `UPDATE emails SET status = $1 WHERE id = $2`,
        [newStatus, emailRecord.id]
      );

      // Audit trail
      await client.query(
        `INSERT INTO audit_log (event_type, entity_type, entity_id, details)
         VALUES ('email_cleaned', 'email', $1, $2)`,
        [emailRecord.id, JSON.stringify({ action, reason: decision.reason, confidence: analysisRecord.confidence })]
      );

      logger.info(`Email ${emailRecord.id} processed: ${action}${errorMsg ? ' (with error: ' + errorMsg + ')' : ''}`);

      return {
        action,
        emailId: emailRecord.id,
        subject: emailRecord.subject,
        sender: emailRecord.sender_email,
        providerSuccess: providerResult.success,
        error: errorMsg,
      };
    });
  }

  // ============================================================
  // Bulk cleanup - scan inbox for deletable emails
  // ============================================================
  async runBulkCleanup(limit = 50) {
    logger.info('Starting bulk inbox cleanup...');

    // Find emails marked DELETE that haven't been processed
    const result = await query(
      `SELECT e.*, a.confidence, a.intent, a.reasoning
       FROM emails e
       JOIN email_analyses a ON a.email_id = e.id
       WHERE e.status = 'pending'
         AND a.decision = 'DELETE'
         AND a.confidence >= $1
       ORDER BY e.received_at DESC
       LIMIT $2`,
      [DELETION_THRESHOLD, limit]
    );

    const emails = result.rows;
    logger.info(`Found ${emails.length} emails eligible for cleanup`);

    const results = {
      processed: 0,
      trashed: 0,
      moved: 0,
      skipped: 0,
      errors: 0,
    };

    for (const email of emails) {
      try {
        const emailRecord = {
          id: email.id,
          provider: email.provider,
          message_id: email.message_id,
          sender_email: email.sender_email,
          subject: email.subject,
        };
        const analysisRecord = {
          confidence: email.confidence,
          intent: email.intent,
          reasoning: email.reasoning,
        };
        const decision = { reason: 'Bulk cleanup', action: 'DELETE' };

        const outcome = await this.processDeleteDecision(emailRecord, analysisRecord, decision);

        results.processed++;
        if (outcome.action === 'trash') results.trashed++;
        else if (outcome.action.startsWith('move')) results.moved++;
      } catch (err) {
        results.errors++;
        logger.error(`Cleanup error for email ${email.id}`, { error: err.message });
      }
    }

    logger.info('Bulk cleanup complete', results);
    return results;
  }

  // ============================================================
  // Recover a deleted email (mark as recovered in log)
  // ============================================================
  async recoverEmail(deletionLogId) {
    const result = await query(
      `UPDATE deletion_log
       SET recovered = TRUE
       WHERE id = $1
       RETURNING *`,
      [deletionLogId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Deletion log entry ${deletionLogId} not found`);
    }

    // Update email status back
    await query(
      `UPDATE emails SET status = 'pending' WHERE id = $1`,
      [result.rows[0].email_id]
    );

    logger.info(`Email marked as recovered in deletion log`, { deletionLogId });
    return {
      success: true,
      message: 'Email marked as recovered. Note: Email may need to be restored from provider trash.',
      record: result.rows[0],
    };
  }

  // ============================================================
  // Get deletion log for audit/review
  // ============================================================
  async getDeletionLog(limit = 100, includeRecovered = false) {
    const result = await query(
      `SELECT * FROM deletion_log
       ${!includeRecovered ? 'WHERE recovered = FALSE' : ''}
       ORDER BY deleted_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  // ============================================================
  // Get cleanup statistics
  // ============================================================
  async getCleanupStats() {
    const result = await query(
      `SELECT
         COUNT(*) as total_cleaned,
         COUNT(*) FILTER (WHERE action = 'trash') as trashed,
         COUNT(*) FILTER (WHERE action LIKE 'move%') as moved,
         COUNT(*) FILTER (WHERE recovered = TRUE) as recovered,
         AVG(confidence)::NUMERIC(5,2) as avg_confidence
       FROM deletion_log`
    );
    return result.rows[0];
  }

  // ============================================================
  // Safety checks
  // ============================================================
  _isSafeToDelete(emailRecord, analysisRecord, decision) {
    // Check 1: Confidence threshold
    if (analysisRecord.confidence < DELETION_THRESHOLD) {
      logger.warn(`DELETE safety: confidence too low (${analysisRecord.confidence} < ${DELETION_THRESHOLD})`);
      return false;
    }

    // Check 2: Never delete high-priority emails
    if (analysisRecord.priority === 'high' || analysisRecord.priority === 'medium') {
      logger.warn('DELETE safety: email has high/medium priority');
      return false;
    }

    // Check 3: Only delete spam/promotional
    if (!['spam', 'promotional'].includes(analysisRecord.intent)) {
      logger.warn(`DELETE safety: intent '${analysisRecord.intent}' is not spam/promotional`);
      return false;
    }

    return true;
  }

  // Determine specific cleanup action based on intent
  _determineCleanupAction(analysisRecord) {
    if (analysisRecord.intent === 'spam') {
      return 'move_to_spam';
    }
    if (analysisRecord.intent === 'promotional') {
      return 'move_to_promotions';  // Softer than trash
    }
    return 'trash';
  }
}

module.exports = new CleanupService();
