// src/services/emailService.js
// Unified email abstraction layer supporting Gmail, Outlook, and IMAP/SMTP
// All emails are normalized into a consistent format

const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const logger = require('../config/logger');

// ============================================================
// NORMALIZED EMAIL SCHEMA
// ============================================================
// {
//   sender: string,
//   senderName: string,
//   subject: string,
//   body: string,
//   htmlBody: string,
//   threadId: string,
//   messageId: string,
//   provider: "gmail" | "outlook" | "imap",
//   receivedAt: Date,
//   attachments: [],
//   rawHeaders: {}
// }

// ============================================================
// GMAIL SERVICE
// ============================================================
class GmailService {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI
    );
    this.oauth2Client.setCredentials({
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    });
    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
  }

  // Decode base64url encoded email body
  _decodeBody(data) {
    if (!data) return '';
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  }

  // Extract body parts from Gmail message payload
  _extractBody(payload) {
    let plainText = '';
    let htmlText = '';

    const extractParts = (parts) => {
      if (!parts) return;
      for (const part of parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          plainText = this._decodeBody(part.body.data);
        } else if (part.mimeType === 'text/html' && part.body?.data) {
          htmlText = this._decodeBody(part.body.data);
        } else if (part.parts) {
          extractParts(part.parts);
        }
      }
    };

    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      plainText = this._decodeBody(payload.body.data);
    } else if (payload.mimeType === 'text/html' && payload.body?.data) {
      htmlText = this._decodeBody(payload.body.data);
    } else if (payload.parts) {
      extractParts(payload.parts);
    }

    return { plainText, htmlText };
  }

  // Parse a raw Gmail message into our normalized format
  _normalizeMessage(message) {
    const headers = message.payload?.headers || [];
    const getHeader = (name) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    const { plainText, htmlText } = this._extractBody(message.payload);
    const from = getHeader('From');
    const senderMatch = from.match(/^(.*?)\s*<(.+)>$/) || [null, '', from];

    return {
      messageId: message.id,
      threadId: message.threadId,
      provider: 'gmail',
      sender: senderMatch[2] || from,
      senderName: senderMatch[1]?.replace(/"/g, '') || '',
      subject: getHeader('Subject'),
      body: plainText,
      htmlBody: htmlText,
      receivedAt: new Date(parseInt(message.internalDate)),
      rawHeaders: Object.fromEntries(headers.map((h) => [h.name, h.value])),
      attachments: [],
    };
  }

  async fetchEmails(maxResults = 20, query = 'is:unread') {
    try {
      const listResponse = await this.gmail.users.messages.list({
        userId: 'me',
        maxResults,
        q: query,
      });

      const messages = listResponse.data.messages || [];
      const emails = [];

      for (const msg of messages) {
        try {
          const detail = await this.gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full',
          });
          emails.push(this._normalizeMessage(detail.data));
        } catch (err) {
          logger.warn(`Failed to fetch Gmail message ${msg.id}`, { error: err.message });
        }
      }

      logger.info(`Fetched ${emails.length} emails from Gmail`);
      return emails;
    } catch (err) {
      logger.error('Gmail fetch error', { error: err.message });
      throw new Error(`Gmail fetch failed: ${err.message}`);
    }
  }

  async sendReply(threadId, toEmail, subject, replyText) {
    try {
      // Create RFC 2822 formatted email
      const rawMessage = [
        `To: ${toEmail}`,
        `Subject: Re: ${subject.replace(/^Re:\s*/i, '')}`,
        `In-Reply-To: ${threadId}`,
        `References: ${threadId}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        replyText,
      ].join('\r\n');

      const encoded = Buffer.from(rawMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encoded, threadId },
      });

      logger.info(`Gmail reply sent to ${toEmail}`);
      return { success: true, provider: 'gmail' };
    } catch (err) {
      logger.error('Gmail send error', { error: err.message });
      throw new Error(`Gmail send failed: ${err.message}`);
    }
  }

  async trashMessage(messageId) {
    try {
      await this.gmail.users.messages.trash({ userId: 'me', id: messageId });
      logger.info(`Gmail message ${messageId} moved to trash`);
      return { success: true };
    } catch (err) {
      logger.error('Gmail trash error', { error: err.message });
      throw err;
    }
  }

  async moveToLabel(messageId, labelName) {
    try {
      // Get or create label
      const labelsRes = await this.gmail.users.labels.list({ userId: 'me' });
      let label = labelsRes.data.labels.find(
        (l) => l.name.toLowerCase() === labelName.toLowerCase()
      );

      if (!label) {
        const created = await this.gmail.users.labels.create({
          userId: 'me',
          requestBody: { name: labelName, labelListVisibility: 'labelShow' },
        });
        label = created.data;
      }

      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { addLabelIds: [label.id], removeLabelIds: ['INBOX'] },
      });

      logger.info(`Gmail message ${messageId} moved to label: ${labelName}`);
      return { success: true };
    } catch (err) {
      logger.error('Gmail label error', { error: err.message });
      throw err;
    }
  }
}

// ============================================================
// OUTLOOK / MICROSOFT GRAPH SERVICE
// ============================================================
class OutlookService {
  constructor() {
    this.clientId = process.env.OUTLOOK_CLIENT_ID;
    this.clientSecret = process.env.OUTLOOK_CLIENT_SECRET;
    this.tenantId = process.env.OUTLOOK_TENANT_ID;
    this.refreshToken = process.env.OUTLOOK_REFRESH_TOKEN;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  async _getAccessToken() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const axios = require('axios');
    const response = await axios.post(
      `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
        scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    this.accessToken = response.data.access_token;
    this.tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
    return this.accessToken;
  }

  async _graphRequest(method, path, body = null) {
    const axios = require('axios');
    const token = await this._getAccessToken();
    const response = await axios({
      method,
      url: `https://graph.microsoft.com/v1.0${path}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: body,
    });
    return response.data;
  }

  _normalizeMessage(msg) {
    return {
      messageId: msg.id,
      threadId: msg.conversationId,
      provider: 'outlook',
      sender: msg.from?.emailAddress?.address || '',
      senderName: msg.from?.emailAddress?.name || '',
      subject: msg.subject || '',
      body: msg.body?.contentType === 'text' ? msg.body.content : this._stripHtml(msg.body?.content || ''),
      htmlBody: msg.body?.contentType === 'html' ? msg.body.content : '',
      receivedAt: new Date(msg.receivedDateTime),
      rawHeaders: {},
      attachments: msg.attachments || [],
    };
  }

  _stripHtml(html) {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  async fetchEmails(maxResults = 20) {
    try {
      const data = await this._graphRequest(
        'GET',
        `/me/mailFolders/inbox/messages?$top=${maxResults}&$filter=isRead eq false&$orderby=receivedDateTime desc`
      );

      const emails = (data.value || []).map((msg) => this._normalizeMessage(msg));
      logger.info(`Fetched ${emails.length} emails from Outlook`);
      return emails;
    } catch (err) {
      logger.error('Outlook fetch error', { error: err.message });
      throw new Error(`Outlook fetch failed: ${err.message}`);
    }
  }

  async sendReply(messageId, replyText) {
    try {
      await this._graphRequest('POST', `/me/messages/${messageId}/reply`, {
        message: {},
        comment: replyText,
      });
      logger.info(`Outlook reply sent for message ${messageId}`);
      return { success: true, provider: 'outlook' };
    } catch (err) {
      logger.error('Outlook send error', { error: err.message });
      throw new Error(`Outlook send failed: ${err.message}`);
    }
  }

  async trashMessage(messageId) {
    try {
      await this._graphRequest('DELETE', `/me/messages/${messageId}`);
      logger.info(`Outlook message ${messageId} deleted`);
      return { success: true };
    } catch (err) {
      logger.error('Outlook trash error', { error: err.message });
      throw err;
    }
  }

  async moveToFolder(messageId, folderName) {
    try {
      // Get or create folder
      const folders = await this._graphRequest('GET', '/me/mailFolders');
      let folder = folders.value.find(
        (f) => f.displayName.toLowerCase() === folderName.toLowerCase()
      );

      if (!folder) {
        folder = await this._graphRequest('POST', '/me/mailFolders', {
          displayName: folderName,
        });
      }

      await this._graphRequest('POST', `/me/messages/${messageId}/move`, {
        destinationId: folder.id,
      });

      logger.info(`Outlook message ${messageId} moved to ${folderName}`);
      return { success: true };
    } catch (err) {
      logger.error('Outlook move error', { error: err.message });
      throw err;
    }
  }
}

// ============================================================
// IMAP/SMTP SERVICE (Yahoo, custom domains, etc.)
// ============================================================
class ImapService {
  constructor() {
    this.config = {
      host: process.env.IMAP_HOST,
      port: parseInt(process.env.IMAP_PORT) || 993,
      tls: process.env.IMAP_TLS !== 'false',
      user: process.env.IMAP_USER,
      password: process.env.IMAP_PASSWORD,
    };
    this.smtpConfig = {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_TLS === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    };
  }

  async fetchEmails(maxResults = 20) {
    return new Promise((resolve, reject) => {
      const Imap = require('node-imap');
      const { simpleParser } = require('mailparser');
      const imap = new Imap(this.config);
      const emails = [];

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err, box) => {
          if (err) { imap.end(); return reject(err); }

          // Fetch last N unseen messages
          imap.search(['UNSEEN'], (err, uids) => {
            if (err) { imap.end(); return reject(err); }

            if (!uids || uids.length === 0) {
              imap.end();
              return resolve([]);
            }

            const fetchUids = uids.slice(-maxResults);
            const fetch = imap.fetch(fetchUids, { bodies: '', struct: true });

            fetch.on('message', (msg) => {
              let rawEmail = '';
              const uid = msg.uid;

              msg.on('body', (stream) => {
                stream.on('data', (chunk) => { rawEmail += chunk.toString('utf8'); });
              });

              msg.once('end', async () => {
                try {
                  const parsed = await simpleParser(rawEmail);
                  emails.push({
                    messageId: parsed.messageId || `imap-${Date.now()}-${Math.random()}`,
                    threadId: parsed.inReplyTo || parsed.messageId,
                    provider: 'imap',
                    sender: parsed.from?.value?.[0]?.address || '',
                    senderName: parsed.from?.value?.[0]?.name || '',
                    subject: parsed.subject || '',
                    body: parsed.text || '',
                    htmlBody: parsed.html || '',
                    receivedAt: parsed.date || new Date(),
                    rawHeaders: Object.fromEntries(parsed.headers || []),
                    attachments: (parsed.attachments || []).map((a) => ({
                      filename: a.filename,
                      contentType: a.contentType,
                      size: a.size,
                    })),
                  });
                } catch (parseErr) {
                  logger.warn('Failed to parse IMAP message', { error: parseErr.message });
                }
              });
            });

            fetch.once('end', () => {
              imap.end();
              logger.info(`Fetched ${emails.length} emails via IMAP`);
              resolve(emails);
            });

            fetch.once('error', (err) => {
              imap.end();
              reject(err);
            });
          });
        });
      });

      imap.once('error', (err) => {
        logger.error('IMAP connection error', { error: err.message });
        reject(new Error(`IMAP failed: ${err.message}`));
      });

      imap.connect();
    });
  }

  async sendReply(toEmail, subject, replyText, inReplyTo = null) {
    try {
      const transporter = nodemailer.createTransport(this.smtpConfig);

      const mailOptions = {
        from: this.smtpConfig.auth.user,
        to: toEmail,
        subject: `Re: ${subject.replace(/^Re:\s*/i, '')}`,
        text: replyText,
        ...(inReplyTo && {
          inReplyTo,
          references: inReplyTo,
        }),
      };

      await transporter.sendMail(mailOptions);
      logger.info(`SMTP reply sent to ${toEmail}`);
      return { success: true, provider: 'imap' };
    } catch (err) {
      logger.error('SMTP send error', { error: err.message });
      throw new Error(`SMTP send failed: ${err.message}`);
    }
  }

  async trashMessage(uid) {
    // IMAP move to Trash
    return new Promise((resolve, reject) => {
      const Imap = require('node-imap');
      const imap = new Imap(this.config);

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err) => {
          if (err) { imap.end(); return reject(err); }

          imap.addFlags(uid, '\\Deleted', (err) => {
            if (err) { imap.end(); return reject(err); }
            imap.expunge((err) => {
              imap.end();
              if (err) return reject(err);
              resolve({ success: true });
            });
          });
        });
      });

      imap.once('error', reject);
      imap.connect();
    });
  }
}

// ============================================================
// UNIFIED EMAIL SERVICE (facade)
// ============================================================
class EmailService {
  constructor() {
    this.providers = {};

    // Initialize providers based on available config
    if (process.env.GMAIL_CLIENT_ID) {
      this.providers.gmail = new GmailService();
    }
    if (process.env.OUTLOOK_CLIENT_ID) {
      this.providers.outlook = new OutlookService();
    }
    if (process.env.IMAP_HOST) {
      this.providers.imap = new ImapService();
    }

    logger.info(`Email providers initialized: ${Object.keys(this.providers).join(', ') || 'none'}`);
  }

  // Fetch from all configured providers
  async fetchAllEmails(maxPerProvider = 20) {
    const allEmails = [];
    const errors = [];

    for (const [name, provider] of Object.entries(this.providers)) {
      try {
        const emails = await provider.fetchEmails(maxPerProvider);
        allEmails.push(...emails);
        logger.info(`Fetched ${emails.length} emails from ${name}`);
      } catch (err) {
        errors.push({ provider: name, error: err.message });
        logger.error(`Failed to fetch from ${name}`, { error: err.message });
      }
    }

    return { emails: allEmails, errors };
  }

  // Send reply via the correct provider
  async sendReply(provider, messageId, threadId, toEmail, subject, replyText) {
    const svc = this.providers[provider];
    if (!svc) throw new Error(`Provider '${provider}' not configured`);

    if (provider === 'gmail') {
      return svc.sendReply(threadId, toEmail, subject, replyText);
    } else if (provider === 'outlook') {
      return svc.sendReply(messageId, replyText);
    } else if (provider === 'imap') {
      return svc.sendReply(toEmail, subject, replyText, messageId);
    }
  }

  // Trash/delete message via the correct provider
  async trashMessage(provider, messageId) {
    const svc = this.providers[provider];
    if (!svc) throw new Error(`Provider '${provider}' not configured`);
    return svc.trashMessage(messageId);
  }

  // Move to folder/label
  async moveToFolder(provider, messageId, folderName) {
    const svc = this.providers[provider];
    if (!svc) throw new Error(`Provider '${provider}' not configured`);

    if (provider === 'gmail') {
      return svc.moveToLabel(messageId, folderName);
    } else if (provider === 'outlook') {
      return svc.moveToFolder(messageId, folderName);
    }
    // IMAP: not implemented for all servers, log it
    logger.warn('moveToFolder not supported for IMAP in this implementation');
    return { success: false, message: 'Not supported' };
  }

  getActiveProviders() {
    return Object.keys(this.providers);
  }
}

module.exports = new EmailService();
module.exports.GmailService = GmailService;
module.exports.OutlookService = OutlookService;
module.exports.ImapService = ImapService;
