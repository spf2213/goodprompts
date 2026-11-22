'use strict';

const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

const MAX_BODY_BYTES = 8 * 1024;
const QUERY_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 10000;
const port = Number(process.env.PORT || 3000);

// Sign-up abuse limits. Counters live in memory: they reset on restart and are per server instance.
const IP_WINDOW_MS = 10 * 60 * 1000;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_CLIENTS = 20000;
const IP_LIMIT = positiveInteger(process.env.WAITLIST_IP_LIMIT, 20);
const GLOBAL_LIMIT = positiveInteger(process.env.WAITLIST_GLOBAL_LIMIT, 1000);
// Hosts put a proxy in front of the app, so the socket address is the proxy's, not the visitor's.
// Set TRUST_PROXY=0 only when nothing sits in front of this server.
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';
// Hidden form field that people never see. Anything typed into it came from a bot.
const TRAP_FIELD = 'hp_confirm';

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port.');
}

// Only these project files can be served over HTTP.
const staticFiles = new Map([
  ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/privacy', { file: 'privacy.html', contentType: 'text/html; charset=utf-8' }],
  ['/hands.png', { file: 'hands.png', contentType: 'image/png', cacheControl: 'public, max-age=86400' }],
  ['/manus-routes.json', { file: 'manus-routes.json', contentType: 'application/json; charset=utf-8' }],
  ['/logos/claude.svg', { file: 'logos/claude.svg', contentType: 'image/svg+xml', cacheControl: 'public, max-age=86400' }],
  ['/logos/gemini.svg', { file: 'logos/gemini.svg', contentType: 'image/svg+xml', cacheControl: 'public, max-age=86400' }],
  ['/logos/chatgpt.svg', { file: 'logos/chatgpt.svg', contentType: 'image/svg+xml', cacheControl: 'public, max-age=86400' }],
  ['/logos/perplexity.svg', { file: 'logos/perplexity.svg', contentType: 'image/svg+xml', cacheControl: 'public, max-age=86400' }],
  ['/logos/manus.svg', { file: 'logos/manus.svg', contentType: 'image/svg+xml', cacheControl: 'public, max-age=86400' }],
  ['/logos/grok.svg', { file: 'logos/grok.svg', contentType: 'image/svg+xml', cacheControl: 'public, max-age=86400' }],
  ['/logos/copilot-icon.svg', { file: 'logos/copilot-icon.svg', contentType: 'image/svg+xml', cacheControl: 'public, max-age=86400' }],
  ['/logos/copilot-wordmark.svg', { file: 'logos/copilot-wordmark.svg', contentType: 'image/svg+xml', cacheControl: 'public, max-age=86400' }],
  ['/logos/deepseek.svg', { file: 'logos/deepseek.svg', contentType: 'image/svg+xml', cacheControl: 'public, max-age=86400' }],
  ['/logos/meta-ai.svg', { file: 'logos/meta-ai.svg', contentType: 'image/svg+xml', cacheControl: 'public, max-age=86400' }],
]);

// Working page for comparing logo options. Local only: it is never served on the live site.
if (process.env.NODE_ENV !== 'production') {
  staticFiles.set('/logo-options', { file: 'logo-options.html', contentType: 'text/html; charset=utf-8' });
}

// Hosts name the database address differently: DATABASE_URL is the usual name, MYSQL_URL is what Railway's MySQL service provides.
const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL || '';

let pool = null;
let ready = false;
let initializing = false;
let retryTimer = null;
let shuttingDown = false;

if (databaseUrl) {
  try {
    const uri = new URL(databaseUrl);
    if (uri.protocol !== 'mysql:') throw new Error('Unsupported database protocol.');
    // The driver can log complete statements and parameters in debug mode.
    uri.searchParams.delete('debug');
    pool = mysql.createPool({
      uri: uri.toString(),
      connectionLimit: 5,
      waitForConnections: true,
      queueLimit: 32,
      connectTimeout: QUERY_TIMEOUT_MS,
    });
  } catch {
    // Do not print configuration or driver errors, which may contain secrets.
  }
}

function hasFullEmailUniqueIndex(indexes) {
  const uniqueIndexes = new Map();
  for (const index of indexes) {
    if (Number(index.Non_unique) !== 0) continue;
    const columns = uniqueIndexes.get(index.Key_name) || [];
    columns.push(index);
    uniqueIndexes.set(index.Key_name, columns);
  }
  return [...uniqueIndexes.values()].some((columns) =>
    columns.length === 1 && columns[0].Column_name === 'email' && columns[0].Sub_part == null
  );
}

function scheduleInitialization(delay = 0) {
  if (!pool || shuttingDown || initializing || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void initializeDatabase();
  }, delay);
}

async function initializeDatabase() {
  if (!pool || initializing || shuttingDown) return;
  initializing = true;
  try {
    await pool.query({
      sql: `CREATE TABLE IF NOT EXISTS waitlist (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        email VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY unique_waitlist_email (email)
      ) ENGINE=InnoDB`,
      timeout: QUERY_TIMEOUT_MS,
    });
    // An existing table is not changed; fail readiness if it lacks the required unique key.
    const [indexes] = await pool.query({ sql: 'SHOW INDEX FROM waitlist', timeout: QUERY_TIMEOUT_MS });
    if (!hasFullEmailUniqueIndex(indexes)) throw new Error('Required unique email index is missing.');
    const [columns] = await pool.query({ sql: "SHOW COLUMNS FROM waitlist LIKE 'email'", timeout: QUERY_TIMEOUT_MS });
    const emailType = columns.length === 1 && /^(?:var)?char\((\d+)\)$/i.exec(columns[0].Type);
    if (!emailType || Number(emailType[1]) < 254 || columns[0].Null !== 'NO') {
      throw new Error('Existing email column is incompatible.');
    }
    ready = true;
  } catch {
    ready = false;
  } finally {
    initializing = false;
    if (!ready) scheduleInitialization(RETRY_DELAY_MS);
  }
}

function markDatabaseUnavailable() {
  ready = false;
  scheduleInitialization(RETRY_DELAY_MS);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finished = true;
        const error = new Error('Request body is too large.');
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const error = new Error('Request body must be valid JSON.');
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', () => {
      if (finished) return;
      finished = true;
      const error = new Error('Could not read the request.');
      error.status = 400;
      reject(error);
    });
  });
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

const clients = new Map();
let globalWindow = { count: 0, resetAt: 0 };

function clientKey(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = typeof forwarded === 'string' ? forwarded.split(',', 1)[0].trim() : '';
    if (first) return first.slice(0, 64);
  }
  return req.socket.remoteAddress || 'unknown';
}

function forgetExpiredClients(now = Date.now()) {
  for (const [key, entry] of clients) {
    if (now >= entry.resetAt) clients.delete(key);
  }
}

// Returns 0 when the request may proceed, otherwise the number of seconds to wait.
function secondsUntilAllowed(req, now = Date.now()) {
  if (now >= globalWindow.resetAt) globalWindow = { count: 0, resetAt: now + GLOBAL_WINDOW_MS };
  const key = clientKey(req);
  let entry = clients.get(key);
  if (!entry || now >= entry.resetAt) {
    if (!entry && clients.size >= MAX_TRACKED_CLIENTS) {
      forgetExpiredClients(now);
      // Still full: start over instead of growing without bound. The hourly cap below still applies.
      if (clients.size >= MAX_TRACKED_CLIENTS) clients.clear();
    }
    entry = { count: 0, resetAt: now + IP_WINDOW_MS };
    clients.set(key, entry);
  }
  if (entry.count >= IP_LIMIT) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  // A forwarded address can be faked, so a second cap covers every visitor combined.
  if (globalWindow.count >= GLOBAL_LIMIT) return Math.max(1, Math.ceil((globalWindow.resetAt - now) / 1000));
  entry.count += 1;
  globalWindow.count += 1;
  return 0;
}

// Visitor addresses are dropped once their ten-minute window ends.
const cleanupTimer = setInterval(forgetExpiredClients, 60 * 1000);
cleanupTimer.unref();

async function handleHealth(res) {
  if (!ready || !pool) {
    sendJson(res, 503, { success: false, status: 'not ready' });
    return;
  }
  try {
    await pool.query({ sql: 'SELECT 1 FROM waitlist LIMIT 1', timeout: QUERY_TIMEOUT_MS });
    sendJson(res, 200, { success: true, status: 'ready' });
  } catch {
    markDatabaseUnavailable();
    sendJson(res, 503, { success: false, status: 'not ready' });
  }
}

async function handleWaitlist(req, res) {
  const wait = secondsUntilAllowed(req);
  if (wait) {
    req.resume();
    sendJson(res, 429, { success: false, error: 'Too many sign-ups from this network. Please try again in a few minutes.' },
      { 'Retry-After': String(wait) });
    return;
  }
  const contentType = (req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    req.resume();
    sendJson(res, 415, { success: false, error: 'Content-Type must be application/json.' });
    return;
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    req.resume();
    sendJson(res, 413, { success: false, error: 'Request body is too large.' }, { Connection: 'close' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    req.resume();
    sendJson(res, error.status || 400, { success: false, error: error.message },
      error.status === 413 ? { Connection: 'close' } : {});
    return;
  }
  const fields = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (typeof fields[TRAP_FIELD] === 'string' && fields[TRAP_FIELD].trim()) {
    // A bot filled the hidden field. Answer as if it worked, and store nothing.
    sendJson(res, 200, { success: true, message: 'You are on the waitlist.' });
    return;
  }
  const email = normalizeEmail(fields.email);
  if (!email) {
    sendJson(res, 400, { success: false, error: 'Enter a valid email address (maximum 254 characters).' });
    return;
  }
  if (!ready || !pool) {
    sendJson(res, 503, { success: false, error: 'Waitlist is temporarily unavailable. Please try again later.' });
    return;
  }

  try {
    await pool.execute({ sql: 'INSERT INTO waitlist (email) VALUES (?)', timeout: QUERY_TIMEOUT_MS }, [email]);
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      // Do not treat a conflicting unrelated unique key as a successful signup.
      try {
        const [rows] = await pool.execute({
          sql: 'SELECT 1 FROM waitlist WHERE email = ? LIMIT 1',
          timeout: QUERY_TIMEOUT_MS,
        }, [email]);
        if (rows.length) {
          sendJson(res, 200, { success: true, message: 'You are on the waitlist.' });
          return;
        }
      } catch {
        // Treat failure to verify a duplicate as an unavailable database.
      }
    }
    markDatabaseUnavailable();
    sendJson(res, 503, { success: false, error: 'Waitlist is temporarily unavailable. Please try again later.' });
    return;
  }
  sendJson(res, 200, { success: true, message: 'You are on the waitlist.' });
}

async function serveStatic(req, res, entry) {
  try {
    const data = await readFile(path.join(__dirname, entry.file));
    res.writeHead(200, {
      'Content-Type': entry.contentType,
      'Content-Length': data.length,
      'Cache-Control': entry.cacheControl || 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    sendJson(res, 500, { success: false, error: 'File is unavailable.' });
  }
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    sendJson(res, 400, { success: false, error: 'Invalid request URL.' });
    return;
  }

  if (pathname === '/api/health') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { success: false, error: 'Method not allowed.' }, { Allow: 'GET' });
      return;
    }
    void handleHealth(res);
    return;
  }
  if (pathname === '/api/waitlist') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { success: false, error: 'Method not allowed.' }, { Allow: 'POST' });
      return;
    }
    void handleWaitlist(req, res);
    return;
  }
  const entry = staticFiles.get(pathname);
  if (entry) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { success: false, error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
      return;
    }
    void serveStatic(req, res, entry);
    return;
  }
  sendJson(res, 404, { success: false, error: 'Not found.' });
});

server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.listen(port, '0.0.0.0');
scheduleInitialization();

function shutdown() {
  shuttingDown = true;
  if (retryTimer) clearTimeout(retryTimer);
  clearInterval(cleanupTimer);
  server.close(() => {
    if (pool) void pool.end().catch(() => {});
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
