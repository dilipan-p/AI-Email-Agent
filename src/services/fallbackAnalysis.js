// src/services/fallbackAnalysis.js
// Heuristic fallback AI engine — activates when OpenAI is unavailable.
// Uses keyword scoring, sender signals, and rule-based logic to simulate
// intelligent email analysis at reduced (but declared) confidence.

'use strict';

// ============================================================
// KNOWLEDGE BASE — keyword groups with weight multipliers
// ============================================================

const INTENT_RULES = [
  {
    intent: 'meeting_request',
    weight: 1.0,
    keywords: [
      'meeting', 'schedule', 'call', 'sync', 'catch up', 'catch-up',
      'appointment', 'availability', 'available', 'calendar', 'zoom',
      'teams', 'google meet', 'standup', 'stand-up', 'discuss',
      'conference', 'slot', 'book a time', 'set up a time',
    ],
  },
  {
    intent: 'question',
    weight: 0.9,
    keywords: [
      'could you', 'can you', 'would you', 'is it possible', 'how do',
      'what is', 'when will', 'do you know', 'have you', 'wondering',
      'clarify', 'confirm', 'let me know', 'please advise', '?',
    ],
  },
  {
    intent: 'task_request',
    weight: 0.9,
    keywords: [
      'please', 'could you', 'action required', 'action needed',
      'deadline', 'need you to', 'kindly', 'follow up', 'follow-up',
      'complete', 'submit', 'send me', 'provide', 'update',
      'deliver', 'prepare', 'review', 'approve',
    ],
  },
  {
    intent: 'spam',
    weight: 1.0,
    keywords: [
      'unsubscribe', 'click here', 'free offer', 'limited time',
      'act now', 'winner', 'you have been selected', 'prize',
      'claim your', 'no obligation', 'risk free', 'risk-free',
      'make money', 'earn money', 'work from home', '!!!', '100% free',
    ],
  },
  {
    intent: 'promotional',
    weight: 0.95,
    keywords: [
      'sale', 'discount', 'offer', 'deal', 'promo', 'coupon',
      'subscribe', 'newsletter', 'marketing', 'advertisement', 'shop now',
      'buy now', 'order now', '% off', 'exclusive', 'limited offer',
    ],
  },
  {
    intent: 'personal',
    weight: 0.85,
    keywords: [
      'hope you', 'how are you', 'how have you been', 'just wanted',
      'checking in', 'reaching out', 'touch base', 'happy to', 'excited',
      'congrats', 'congratulations', 'birthday', 'anniversary',
    ],
  },
  {
    intent: 'informational',
    weight: 0.8,
    keywords: [
      'fyi', 'for your information', 'just letting you know',
      'update on', 'status update', 'heads up', 'reminder',
      'announcement', 'notice', 'notification',
    ],
  },
];

const TONE_RULES = [
  {
    tone: 'angry',
    weight: 1.0,
    keywords: [
      'unacceptable', 'outrageous', 'disgusting', 'furious', 'fed up',
      'this is ridiculous', 'terrible', 'horrible', 'worst', 'hate',
      'demand', 'lawsuit', 'legal action', 'not okay', 'completely wrong',
    ],
  },
  {
    tone: 'negative',
    weight: 0.9,
    keywords: [
      'complaint', 'not happy', 'dissatisfied', 'disappointed',
      'issue', 'problem', 'broken', 'wrong', 'error', 'mistake',
      'failed', 'failure', 'not working', 'concerned', 'frustrated',
    ],
  },
  {
    tone: 'urgent',
    weight: 1.0,
    keywords: [
      'urgent', 'asap', 'immediately', 'right away', 'as soon as possible',
      'critical', 'emergency', 'time-sensitive', 'time sensitive',
      'by end of day', 'eod', 'today', 'now', 'cannot wait',
    ],
  },
  {
    tone: 'positive',
    weight: 0.85,
    keywords: [
      'thank you', 'thanks', 'appreciate', 'grateful', 'pleased',
      'wonderful', 'excellent', 'great job', 'well done', 'impressed',
      'happy', 'love', 'perfect', 'amazing', 'fantastic',
    ],
  },
  {
    tone: 'formal',
    weight: 0.75,
    keywords: [
      'dear', 'sincerely', 'regards', 'to whom it may concern',
      'pursuant to', 'herewith', 'kindly', 'per our', 'as discussed',
      'please find attached', 'i am writing to',
    ],
  },
  {
    tone: 'informal',
    weight: 0.75,
    keywords: [
      'hey', 'hi there', 'what\'s up', 'gonna', 'wanna', 'btw',
      'lol', 'haha', 'cool', 'awesome', 'yeah', 'yep', 'nope',
    ],
  },
];

const PRIORITY_RULES = [
  {
    priority: 'high',
    weight: 1.0,
    keywords: [
      'urgent', 'asap', 'immediately', 'critical', 'emergency',
      'time-sensitive', 'deadline', 'overdue', 'blocker', 'blocked',
      'must', 'today', 'eod', 'end of day', 'cannot wait', 'escalate',
    ],
  },
  {
    priority: 'low',
    weight: 0.9,
    keywords: [
      'no rush', 'whenever you can', 'at your convenience',
      'low priority', 'not urgent', 'fyi only', 'just fyi',
      'when you get a chance', 'no hurry', 'optional',
    ],
  },
];

// Suspicious sender patterns (free bulk email hosts, no-reply addresses, etc.)
const SUSPICIOUS_SENDER_PATTERNS = [
  /no.?reply/i, /noreply/i, /donotreply/i, /do.not.reply/i,
  /newsletter/i, /marketing@/i, /promo@/i, /offers@/i,
  /notifications?@/i, /alerts?@/i, /info@.*\.(tk|ml|ga|cf|gq)$/i,
];

// ============================================================
// HELPERS
// ============================================================

/**
 * Normalise text for matching — lowercase, collapse whitespace.
 * @param {string} text
 * @returns {string}
 */
function normalise(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Count how many keywords from a list appear in the text.
 * Returns { matches: string[], score: number (0-1) }
 */
function scoreKeywords(text, keywords) {
  const norm = normalise(text);
  const matches = keywords.filter((kw) => norm.includes(kw));
  const score = Math.min(matches.length / Math.max(keywords.length * 0.2, 1), 1);
  return { matches, score };
}

/**
 * Run all rules in a rule set against text and return the
 * top-scoring category along with matched keywords.
 *
 * @param {string} text
 * @param {Array}  rules  — one of INTENT_RULES / TONE_RULES / PRIORITY_RULES
 * @param {string} fallback — default value when nothing matches
 * @returns {{ value: string, confidence: number, matchedKeywords: string[] }}
 */
function detectCategory(text, rules, fallback) {
  let best = { value: fallback, confidence: 0, matchedKeywords: [] };

  for (const rule of rules) {
    const { matches, score } = scoreKeywords(text, rule.keywords);
    const weighted = score * rule.weight;
    if (weighted > best.confidence) {
      best = {
        value: rule.intent || rule.tone || rule.priority,
        confidence: weighted,
        matchedKeywords: matches,
      };
    }
  }

  return best;
}

/**
 * Derive a final confidence score from multiple signal strengths.
 * Clamps the output to [0.60, 0.90] — we never claim certainty.
 */
function deriveConfidence(intentScore, toneScore, priorityScore, keywordCount) {
  // Weighted average — intent signal is most diagnostic
  const raw = intentScore * 0.6 + toneScore * 0.25 + priorityScore * 0.15;

  // Bonus for having more keyword matches (more evidence = more sure)
  const evidenceBonus = Math.min(keywordCount * 0.025, 0.12);

  // Clamp to realistic heuristic range
  return parseFloat(Math.min(Math.max(raw + evidenceBonus, 0.60), 0.90).toFixed(2));
}

/**
 * Build a human-readable reasoning string that sounds like an analyst wrote it.
 */
function buildReasoning(intent, intentKeywords, tone, toneKeywords, priority, senderFlag) {
  const parts = [];

  if (intentKeywords.length > 0) {
    const sample = intentKeywords.slice(0, 3).map((k) => `"${k}"`).join(', ');
    const intentLabel = intent.replace(/_/g, ' ');
    parts.push(`Detected ${intentLabel} intent based on keywords: ${sample}.`);
  } else {
    parts.push('No strong intent keywords found; defaulting to general classification.');
  }

  if (toneKeywords.length > 0) {
    const sample = toneKeywords.slice(0, 2).map((k) => `"${k}"`).join(' and ');
    parts.push(`Tone assessed as ${tone} due to language like ${sample}.`);
  }

  if (priority === 'high') {
    parts.push('Marked high priority from urgency signals in the message.');
  }

  if (senderFlag) {
    parts.push('Sender address matches a known automated or bulk-mail pattern.');
  }

  parts.push('Analysis performed by heuristic fallback engine (OpenAI unavailable).');

  return parts.join(' ');
}

/**
 * Extract a plausible list of key points from the email body.
 * Picks the first 3 sentences that contain a verb — simple but effective.
 */
function extractKeyPoints(body) {
  const sentences = (body || '')
    .replace(/\r\n/g, '\n')
    .split(/[.!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && /\b(is|are|was|were|will|need|want|have|can|please|would|should)\b/i.test(s));

  return sentences.slice(0, 3);
}

/**
 * Determine decision based on confidence, tone, and intent.
 */
function deriveDecision(confidence, tone, intent, isSuspiciousSender) {
  // Hard rules first — these override confidence score
  if (intent === 'spam' || isSuspiciousSender) return 'DELETE';
  if (intent === 'promotional') return 'DELETE';
  if (intent === 'informational') return 'IGNORE';
  if (tone === 'angry' || tone === 'negative') return 'NEEDS_APPROVAL';
  if (tone === 'urgent') return 'NEEDS_APPROVAL';

  // Confidence-based routing
  if (confidence > 0.75) return 'AUTO_REPLY';
  return 'NEEDS_APPROVAL';
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * fallbackAnalysis — intelligent rule-based email analysis.
 *
 * Drop-in replacement for OpenAI analysis when the API is unavailable.
 * Returns the same shape as aiService.analyzeEmail().
 *
 * @param {{ sender: string, subject: string, body: string, isKnownContact?: boolean }} email
 * @returns {object} Structured analysis result
 */
function fallbackAnalysis(email) {
  const { sender = '', subject = '', body = '', isKnownContact = false } = email;

  // Combine fields into one searchable text block (subject weighted 2×)
  const combinedText = `${subject} ${subject} ${body}`;

  // --- Intent detection ---
  const intentResult = detectCategory(combinedText, INTENT_RULES, 'other');

  // --- Tone detection ---
  const toneResult = detectCategory(combinedText, TONE_RULES, 'neutral');

  // --- Priority detection ---
  const priorityResult = detectCategory(combinedText, PRIORITY_RULES, 'medium');

  // --- Sender signal ---
  const isSuspiciousSender = SUSPICIOUS_SENDER_PATTERNS.some((re) => re.test(sender));

  // Known contacts get a meaningful trust boost
  const contactBonus = isKnownContact ? 0.15 : 0;

  // Strong, unambiguous intents get an extra signal boost
  const STRONG_INTENTS = ["meeting_request", "task_request", "question"];
  const intentBonus = STRONG_INTENTS.includes(intentResult.value) ? 0.10 : 0;

  // --- Composite confidence ---
  const allKeywords = [
    ...intentResult.matchedKeywords,
    ...toneResult.matchedKeywords,
    ...priorityResult.matchedKeywords,
  ];
  const confidence = Math.min(
    deriveConfidence(
      intentResult.confidence + contactBonus + intentBonus,
      toneResult.confidence,
      priorityResult.confidence,
      allKeywords.length,
    ),
    0.90,
  );

  // --- Decision ---
  const suggestedDecision = deriveDecision(
    confidence,
    toneResult.value,
    intentResult.value,
    isSuspiciousSender,
  );

  // --- isSafeToAutoReply mirrors the decision engine's expectations ---
  const isSafeToAutoReply =
    suggestedDecision === 'AUTO_REPLY' &&
    isKnownContact &&
    toneResult.value !== 'angry' &&
    toneResult.value !== 'negative';

  return {
    intent: intentResult.value,
    tone: toneResult.value,
    priority: priorityResult.value,
    confidence,
    reasoning: buildReasoning(
      intentResult.value,
      intentResult.matchedKeywords,
      toneResult.value,
      toneResult.matchedKeywords,
      priorityResult.value,
      isSuspiciousSender,
    ),
    keyPoints: extractKeyPoints(body),
    isSafeToAutoReply,
    extractedDatetime: null,      // Not reliably extractable without NLP
    extractedParticipants: [],    // Not reliably extractable without NLP
    suggestedDecision,
    isKnownSafe: isKnownContact,
    // Metadata so callers know this result came from the fallback
    usedFallback: true,
    aiModel: 'heuristic-fallback-v1',
    tokensUsed: 0,
  };
}

module.exports = { fallbackAnalysis };