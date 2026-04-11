// src/routes/auth.js
// OAuth authentication flows for Gmail and Outlook

const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const axios = require('axios');
const logger = require('../config/logger');

// ============================================================
// GMAIL OAuth 2.0 Flow
// ============================================================

const getOAuth2Client = () => new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);

// Step 1: Redirect to Google's OAuth consent screen
router.get('/gmail', (req, res) => {
  const oauth2Client = getOAuth2Client();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
  });

  logger.info('Redirecting to Gmail OAuth consent');
  res.redirect(authUrl);
});

// Step 2: Handle OAuth callback - exchange code for tokens
router.get('/gmail/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    logger.error('Gmail OAuth error', { error });
    return res.status(400).json({ error: `OAuth denied: ${error}` });
  }

  if (!code) {
    return res.status(400).json({ error: 'No authorization code received' });
  }

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    logger.info('Gmail OAuth successful - save these tokens to .env!');
    logger.info('GMAIL_REFRESH_TOKEN=' + tokens.refresh_token);

    res.json({
      success: true,
      message: 'Gmail OAuth successful! Save the refresh_token to your .env file.',
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expiry_date: tokens.expiry_date,
      instruction: 'Set GMAIL_REFRESH_TOKEN in your .env file with the refresh_token above',
    });
  } catch (err) {
    logger.error('Gmail token exchange failed', { error: err.message });
    res.status(500).json({ error: `Token exchange failed: ${err.message}` });
  }
});

// ============================================================
// OUTLOOK OAuth 2.0 Flow
// ============================================================

router.get('/outlook', (req, res) => {
  const scope = encodeURIComponent(
    'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access'
  );
  const authUrl = `https://login.microsoftonline.com/${process.env.OUTLOOK_TENANT_ID}/oauth2/v2.0/authorize` +
    `?client_id=${process.env.OUTLOOK_CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(process.env.OUTLOOK_REDIRECT_URI)}` +
    `&scope=${scope}` +
    `&response_mode=query`;

  logger.info('Redirecting to Outlook OAuth consent');
  res.redirect(authUrl);
});

router.get('/outlook/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).json({ error: `OAuth denied: ${error}` });
  }

  try {
    const response = await axios.post(
      `https://login.microsoftonline.com/${process.env.OUTLOOK_TENANT_ID}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: process.env.OUTLOOK_CLIENT_ID,
        client_secret: process.env.OUTLOOK_CLIENT_SECRET,
        code,
        redirect_uri: process.env.OUTLOOK_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    logger.info('Outlook OAuth successful!');

    res.json({
      success: true,
      message: 'Outlook OAuth successful! Save the refresh_token to your .env file.',
      refresh_token: response.data.refresh_token,
      access_token: response.data.access_token,
      instruction: 'Set OUTLOOK_REFRESH_TOKEN in your .env file with the refresh_token above',
    });
  } catch (err) {
    logger.error('Outlook token exchange failed', { error: err.message });
    res.status(500).json({ error: `Token exchange failed: ${err.message}` });
  }
});

// ============================================================
// Test current auth status
// ============================================================
router.get('/status', async (req, res) => {
  const status = {
    gmail: false,
    outlook: false,
    imap: false,
  };

  // Gmail
  if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_REFRESH_TOKEN) {
    try {
      const oauth2Client = getOAuth2Client();
      oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
      await oauth2Client.getAccessToken();
      status.gmail = true;
    } catch {
      status.gmail = false;
    }
  }

  // Outlook
  if (process.env.OUTLOOK_CLIENT_ID && process.env.OUTLOOK_REFRESH_TOKEN) {
    status.outlook = !!process.env.OUTLOOK_REFRESH_TOKEN;
  }

  // IMAP - just check config
  if (process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASSWORD) {
    status.imap = true;
  }

  res.json({ success: true, authStatus: status });
});

module.exports = router;
