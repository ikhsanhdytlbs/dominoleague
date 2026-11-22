// Server Domino League (Node.js, tanpa dependensi).
// Hanya pembungkus HTTP: seluruh aturan ada di engine/engine.js (dipakai juga oleh Supabase Edge Function).
// Jalankan: npm start   (atau: node server.cjs)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // isi bila tampilan di-hosting di domain lain (mis. GitHub Pages)
const MAX_BODY = 10 * 1024 * 1024;

const PUBLIC_FILES = new Set(['index.html', 'app.js', 'dominoLogic.js', 'demoData.js', 'favicon.svg', 'google-apps-script.js']);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'
};

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function loadConfig() {
  let file = {};
  for (const dir of [DATA_DIR, ROOT]) {
    try { file = JSON.parse(fs.readFileSync(path.join(dir, 'config.local.json'), 'utf8')); break; } catch (_) { /* coba lokasi lain */ }
  }
  return { forcePassword: String(process.env.FORCE_PASSWORD || file.force_password || ''), timezone: process.env.TIMEZONE || 'Asia/Jakarta', initialData: process.env.INITIAL_DATA || 'demo' };
}

function corsHeaders(req) {
  if (!ALLOWED_ORIGIN) return {};
  const list = ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const allow = list.includes('*') ? '*' : (list.includes(origin) ? origin : list[0]);
  return {
    'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Session', 'Access-Control-Max-Age': '86400', Vary: 'Origin'
  };
}

function sendJson(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function tokenOf(req) {
  const x = req.headers['x-session'];
  if (x) return String(x);
  const m = String(req.headers['authorization'] || '').match(/^Bearer (.+)$/);
  return m ? m[1] : '';
}

async function main() {
  const { makeEngine } = await import(pathToFileURL(path.join(ROOT, 'engine', 'engine.js')).href);
  const { createFileStore } = await import(pathToFileURL(path.join(ROOT, 'engine', 'store-file.js')).href);
  const L = await import(pathToFileURL(path.join(ROOT, 'dominoLogic.js')).href);
  const D = await import(pathToFileURL(path.join(ROOT, 'demoData.js')).href);
  const config = loadConfig();

  const store = createFileStore({ dataDir: DATA_DIR });
  try {
    store.init();
  } catch (e) {
    console.error('database.json tidak bisa dibaca: ' + e.message);
    console.error('Server berhenti agar data tidak tertimpa. Pulihkan dari folder backups/ lalu jalankan lagi.');
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch (e) { res.writeHead(400); res.end('Bad Request'); return; }
    const cors = corsHeaders(req);

    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

    // ---- API (semua lewat mesin aturan bersama) ----
    if (url.pathname.startsWith('/api/')) {
      const route = url.pathname.slice(5).replace(/\/+$/, '');
      const run = async (body) => {
        const api = makeEngine({ store, L, D, config });
        const out = await api.handle({ method: req.method, route, query: url.searchParams, token: tokenOf(req), body, ip: clientIp(req) });
        sendJson(res, out.status, out.body, cors);
      };
      if (req.method === 'POST') {
        let raw = '';
        let tooBig = false;
        req.on('data', chunk => {
          if (tooBig) return;
          raw += chunk;
          if (raw.length > MAX_BODY) { tooBig = true; sendJson(res, 413, { ok: false, code: 'TOO_BIG', error: 'Payload terlalu besar.' }, cors); req.destroy(); }
        });
        req.on('end', async () => {
          if (tooBig) return;
          let body;
          try { body = raw ? JSON.parse(raw) : {}; } catch (e) { sendJson(res, 400, { ok: false, code: 'BAD_JSON', error: 'Body bukan JSON valid.' }, cors); return; }
          try { await run(body); } catch (e) { console.error(e); sendJson(res, 500, { ok: false, code: 'SERVER', error: 'Terjadi kesalahan di server.' }, cors); }
        });
      } else {
        run(null).catch(e => { console.error(e); sendJson(res, 500, { ok: false, code: 'SERVER', error: 'Terjadi kesalahan di server.' }, cors); });
      }
      return;
    }

    // ---- config.js: kosong bila dijalankan dari server ini (API di alamat yang sama) ----
    if (url.pathname === '/config.js') {
      const p = path.join(ROOT, 'config.js');
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(fs.existsSync(p) ? fs.readFileSync(p) : 'window.DOMINO_CONFIG = {};\n');
      return;
    }

    // ---- File statis (daftar putih, aman dari path traversal) ----
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch (e) { rel = ''; }
    rel = rel === '/' ? 'index.html' : rel.replace(/^\/+/, '');
    if (!PUBLIC_FILES.has(rel)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    const filePath = path.join(ROOT, rel);
    fs.readFile(filePath, (err, content) => {
      if (err) {
        const nf = err.code === 'ENOENT';
        res.writeHead(nf ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(nf ? '404 Not Found' : `Server Error: ${err.code}`);
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(content);
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIp();
    console.log('====================================================');
    console.log('🀄 DOMINO LEAGUE WEB APP BERHASIL DIJALANKAN!');
    console.log('====================================================');
    console.log(`💻 Buka di Laptop: http://localhost:${PORT}`);
    console.log(`📱 Buka di HP (Wi-Fi sama): http://${ip}:${PORT}`);
    console.log(`💾 Data: ${path.join(DATA_DIR, 'database.json')}`);
    console.log(`🔑 Edit paksa dengan kata sandi: ${config.forcePassword ? 'AKTIF' : 'NONAKTIF (atur FORCE_PASSWORD)'}`);
    console.log('====================================================');
  });
}

main().catch(e => { console.error(e); process.exit(1); });
