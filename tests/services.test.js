// tests/decisionEngine.test.js
// Unit tests for the decision engine

const decisionEngine = require('../src/services/decisionEngine');

// Mock the database
jest.mock('../src/config/database', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  withTransaction: jest.fn(),
}));

describe('DecisionEngine', () => {
  // ── Safety checks ────────────────────────────────
  describe('_runSafetyChecks', () => {
    it('detects spam intent', () => {
      const email = { sender: 'spam@bad.com', subject: 'Click now!', body: '' };
      const analysis = { intent: 'spam', tone: 'neutral', priority: 'low', confidence: 0.95, isSafeToAutoReply: false };
      const checks = decisionEngine._runSafetyChecks(email, analysis, null);
      expect(checks.isSpam).toBe(true);
    });

    it('detects marketing patterns in body', () => {
      const email = {
        sender: 'promo@example.com',
        subject: 'SALE! 80% OFF!',
        body: 'Click here for exclusive offer! Unsubscribe below. Limited time only.',
      };
      const analysis = { intent: 'promotional', tone: 'neutral', priority: 'low', confidence: 0.9, isSafeToAutoReply: false };
      const checks = decisionEngine._runSafetyChecks(email, analysis, null);
      expect(checks.isLikelyMarketing).toBe(true);
    });

    it('flags angry tone as emotional', () => {
      const email = { sender: 'angry@user.com', subject: 'COMPLAINT', body: '' };
      const analysis = { intent: 'other', tone: 'angry', priority: 'high', confidence: 0.88, isSafeToAutoReply: false };
      const checks = decisionEngine._runSafetyChecks(email, analysis, null);
      expect(checks.isEmotionalContent).toBe(true);
      expect(checks.isAngryTone).toBe(true);
    });
  });

  // ── Decision rules ────────────────────────────────
  describe('_applyRules', () => {
    const knownContact = { trust_level: 'known' };

    it('returns AUTO_REPLY for known contact with safe question', () => {
      const email = { sender: 'client@known.com', subject: 'Question', body: '' };
      const analysis = {
        intent: 'question',
        tone: 'formal',
        priority: 'medium',
        confidence: 0.92,
        isSafeToAutoReply: true,
        keyPoints: [],
      };
      const checks = decisionEngine._runSafetyChecks(email, analysis, knownContact);
      const decision = decisionEngine._applyRules(email, analysis, knownContact, checks);
      expect(decision.action).toBe('AUTO_REPLY');
    });

    it('returns NEEDS_APPROVAL for unknown sender', () => {
      const email = { sender: 'unknown@stranger.org', subject: 'Task request', body: '' };
      const analysis = {
        intent: 'task_request',
        tone: 'formal',
        priority: 'medium',
        confidence: 0.80,
        isSafeToAutoReply: false,
      };
      const checks = decisionEngine._runSafetyChecks(email, analysis, null);
      const decision = decisionEngine._applyRules(email, analysis, null, checks);
      expect(decision.action).toBe('NEEDS_APPROVAL');
    });

    it('returns DELETE for high-confidence spam', () => {
      const email = { sender: 'spam@spam.net', subject: 'Win prize!!!', body: 'click here unsubscribe' };
      const analysis = {
        intent: 'spam',
        tone: 'neutral',
        priority: 'low',
        confidence: 0.97,
        isSafeToAutoReply: false,
      };
      const checks = decisionEngine._runSafetyChecks(email, analysis, null);
      const decision = decisionEngine._applyRules(email, analysis, null, checks);
      expect(decision.action).toBe('DELETE');
    });

    it('NEVER deletes known contact emails even if classified as spam', () => {
      const email = { sender: 'client@known.com', subject: 'Special offer', body: 'unsubscribe below' };
      const analysis = {
        intent: 'spam',
        tone: 'neutral',
        priority: 'low',
        confidence: 0.95,
        isSafeToAutoReply: false,
      };
      const checks = decisionEngine._runSafetyChecks(email, analysis, knownContact);
      const decision = decisionEngine._applyRules(email, analysis, knownContact, checks);
      expect(decision.action).not.toBe('DELETE');
      expect(decision.overridden).toBe(true);
    });

    it('returns NEEDS_APPROVAL for low-confidence analysis', () => {
      const email = { sender: 'maybe@unknown.com', subject: '???', body: '' };
      const analysis = {
        intent: 'other',
        tone: 'neutral',
        priority: 'low',
        confidence: 0.45,  // low
        isSafeToAutoReply: false,
      };
      const checks = decisionEngine._runSafetyChecks(email, analysis, null);
      const decision = decisionEngine._applyRules(email, analysis, null, checks);
      expect(decision.action).toBe('NEEDS_APPROVAL');
    });

    it('returns NEEDS_APPROVAL for angry tone even from known contact', () => {
      const email = { sender: 'client@known.com', subject: 'VERY UPSET', body: '' };
      const analysis = {
        intent: 'personal',
        tone: 'angry',
        priority: 'high',
        confidence: 0.88,
        isSafeToAutoReply: false,
      };
      const checks = decisionEngine._runSafetyChecks(email, analysis, knownContact);
      const decision = decisionEngine._applyRules(email, analysis, knownContact, checks);
      expect(decision.action).toBe('NEEDS_APPROVAL');
    });

    it('returns IGNORE for low-priority informational email', () => {
      const email = { sender: 'info@service.com', subject: 'Your monthly summary', body: '' };
      const analysis = {
        intent: 'informational',
        tone: 'neutral',
        priority: 'low',
        confidence: 0.88,
        isSafeToAutoReply: false,
      };
      const checks = decisionEngine._runSafetyChecks(email, analysis, knownContact);
      const decision = decisionEngine._applyRules(email, analysis, knownContact, checks);
      expect(decision.action).toBe('IGNORE');
    });
  });

  // ── Trusted domain ────────────────────────────────
  describe('_isFromTrustedDomain', () => {
    const originalEnv = process.env.TRUSTED_DOMAINS;
    beforeAll(() => { process.env.TRUSTED_DOMAINS = 'yourcompany.com,trustedpartner.com'; });
    afterAll(() => { process.env.TRUSTED_DOMAINS = originalEnv; });

    it('returns true for trusted domain', () => {
      expect(decisionEngine._isFromTrustedDomain('user@yourcompany.com')).toBe(true);
    });

    it('returns false for unknown domain', () => {
      expect(decisionEngine._isFromTrustedDomain('user@randomspam.org')).toBe(false);
    });
  });
});


// ══════════════════════════════════════════════════════════
// tests/cleanupService.test.js
// ══════════════════════════════════════════════════════════
// Note: Import separately in real test run
describe('CleanupService safety checks', () => {
  const cleanupService = require('../src/services/cleanupService');

  it('rejects deletion below confidence threshold', () => {
    const email = { id: '1', provider:'imap', message_id:'x', sender_email:'s@s.com', subject:'s' };
    const analysis = { confidence: 0.70, intent:'spam', priority:'low', reasoning:'test' };
    const result = cleanupService._isSafeToDelete(email, analysis, {});
    expect(result).toBe(false);
  });

  it('rejects deletion of high-priority email', () => {
    const email = { id: '1', provider:'imap', message_id:'x', sender_email:'s@s.com', subject:'s' };
    const analysis = { confidence: 0.99, intent:'spam', priority:'high', reasoning:'test' };
    const result = cleanupService._isSafeToDelete(email, analysis, {});
    expect(result).toBe(false);
  });

  it('rejects deletion if intent is not spam/promotional', () => {
    const email = { id: '1', provider:'imap', message_id:'x', sender_email:'s@s.com', subject:'s' };
    const analysis = { confidence: 0.95, intent:'question', priority:'low', reasoning:'test' };
    const result = cleanupService._isSafeToDelete(email, analysis, {});
    expect(result).toBe(false);
  });

  it('allows deletion for high-confidence spam', () => {
    process.env.DELETION_CONFIDENCE_THRESHOLD = '0.90';
    const email = { id: '1', provider:'imap', message_id:'x', sender_email:'spam@spam.com', subject:'BUY NOW' };
    const analysis = { confidence: 0.97, intent:'spam', priority:'low', reasoning:'clear spam' };
    const result = cleanupService._isSafeToDelete(email, analysis, {});
    expect(result).toBe(true);
  });
});
