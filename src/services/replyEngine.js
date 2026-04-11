// src/services/replyEngine.js
// Autonomous rule-based reply generator — zero dependency on OpenAI.
// Produces dynamic, context-aware replies using intent + keyword signals.

'use strict';

// ─── Sender name extraction ───────────────────────────────────────────────────

function extractFirstName(email, senderName) {
  if (senderName && senderName !== 'Unknown') {
    return senderName.split(/\s+/)[0];
  }
  // Try to pull a name from the email local-part: "john.doe@..." → "John"
  const local = (email || '').split('@')[0].split(/[._-]/)[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : 'there';
}

// ─── Greeting / sign-off helpers ─────────────────────────────────────────────

function greeting(tone, firstName) {
  const greetings = {
    formal:   `Dear ${firstName},`,
    angry:    `Dear ${firstName},`,
    urgent:   `Hi ${firstName},`,
    positive: `Hi ${firstName},`,
    informal: `Hey ${firstName},`,
    negative: `Dear ${firstName},`,
    neutral:  `Hi ${firstName},`,
  };
  return greetings[tone] || `Hi ${firstName},`;
}

function signOff(tone) {
  const signs = {
    formal:   'Best regards,',
    angry:    'Best regards,',
    urgent:   'Best regards,',
    positive: 'Thanks,',
    informal: 'Cheers,',
    negative: 'Kind regards,',
    neutral:  'Best,',
  };
  return signs[tone] || 'Best,';
}

// ─── Keyword helpers ──────────────────────────────────────────────────────────

function norm(text) {
  return (text || '').toLowerCase();
}

function has(text, ...words) {
  const n = norm(text);
  return words.some((w) => n.includes(w));
}

// Extract a time/date hint from text if present
function extractTimeHint(text) {
  const patterns = [
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    /\b(tomorrow|today|next week|this week)\b/i,
    /\b(\d{1,2}[:/]\d{2}\s*(?:am|pm)?)\b/i,
    /\b(\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*)\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

// ─── Reply templates per intent ──────────────────────────────────────────────

const REPLY_BUILDERS = {

  // ── Meeting request ──────────────────────────────────────────────────────
  meeting_request(email, analysis) {
    const combined = `${email.subject} ${email.body}`;
    const timeHint = extractTimeHint(combined);
    const isZoom   = has(combined, 'zoom');
    const isTeams  = has(combined, 'teams', 'microsoft teams');
    const isMeet   = has(combined, 'google meet', 'meet');
    const platform = isZoom ? 'Zoom' : isTeams ? 'Microsoft Teams' : isMeet ? 'Google Meet' : 'a video call';

    let body;
    if (timeHint) {
      body = `Thank you for reaching out. ${timeHint} works well for me — I have confirmed that slot in my calendar.\n\n` +
             `I will send a ${platform} invite shortly. Please let me know if you need to adjust anything.`;
    } else {
      body = `Thank you for reaching out about scheduling a meeting. I would be happy to connect.\n\n` +
             `Could you please share a few time slots that work for you? I will confirm the one that fits best and send a ${platform} invite.`;
    }
    return body;
  },

  // ── Question / clarification ─────────────────────────────────────────────
  question(email, analysis) {
    const combined = `${email.subject} ${email.body}`;

    let focus = 'your query';
    if (has(combined, 'deadline', 'due date', 'when'))      focus = 'the timeline';
    else if (has(combined, 'price', 'cost', 'fee', 'rate')) focus = 'pricing details';
    else if (has(combined, 'process', 'how', 'steps'))      focus = 'the process';
    else if (has(combined, 'status', 'update', 'progress')) focus = 'the current status';
    else if (has(combined, 'document', 'file', 'report'))   focus = 'the document';

    return `Thank you for your message. I have reviewed ${focus} and will get back to you with a complete answer shortly.\n\n` +
           `If this is time-sensitive, please feel free to follow up and I will prioritize accordingly.`;
  },

  // ── Task request ─────────────────────────────────────────────────────────
  task_request(email, analysis) {
    const combined = `${email.subject} ${email.body}`;
    const isUrgent  = analysis.priority === 'high' || analysis.tone === 'urgent';
    const hasDeadline = has(combined, 'deadline', 'by end of day', 'eod', 'today', 'asap');

    if (isUrgent || hasDeadline) {
      return `Thank you for flagging this. I have noted the urgency and will prioritize this task immediately.\n\n` +
             `I will keep you updated on the progress and confirm once it is completed.`;
    }
    return `Thank you for the request. I have logged this task and will work on it as per the timeline discussed.\n\n` +
           `I will reach out if I need any clarifications, and confirm once it is done.`;
  },

  // ── Personal / friendly ──────────────────────────────────────────────────
  personal(email, analysis) {
    const combined = `${email.subject} ${email.body}`;
    const isCongrats = has(combined, 'congratulation', 'congrats', 'well done', 'great job');
    const isCheckin  = has(combined, 'how are you', 'checking in', 'hope you');

    if (isCongrats) {
      return `Thank you so much — that means a lot! It has been a great experience and I truly appreciate the kind words.\n\n` +
             `Hope we get a chance to catch up soon.`;
    }
    if (isCheckin) {
      return `Thanks for checking in — I am doing well! Hope things are going great on your end too.\n\n` +
             `Let us find a time to catch up soon.`;
    }
    return `Thank you for your message — always great to hear from you!\n\n` +
           `Hope all is well. Let us stay in touch.`;
  },

  // ── Informational / FYI ──────────────────────────────────────────────────
  informational(email, analysis) {
    return `Thank you for the update — noted and appreciated.\n\n` +
           `I will review the details and reach out if I have any questions.`;
  },

  // ── Negative tone / complaint ────────────────────────────────────────────
  negative_tone(email, analysis) {
    return `Thank you for bringing this to our attention. I sincerely apologize for the inconvenience caused.\n\n` +
           `I am looking into this matter urgently and will provide you with a full resolution as soon as possible. ` +
           `Your feedback is important and we take it seriously.`;
  },

  // ── Urgent / high priority ───────────────────────────────────────────────
  urgent(email, analysis) {
    return `I have received your message and understand this is urgent. You have my full attention on this.\n\n` +
           `I am addressing this right now and will update you within the hour.`;
  },

  // ── Generic fallback ─────────────────────────────────────────────────────
  other(email, analysis) {
    return `Thank you for your email. I have received it and will review the details carefully.\n\n` +
           `I will get back to you with a response as soon as possible.`;
  },
};

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * generateReply — builds a complete, ready-to-send reply string.
 *
 * @param {object} email    — normalized email { sender, senderName, subject, body }
 * @param {object} analysis — output from fallbackAnalysis()
 * @returns {{ subject: string, body: string, replyType: string }}
 */
function generateReply(email, analysis) {
  const firstName = extractFirstName(email.sender, email.senderName);
  const tone      = analysis.tone || 'neutral';
  const intent    = analysis.intent || 'other';

  // Pick the right builder — prefer tone override for angry/negative/urgent
  let builderKey = intent;
  if (tone === 'angry' || tone === 'negative') builderKey = 'negative_tone';
  else if (tone === 'urgent' && intent !== 'meeting_request') builderKey = 'urgent';

  const builder  = REPLY_BUILDERS[builderKey] || REPLY_BUILDERS.other;
  const bodyCore = builder(email, analysis);

  const fullBody =
    `${greeting(tone, firstName)}\n\n` +
    `${bodyCore}\n\n` +
    `${signOff(tone)}`;

  const subject = email.subject?.startsWith('Re:')
    ? email.subject
    : `Re: ${email.subject || '(no subject)'}`;

  return {
    subject,
    body: fullBody,
    replyType: builderKey,
  };
}

module.exports = { generateReply };
