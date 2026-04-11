// tests/fallbackAnalysis.test.js
// Unit tests for the heuristic fallback AI engine

'use strict';

const { fallbackAnalysis } = require('../src/services/fallbackAnalysis');

// ─── helpers ────────────────────────────────────────────────────────────────

function make(overrides = {}) {
  return {
    sender: 'test@example.com',
    subject: 'Hello',
    body: '',
    isKnownContact: false,
    ...overrides,
  };
}

// ─── output shape ────────────────────────────────────────────────────────────

describe('fallbackAnalysis — output shape', () => {
  it('returns all required fields', () => {
    const result = fallbackAnalysis(make());
    const required = [
      'intent', 'tone', 'priority', 'confidence', 'reasoning',
      'keyPoints', 'isSafeToAutoReply', 'extractedDatetime',
      'extractedParticipants', 'suggestedDecision', 'isKnownSafe',
      'usedFallback', 'aiModel', 'tokensUsed',
    ];
    required.forEach((key) => expect(result).toHaveProperty(key));
  });

  it('always sets usedFallback = true', () => {
    expect(fallbackAnalysis(make()).usedFallback).toBe(true);
  });

  it('always sets tokensUsed = 0', () => {
    expect(fallbackAnalysis(make()).tokensUsed).toBe(0);
  });

  it('confidence is always between 0.60 and 0.90', () => {
    const tests = [
      make(),
      make({ subject: 'URGENT meeting asap!!', body: 'please join now immediately' }),
      make({ subject: 'Unsubscribe from our newsletter', body: '% off limited time offer' }),
    ];
    tests.forEach((email) => {
      const { confidence } = fallbackAnalysis(email);
      expect(confidence).toBeGreaterThanOrEqual(0.60);
      expect(confidence).toBeLessThanOrEqual(0.90);
    });
  });
});

// ─── intent detection ────────────────────────────────────────────────────────

describe('fallbackAnalysis — intent detection', () => {
  it('detects meeting_request from subject keywords', () => {
    const result = fallbackAnalysis(make({ subject: 'Can we schedule a meeting?' }));
    expect(result.intent).toBe('meeting_request');
  });

  it('detects meeting_request from body keywords', () => {
    const result = fallbackAnalysis(make({ body: 'Are you available for a Zoom call?' }));
    expect(result.intent).toBe('meeting_request');
  });

  it('detects spam', () => {
    const result = fallbackAnalysis(make({
      subject: 'You have been selected — claim your free prize now!',
      sender: 'noreply@promo.example.com',
    }));
    expect(result.intent).toBe('spam');
  });

  it('detects promotional', () => {
    const result = fallbackAnalysis(make({
      subject: 'Flash sale — 50% off this weekend only',
    }));
    expect(['promotional', 'spam']).toContain(result.intent);
  });

  it('detects task_request', () => {
    const result = fallbackAnalysis(make({
      subject: 'Action required: please review and approve',
    }));
    expect(result.intent).toBe('task_request');
  });

  it('detects question intent', () => {
    const result = fallbackAnalysis(make({
      subject: 'Could you clarify the deadline?',
      body: 'I was wondering if you could let me know when this is due?',
    }));
    expect(result.intent).toBe('question');
  });
});

// ─── tone detection ──────────────────────────────────────────────────────────

describe('fallbackAnalysis — tone detection', () => {
  it('detects positive tone from "thank you"', () => {
    const result = fallbackAnalysis(make({ body: 'Thank you so much, I really appreciate your help!' }));
    expect(result.tone).toBe('positive');
  });

  it('detects negative tone from complaint language', () => {
    const result = fallbackAnalysis(make({
      body: 'I am disappointed and not happy with this issue. There is clearly a problem.',
    }));
    expect(result.tone).toBe('negative');
  });

  it('detects angry tone', () => {
    const result = fallbackAnalysis(make({
      body: 'This is completely unacceptable and outrageous. I demand an immediate resolution.',
    }));
    expect(result.tone).toBe('angry');
  });

  it('detects urgent tone', () => {
    const result = fallbackAnalysis(make({
      subject: 'URGENT — needs your attention ASAP',
      body: 'Please respond immediately, this is time-sensitive.',
    }));
    expect(result.tone).toBe('urgent');
  });

  it('detects formal tone', () => {
    const result = fallbackAnalysis(make({
      body: 'Dear Sir, I am writing to inform you, pursuant to our agreement. Sincerely.',
    }));
    expect(result.tone).toBe('formal');
  });
});

// ─── priority detection ──────────────────────────────────────────────────────

describe('fallbackAnalysis — priority detection', () => {
  it('sets high priority for urgent keywords', () => {
    const result = fallbackAnalysis(make({ subject: 'Critical blocker — urgent action needed by EOD' }));
    expect(result.priority).toBe('high');
  });

  it('sets low priority when no-rush language present', () => {
    const result = fallbackAnalysis(make({ body: 'No rush at all, just fyi, whenever you get a chance.' }));
    expect(result.priority).toBe('low');
  });

  it('defaults to medium when no priority signals', () => {
    const result = fallbackAnalysis(make({ subject: 'Hello', body: 'Just wanted to say hi.' }));
    expect(result.priority).toBe('medium');
  });
});

// ─── decision logic ──────────────────────────────────────────────────────────

describe('fallbackAnalysis — decision logic', () => {
  it('returns DELETE for spam', () => {
    const result = fallbackAnalysis(make({
      subject: 'You are a winner! Claim your free prize now, unsubscribe link below',
    }));
    expect(result.suggestedDecision).toBe('DELETE');
  });

  it('returns DELETE for suspicious sender even without spam keywords', () => {
    const result = fallbackAnalysis(make({
      sender: 'newsletter@marketing.example.com',
      subject: 'Our weekly update',
    }));
    expect(result.suggestedDecision).toBe('DELETE');
  });

  it('returns NEEDS_APPROVAL for angry tone', () => {
    const result = fallbackAnalysis(make({
      body: 'This is unacceptable. I demand action. Lawsuit is on the table.',
    }));
    expect(result.suggestedDecision).toBe('NEEDS_APPROVAL');
  });

  it('returns NEEDS_APPROVAL for negative tone', () => {
    const result = fallbackAnalysis(make({
      body: 'I am very disappointed and not happy with this issue.',
    }));
    expect(result.suggestedDecision).toBe('NEEDS_APPROVAL');
  });

  it('returns NEEDS_APPROVAL for urgent tone', () => {
    const result = fallbackAnalysis(make({
      subject: 'URGENT: respond immediately, critical emergency',
    }));
    expect(result.suggestedDecision).toBe('NEEDS_APPROVAL');
  });

  it('returns AUTO_REPLY for high-confidence meeting request from known contact', () => {
    const result = fallbackAnalysis(make({
      sender: 'colleague@company.com',
      subject: 'Can we schedule a quick meeting or call to sync this week?',
      body: 'Are you available for a Zoom call? I need to discuss the project.',
      isKnownContact: true,
    }));
    expect(result.suggestedDecision).toBe('AUTO_REPLY');
    expect(result.isSafeToAutoReply).toBe(true);
  });

  it('never sets isSafeToAutoReply=true for unknown senders', () => {
    const result = fallbackAnalysis(make({
      subject: 'Meeting schedule availability calendar zoom call',
      body: 'Please schedule a meeting to discuss and sync.',
      isKnownContact: false,
    }));
    expect(result.isSafeToAutoReply).toBe(false);
  });
});

// ─── reasoning ───────────────────────────────────────────────────────────────

describe('fallbackAnalysis — reasoning', () => {
  it('mentions detected keywords in reasoning', () => {
    const result = fallbackAnalysis(make({ subject: 'Let us schedule a meeting' }));
    expect(result.reasoning).toMatch(/meeting|schedule/i);
  });

  it('always mentions fallback engine in reasoning', () => {
    const result = fallbackAnalysis(make());
    expect(result.reasoning).toMatch(/heuristic fallback/i);
  });
});

// ─── edge cases ──────────────────────────────────────────────────────────────

describe('fallbackAnalysis — edge cases', () => {
  it('handles completely empty email gracefully', () => {
    expect(() => fallbackAnalysis({})).not.toThrow();
    const result = fallbackAnalysis({});
    expect(result.confidence).toBeGreaterThanOrEqual(0.60);
  });

  it('handles null / undefined fields gracefully', () => {
    expect(() => fallbackAnalysis({ sender: null, subject: null, body: null })).not.toThrow();
  });

  it('handles very long body without crashing', () => {
    const longBody = 'please schedule a meeting '.repeat(500);
    expect(() => fallbackAnalysis(make({ body: longBody }))).not.toThrow();
  });
});
