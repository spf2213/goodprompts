'use strict';

// The two back-end endpoints, written for Vercel's Node functions:
//   POST /api/waitlist  saves an email address
//   GET  /api/health    reports whether the database is reachable
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

module.exports = { waitlist, health, normalizeEmail };
