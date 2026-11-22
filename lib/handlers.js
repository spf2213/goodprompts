'use strict';

// The back-end endpoints, written for Vercel's Node functions:
//   POST /api/waitlist  saves an email address
//   GET  /api/health    reports whether the database is reachable
//   POST /api/rewrite   rewrites a draft prompt for the extension
const db = require('./db');

const MAX_BODY_BYTES = 8 * 1024;
// Hidden form field that people never see. Anything typed into it came from a bot.
const TRAP_FIELD = 'hp_confirm';

// Sign-up limit per visitor. Functions keep this in memory, so it applies per running instance and
// resets when an instance is recycled. It slows casual abuse; firm limits belong in Vercel's firewall.
const IP_WINDOW_MS = 10 * 60 * 1000;
const IP_LIMIT = positiveInteger(process.env.WAITLIST_IP_LIMIT, 20);
const MAX_TRACKED_CLIENTS = 5000;
const clients = new Map();

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const first = typeof forwarded === 'string' ? forwarded.split(',', 1)[0].trim() : '';
  return (first || (req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 64);
}

// Returns 0 when the request may proceed, otherwise the number of seconds to wait.
function secondsUntilAllowed(req, now = Date.now()) {
  const key = clientKey(req);
  let entry = clients.get(key);
  if (!entry || now >= entry.resetAt) {
    if (clients.size >= MAX_TRACKED_CLIENTS) {
      for (const [k, e] of clients) if (now >= e.resetAt) clients.delete(k);
      if (clients.size >= MAX_TRACKED_CLIENTS) clients.clear();
    }
    entry = { count: 0, resetAt: now + IP_WINDOW_MS };
    clients.set(key, entry);
  }
  if (entry.count >= IP_LIMIT) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  entry.count += 1;
  return 0;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254) return null;
  const parts = email.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (
    !local || local.length > 64 || local.startsWith('.') || local.endsWith('.') ||
    local.includes('..') || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  ) return null;
  const labels = domain.split('.');
  if (
    labels.length < 2 || labels[labels.length - 1].length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) return null;
  return email;
}

function send(res, status, body, headers = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.status(status).json(body);
}

const UNAVAILABLE = { success: false, error: 'Waitlist is temporarily unavailable. Please try again later.' };

async function waitlist(req, res) {
  if (req.method !== 'POST') {
    send(res, 405, { success: false, error: 'Method not allowed.' }, { Allow: 'POST' });
    return;
  }
  const wait = secondsUntilAllowed(req);
  if (wait) {
    send(res, 429, { success: false, error: 'Too many sign-ups from this network. Please try again in a few minutes.' },
      { 'Retry-After': String(wait) });
    return;
  }
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    send(res, 415, { success: false, error: 'Content-Type must be application/json.' });
    return;
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    send(res, 413, { success: false, error: 'Request body is too large.' });
    return;
  }
  let body;
  try {
    body = req.body; // parsed by the platform; reading it throws when the JSON is malformed
  } catch {
    send(res, 400, { success: false, error: 'Request body must be valid JSON.' });
    return;
  }
  const fields = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (typeof fields[TRAP_FIELD] === 'string' && fields[TRAP_FIELD].trim()) {
    // A bot filled the hidden field. Answer as if it worked, and store nothing.
    send(res, 200, { success: true, message: 'You are on the waitlist.' });
    return;
  }
  const email = normalizeEmail(fields.email);
  if (!email) {
    send(res, 400, { success: false, error: 'Enter a valid email address (maximum 254 characters).' });
    return;
  }
  if (!db.isConfigured()) {
    send(res, 503, UNAVAILABLE);
    return;
  }
  try {
    await db.addEmail(email);
  } catch {
    // Do not log the error: driver messages can include the connection address.
    send(res, 503, UNAVAILABLE);
    return;
  }
  send(res, 200, { success: true, message: 'You are on the waitlist.' });
}

async function health(req, res) {
  if (req.method !== 'GET') {
    send(res, 405, { success: false, error: 'Method not allowed.' }, { Allow: 'GET' });
    return;
  }
  try {
    await db.ping();
    send(res, 200, { success: true, status: 'ready' });
  } catch {
    send(res, 503, { success: false, status: 'not ready' });
  }
}

// ---- POST /api/rewrite ------------------------------------------------------
// The extension sends a draft prompt and gets back the rewrite. The draft is passed to the model
// and returned; it is never written to the database or to the logs.
const crypto = require('node:crypto');
const engine = require('./rewrite-engine');

const REWRITE_BODY_BYTES = 64 * 1024;
const INSTALL_DAILY = positiveInteger(process.env.REWRITE_INSTALL_DAILY, 40);   // per installed copy
const NETWORK_DAILY = positiveInteger(process.env.REWRITE_NETWORK_DAILY, 120);  // per network address
// The try-it box on the website is anonymous, so it gets a much smaller allowance than an installed copy.
const WEB_DAILY = positiveInteger(process.env.REWRITE_WEB_DAILY, 5);                 // per browser
const WEB_NETWORK_DAILY = positiveInteger(process.env.REWRITE_WEB_NETWORK_DAILY, 20); // per network address
const GLOBAL_DAILY = positiveInteger(process.env.REWRITE_GLOBAL_DAILY, 3000);   // everyone combined: the spend ceiling

// Used only when there is no database (local preview). On Vercel the counters live in Postgres.
const localCounts = new Map();
function countLocally(keys) {
  const day = new Date().toISOString().slice(0, 10);
  const totals = {};
  for (const key of keys) {
    const id = `${day}:${key}`;
    localCounts.set(id, (localCounts.get(id) || 0) + 1);
    totals[key] = localCounts.get(id);
  }
  return totals;
}

const STATUS_FOR = { empty: 400, too_long: 413, refused: 422, timeout: 504, busy: 503, not_ready: 503, network: 502, upstream: 502, bad_response: 502 };

async function rewrite(req, res) {
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, code: 'method', message: 'Method not allowed.' }, { Allow: 'POST' });
    return;
  }
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    send(res, 415, { ok: false, code: 'bad_request', message: 'Content-Type must be application/json.' });
    return;
  }
  if (Number(req.headers['content-length']) > REWRITE_BODY_BYTES) {
    send(res, 413, { ok: false, code: 'too_long', message: 'The prompt is over 1,500 words.' });
    return;
  }
  let body;
  try {
    body = req.body;
  } catch {
    send(res, 400, { ok: false, code: 'bad_request', message: 'Request body must be valid JSON.' });
    return;
  }
  const fields = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const text = typeof fields.text === 'string' ? fields.text : '';
  const installId = typeof fields.installId === 'string' ? fields.installId : '';
  if (!/^[A-Za-z0-9-]{16,64}$/.test(installId)) {
    send(res, 400, { ok: false, code: 'bad_request', message: 'Missing install id.' });
    return;
  }
  if (!text.trim()) {
    send(res, 400, { ok: false, code: 'empty', message: 'There is no text to rewrite.' });
    return;
  }
  if (engine.countWords(text) > engine.MAX_WORDS) {
    send(res, 413, { ok: false, code: 'too_long', message: 'The prompt is over 1,500 words.' });
    return;
  }
  // On Vercel, refuse to run without the key or without the database that enforces the limits.
  const hosted = Boolean(process.env.VERCEL);
  if (!engine.isConfigured() && !rewrite.testClient) {
    send(res, 503, { ok: false, code: 'not_ready', message: 'The rewrite service is not set up yet.' });
    return;
  }
  if (hosted && !db.isConfigured()) {
    send(res, 503, { ok: false, code: 'not_ready', message: 'The rewrite service is not set up yet.' });
    return;
  }

  // Count this request against the three daily limits before spending anything on the model.
  const day = new Date().toISOString().slice(0, 10);
  const network = crypto.createHash('sha256').update(`${day}|${clientKey(req)}`).digest('hex').slice(0, 32);
  const fromWeb = installId.startsWith('web-');
  const perCopy = fromWeb ? WEB_DAILY : INSTALL_DAILY;
  const perNetwork = fromWeb ? WEB_NETWORK_DAILY : NETWORK_DAILY;
  const keys = [`install:${installId}`, `${fromWeb ? 'webnet' : 'network'}:${network}`, 'global'];
  let totals;
  try {
    totals = db.isConfigured() ? await db.countUsage(keys) : countLocally(keys);
  } catch {
    send(res, 503, { ok: false, code: 'not_ready', message: 'The rewrite service is temporarily unavailable.' });
    return;
  }
  if (totals.global > GLOBAL_DAILY) {
    send(res, 429, { ok: false, code: 'rate_limit', message: 'Good Prompts has reached its limit for today. Try again tomorrow.' });
    return;
  }
  if (totals[keys[0]] > perCopy || totals[keys[1]] > perNetwork) {
    send(res, 429, { ok: false, code: 'rate_limit', message: `You have used today's ${perCopy} free ${fromWeb ? 'tries' : 'rewrites'}. They reset at midnight UTC.` });
    return;
  }

  try {
    const result = await engine.rewrite({
      text,
      site: typeof fields.site === 'string' ? fields.site.slice(0, 40) : '',
      context: fields.context && typeof fields.context === 'object' ? fields.context : {},
      client: rewrite.testClient || null,
    });
    const { usage, ...visible } = result; // token counts stay on the server
    send(res, 200, { ok: true, result: visible, remaining: Math.max(0, perCopy - totals[keys[0]]) });
  } catch (error) {
    if (error instanceof engine.RewriteError) {
      send(res, STATUS_FOR[error.code] || 502, { ok: false, code: error.code, message: error.message });
      return;
    }
    send(res, 500, { ok: false, code: 'server', message: 'Something went wrong. Nothing was changed.' });
  }
}

module.exports = { waitlist, health, rewrite, normalizeEmail };
