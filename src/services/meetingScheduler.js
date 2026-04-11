// src/services/meetingScheduler.js
// Rule-based meeting scheduler — extracts meeting intent and finds available slots.
// No OpenAI required. Integrates with Google Calendar when credentials are present.

'use strict';

const logger = require('../config/logger');

// ─── Time slot generator ──────────────────────────────────────────────────────

/**
 * Generate N available working-hours slots starting from tomorrow.
 * Slots are 30 or 60 min based on detected duration hint.
 */
function generateSlots(count = 3, durationMinutes = 60) {
  const slots = [];
  const now   = new Date();
  let   day   = new Date(now);
  day.setDate(day.getDate() + 1); // start from tomorrow
  day.setSeconds(0);
  day.setMilliseconds(0);

  const WORK_START = 9;  // 9 AM
  const WORK_END   = 17; // 5 PM
  const SKIP_DAYS  = [0, 6]; // Sun, Sat

  while (slots.length < count) {
    // Skip weekends
    if (SKIP_DAYS.includes(day.getDay())) {
      day.setDate(day.getDate() + 1);
      day.setHours(WORK_START, 0, 0, 0);
      continue;
    }

    // Offer slots at 10:00, 14:00, 16:00
    const preferredHours = [10, 14, 16];
    for (const h of preferredHours) {
      if (slots.length >= count) break;
      const slot = new Date(day);
      slot.setHours(h, 0, 0, 0);
      const end = new Date(slot.getTime() + durationMinutes * 60 * 1000);
      slots.push({
        start: slot.toISOString(),
        end:   end.toISOString(),
        label: formatSlot(slot, end),
      });
    }
    day.setDate(day.getDate() + 1);
    day.setHours(WORK_START, 0, 0, 0);
  }

  return slots.slice(0, count);
}

function formatSlot(start, end) {
  const opts = { weekday: 'long', month: 'short', day: 'numeric',
                 hour: '2-digit', minute: '2-digit', hour12: true };
  const s = start.toLocaleString('en-US', opts);
  const e = end.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  return `${s} – ${e}`;
}

// ─── Meeting intent extractor ─────────────────────────────────────────────────

function norm(t) { return (t || '').toLowerCase(); }
function has(t, ...words) { const n = norm(t); return words.some((w) => n.includes(w)); }

/**
 * Extract meeting details from email text using pattern matching.
 */
function extractMeetingDetails(email) {
  const combined = `${email.subject || ''} ${email.body || ''}`;
  const n = norm(combined);

  // Is this actually a meeting request?
  const isMeetingRequest =
    has(combined, 'meeting', 'schedule', 'call', 'sync', 'catch up',
                  'availability', 'available', 'calendar', 'zoom',
                  'teams', 'google meet', 'appointment', 'book');

  if (!isMeetingRequest) {
    return { hasMeetingRequest: false };
  }

  // Duration hint
  let durationMinutes = 60;
  if (has(combined, '30 min', '30-min', 'half hour', 'quick call', 'brief')) {
    durationMinutes = 30;
  } else if (has(combined, '2 hour', '2-hour', 'two hour')) {
    durationMinutes = 120;
  }

  // Platform hint
  let platform = 'video call';
  if (has(combined, 'zoom'))                    platform = 'Zoom';
  else if (has(combined, 'teams'))              platform = 'Microsoft Teams';
  else if (has(combined, 'meet', 'google meet')) platform = 'Google Meet';
  else if (has(combined, 'phone', 'call me'))   platform = 'phone call';
  else if (has(combined, 'in person', 'office', 'come by')) platform = 'in-person meeting';

  // Proposed time — simple regex extraction
  const timePatterns = [
    /\b(monday|tuesday|wednesday|thursday|friday)\b/gi,
    /\b(tomorrow|today|next week|this week)\b/gi,
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/gi,
  ];
  const proposedTimes = [];
  for (const re of timePatterns) {
    const matches = combined.match(re) || [];
    proposedTimes.push(...matches.map((m) => m.trim()));
  }

  // Purpose hint
  let purpose = 'a meeting';
  if (has(combined, 'project'))   purpose = 'a project discussion';
  else if (has(combined, 'interview')) purpose = 'an interview';
  else if (has(combined, 'review'))    purpose = 'a review session';
  else if (has(combined, 'onboard'))   purpose = 'an onboarding session';
  else if (has(combined, 'demo'))      purpose = 'a product demo';

  return {
    hasMeetingRequest: true,
    durationMinutes,
    platform,
    purpose,
    proposedTimes: [...new Set(proposedTimes)],
    isFlexible: proposedTimes.length === 0,
  };
}

// ─── Reply builder ────────────────────────────────────────────────────────────

/**
 * Build a meeting-reply body with available time slots embedded.
 */
function buildMeetingReply(details, senderFirstName) {
  const slots  = generateSlots(3, details.durationMinutes);
  const name   = senderFirstName || 'there';

  if (details.proposedTimes.length > 0) {
    // Sender already proposed times — confirm one
    const confirmed = details.proposedTimes[0];
    return (
      `Hi ${name},\n\n` +
      `Thank you for reaching out! I would be happy to connect for ${details.purpose} via ${details.platform}.\n\n` +
      `${confirmed} works for me. I will send a calendar invite shortly.\n\n` +
      `Please let me know if you need to adjust anything.\n\n` +
      `Best regards,`
    );
  }

  // No times proposed — offer slots
  const slotList = slots.map((s, i) => `  ${i + 1}. ${s.label}`).join('\n');
  return (
    `Hi ${name},\n\n` +
    `Thank you for reaching out! I would love to schedule ${details.purpose} via ${details.platform}.\n\n` +
    `Here are a few slots that work for me:\n\n` +
    `${slotList}\n\n` +
    `Please pick the one that suits you best and I will send a calendar invite right away.\n\n` +
    `Best regards,`
  );
}

// ─── Google Calendar integration (optional) ───────────────────────────────────

/**
 * Create a Google Calendar event if credentials are configured.
 * Silently skips if not configured — meeting scheduling still works
 * via email reply even without Calendar API.
 */
async function createCalendarEvent(details, attendeeEmail, slot) {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
    logger.warn('Google Calendar skipped — OAuth credentials not configured');
    return null;
  }

  try {
    const { google } = require('googleapis');
    const oauth2 = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI,
    );
    oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

    const calendar = google.calendar({ version: 'v3', auth: oauth2 });
    const event = {
      summary: details.purpose,
      description: `Scheduled by AI Email Agent`,
      start: { dateTime: slot.start, timeZone: 'Asia/Kolkata' },
      end:   { dateTime: slot.end,   timeZone: 'Asia/Kolkata' },
      attendees: [{ email: attendeeEmail }],
      conferenceData: details.platform === 'Google Meet' ? {
        createRequest: { requestId: `ai-agent-${Date.now()}` },
      } : undefined,
    };

    const response = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      resource: event,
      conferenceDataVersion: details.platform === 'Google Meet' ? 1 : 0,
      sendNotifications: true,
    });

    logger.info(`Calendar event created: ${response.data.htmlLink}`);
    return response.data;
  } catch (err) {
    logger.error('Calendar event creation failed', { error: err.message });
    return null;
  }
}

module.exports = { extractMeetingDetails, generateSlots, buildMeetingReply, createCalendarEvent };
