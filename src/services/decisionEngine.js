// src/services/decisionEngine.js
// Decision engine: determines AUTO_REPLY, NEEDS_APPROVAL, IGNORE, or DELETE
// Safety-first: when in doubt, escalate to human

const { query } = require('../config/database');
const logger = require('../config/logger');

// Confidence threshold for deletion (from env, default 90%)
const DELETION_THRESHOLD = parseFloat(process.env.DELETION_CONFIDENCE_THRESHOLD) || 0.90;

class DecisionEngine {
  // ============================================================
  // MAIN: Compute final decision for an email + analysis
  // ============================================================
  async computeDecision(email, aiAnalysis) {
    logger.info(`Computing decision for email from ${email.sender}`);

    // Step 1: Check if sender is a known/trusted/blocked contact
    const contactInfo = await this._getContactInfo(email.sender);

    // Step 2: Run all safety checks
    const checks = this._runSafetyChecks(email, aiAnalysis, contactInfo);

    // Step 3: Apply decision rules (in priority order)
    const decision = this._applyRules(email, aiAnalysis, contactInfo, checks);

    logger.info(`Decision: ${decision.action}`, {
      reason: decision.reason,
      confidence: decision.finalConfidence,
    });

    // Update known contacts if sender is new
    if (!contactInfo) {
      await this._recordNewSender(email);
    } else {
      await this._incrementInteractionCount(email.sender);
    }

    return {
      ...decision,
      contactInfo,
      checks,
    };
  }

  // ============================================================
  // Safety checks - comprehensive guard rails
  // ============================================================
  _runSafetyChecks(email, analysis, contactInfo) {
    return {
      // Sender checks
      isKnownContact: !!contactInfo && contactInfo.trust_level !== 'blocked',
      isTrustedContact: contactInfo?.trust_level === 'trusted',
      isBlockedContact: contactInfo?.trust_level === 'blocked',

      // Content safety checks
      isHighPriority: analysis.priority === 'high',
      isMediumPriority: analysis.priority === 'medium',
      isAngryTone: analysis.tone === 'angry',
      isUrgentTone: analysis.tone === 'urgent',
      isEmotionalContent: ['angry', 'urgent'].includes(analysis.tone),
      isHumorous: analysis.tone === 'humorous',

      // Intent checks
      isSpam: analysis.intent === 'spam',
      isPromotional: analysis.intent === 'promotional',
      isMeetingRequest: analysis.intent === 'meeting_request',
      isQuestion: analysis.intent === 'question',
      isTaskRequest: analysis.intent === 'task_request',
      isInformational: analysis.intent === 'informational',

      // Confidence checks
      isHighConfidence: analysis.confidence >= 0.85,
      isDeletionSafe: analysis.confidence >= DELETION_THRESHOLD,
      isLowConfidence: analysis.confidence < 0.60,

      // Sender domain checks
      isFromTrustedDomain: this._isFromTrustedDomain(email.sender),
      isLikelyMarketing: this._detectMarketingPatterns(email),
    };
  }

  // ============================================================
  // Decision rules - strict priority order
  // ============================================================
  _applyRules(email, analysis, contactInfo, checks) {
    // ---- RULE 1: NEVER delete emails from known/trusted contacts ----
    if (checks.isKnownContact || checks.isTrustedContact) {
      if (checks.isSpam || checks.isPromotional) {
        // Even known contacts can send promotions - but we DON'T delete
        logger.info(`Known contact email flagged as ${analysis.intent} - overriding to IGNORE`);
        return {
          action: 'IGNORE',
          reason: 'Known contact - overriding spam/promo classification for safety',
          finalConfidence: analysis.confidence,
          overridden: true,
        };
      }
    }

    // ---- RULE 2: Block/blacklisted senders -> DELETE with high confidence ----
    if (checks.isBlockedContact && checks.isDeletionSafe) {
      return {
        action: 'DELETE',
        reason: 'Sender is in blocked contacts list',
        finalConfidence: analysis.confidence,
      };
    }

    // ---- RULE 3: Clear spam - DELETE only if high confidence ----
    if (checks.isSpam && checks.isDeletionSafe) {
      return {
        action: 'DELETE',
        reason: `Classified as spam with ${Math.round(analysis.confidence * 100)}% confidence`,
        finalConfidence: analysis.confidence,
      };
    }

    // ---- RULE 4: Promotional/marketing - DELETE or IGNORE ----
    if (checks.isPromotional || checks.isLikelyMarketing) {
      if (checks.isDeletionSafe) {
        return {
          action: 'DELETE',
          reason: 'Promotional/marketing email above deletion confidence threshold',
          finalConfidence: analysis.confidence,
          suggestFolder: 'Promotions',  // Optional: move to promotions folder instead
        };
      }
      return {
        action: 'IGNORE',
        reason: 'Promotional email - insufficient confidence to delete, ignoring',
        finalConfidence: analysis.confidence,
      };
    }

    // ---- RULE 5: High/medium priority emails - NEVER auto-delete ----
    if (checks.isHighPriority || checks.isMediumPriority) {
      // Still determine if we reply or need approval
      if (this._canAutoReply(checks, analysis)) {
        return {
          action: 'AUTO_REPLY',
          reason: `High/medium priority ${analysis.intent} from ${checks.isKnownContact ? 'known' : 'unknown'} contact`,
          finalConfidence: analysis.confidence,
        };
      }
      return {
        action: 'NEEDS_APPROVAL',
        reason: `High/medium priority email requires human review`,
        finalConfidence: analysis.confidence,
      };
    }

    // ---- RULE 6: Emotional/angry tone -> human approval always ----
    if (checks.isEmotionalContent) {
      return {
        action: 'NEEDS_APPROVAL',
        reason: `Email has ${analysis.tone} tone - requires human sensitivity`,
        finalConfidence: analysis.confidence,
      };
    }

    // ---- RULE 7: Unknown sender + complex/unclear request ----
    if (!checks.isKnownContact && !checks.isFromTrustedDomain) {
      if (checks.isTaskRequest || checks.isMeetingRequest) {
        return {
          action: 'NEEDS_APPROVAL',
          reason: 'Unknown sender with action-required email',
          finalConfidence: analysis.confidence,
        };
      }
    }

    // ---- RULE 8: Low confidence -> always need approval ----
    if (checks.isLowConfidence) {
      return {
        action: 'NEEDS_APPROVAL',
        reason: `Low confidence (${Math.round(analysis.confidence * 100)}%) - requires human review`,
        finalConfidence: analysis.confidence,
      };
    }

    // ---- RULE 9: AUTO_REPLY conditions ----
    if (this._canAutoReply(checks, analysis)) {
      return {
        action: 'AUTO_REPLY',
        reason: `Safe auto-reply: known contact, ${analysis.intent}, ${analysis.tone} tone`,
        finalConfidence: analysis.confidence,
      };
    }

    // ---- RULE 10: Informational only -> IGNORE ----
    if (checks.isInformational && !checks.isHighPriority) {
      return {
        action: 'IGNORE',
        reason: 'Informational email requiring no response',
        finalConfidence: analysis.confidence,
      };
    }

    // ---- DEFAULT: When in doubt, escalate to human ----
    return {
      action: 'NEEDS_APPROVAL',
      reason: 'No clear rule matched - defaulting to human approval for safety',
      finalConfidence: analysis.confidence,
    };
  }

  // ============================================================
  // Helper: Can we safely auto-reply?
  // ============================================================
  _canAutoReply(checks, analysis) {
    return (
      checks.isKnownContact &&          // Must know the sender
      !checks.isEmotionalContent &&      // No emotional tone
      !checks.isLowConfidence &&         // High enough confidence
      analysis.isSafeToAutoReply &&      // AI says it's safe
      ['question', 'meeting_request', 'task_request', 'personal'].includes(analysis.intent) &&
      ['formal', 'informal', 'friendly', 'neutral'].includes(analysis.tone)
    );
  }

  // ============================================================
  // Helpers
  // ============================================================
  _isFromTrustedDomain(senderEmail) {
    const trustedDomains = (process.env.TRUSTED_DOMAINS || '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);

    const domain = senderEmail.split('@')[1]?.toLowerCase();
    return domain ? trustedDomains.includes(domain) : false;
  }

  _detectMarketingPatterns(email) {
    const marketingKeywords = [
      'unsubscribe', 'click here', 'limited time', 'act now', 'exclusive offer',
      'discount', '% off', 'free shipping', 'sale ends', 'deal of the day',
      'newsletter', 'weekly digest', 'promotion', 'subscribe', 'opt out',
    ];

    const text = `${email.subject || ''} ${email.body || ''}`.toLowerCase();
    const matches = marketingKeywords.filter((kw) => text.includes(kw));
    return matches.length >= 2;  // 2+ marketing keywords = likely marketing
  }

  async _getContactInfo(email) {
    try {
      const result = await query(
        'SELECT * FROM known_contacts WHERE email = $1',
        [email.toLowerCase()]
      );
      return result.rows[0] || null;
    } catch {
      return null;
    }
  }

  async _recordNewSender(email) {
    try {
      const domain = email.sender?.split('@')[1] || '';
      await query(
        `INSERT INTO known_contacts (email, name, domain, trust_level, interaction_count)
         VALUES ($1, $2, $3, 'known', 1)
         ON CONFLICT (email) DO UPDATE SET interaction_count = known_contacts.interaction_count + 1`,
        [email.sender?.toLowerCase(), email.senderName || '', domain.toLowerCase()]
      );
    } catch (err) {
      logger.warn('Failed to record new sender', { error: err.message });
    }
  }

  async _incrementInteractionCount(senderEmail) {
    try {
      await query(
        'UPDATE known_contacts SET interaction_count = interaction_count + 1, updated_at = NOW() WHERE email = $1',
        [senderEmail.toLowerCase()]
      );
    } catch {
      // Non-critical
    }
  }
}

module.exports = new DecisionEngine();
