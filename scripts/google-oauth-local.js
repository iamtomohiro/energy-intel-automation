#!/usr/bin/env node

require('dotenv').config();

const http = require('http');
const { google } = require('googleapis');

const PORT = Number(process.env.GOOGLE_OAUTH_PORT || 3000);
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const oauth2Client = new google.auth.OAuth2(
    requireEnv('GOOGLE_CLIENT_ID'),
    requireEnv('GOOGLE_CLIENT_SECRET'),
    REDIRECT_URI
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) throw new Error('No authorization code returned.');

      const { tokens } = await oauth2Client.getToken(code);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Authorization complete. You can close this browser tab and return to the terminal.');

      console.log('\nAuthorization complete.\n');
      console.log('Copy this value into GitHub Secrets as GOOGLE_REFRESH_TOKEN:\n');
      console.log(tokens.refresh_token || '(No refresh_token returned. Re-run with prompt=consent or remove prior app access.)');
      server.close();
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.message);
      console.error(error);
      server.close();
      process.exitCode = 1;
    }
  });

  server.listen(PORT, () => {
    console.log(`Listening on ${REDIRECT_URI}`);
    console.log('\nOpen this URL in a browser, sign in as fortunaoi132@gmail.com, and approve access:\n');
    console.log(authUrl);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
