// src/services/spamDetector.js
// Rule-based spam & promotional email detector — no OpenAI required.
// Returns { isSpam, isPromotional, confidence, reason, action }

'use strict';

// ─── Signal sets ──────────────────────────────────────────────────────────────

const SPAM_SUBJECTS = [
  'you have been selected', 'you are a winner', 'claim your prize',
  'free offer', 'free gift', 'act now', 'limited time offer',
  'no obligation', 'risk free', '100% free', 'make money fast',
  'earn money', 'work from home', 'click here', 'verify your account',
  'your account has been', 'urgent security', 'bitcoin', 'cryptocurrency',
  'investment opportunity', 'guaranteed income', 'get paid',
];

const SPAM_BODY = [
  'unsubscribe', 'click here to unsubscribe', 'remove me from',
  'you have been pre-approved', 'no credit check', 'payday loan',
  'casino', 'poker', 'lottery', 'jackpot', 'you won',
  'wire transfer', 'western union', 'money gram', 'prince',
  'inheritance', 'beneficiary', 'million dollar',
];

const PROMO_SUBJECTS = [
  'sale', '% off', 'discount', 'coupon', 'promo code', 'deal',
  'shop now', 'buy now', 'order now', 'flash sale', 'limited offer',
  'exclusive offer', 'special offer', 'clearance', 'free shipping',
  'today only', 'ends tonight', 'last chance', 'subscribe',
  'newsletter', 'weekly digest', 'monthly update', 'our latest',
];

const PROMO_BODY = [
  'view in browser', 'view this email in your browser',
  'unsubscribe from this list', 'email preferences',
  'you are receiving this', 'manage your subscription',
  'opt out', 'privacy policy', 'terms and conditions',
  'copyright ©', 'all rights reserved', '©',
];

const SPAM_SENDER_PATTERNS = [
  /no.?reply/i, /noreply/i, /donotreply/i,
  /newsletter@/i, /marketing@/i, /promo@/i, /offers@/i,
  /notifications?@/i, /alerts?@/i, /updates?@/i,
  /support@.*\.(tk|ml|ga|cf|gq)$/i,
  /\d{5,}@/i,                    // lots of numbers in local part
  /@.*\.(xyz|top|click|loan|win|bid|stream)$/i,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function norm(t) { return (t || '').toLowerCase(); }

function countMatches(text, keywords) {
  const n = norm(text);
  return keywords.filter((k) => n.includes(k)).length;
}

// ─── Main detector ────────────────────────────────────────────────────────────

/**
 * detectSpam — classifies an email as spam, promotional, or clean.
 *
 * @param {{ sender, subject, body }} email
 * @returns {{ isSpam, isPromotional, confidence, reason, action }}
 */
function detectSpam(email) {
  const { sender = '', subject = '', body = '' } = email;
  const combined = `${subject} ${body}`;

  // ── Spam signals ────────────────────────────────────────────────────────
  const spamSubjectHits = countMatches(subject, SPAM_SUBJECTS);
  const spamBodyHits    = countMatches(body, SPAM_BODY);
  const suspiciousSender = SPAM_SENDER_PATTERNS.some((re) => re.test(sender));

  // Excessive punctuation in subject (!!!  $$$)
  const excessivePunct = (subject.match(/[!$]{2,}/g) || []).length > 0;

  // ALL CAPS subject
  const allCaps = subject.length > 5 && subject === subject.toUpperCase();

  const spamScore =
    spamSubjectHits * 0.30 +
    spamBodyHits    * 0.25 +
    (suspiciousSender ? 0.25 : 0) +
    (excessivePunct   ? 0.10 : 0) +
    (allCaps          ? 0.10 : 0);

  // ── Promo signals ───────────────────────────────────────────────────────
  const promoSubjectHits = countMatches(subject, PROMO_SUBJECTS);
  const promoBodyHits    = countMatches(body, PROMO_BODY);

  const promoScore =
    promoSubjectHits * 0.40 +
    promoBodyHits    * 0.60;

  // ── Decision ────────────────────────────────────────────────────────────
  const isSpam        = spamScore  >= 0.30;
  const isPromotional = !isSpam && promoScore >= 0.40;

  const confidence = Math.min(
    isSpam        ? 0.60 + Math.min(spamScore,  0.40) :
    isPromotional ? 0.60 + Math.min(promoScore * 0.5, 0.30) :
    0,
    0.99,
  );

  // Build reason string
  const reasons = [];
  if (spamSubjectHits)  reasons.push(`${spamSubjectHits} spam keyword(s) in subject`);
  if (spamBodyHits)     reasons.push(`${spamBodyHits} spam keyword(s) in body`);
  if (suspiciousSender) reasons.push('suspicious sender address');
  if (excessivePunct)   reasons.push('excessive punctuation in subject');
  if (allCaps)          reasons.push('all-caps subject');
  if (promoSubjectHits) reasons.push(`${promoSubjectHits} promotional keyword(s) in subject`);
  if (promoBodyHits)    reasons.push(`${promoBodyHits} promotional marker(s) in body`);

  return {
    isSpam,
    isPromotional,
    confidence: parseFloat(confidence.toFixed(2)),
    reason: reasons.length ? reasons.join('; ') : 'No spam/promo signals detected',
    action: isSpam || isPromotional ? 'DELETE' : 'PASS',
  };
}

module.exports = { detectSpam };
