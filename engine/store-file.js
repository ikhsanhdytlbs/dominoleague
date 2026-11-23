// Penyimpanan berbasis file untuk server Node (database.json + backup bergilir).
// Sesi login dan pembatasan percobaan disimpan di memori (hilang saat server restart).
import fs from 'node:fs';
import path from 'node:path';

export function createFileStore({ dataDir, backupKeep = 40 }) {
  const file = path.join(dataDir, 'database.json');
  const backupDir = path.join(dataDir, 'backups');
  let cache; // undefined = belum dibaca, null = tidak ada file, { json, rev }
  let lastBackup = 0;

  function read() {
    if (!fs.existsSync(file)) return null;
    const json = fs.readFileSync(file, 'utf8');
    const doc = JSON.parse(json); // melempar error bila file rusak
    return { json, rev: Number(doc.rev) || 0 };
  }
  function ensure() { if (cache === undefined) cache = read(); return cache; }

  const sessions = new Map(); // hash -> { player_id, expires }
  const fails = new Map();
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    for (const [k, v] of fails) if (v.until <= now && v.count === 0) fails.delete(k);
    for (const [k, v] of sessions) if (v.expires <= now) sessions.delete(k);
  }, 60 * 1000);
  if (timer.unref) timer.unref();

  return {
    // Dipanggil saat server menyala agar file rusak ketahuan sebelum menerima permintaan
    init() { ensure(); },
    async load() {
      const c = ensure();
      return c ? { doc: JSON.parse(c.json), rev: c.rev } : null;
    },
    async getRev() {
      const c = ensure();
      return c ? c.rev : null;
    },
    // expectedRev = revisi yang dibaca perintah ini; false bila sudah berubah (konflik)
    async save(doc, expectedRev, opts = {}) {
      const c = ensure();
      if (expectedRev === null) { if (c) return false; }
      else if (!c || c.rev !== expectedRev) return false;

      const json = JSON.stringify(doc);
      const tmp = file + '.tmp';
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(tmp, json, 'utf8');
      if (c && (opts.backup || Date.now() - lastBackup > 5 * 60 * 1000)) {
        try {
          fs.mkdirSync(backupDir, { recursive: true });
          fs.copyFileSync(file, path.join(backupDir, 'database-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'));
          lastBackup = Date.now();
          const files = fs.readdirSync(backupDir).filter(f => f.startsWith('database-')).sort();
          files.slice(0, Math.max(0, files.length - backupKeep)).forEach(f => { try { fs.unlinkSync(path.join(backupDir, f)); } catch (_) { /* abaikan */ } });
        } catch (e) { console.warn('Backup gagal:', e.message); }
      }
      fs.renameSync(tmp, file);
      cache = { json, rev: Number(doc.rev) || 0 };
      return true;
    },
    session: {
      async create(hash, playerId, expires) { sessions.set(hash, { player_id: playerId, expires }); },
      async get(hash) { return sessions.get(hash) || null; },
      async extend(hash, expires) { const s = sessions.get(hash); if (s) s.expires = expires; },
      async delete(hash) { sessions.delete(hash); },
      async prune(validIds) { const ok = new Set(validIds); for (const [h, s] of sessions) if (!ok.has(s.player_id)) sessions.delete(h); }
    },
    limit: {
      async locked(key) {
        const f = fails.get(key);
        return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
      },
      async fail(key, max = 5, lockMs = 5 * 60 * 1000) {
        const f = fails.get(key) || { count: 0, until: 0 };
        if (f.until && f.until <= Date.now()) { f.count = 0; f.until = 0; }
        f.count++;
        if (f.count >= max) { f.until = Date.now() + lockMs; f.count = 0; }
        fails.set(key, f);
      },
      async clear(key) { fails.delete(key); },
      async throttle(key, max, windowMs) {
        const now = Date.now();
        const h = hits.get(key);
        if (!h || h.reset <= now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
        h.n++;
        return h.n <= max;
      }
    }
  };
}
