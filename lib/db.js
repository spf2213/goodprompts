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

module.exports = { addEmail, ping, isConfigured, useQuery };
