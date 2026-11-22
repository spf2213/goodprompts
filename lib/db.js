'use strict';

// Database access for the waitlist (Postgres).
// On Vercel the address is DATABASE_URL, which the Neon Postgres integration adds to the project.
const { neon } = require('@neondatabase/serverless');

let run = null;        // (text, params) => Promise<rows>
let tableReady = null; // set once per running function instance

function connect() {
  if (run) return run;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!url) return null;
  const sql = neon(url);
  run = (text, params = []) => sql.query(text, params);
  return run;
}

// Lets tests run the same statements against a different Postgres.
function useQuery(query) {
  run = query;
  tableReady = null;
  usageReady = null;
}

function ensureTable(query) {
  if (!tableReady) {
    tableReady = query(`CREATE TABLE IF NOT EXISTS waitlist (
      id BIGSERIAL PRIMARY KEY,
      email VARCHAR(254) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`).catch((error) => {
      tableReady = null; // try again on the next request
      throw error;
    });
  }
  return tableReady;
}

function isConfigured() {
  return Boolean(connect());
}

// Saves the address. Signing up twice with the same address is fine and stores it once.
async function addEmail(email) {
  const query = connect();
  if (!query) throw new Error('Database is not configured.');
  await ensureTable(query);
  await query('INSERT INTO waitlist (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [email]);
}

async function ping() {
  const query = connect();
  if (!query) throw new Error('Database is not configured.');
  await ensureTable(query);
  await query('SELECT 1 FROM waitlist LIMIT 1');
}

// ---- Rewrite usage counters -------------------------------------------------
// One row per day and counter. No prompt text and no raw network address is ever stored here.
let usageReady = null;

function ensureUsageTable(query) {
  if (!usageReady) {
    usageReady = query(`CREATE TABLE IF NOT EXISTS rewrite_usage (
      day DATE NOT NULL,
      key VARCHAR(80) NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, key)
    )`).catch((error) => {
      usageReady = null;
      throw error;
    });
  }
  return usageReady;
}

// Adds one to each named counter for today and returns the new totals as { key: count }.
async function countUsage(keys) {
  const query = connect();
  if (!query) throw new Error('Database is not configured.');
  await ensureUsageTable(query);
  const values = keys.map((_, i) => `(CURRENT_DATE, $${i + 1}, 1)`).join(', ');
  const rows = await query(
    `INSERT INTO rewrite_usage (day, key, count) VALUES ${values}
     ON CONFLICT (day, key) DO UPDATE SET count = rewrite_usage.count + 1
     RETURNING key, count`,
    keys,
  );
  // Now and then, drop counters older than a month.
  if (Math.random() < 0.01) query("DELETE FROM rewrite_usage WHERE day < CURRENT_DATE - 30").catch(() => {});
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.count)]));
}

module.exports = { addEmail, ping, isConfigured, useQuery, countUsage };
