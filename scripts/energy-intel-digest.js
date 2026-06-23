#!/usr/bin/env node

require('dotenv').config();

const { google } = require('googleapis');
const OpenAI = require('openai');

const CONFIG = {
  spreadsheetId: process.env.ENERGY_INTEL_SPREADSHEET_ID || '1ovlkKK6EKxM4Lr75ngR1cceHf6pV6hpfCEl_wct03VY',
  configSheet: process.env.ENERGY_INTEL_CONFIG_SHEET || 'config',
  stateSheet: process.env.ENERGY_INTEL_STATE_SHEET || 'system_state',
  outputSheet: process.env.ENERGY_INTEL_OUTPUT_SHEET || 'all_outputs',
  batchSize: Number(process.env.ENERGY_INTEL_BATCH_SIZE || 3),
  defaultSlackChannel: process.env.ENERGY_INTEL_SLACK_CHANNEL || '#energy-intel',
  model: process.env.ENERGY_INTEL_MODEL || 'gpt-4o',
};

const STATE_HEADERS = ['key', 'value', 'updated_at'];
const OUTPUT_HEADERS = [
  'processed_at_jst',
  'feed_name',
  'gmail_from',
  'email_subject',
  'received_at_jst',
  'message_id',
  'channel',
  'executive_summary',
  'why_it_matters',
  'digest_markdown',
];
const SOURCE_HEADERS = [
  'processed_at_jst',
  'email_subject',
  'received_at_jst',
  'message_id',
  'executive_summary',
  'why_it_matters',
  'digest_markdown',
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function nowJst() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date()).replace(' ', 'T');
}

function toJst(isoOrMillis) {
  const date = typeof isoOrMillis === 'number' ? new Date(isoOrMillis) : new Date(isoOrMillis);
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function sanitizeSheetName(name) {
  return String(name || 'source')
    .replace(/[\[\]\*\?\/\\:]/g, '-')
    .slice(0, 90)
    .trim() || 'source';
}

function decodeBase64Url(data = '') {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function flattenParts(payload, acc = []) {
  if (!payload) return acc;
  if (payload.body?.data && (payload.mimeType || '').startsWith('text/')) {
    acc.push({ mimeType: payload.mimeType, text: decodeBase64Url(payload.body.data) });
  }
  for (const part of payload.parts || []) flattenParts(part, acc);
  return acc;
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getHeader(headers, name) {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

async function getAuth() {
  const oauth2Client = new google.auth.OAuth2(
    requireEnv('GOOGLE_CLIENT_ID'),
    requireEnv('GOOGLE_CLIENT_SECRET')
  );
  oauth2Client.setCredentials({ refresh_token: requireEnv('GOOGLE_REFRESH_TOKEN') });
  return oauth2Client;
}

async function getSheets(auth) {
  return google.sheets({ version: 'v4', auth });
}

async function getGmail(auth) {
  return google.gmail({ version: 'v1', auth });
}

async function ensureSheet(sheets, title, headers) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: CONFIG.spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === title);
  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: CONFIG.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
  }

  const read = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.spreadsheetId,
    range: `'${title}'!A1:${String.fromCharCode(64 + headers.length)}1`,
  }).catch(() => ({ data: { values: [] } }));

  if (!read.data.values?.[0]?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.spreadsheetId,
      range: `'${title}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
}

async function readRows(sheets, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.spreadsheetId,
    range: `'${sheetName}'!A:Z`,
  });
  const values = res.data.values || [];
  const headers = values[0] || [];
  return values.slice(1).map((row, idx) => {
    const item = { _rowNumber: idx + 2 };
    headers.forEach((h, i) => { item[h] = row[i] || ''; });
    return item;
  });
}

async function readState(sheets) {
  await ensureSheet(sheets, CONFIG.stateSheet, STATE_HEADERS);
  const rows = await readRows(sheets, CONFIG.stateSheet);
  const state = {};
  for (const row of rows) state[row.key] = row.value;
  return state;
}

async function writeState(sheets, state) {
  const rows = Object.entries(state).map(([key, value]) => [key, String(value), nowJst()]);
  await sheets.spreadsheets.values.clear({
    spreadsheetId: CONFIG.spreadsheetId,
    range: `'${CONFIG.stateSheet}'!A2:C`,
  });
  if (rows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.spreadsheetId,
      range: `'${CONFIG.stateSheet}'!A2`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  }
}

function pickSources(configRows, startIndex) {
  const enabled = configRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => String(row.enabled).toUpperCase() === 'TRUE');
  if (!enabled.length) return { sources: [], nextIndex: 0 };

  const sources = [];
  let cursor = Number.isFinite(startIndex) ? startIndex : 0;
  let scanned = 0;

  while (sources.length < CONFIG.batchSize && scanned < configRows.length) {
    const index = cursor % configRows.length;
    const row = configRows[index];
    if (String(row.enabled).toUpperCase() === 'TRUE') sources.push({ row, index });
    cursor += 1;
    scanned += 1;
  }

  return { sources, nextIndex: cursor % configRows.length };
}

async function fetchLatestMessage(gmail, source, afterIso) {
  if (source.source_type !== 'gmail') return null;
  if (!source.gmail_from && !source.gmail_query) {
    console.warn(`Skip ${source.feed_name}: gmail_from or gmail_query is required.`);
    return null;
  }

  const afterMillis = new Date(afterIso || '1970-01-01T00:00:00Z').getTime();
  const baseQuery = source.gmail_query || `from:${source.gmail_from}`;
  const afterDate = afterMillis > 0
    ? new Date(afterMillis - 86400000).toISOString().slice(0, 10).replace(/-/g, '/')
    : '';
  const query = afterDate ? `${baseQuery} after:${afterDate}` : baseQuery;

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 10,
  });
  const messages = list.data.messages || [];
  if (!messages.length) return null;

  const details = [];
  for (const msg of messages) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    });
    details.push(full.data);
  }

  const freshDetails = details.filter((item) => Number(item.internalDate) > afterMillis);
  if (!freshDetails.length) return null;

  freshDetails.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
  const latest = freshDetails[0];
  const parts = flattenParts(latest.payload);
  const plain = parts.find((p) => p.mimeType === 'text/plain')?.text;
  const html = parts.find((p) => p.mimeType === 'text/html')?.text;
  const body = (plain || htmlToText(html || latest.snippet || '')).slice(0, 25000);

  return {
    id: latest.id,
    internalDate: Number(latest.internalDate),
    receivedIso: new Date(Number(latest.internalDate)).toISOString(),
    receivedJst: toJst(Number(latest.internalDate)),
    subject: getHeader(latest.payload.headers || [], 'Subject'),
    from: getHeader(latest.payload.headers || [], 'From'),
    body,
  };
}

function extractSection(markdown, heading) {
  const pattern = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
  return markdown.match(pattern)?.[1]?.trim() || '';
}

async function analyzeNewsletter(source, message) {
  const client = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') });
  const system = `You are an energy and power-sector strategy consultant. Write in Japanese. Markdown section headings must be English. Separate Fact, Interpretation, Implication, and Next Action. Include Executive Summary, Why It Matters, Client Relevance, Consultant Questions, and Terms. Do not invent facts.`;
  const user = `Analyze this newsletter for an energy strategy consultant.

Source metadata:
- feed_name: ${source.feed_name}
- gmail_from: ${source.gmail_from}
- segment: ${source.segment || ''}
- region: ${source.region || ''}
- priority: ${source.priority || ''}

Email metadata:
- subject: ${message.subject}
- received_at_jst: ${message.receivedJst}
- from: ${message.from}

Newsletter body:
${message.body}

Return exactly these Markdown sections:
## Source
## Subject
## Executive Summary
## Why It Matters
## Fact
## Interpretation
## Implication
## Client Relevance
## Consultant Questions
## Next Action
## Terms
## Watchlist
## Confidence`;

  const response = await client.chat.completions.create({
    model: CONFIG.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.4,
    max_completion_tokens: 2500,
  });

  return response.choices[0].message.content.trim();
}

async function postToSlack(markdown, source) {
  const webhookUrl = requireEnv('SLACK_WEBHOOK_URL');
  const text = markdown.length > 39000 ? `${markdown.slice(0, 39000)}\n\n...truncated` : markdown;
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      channel: source.channel || CONFIG.defaultSlackChannel,
      username: 'Energy Intel',
    }),
  });
  if (!res.ok) throw new Error(`Slack post failed: ${res.status} ${await res.text()}`);
}

async function appendOutput(sheets, sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: CONFIG.spreadsheetId,
    range: `'${sheetName}'!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}

async function main() {
  const auth = await getAuth();
  const sheets = await getSheets(auth);
  const gmail = await getGmail(auth);

  await ensureSheet(sheets, CONFIG.outputSheet, OUTPUT_HEADERS);

  const configRows = await readRows(sheets, CONFIG.configSheet);
  const state = await readState(sheets);
  const cursor = Number(state.next_config_index || 0);
  const { sources, nextIndex } = pickSources(configRows, cursor);

  console.log(`Checking ${sources.length} sources from config index ${cursor}.`);

  for (const { row: source } of sources) {
    const sourceKey = `last_received_at_iso:${source.feed_name}`;
    const previousIso = state[sourceKey] || '1970-01-01T00:00:00Z';
    const message = await fetchLatestMessage(gmail, source, previousIso);

    if (!message) {
      console.log(`No update: ${source.feed_name}`);
      continue;
    }

    console.log(`Processing ${source.feed_name}: ${message.subject}`);
    const digest = await analyzeNewsletter(source, message);
    await postToSlack(digest, source);

    const processedAt = nowJst();
    const executiveSummary = extractSection(digest, 'Executive Summary');
    const whyItMatters = extractSection(digest, 'Why It Matters');
    const sourceSheet = sanitizeSheetName(source.feed_name);

    await ensureSheet(sheets, sourceSheet, SOURCE_HEADERS);
    await appendOutput(sheets, CONFIG.outputSheet, [
      processedAt,
      source.feed_name,
      source.gmail_from,
      message.subject,
      message.receivedJst,
      message.id,
      source.channel || CONFIG.defaultSlackChannel,
      executiveSummary,
      whyItMatters,
      digest,
    ]);
    await appendOutput(sheets, sourceSheet, [
      processedAt,
      message.subject,
      message.receivedJst,
      message.id,
      executiveSummary,
      whyItMatters,
      digest,
    ]);

    state[sourceKey] = message.receivedIso;
    state[`last_subject:${source.feed_name}`] = message.subject;
  }

  state.next_config_index = nextIndex;
  state.last_run_at_jst = nowJst();
  await writeState(sheets, state);
  console.log(`Done. Next config index: ${nextIndex}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
