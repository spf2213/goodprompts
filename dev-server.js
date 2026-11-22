'use strict';

// Local preview only. Vercel does not use this file: there, the files in public/ are served
// directly and each file in api/ runs as a function. This small server imitates that on your Mac.
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const handlers = require('./lib/handlers');

const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');
const types = {
  '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
};
const api = { '/api/waitlist': handlers.waitlist, '/api/health': handlers.health };

// Gives a handler the same helpers Vercel provides: req.body, res.status() and res.json().
async function runFunction(handler, req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const isJson = String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json');
  Object.defineProperty(req, 'body', { get: () => (isJson ? JSON.parse(raw) : undefined) });
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); };
  await handler(req, res);
}

async function serveFile(res, file) {
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (api[pathname]) { runFunction(api[pathname], req, res).catch(() => { res.statusCode = 500; res.end('Function error'); }); return; }
  // A working page for comparing logo options. It lives outside public/, so it is never deployed.
  if (pathname === '/logo-options') { serveFile(res, path.join(__dirname, 'logo-options.html')); return; }
  // Same clean addresses as on Vercel: "/" is index.html and "/privacy" is privacy.html.
  let relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!path.extname(relative)) relative += '.html';
  const file = path.join(publicDir, relative);
  if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(res, file);
}).listen(port, () => console.log(`Local preview on http://localhost:${port}`));
