// Tiruan PostgREST (subset yang dipakai store-supabase.js) untuk pengujian tanpa Supabase asli.
// Ketat: kolom/tabel/filter yang tidak dikenal ditolak (supaya salah ketik antara kode dan SQL ketahuan),
// dan kunci selain service_role ditolak (meniru tabel yang dikunci RLS).
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 5400);
const SERVICE_KEY = process.env.MOCK_SERVICE_KEY || 'test-service-key';

const SCHEMA = {
  league_state:   { pk: 'id',         cols: ['id', 'doc', 'rev', 'updated_at'], defaults: () => ({ updated_at: new Date().toISOString() }) },
  league_backups: { pk: 'id',         cols: ['id', 'taken_at', 'rev', 'reason', 'doc'], serial: 'id', defaults: () => ({ taken_at: new Date().toISOString() }) },
  app_sessions:   { pk: 'token_hash', cols: ['token_hash', 'player_id', 'expires_at', 'created_at'], defaults: () => ({ created_at: new Date().toISOString() }) },
  app_limits:     { pk: 'key',        cols: ['key', 'fails', 'locked_until', 'hits', 'window_reset'], defaults: () => ({ fails: 0, locked_until: null, hits: 0, window_reset: null }) }
};
const tables = Object.fromEntries(Object.keys(SCHEMA).map(t => [t, { rows: [], seq: 0 }]));
const stats = { requests: 0 };

const err = (res, status, code, message) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code, message })); };

function coerce(a, b) {
  if (a === null || a === undefined) return [a, b];
  if (typeof a === 'number' || /^-?\d+(\.\d+)?$/.test(String(b))) { const n = Number(b); if (!Number.isNaN(n) && typeof a === 'number') return [a, n]; }
  if (typeof a === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(a) && /^\d{4}-\d{2}-\d{2}T/.test(String(b))) return [Date.parse(a), Date.parse(b)];
  return [String(a), String(b)];
}
function parseList(v) {
  const inner = v.replace(/^\(/, '').replace(/\)$/, '');
  const out = []; let cur = '', q = false;
  for (const ch of inner) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
  if (inner.length) out.push(cur);
  return out;
}
function matcher(col, expr) {
  const m = expr.match(/^(not\.)?(eq|neq|lt|lte|gt|gte|in|is)\.(.*)$/s);
  if (!m) throw new Error('filter tidak dikenal: ' + col + '=' + expr);
  const neg = !!m[1], op = m[2], val = m[3];
  return row => {
    const cell = row[col];
    let r;
    if (op === 'is') r = val === 'null' ? (cell === null || cell === undefined) : cell === (val === 'true');
    else if (op === 'in') r = parseList(val).some(x => { const [a, b] = coerce(cell, x); return a === b; });
    else {
      if (cell === null || cell === undefined) r = false;
      else {
        const [a, b] = coerce(cell, val);
        r = op === 'eq' ? a === b : op === 'neq' ? a !== b : op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a >= b;
      }
    }
    return neg ? !r : r;
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/__debug/')) {
    const t = tables[url.pathname.slice(9)];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(t ? t.rows : stats));
    return;
  }
  stats.requests++;
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    try {
      const key = req.headers['apikey'];
      const bearer = String(req.headers['authorization'] || '').replace(/^Bearer /, '');
      const m = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
      if (!m || !SCHEMA[m[1]]) return err(res, 404, 'PGRST205', 'tabel tidak ditemukan: ' + url.pathname);
      if (key !== SERVICE_KEY || bearer !== SERVICE_KEY) return err(res, 401, '42501', `permission denied for table ${m[1]}`);
      const name = m[1], sch = SCHEMA[name], tbl = tables[name];

      const filters = [];
      let select = null, order = null, limit = null, offset = 0, onConflict = null;
      for (const [k, v] of url.searchParams) {
        if (k === 'select') { select = v.split(','); select.forEach(c => { if (c !== '*' && !sch.cols.includes(c)) throw new Error('kolom tidak ada: ' + c); }); }
        else if (k === 'order') order = v;
        else if (k === 'limit') limit = Number(v);
        else if (k === 'offset') offset = Number(v);
        else if (k === 'on_conflict') onConflict = v;
        else { if (!sch.cols.includes(k)) throw new Error('kolom tidak ada: ' + k); filters.push(matcher(k, v)); }
      }
      const prefer = String(req.headers['prefer'] || '');
      const project = rows => (!select || select.includes('*')) ? rows : rows.map(r => Object.fromEntries(select.map(c => [c, r[c]])));
      const body = raw ? JSON.parse(raw) : null;
      const checkCols = o => Object.keys(o).forEach(c => { if (!sch.cols.includes(c)) throw new Error('kolom tidak ada: ' + c); });
      const send = (status, data) => {
        if (data === undefined) { res.writeHead(status); res.end(); return; }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
      };

      if (req.method === 'GET') {
        let rows = tbl.rows.filter(r => filters.every(f => f(r)));
        if (order) { const [c, d] = order.split('.'); rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (d === 'desc' ? -1 : 1)); }
        rows = rows.slice(offset, limit === null ? undefined : offset + limit);
        return send(200, project(rows).map(r => JSON.parse(JSON.stringify(r))));
      }
      if (req.method === 'POST') {
        const items = Array.isArray(body) ? body : [body];
        const out = [];
        for (const it of items) {
          checkCols(it);
          const existing = tbl.rows.find(r => r[sch.pk] === it[sch.pk]);
          if (existing) {
            if (prefer.includes('resolution=merge-duplicates') && onConflict === sch.pk) { Object.assign(existing, it); out.push(existing); continue; }
            return err(res, 409, '23505', `duplicate key value violates unique constraint "${name}_pkey"`);
          }
          const row = { ...sch.defaults(), ...it };
          if (sch.serial && row[sch.serial] === undefined) row[sch.serial] = ++tbl.seq;
          if (row[sch.pk] === undefined) return err(res, 400, '23502', 'null value in primary key');
          for (const c of sch.cols) if (row[c] === undefined) row[c] = null;
          tbl.rows.push(row); out.push(row);
        }
        return prefer.includes('return=representation') ? send(201, project(out)) : send(201);
      }
      if (req.method === 'PATCH') {
        checkCols(body);
        const hit = tbl.rows.filter(r => filters.every(f => f(r)));
        hit.forEach(r => Object.assign(r, body));
        return prefer.includes('return=representation') ? send(200, project(hit)) : send(204);
      }
      if (req.method === 'DELETE') {
        if (!filters.length) return err(res, 400, 'PGRST000', 'DELETE tanpa filter ditolak');
        tbl.rows = tbl.rows.filter(r => !filters.every(f => f(r)));
        return send(204);
      }
      return err(res, 405, 'PGRST000', 'metode tidak didukung');
    } catch (e) {
      return err(res, 400, 'PGRST100', String(e.message));
    }
  });
});
server.listen(PORT, '127.0.0.1');
