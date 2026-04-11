// src/services/calendarService.js
// Google Calendar integration for meeting scheduling

const { google } = require('googleapis');
const { DateTime } = require('luxon');
const logger = require('../config/logger');
const { query } = require('../config/database');

class CalendarService {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,   // Reuse Gmail OAuth credentials
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI
    );
    this.oauth2Client.setCredentials({
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    });
    this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
    this.calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  }

  // ============================================================
  // Get busy/free slots for a time range
  // ============================================================
  async checkAvailability(startDate, endDate, timezone = 'UTC') {
    try {
      const start = DateTime.fromISO(startDate, { zone: timezone }).toUTC().toISO();
      const end = DateTime.fromISO(endDate, { zone: timezone }).toUTC().toISO();

      const response = await this.calendar.freebusy.query({
        requestBody: {
          timeMin: start,
          timeMax: end,
          timeZone: timezone,
          items: [{ id: this.calendarId }],
        },
      });

      const busySlots = response.data.calendars?.[this.calendarId]?.busy || [];
      logger.info(`Checked availability: ${busySlots.length} busy slot(s)`);
      return { busy: busySlots, timezone };
    } catch (err) {
      logger.error('Calendar availability check failed', { error: err.message });
      throw new Error(`Calendar check failed: ${err.message}`);
    }
  }

  // ============================================================
  // Find available 30/60 min slots in next N days
  // ============================================================
  async findAvailableSlots(durationMinutes = 60, daysAhead = 7, timezone = 'UTC') {
    try {
      const now = DateTime.now().setZone(timezone);
      const endDate = now.plus({ days: daysAhead });

      const { busy } = await this.checkAvailability(
        now.toISO(),
        endDate.toISO(),
        timezone
      );

      const slots = [];
      let current = now.startOf('hour').plus({ hours: 1 });

      // Business hours: 9am - 6pm
      while (current < endDate) {
        const hour = current.hour;
        const isBusinessHour = hour >= 9 && hour < 18;
        const isWeekday = current.weekday <= 5;

        if (isBusinessHour && isWeekday) {
          const slotEnd = current.plus({ minutes: durationMinutes });

          // Check if slot overlaps with any busy period
          const isBusy = busy.some((b) => {
            const busyStart = DateTime.fromISO(b.start);
            const busyEnd = DateTime.fromISO(b.end);
            return current < busyEnd && slotEnd > busyStart;
          });

          if (!isBusy) {
            slots.push({
              start: current.toISO(),
              end: slotEnd.toISO(),
              displayTime: current.toFormat("cccc, LLLL d 'at' h:mm a"),
              timezone,
            });
          }
        }

        current = current.plus({ minutes: 30 });  // Check every 30 mins
        if (slots.length >= 5) break;  // Return first 5 available slots
      }

      return slots;
    } catch (err) {
      logger.error('Find available slots failed', { error: err.message });
      return [];
    }
  }

  // ============================================================
  // Create a calendar event
  // ============================================================
  async createEvent(options) {
    const {
      title,
      description,
      startDatetime,
      endDatetime,
      timezone = 'UTC',
      participants = [],
      emailId,
    } = options;

    try {
      const event = {
        summary: title,
        description,
        start: {
          dateTime: DateTime.fromISO(startDatetime).toUTC().toISO(),
          timeZone: timezone,
        },
        end: {
          dateTime: DateTime.fromISO(endDatetime).toUTC().toISO(),
          timeZone: timezone,
        },
        attendees: participants.map((email) => ({ email })),
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 },  // 1 day before
            { method: 'popup', minutes: 15 },         // 15 min before
          ],
        },
      };

      const response = await this.calendar.events.insert({
        calendarId: this.calendarId,
        requestBody: event,
        sendUpdates: 'all',  // Notify attendees
      });

      const createdEvent = response.data;

      // Log to database
      await query(
        `INSERT INTO calendar_events
           (email_id, google_event_id, title, description, start_datetime, end_datetime,
            timezone, participants, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'created')`,
        [
          emailId, createdEvent.id, title, description,
          startDatetime, endDatetime, timezone,
          JSON.stringify(participants),
        ]
      );

      logger.info(`Calendar event created: ${createdEvent.htmlLink}`);
      return {
        success: true,
        eventId: createdEvent.id,
        htmlLink: createdEvent.htmlLink,
        event: createdEvent,
      };
    } catch (err) {
      logger.error('Calendar event creation failed', { error: err.message });
      throw new Error(`Event creation failed: ${err.message}`);
    }
  }

  // ============================================================
  // Schedule meeting from email analysis
  // ============================================================
  async scheduleMeetingFromEmail(email, meetingDetails, emailId) {
    try {
      // If specific times were proposed, check availability
      if (meetingDetails.proposedTimes && meetingDetails.proposedTimes.length > 0) {
        const durationMs = (meetingDetails.duration || 60) * 60 * 1000;
        const participants = [
          email.sender,
          ...(meetingDetails.participants || []),
        ];

        // Try to parse first proposed time
        const proposedTime = meetingDetails.proposedTimes[0];
        const startDt = DateTime.fromISO(proposedTime);

        if (startDt.isValid) {
          const endDt = startDt.plus({ milliseconds: durationMs });

          return await this.createEvent({
            title: meetingDetails.meetingPurpose || `Meeting with ${email.senderName || email.sender}`,
            description: `Meeting scheduled from email: "${email.subject}"\n\nOriginal request:\n${email.body?.substring(0, 500)}`,
            startDatetime: startDt.toISO(),
            endDatetime: endDt.toISO(),
            timezone: meetingDetails.timezone || 'UTC',
            participants,
            emailId,
          });
        }
      }

      // No specific time - find available slots and return suggestions
      const slots = await this.findAvailableSlots(
        meetingDetails.duration || 60,
        7,
        meetingDetails.timezone || 'UTC'
      );

      return {
        success: false,
        suggestedSlots: slots,
        message: 'No specific time parsed - here are available slots',
      };
    } catch (err) {
      logger.error('Schedule meeting from email failed', { error: err.message });
      throw err;
    }
  }

  // ============================================================
  // List upcoming events
  // ============================================================
  async listUpcomingEvents(maxResults = 10) {
    try {
      const response = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin: new Date().toISOString(),
        maxResults,
        singleEvents: true,
        orderBy: 'startTime',
      });

      return response.data.items || [];
    } catch (err) {
      logger.error('List events failed', { error: err.message });
      return [];
    }
  }
}

module.exports = new CalendarService();
