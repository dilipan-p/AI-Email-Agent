// src/services/replyEngine.js
// Dynamic reply engine — produces varied, natural-sounding replies.
// Uses multiple templates per intent + keyword context injection
// so no two emails ever get the exact same reply.
'use strict';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function norm(t) { return (t || '').toLowerCase(); }
function has(text, ...words) { const n = norm(text); return words.some(w => n.includes(w)); }

function extractFirstName(sender, senderName) {
  if (senderName && senderName !== 'Unknown' && !senderName.includes('@')) {
    return senderName.split(/\s+/)[0];
  }
  const local = (sender || '').split('@')[0].split(/[._-]/)[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : 'there';
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ─── Greeting variants ────────────────────────────────────────────────────────
function greeting(tone, name) {
  const greetings = {
    formal:   [`Dear ${name},`, `Good day, ${name},`],
    angry:    [`Dear ${name},`],
    urgent:   [`Hi ${name},`, `Hello ${name},`],
    positive: [`Hi ${name}!`, `Hello ${name},`, `Hey ${name},`],
    informal: [`Hey ${name}!`, `Hi ${name},`],
    negative: [`Dear ${name},`, `Hello ${name},`],
    neutral:  [`Hi ${name},`, `Hello ${name},`, `Dear ${name},`],
  };
  return pick(greetings[tone] || greetings.neutral);
}

function signOff(tone) {
  const signs = {
    formal:   ['Best regards,', 'Warm regards,', 'Sincerely,'],
    angry:    ['Best regards,'],
    urgent:   ['Best regards,', 'Thanks,'],
    positive: ['Thanks!', 'Best,', 'Cheers,', 'Warm regards,'],
    informal: ['Cheers,', 'Thanks!', 'Best,'],
    negative: ['Kind regards,', 'Best regards,'],
    neutral:  ['Best regards,', 'Thanks,', 'Best,', 'Warm regards,'],
  };
  return pick(signs[tone] || signs.neutral);
}

// ─── Intent reply builders ────────────────────────────────────────────────────

const BUILDERS = {

  meeting_request(email, analysis) {
    const text = `${email.subject} ${email.body}`;
    const isZoom   = has(text, 'zoom');
    const isTeams  = has(text, 'teams');
    const isMeet   = has(text, 'google meet', 'meet');
    const platform = isZoom ? 'Zoom' : isTeams ? 'Microsoft Teams' : isMeet ? 'Google Meet' : 'a video call';
    const isProject = has(text, 'project', 'discuss', 'sync', 'review');
    const isIntro   = has(text, 'introduce', 'introduction', 'connect', 'network');

    const variants = [
      `Thank you for reaching out about scheduling a meeting. I would be happy to connect${isProject ? ' to discuss the project' : ''} via ${platform}.\n\nCould you please share a few time slots that work for you? I will confirm the one that fits best and send an invite right away.`,
      `Thanks for getting in touch! I am available for a ${platform}${isIntro ? ' to connect' : isProject ? ' to review the project' : ''}.\n\nPlease share your preferred time and I will confirm promptly.`,
      `I would love to schedule${isProject ? ' a project sync' : ' a meeting'} via ${platform}. Happy to make this work.\n\nJust send over a couple of time slots and I will lock one in.`,
      `Absolutely, let us get something on the calendar. A ${platform}${isProject ? ' to go over the project details' : ''} sounds great.\n\nWhat times work best for you this week?`,
    ];
    return pick(variants);
  },

  question(email, analysis) {
    const text = `${email.subject} ${email.body}`;
    const isStatus  = has(text, 'status', 'update', 'progress');
    const isDeadline = has(text, 'deadline', 'when', 'due');
    const isProcess  = has(text, 'how', 'process', 'steps', 'procedure');
    const focus = isStatus ? 'the current status' : isDeadline ? 'the timeline' : isProcess ? 'the process' : 'your query';

    const variants = [
      `Thank you for your message. I have noted ${focus} and will get back to you with a thorough response shortly.\n\nIf this is time-sensitive, feel free to follow up and I will prioritize it.`,
      `Thanks for reaching out! I am looking into ${focus} and will share a complete answer as soon as possible.\n\nPlease feel free to follow up if you need this urgently.`,
      `I appreciate you reaching out. I will review ${focus} and get back to you with all the details you need.\n\nExpect a response from me shortly.`,
      `Good question — I am on it. Let me pull together the details on ${focus} and I will have a proper answer for you soon.`,
    ];
    return pick(variants);
  },

  task_request(email, analysis) {
    const text = `${email.subject} ${email.body}`;
    const isUrgent  = has(text, 'urgent', 'asap', 'immediately', 'today', 'eod');
    const isReport  = has(text, 'report', 'document', 'file', 'submission');
    const isReview  = has(text, 'review', 'approve', 'feedback');

    const urgentVariants = [
      `I have received your message and understand this is urgent. You have my full attention on this.\n\nI am addressing this right now and will update you within the hour.`,
      `Noted — I am treating this as a priority. I will get on this immediately and keep you updated on progress.`,
      `Understood, this is urgent. I am dropping everything else to address this right away.\n\nI will have an update for you very shortly.`,
    ];

    const normalVariants = [
      `Thank you for the ${isReport ? 'submission request' : isReview ? 'review request' : 'task'}. I have logged this and will work on it as per the timeline.\n\nI will reach out if I need any clarifications and confirm once done.`,
      `Got it — I will take care of ${isReport ? 'the report' : isReview ? 'the review' : 'this task'} and keep you posted on the progress.\n\nExpect an update from me soon.`,
      `Thanks for sending this over. I have made a note and will get started on ${isReport ? 'the report' : isReview ? 'the review' : 'this'} shortly.\n\nI will confirm once it is completed.`,
      `Received and noted. I will prioritize ${isReport ? 'the report submission' : isReview ? 'your review request' : 'this task'} and circle back with you once done.`,
    ];

    return isUrgent ? pick(urgentVariants) : pick(normalVariants);
  },

  personal(email, analysis) {
    const text = `${email.subject} ${email.body}`;
    const isCongrats = has(text, 'congratulations', 'congrats', 'well done', 'great job', 'proud');
    const isBirthday = has(text, 'birthday', 'bday');
    const isCheckin  = has(text, 'how are you', 'checking in', 'hope you');

    if (isCongrats) return pick([
      `Thank you so much — that really means a lot! It has been quite a journey and I am grateful for the kind words.\n\nHope to catch up with you soon!`,
      `Wow, thank you! Your message put a big smile on my face. Really appreciate the support.\n\nLet us find a time to celebrate together soon!`,
    ]);
    if (isBirthday) return pick([
      `Thank you so much for the birthday wishes! It really made my day.\n\nHope to celebrate together soon!`,
      `Aww, thank you! So sweet of you to remember. Really appreciate it!\n\nLet us meet up soon.`,
    ]);
    if (isCheckin) return pick([
      `Thanks for checking in — I am doing really well! Hope everything is great on your end too.\n\nLet us find a time to catch up soon.`,
      `So good to hear from you! Things are going well here. Hope you are doing fantastic too.\n\nWe should definitely catch up soon!`,
    ]);
    return pick([
      `Thank you for your message — always great to hear from you!\n\nHope all is well. Let us stay in touch.`,
      `Thanks for reaching out! Really appreciate you thinking of me.\n\nHope things are going brilliantly on your end!`,
    ]);
  },

  informational(email, analysis) {
    return pick([
      `Thank you for the update — noted and appreciated.\n\nI will review the details and reach out if I have any questions.`,
      `Thanks for keeping me in the loop. I have noted all the details.\n\nWill follow up if I need anything further.`,
      `Appreciated — I have read through the information and taken note.\n\nThank you for sharing this.`,
    ]);
  },

  negative_tone(email, analysis) {
    return pick([
      `Thank you for bringing this to my attention. I sincerely apologize for the inconvenience caused.\n\nI am looking into this matter urgently and will provide you with a full resolution as soon as possible. Your feedback is important and I take it very seriously.`,
      `I am truly sorry to hear about your experience. This is not the standard I hold myself to and I want to make it right.\n\nI am treating this as a priority and will follow up with a resolution shortly.`,
      `I appreciate you taking the time to raise this concern. I sincerely apologize — this should not have happened.\n\nI will personally look into this and get back to you with a proper resolution as quickly as possible.`,
    ]);
  },

  urgent(email, analysis) {
    return pick([
      `I have received your message and understand this is urgent. You have my full attention on this.\n\nI am addressing this right now and will update you within the hour.`,
      `Noted — treating this as top priority. I am on it right now.\n\nWill keep you updated every step of the way.`,
      `Understood. I am dropping everything to address this immediately.\n\nExpect an update from me very shortly.`,
    ]);
  },

  other(email, analysis) {
    return pick([
      `Thank you for your email. I have received it and will review the details carefully.\n\nI will get back to you with a response as soon as possible.`,
      `Thanks for reaching out. I have noted your message and will respond properly shortly.`,
      `I appreciate you getting in touch. I will look into this and come back to you with a full response soon.`,
    ]);
  },
};

// ─── Main export ──────────────────────────────────────────────────────────────
function generateReply(email, analysis) {
  const firstName = extractFirstName(email.sender, email.senderName);
  const tone      = analysis.tone || 'neutral';
  const intent    = analysis.intent || 'other';

  let builderKey = intent;
  if (tone === 'angry' || tone === 'negative') builderKey = 'negative_tone';
  else if (tone === 'urgent' && intent !== 'meeting_request') builderKey = 'urgent';

  const builder  = BUILDERS[builderKey] || BUILDERS.other;
  const bodyCore = builder(email, analysis);

  const fullBody =
    `${greeting(tone, firstName)}\n\n` +
    `${bodyCore}\n\n` +
    `${signOff(tone)}`;

  const subject = (email.subject || '').startsWith('Re:')
    ? email.subject
    : `Re: ${email.subject || '(no subject)'}`;

  return { subject, body: fullBody, replyType: builderKey };
}

module.exports = { generateReply };