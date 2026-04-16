// src/services/reminderService.js
// Reminder engine — creates reminders when agent replies to task/project emails.
// Stores in DB and surfaces them in the UI with snooze/dismiss controls.
'use strict';

const logger = require('../config/logger');
const { query } = require('../config/database');

// ─── Detect if email needs a reminder ────────────────────────────────────────
function shouldCreateReminder(analysis, email) {
  const REMINDER_INTENTS = ['task_request', 'question', 'meeting_request'];
  if (!REMINDER_INTENTS.includes(analysis.intent)) return false;

  const text = `${email.subject || ''} ${email.body || ''}`.toLowerCase();
  const hasDeadline = /deadline|due|by end of day|eod|today|tomorrow|by \w+day|asap|urgent/.test(text);
  const hasTask     = /report|submit|send|review|approve|complete|deliver|update/.test(text);
  return hasDeadline || hasTask || analysis.priority === 'high';
}

// ─── Extract reminder details from email ─────────────────────────────────────
function extractReminderDetails(email, analysis) {
  const text = `${email.subject || ''} ${email.body || ''}`.toLowerCase();

  // Default remind in 1 hour; bump to 3h for non-urgent
  let remindInHours = analysis.priority === 'high' ? 1 : 3;

  // Try to extract deadline from text
  if (/today|eod|by end of day/.test(text))      remindInHours = 2;
  if (/tomorrow/.test(text))                      remindInHours = 20;
  if (/next week/.test(text))                     remindInHours = 72;
  if (/asap|immediately|urgent/.test(text))       remindInHours = 1;

  const remindAt = new Date(Date.now() + remindInHours * 60 * 60 * 1000);

  const label =
    analysis.intent === 'meeting_request' ? `Follow up on meeting request from ${email.senderName || email.sender}`
    : analysis.intent === 'task_request'  ? `Complete task requested by ${email.senderName || email.sender}`
    : `Follow up on email from ${email.senderName || email.sender}`;

  return {
    label,
    subject: email.subject,
    sender: email.sender,
    senderName: email.senderName || email.sender,
    intent: analysis.intent,
    priority: analysis.priority,
    remindAt,
    remindInHours,
  };
}

// ─── Create a reminder ────────────────────────────────────────────────────────
async function createReminder(email, analysis) {
  if (!shouldCreateReminder(analysis, email)) return null;

  const details = extractReminderDetails(email, analysis);

  try {
    const result = await query(
      `INSERT INTO reminders
         (label, subject, sender, sender_name, intent, priority, remind_at, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
       RETURNING id`,
      [
        details.label, details.subject, details.sender,
        details.senderName, details.intent, details.priority,
        details.remindAt,
      ],
    );
    logger.info(`Reminder created: "${details.label}" at ${details.remindAt.toISOString()}`);
    return result.rows[0];
  } catch (err) {
    logger.warn('Could not create reminder', { error: err.message });
    return null;
  }
}

// ─── Get all reminders ────────────────────────────────────────────────────────
async function getReminders(status = null) {
  try {
    const q = status
      ? `SELECT * FROM reminders WHERE status = $1 ORDER BY remind_at ASC`
      : `SELECT * FROM reminders ORDER BY remind_at ASC`;
    const params = status ? [status] : [];
    const result = await query(q, params);
    return result.rows;
  } catch (err) {
    logger.warn('Could not fetch reminders', { error: err.message });
    return [];
  }
}

// ─── Dismiss a reminder ───────────────────────────────────────────────────────
async function dismissReminder(id) {
  try {
    await query(
      `UPDATE reminders SET status = 'dismissed', updated_at = NOW() WHERE id = $1`,
      [id],
    );
    return true;
  } catch (err) {
    logger.warn('Could not dismiss reminder', { error: err.message });
    return false;
  }
}

// ─── Snooze a reminder (push by 1 hour) ──────────────────────────────────────
async function snoozeReminder(id, hours = 1) {
  try {
    await query(
      `UPDATE reminders
       SET remind_at = remind_at + ($1 || ' hours')::interval,
           status = 'pending',
           updated_at = NOW()
       WHERE id = $2`,
      [hours, id],
    );
    return true;
  } catch (err) {
    logger.warn('Could not snooze reminder', { error: err.message });
    return false;
  }
}

// ─── Get due reminders (for badge count) ─────────────────────────────────────
async function getDueCount() {
  try {
    const result = await query(
      `SELECT COUNT(*) as count FROM reminders WHERE status = 'pending' AND remind_at <= NOW()`,
    );
    return parseInt(result.rows[0]?.count || 0);
  } catch {
    return 0;
  }
}

module.exports = { createReminder, getReminders, dismissReminder, snoozeReminder, getDueCount };