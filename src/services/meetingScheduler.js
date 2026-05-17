// src/services/meetingScheduler.js
// Rule-based meeting scheduler — IST-safe throughout.
// All dates and times are computed in Asia/Kolkata (UTC+05:30).
// No server timezone dependency — works correctly on any UTC/cloud server.

'use strict';

const logger = require('../config/logger');

// ─── IST helpers ──────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5h 30m in milliseconds

/**
 * Get the current time as an IST-aware object.
 */
function nowIST() {
  return utcToIST(new Date());
}

/**
 * Convert any UTC Date to IST fields.
 * Returns { year, month (1-12), day, hours, minutes, dayOfWeek (0=Sun) }
 */
function utcToIST(date) {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year:      ist.getUTCFullYear(),
    month:     ist.getUTCMonth() + 1,
    day:       ist.getUTCDate(),
    hours:     ist.getUTCHours(),
    minutes:   ist.getUTCMinutes(),
    dayOfWeek: ist.getUTCDay(),
  };
}

/**
 * Build an ISO 8601 string with explicit +05:30 offset.
 * This is the ONLY correct way to pass IST times to Google Calendar.
 * e.g. buildISTString(2026, 4, 25, 17, 0) => "2026-04-25T17:00:00+05:30"
 */
function buildISTString(year, month, day, hours, mins) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(mins)}:00+05:30`;
}

/**
 * Convert IST components to a UTC Date (for calendar API comparisons).
 */
function istToUTC(year, month, day, hours, mins) {
  return new Date(Date.UTC(year, month - 1, day, hours, mins) - IST_OFFSET_MS);
}

/**
 * Advance an IST { year, month, day } by N days.
 */
function addDaysIST(year, month, day, n) {
  const utc = istToUTC(year, month, day, 0, 0);
  utc.setUTCDate(utc.getUTCDate() + n);
  const ist = utcToIST(utc);
  return { year: ist.year, month: ist.month, day: ist.day };
}

/**
 * Get day-of-week (0=Sun) for an IST date.
 */
function dayOfWeekIST(year, month, day) {
  return utcToIST(istToUTC(year, month, day, 0, 0)).dayOfWeek;
}

/**
 * Format an IST datetime for display in emails.
 * e.g. "Friday, 25 April 2026 at 5:00 PM IST"
 */
function formatISTDisplay(year, month, day, hours, mins) {
  const isoStr = buildISTString(year, month, day, hours, mins);
  const date   = new Date(isoStr);
  return date.toLocaleString('en-IN', {
    weekday:  'long',
    year:     'numeric',
    month:    'long',
    day:      'numeric',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   true,
    timeZone: 'Asia/Kolkata',
  }) + ' IST';
}

/**
 * Format a slot label for display.
 * e.g. "Friday, 25 Apr 2026, 10:00 AM – 11:00 AM IST"
 */
function formatSlotLabel(startISO, endISO) {
  const s = new Date(startISO).toLocaleString('en-IN', {
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Kolkata',
  });
  const e = new Date(endISO).toLocaleString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Kolkata',
  });
  return `${s} – ${e} IST`;
}

// ─── Slot generator ───────────────────────────────────────────────────────────

const WORK_START   = 9;
const WORK_END     = 17;
const SKIP_DAYS    = [0, 6]; // Sun, Sat
const PREFER_HOURS = [10, 11, 14, 15, 16];

/**
 * Generate N available working-hour slots starting from tomorrow (IST).
 * All returned start/end are ISO strings with +05:30 offset.
 */
function generateSlots(count = 3, durationMinutes = 60) {
  const slots = [];
  const today = nowIST();
  let cur = addDaysIST(today.year, today.month, today.day, 1);
  let maxIterations = 30;

  while (slots.length < count && maxIterations-- > 0) {
    const dow = dayOfWeekIST(cur.year, cur.month, cur.day);

    if (SKIP_DAYS.includes(dow)) {
      cur = addDaysIST(cur.year, cur.month, cur.day, 1);
      continue;
    }

    for (const h of PREFER_HOURS) {
      if (slots.length >= count) break;
      const totalEndMins = h * 60 + durationMinutes;
      const endH = Math.floor(totalEndMins / 60);
      const endM = totalEndMins % 60;
      if (endH > WORK_END) continue;

      const startISO = buildISTString(cur.year, cur.month, cur.day, h, 0);
      const endISO   = buildISTString(cur.year, cur.month, cur.day, endH, endM);
      slots.push({ start: startISO, end: endISO, label: formatSlotLabel(startISO, endISO) });
    }

    cur = addDaysIST(cur.year, cur.month, cur.day, 1);
  }

  return slots.slice(0, count);
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

function norm(t) { return (t || '').toLowerCase(); }
function has(t, ...words) { const n = norm(t); return words.some((w) => n.includes(w)); }

// ─── Date / time parsers ──────────────────────────────────────────────────────

/**
 * Parse time string → { hours (0-23 IST), mins }
 * Supports: "5pm", "5 pm", "17:00", "10:30am", "3 PM"
 */
function parseTimeStr(t) {
  if (!t) return null;
  const clean = t.trim();

  // 24-hour: "17:00", "09:30"
  const h24 = clean.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const hours = parseInt(h24[1]);
    const mins  = parseInt(h24[2]);
    if (hours >= 0 && hours <= 23 && mins >= 0 && mins <= 59) return { hours, mins };
  }

  // 12-hour: "6pm", "10:30am", "3 PM", "6 pm"
  const h12 = clean.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (h12) {
    let hours  = parseInt(h12[1]);
    const mins = parseInt(h12[2] || '0');
    const ampm = h12[3].toUpperCase();
    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
    return { hours, mins };
  }

  return null;
}

/**
 * Parse DD/MM/YYYY or DD-MM-YYYY → { year, month, day }
 */
function parseDMY(str) {
  const m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;
  const day   = parseInt(m[1]);
  const month = parseInt(m[2]);
  const year  = parseInt(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/**
 * Parse "today" / "tomorrow" → { year, month, day } in IST
 */
function parseRelative(word) {
  const today = nowIST();
  if (/today/i.test(word))    return { year: today.year, month: today.month, day: today.day };
  if (/tomorrow/i.test(word)) return addDaysIST(today.year, today.month, today.day, 1);
  return null;
}

/**
 * Parse day name ("Friday") → nearest future { year, month, day } in IST
 */
function parseDayName(word) {
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const target = days.indexOf(word.toLowerCase());
  if (target === -1) return null;

  const today = nowIST();
  let cur = addDaysIST(today.year, today.month, today.day, 1);

  for (let i = 0; i < 8; i++) {
    if (dayOfWeekIST(cur.year, cur.month, cur.day) === target) return cur;
    cur = addDaysIST(cur.year, cur.month, cur.day, 1);
  }
  return null;
}

/**
 * Parse "10 April 2026" or "April 10, 2026" → { year, month, day }
 */
function parseWrittenDate(str) {
  const monthMap = {
    jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
    jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
  };
  const m1 = str.match(/\b(\d{1,2})\s+([a-z]+)\s+(\d{4})\b/i);
  if (m1) {
    const day   = parseInt(m1[1]);
    const month = monthMap[m1[2].slice(0,3).toLowerCase()];
    const year  = parseInt(m1[3]);
    if (month && day >= 1 && day <= 31) return { year, month, day };
  }
  const m2 = str.match(/\b([a-z]+)\s+(\d{1,2})[,\s]+(\d{4})\b/i);
  if (m2) {
    const month = monthMap[m2[1].slice(0,3).toLowerCase()];
    const day   = parseInt(m2[2]);
    const year  = parseInt(m2[3]);
    if (month && day >= 1 && day <= 31) return { year, month, day };
  }
  return null;
}

// ─── Meeting intent extractor ─────────────────────────────────────────────────

/**
 * Extract all meeting details from an email.
 * exactDate → { year, month, day }   (IST — no Date object, no timezone confusion)
 * exactTime → { hours (0-23), mins } (IST hours directly from user text)
 */
function extractMeetingDetails(email) {
  const combined = `${email.subject || ''} ${email.body || ''}`;

  const isMeetingRequest = has(combined,
    'meeting', 'schedule', 'call', 'sync', 'catch up',
    'availability', 'available', 'calendar', 'zoom',
    'teams', 'google meet', 'appointment', 'book', 'discuss'
  );
  if (!isMeetingRequest) return { hasMeetingRequest: false };

  // Duration
  let durationMinutes = 60;
  if (has(combined, '30 min', '30-min', 'half hour', 'quick call', 'brief')) durationMinutes = 30;
  else if (has(combined, '2 hour', '2-hour', 'two hour')) durationMinutes = 120;

  // Platform
  let platform = 'video call';
  if (has(combined, 'zoom'))                      platform = 'Zoom';
  else if (has(combined, 'teams'))                platform = 'Microsoft Teams';
  else if (has(combined, 'google meet','gmeet'))  platform = 'Google Meet';
  else if (has(combined, 'phone', 'call me'))     platform = 'phone call';
  else if (has(combined, 'in person', 'office'))  platform = 'in-person meeting';

  // Purpose
  let purpose = 'a meeting';
  if (has(combined, 'project'))        purpose = 'a project discussion';
  else if (has(combined, 'interview')) purpose = 'an interview';
  else if (has(combined, 'review'))    purpose = 'a review session';
  else if (has(combined, 'onboard'))   purpose = 'an onboarding session';
  else if (has(combined, 'demo'))      purpose = 'a product demo';
  else if (has(combined, 'discuss'))   purpose = 'a discussion';

  let exactDate = null;
  let exactTime = null;
  const proposedTimes = [];

  // 1. DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = combined.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
  if (dmyMatch) {
    const d = parseDMY(dmyMatch[0]);
    if (d) { exactDate = d; proposedTimes.push(dmyMatch[0]); }
  }

  // 2. Written month: "25 April 2026"
  if (!exactDate) {
    const mn = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
    for (const re of [
      new RegExp(`\\b(\\d{1,2})\\s+(${mn})\\s+(\\d{4})\\b`, 'gi'),
      new RegExp(`\\b(${mn})\\s+(\\d{1,2})[,\\s]+(\\d{4})\\b`, 'gi'),
    ]) {
      const m = re.exec(combined);
      if (m) {
        const d = parseWrittenDate(m[0]);
        if (d) { exactDate = d; proposedTimes.push(m[0].trim()); break; }
      }
    }
  }

  // 3. Relative: today / tomorrow
  if (!exactDate) {
    const rel = combined.match(/\b(today|tomorrow)\b/i);
    if (rel) {
      const d = parseRelative(rel[0]);
      if (d) { exactDate = d; proposedTimes.push(rel[0]); }
    }
  }

  // 4. Day names
  if (!exactDate) {
    const dm = combined.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi);
    if (dm) {
      const d = parseDayName(dm[0]);
      if (d) exactDate = d;
      proposedTimes.push(...dm.map((x) => x.trim()));
    }
  }

  // 5. Time — 24h first, then 12h
  const t24 = combined.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (t24) {
    const parsed = parseTimeStr(t24[0]);
    if (parsed) { exactTime = parsed; proposedTimes.push(t24[0]); }
  }
  if (!exactTime) {
    const t12 = combined.match(/\b(\d{1,2}(?::\d{2})?\s*[ap]m)\b/gi);
    if (t12) {
      const parsed = parseTimeStr(t12[0].trim());
      if (parsed) { exactTime = parsed; proposedTimes.push(t12[0].trim()); }
    }
  }

  return {
    hasMeetingRequest: true,
    durationMinutes,
    platform,
    purpose,
    proposedTimes: [...new Set(proposedTimes)],
    exactDate,
    exactTime,
    isFlexible: proposedTimes.length === 0 && !exactDate,
  };
}

// ─── Reply builders ───────────────────────────────────────────────────────────

function buildMeetingReply(details, senderFirstName) {
  const name = senderFirstName || 'there';

  if (details.exactDate) {
    const { year, month, day } = details.exactDate;
    const h = details.exactTime ? details.exactTime.hours : 10;
    const m = details.exactTime ? details.exactTime.mins  : 0;
    const label = formatISTDisplay(year, month, day, h, m);
    return (
      `Hi ${name},\n\n` +
      `Thank you for reaching out! I would be happy to connect for ${details.purpose} via ${details.platform}.\n\n` +
      `${label} works perfectly for me. I will send a calendar invite shortly.\n\n` +
      `Please let me know if you need to adjust anything.\n\nBest regards,`
    );
  }

  if (details.proposedTimes.length > 0) {
    const dayHint  = details.proposedTimes.find((t) => !/am|pm|\d{2}:\d{2}/i.test(t));
    const timeHint = details.proposedTimes.find((t) => /am|pm|\d{2}:\d{2}/i.test(t));
    const when     = [dayHint, timeHint].filter(Boolean).join(' at ');
    return (
      `Hi ${name},\n\n` +
      `Thank you for reaching out! I would be happy to connect for ${details.purpose} via ${details.platform}.\n\n` +
      `${when} works for me (IST). I will send a calendar invite shortly.\n\n` +
      `Please let me know if you need to adjust anything.\n\nBest regards,`
    );
  }

  const slots    = generateSlots(3, details.durationMinutes);
  const slotList = slots.map((s, i) => `  ${i + 1}. ${s.label}`).join('\n');
  return (
    `Hi ${name},\n\n` +
    `Thank you for reaching out! I would love to schedule ${details.purpose} via ${details.platform}.\n\n` +
    `Here are a few slots that work for me (all times IST):\n\n${slotList}\n\n` +
    `Please pick the one that suits you best and I will send a calendar invite right away.\n\nBest regards,`
  );
}

function buildBusyReply(details, senderFirstName, conflictEvent, nextSlots) {
  const name = senderFirstName || 'there';
  let requestedLabel = details.proposedTimes[0] || 'that time';
  if (details.exactDate) {
    const { year, month, day } = details.exactDate;
    const h = details.exactTime ? details.exactTime.hours : 10;
    const m = details.exactTime ? details.exactTime.mins  : 0;
    requestedLabel = formatISTDisplay(year, month, day, h, m);
  }

  const apology =
    `Hi ${name},\n\n` +
    `Thank you for reaching out! I apologise, but I already have a commitment at ${requestedLabel} ` +
    `and I am unable to meet at that time.\n\n`;

  if (nextSlots && nextSlots.length > 0) {
    const slotList = nextSlots.map((s, i) => `  ${i + 1}. ${s.label}`).join('\n');
    return (
      apology +
      `Here are my next available slots (all times IST):\n\n${slotList}\n\n` +
      `Please let me know which one works best and I will send a calendar invite right away.\n\n` +
      `Sorry for any inconvenience — looking forward to connecting!\n\nBest regards,`
    );
  }

  return (
    apology +
    `Could you please suggest another date and time (IST) that works for you? ` +
    `I will do my best to accommodate.\n\nSorry for any inconvenience!\n\nBest regards,`
  );
}

// ─── Google Calendar client ───────────────────────────────────────────────────

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

// ─── Calendar conflict checker ────────────────────────────────────────────────

async function checkCalendarConflict(startISO, endISO) {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
    return { hasConflict: false, conflictEvent: null, nextSlots: [] };
  }
  try {
    const calendar = getCalendarClient();
    const res = await calendar.events.list({
      calendarId:   process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeMin:      startISO,
      timeMax:      endISO,
      singleEvents: true,
      orderBy:      'startTime',
    });
    const events    = res.data.items || [];
    const conflicts = events.filter((e) => {
      if (!e.start?.dateTime) return false;
      const selfStatus = (e.attendees || []).find((a) => a.self)?.responseStatus;
      return selfStatus !== 'declined';
    });
    if (conflicts.length === 0) return { hasConflict: false, conflictEvent: null, nextSlots: [] };
    const nextSlots = await findNextFreeSlots(calendar, new Date(endISO), 3, 60);
    logger.info(`Calendar conflict: ${conflicts[0].summary} at ${startISO}`);
    return { hasConflict: true, conflictEvent: conflicts[0], nextSlots };
  } catch (err) {
    logger.warn('Calendar conflict check failed', { error: err.message });
    return { hasConflict: false, conflictEvent: null, nextSlots: [] };
  }
}

// ─── Find next free slots ─────────────────────────────────────────────────────

async function findNextFreeSlots(calendar, afterUTC, count = 3, durationMinutes = 60) {
  const slots    = [];
  const afterIST = utcToIST(afterUTC);
  let cur = { year: afterIST.year, month: afterIST.month, day: afterIST.day };
  if (afterIST.hours >= WORK_END) cur = addDaysIST(cur.year, cur.month, cur.day, 1);

  let maxDays = 14;

  while (slots.length < count && maxDays-- > 0) {
    const dow = dayOfWeekIST(cur.year, cur.month, cur.day);
    if (SKIP_DAYS.includes(dow)) { cur = addDaysIST(cur.year, cur.month, cur.day, 1); continue; }

    for (const h of PREFER_HOURS) {
      if (slots.length >= count) break;
      const totalEndMins = h * 60 + durationMinutes;
      const endH = Math.floor(totalEndMins / 60);
      const endM = totalEndMins % 60;
      if (endH > WORK_END) continue;

      // Skip hours before afterIST on the same IST day
      if (cur.year === afterIST.year && cur.month === afterIST.month &&
          cur.day === afterIST.day && h <= afterIST.hours) continue;

      const startISO = buildISTString(cur.year, cur.month, cur.day, h, 0);
      const endISO   = buildISTString(cur.year, cur.month, cur.day, endH, endM);
      if (new Date(startISO) <= new Date()) continue;

      try {
        const res  = await calendar.events.list({
          calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
          timeMin: startISO, timeMax: endISO, singleEvents: true,
        });
        const busy = (res.data.items || []).filter((e) => e.start?.dateTime);
        if (busy.length === 0) slots.push({ start: startISO, end: endISO, label: formatSlotLabel(startISO, endISO) });
      } catch {
        slots.push({ start: startISO, end: endISO, label: formatSlotLabel(startISO, endISO) });
      }
    }
    cur = addDaysIST(cur.year, cur.month, cur.day, 1);
  }
  return slots;
}

// ─── Calendar event creator ───────────────────────────────────────────────────

/**
 * THE ROOT FIX:
 * We build the ISO string directly from the parsed IST fields using buildISTString().
 * We NEVER pass the date through a JavaScript Date object for hour/minute extraction
 * because the server runs in UTC and .getHours() would return UTC hours, not IST hours.
 * A 5pm IST meeting = 11:30am UTC → server's .getHours() returns 11 → event saved at 11am IST.
 * buildISTString() bypasses this entirely by constructing "2026-04-25T17:00:00+05:30" directly.
 */
async function createCalendarEvent(details, attendeeEmail, slot) {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
    logger.warn('Google Calendar skipped — OAuth credentials not configured');
    return null;
  }
  try {
    const calendar = getCalendarClient();

    let startISO, endISO;

    if (details.exactDate) {
      const { year, month, day } = details.exactDate;
      const istH = details.exactTime ? details.exactTime.hours : 10; // default 10am IST
      const istM = details.exactTime ? details.exactTime.mins  : 0;

      // IST end time arithmetic (no Date object needed)
      const totalEndMins = istH * 60 + istM + details.durationMinutes;
      const endH = Math.floor(totalEndMins / 60) % 24;
      const endM = totalEndMins % 60;

      // Build +05:30 ISO strings directly — this is the fix
      startISO = buildISTString(year, month, day, istH, istM);
      endISO   = buildISTString(year, month, day, endH, endM);

      logger.info(`Calendar event IST: ${startISO} → ${endISO}`);

    } else if (slot) {
      startISO = slot.start;
      endISO   = slot.end;
    } else {
      logger.warn('createCalendarEvent: no exactDate or slot provided');
      return null;
    }

    const event = {
      summary:     details.purpose || 'Meeting',
      description: 'Scheduled by AI Email Agent',
      start: { dateTime: startISO, timeZone: 'Asia/Kolkata' },
      end:   { dateTime: endISO,   timeZone: 'Asia/Kolkata' },
      conferenceData: details.platform === 'Google Meet' ? {
        createRequest: { requestId: `ai-agent-${Date.now()}` },
      } : undefined,
    };

    const response = await calendar.events.insert({
      calendarId:            process.env.GOOGLE_CALENDAR_ID || 'primary',
      resource:              event,
      conferenceDataVersion: details.platform === 'Google Meet' ? 1 : 0,
      sendUpdates:           'none',
      sendNotifications:     false,
    });

    logger.info(`Calendar event created: ${response.data.htmlLink}`);
    return response.data;

  } catch (err) {
    logger.error('Calendar event creation failed', { error: err.message });
    return null;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  extractMeetingDetails,
  generateSlots,
  buildMeetingReply,
  buildBusyReply,
  checkCalendarConflict,
  findNextFreeSlots,
  createCalendarEvent,
  // Exported for testing
  parseTimeStr,
  parseDMY,
  parseRelative,
  parseDayName,
  buildISTString,
  nowIST,
  utcToIST,
  buildISTString,
};