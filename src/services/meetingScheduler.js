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

  // Proposed time — extract specific dates, day names, and times
  const proposedTimes = [];
  let exactDate = null;

  // Match "10 april 2026", "april 10 2026", "10/04/2026", "2026-04-10"
  const fullDatePatterns = [
    /\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})\b/gi,
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})[,\s]+(\d{4})\b/gi,
    /\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/g,
  ];

  for (const re of fullDatePatterns) {
    const m = combined.match(re);
    if (m && m[0]) {
      const parsed = new Date(m[0]);
      if (!isNaN(parsed.getTime())) {
        exactDate = parsed;
        proposedTimes.push(m[0].trim());
        break;
      }
    }
  }

  // Day name patterns (only if no exact date found)
  if (!exactDate) {
    const dayPatterns = [
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
      /\b(tomorrow|today|next week|this week)\b/gi,
    ];
    for (const re of dayPatterns) {
      const matches = combined.match(re) || [];
      proposedTimes.push(...matches.map((m) => m.trim()));
    }
  }

  // Time of day
  const timeMatch = combined.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/gi);
  if (timeMatch) proposedTimes.push(...timeMatch.map((m) => m.trim()));

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
    exactDate,
    isFlexible: proposedTimes.length === 0 && !exactDate,
  };
}

// ─── Reply builder ────────────────────────────────────────────────────────────

/**
 * Build a meeting-reply body with available time slots embedded.
 */
function buildMeetingReply(details, senderFirstName) {
  const name = senderFirstName || 'there';

  // Case 1: Exact date found (e.g. "Friday 10 April 2026")
  if (details.exactDate) {
    const dateLabel = details.exactDate.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    // Find the time if mentioned
    const timeHint = details.proposedTimes.find((t) => /am|pm/i.test(t));
    const timeLabel = timeHint ? ` at ${timeHint}` : '';
    return (
      `Hi ${name},\n\n` +
      `Thank you for reaching out! I would be happy to connect for ${details.purpose} via ${details.platform}.\n\n` +
      `${dateLabel}${timeLabel} works perfectly for me. I will send a calendar invite shortly.\n\n` +
      `Please let me know if you need to adjust anything.\n\n` +
      `Best regards,`
    );
  }

  // Case 2: Day name or relative time proposed (e.g. "Friday", "tomorrow")
  if (details.proposedTimes.length > 0) {
    const dayHint  = details.proposedTimes.find((t) => !/am|pm/i.test(t));
    const timeHint = details.proposedTimes.find((t) => /am|pm/i.test(t));
    const when     = [dayHint, timeHint].filter(Boolean).join(' at ');
    return (
      `Hi ${name},\n\n` +
      `Thank you for reaching out! I would be happy to connect for ${details.purpose} via ${details.platform}.\n\n` +
      `${when} works for me. I will send a calendar invite shortly.\n\n` +
      `Please let me know if you need to adjust anything.\n\n` +
      `Best regards,`
    );
  }

  // Case 3: No time proposed — offer 3 slots
  const slots    = generateSlots(3, details.durationMinutes);
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

// ─── Conflict checker ────────────────────────────────────────────────────────

/**
 * Get Google Calendar auth client — shared helper.
 */
function getCalendarClient() {
  const { google } = require('googleapis');
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI,
  );
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth: oauth2 });
}

/**
 * checkCalendarConflict — checks if there is already an event at the requested time.
 *
 * @param {string} startISO — ISO start datetime
 * @param {string} endISO   — ISO end datetime
 * @returns {{ hasConflict: boolean, conflictEvent: object|null, nextSlots: Array }}
 */
async function checkCalendarConflict(startISO, endISO) {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
    return { hasConflict: false, conflictEvent: null, nextSlots: [] };
  }

  try {
    const calendar = getCalendarClient();

    // Query calendar for events in the requested window
    const res = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeMin: startISO,
      timeMax: endISO,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items || [];
    // Filter out declined events and all-day events
    const conflicts = events.filter((e) => {
      if (!e.start?.dateTime) return false; // skip all-day events
      const selfStatus = (e.attendees || []).find((a) => a.self)?.responseStatus;
      return selfStatus !== 'declined';
    });

    if (conflicts.length === 0) {
      return { hasConflict: false, conflictEvent: null, nextSlots: [] };
    }

    // Find next 3 free slots after the conflict
    const nextSlots = await findNextFreeSlots(calendar, new Date(endISO), 3, 60);

    logger.info(`Calendar conflict found: ${conflicts[0].summary} at ${startISO}`);
    return {
      hasConflict: true,
      conflictEvent: conflicts[0],
      nextSlots,
    };
  } catch (err) {
    logger.warn('Calendar conflict check failed', { error: err.message });
    return { hasConflict: false, conflictEvent: null, nextSlots: [] };
  }
}

/**
 * findNextFreeSlots — find N free working-hours slots after a given time.
 */
async function findNextFreeSlots(calendar, after, count = 3, durationMinutes = 60) {
  const slots = [];
  let cursor  = new Date(after);
  cursor.setMinutes(0, 0, 0);

  const WORK_START = 9;
  const WORK_END   = 17;
  const SKIP_DAYS  = [0, 6];
  const attempts   = 0;
  let   maxDays    = 7; // search up to 7 days ahead

  while (slots.length < count && maxDays > 0) {
    // Skip weekends
    if (SKIP_DAYS.includes(cursor.getDay())) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(WORK_START, 0, 0, 0);
      maxDays--;
      continue;
    }

    // Try hours 9, 10, 11, 14, 15, 16
    const tryHours = [9, 10, 11, 14, 15, 16];
    for (const h of tryHours) {
      if (slots.length >= count) break;
      if (h < cursor.getHours() && cursor.toDateString() === new Date().toDateString()) continue;

      const start = new Date(cursor);
      start.setHours(h, 0, 0, 0);
      if (start <= new Date()) continue; // skip past times

      const end = new Date(start.getTime() + durationMinutes * 60000);

      try {
        const res = await calendar.events.list({
          calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          singleEvents: true,
        });
        const busy = (res.data.items || []).filter((e) => e.start?.dateTime);
        if (busy.length === 0) {
          slots.push({
            start: start.toISOString(),
            end:   end.toISOString(),
            label: formatSlot(start, end),
          });
        }
      } catch {
        // If check fails, include the slot anyway
        slots.push({
          start: start.toISOString(),
          end:   end.toISOString(),
          label: formatSlot(start, end),
        });
      }
    }

    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(WORK_START, 0, 0, 0);
    maxDays--;
  }

  return slots;
}

/**
 * buildBusyReply — reply telling sender the slot is taken + offer next free slots.
 */
function buildBusyReply(details, senderFirstName, conflictEvent, nextSlots) {
  const name        = senderFirstName || 'there';
  const requestedAt = details.exactDate
    ? details.exactDate.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })
    : (details.proposedTimes[0] || 'that time');

  const apology =
    `Hi ${name},

` +
    `Thank you for reaching out! I apologise, but I already have another commitment scheduled on ${requestedAt} ` +
    `and I am unable to meet at that time.

`;

  if (nextSlots.length > 0) {
    const slotList = nextSlots.map((s, i) => `  ${i + 1}. ${s.label}`).join('\n');
    return (
      apology +
      `Here are my next available slots:

` +
      `${slotList}

` +
      `Please let me know which one works best for you and I will send a calendar invite right away.

` +
      `Sorry for any inconvenience and looking forward to connecting!

` +
      `Best regards,`
    );
  }

  return (
    apology +
    `Could you please suggest another date or time that works for you? ` +
    `I will do my best to accommodate.

` +
    `Sorry for any inconvenience!

` +
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
    // Use the sender's requested date if available, else use generated slot
    let startTime = slot.start;
    let endTime   = slot.end;
    if (details.exactDate) {
      const d = new Date(details.exactDate);
      // Check if a time was mentioned (e.g. "10am")
      const timeHint = (details.proposedTimes || []).find((t) => /am|pm/i.test(t));
      if (timeHint) {
        const parsed = new Date(`${d.toDateString()} ${timeHint}`);
        if (!isNaN(parsed.getTime())) {
          startTime = parsed.toISOString();
          endTime   = new Date(parsed.getTime() + details.durationMinutes * 60000).toISOString();
        }
      } else {
        d.setHours(10, 0, 0, 0); // Default to 10am on their requested date
        startTime = d.toISOString();
        endTime   = new Date(d.getTime() + details.durationMinutes * 60000).toISOString();
      }
    }

    const event = {
      summary: details.purpose,
      description: `Scheduled by AI Email Agent`,
      start: { dateTime: startTime, timeZone: 'Asia/Kolkata' },
      end:   { dateTime: endTime,   timeZone: 'Asia/Kolkata' },
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

module.exports = { extractMeetingDetails, generateSlots, buildMeetingReply, buildBusyReply, checkCalendarConflict, createCalendarEvent };