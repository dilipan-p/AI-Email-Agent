require('dotenv').config();
const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);

oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN,
});

oauth2Client.refreshAccessToken((err, tokens) => {
  if (err) {
    console.error('❌ Token Expired/Invalid:', err.message);
    console.log('👉 Run: npm run dev, then visit http://localhost:3000/auth/gmail to get a fresh token');
    process.exit(1);
  }
  console.log('✅ OAuth Token Valid!');
  console.log('Access Token:', tokens.access_token.slice(0, 20) + '...');
  process.exit(0);
});