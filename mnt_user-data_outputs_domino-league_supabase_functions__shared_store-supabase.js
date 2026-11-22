// Penyimpanan di Supabase (Postgres lewat PostgREST), dipakai oleh Edge Function.
// Hanya memakai fetch + kunci service_role (rahasia di sisi Edge Function, tidak pernah ke browser).
// Tabelnya ada di supabase/migrations/*.sql. Seluruh logika ada di engine.js, bukan di SQL.
const BACKUP_KEEP = 40;

export function createSupabaseStore({ url, serviceKey, fetch: fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const base = String(url).replace(/\/+$/, '') + '/rest/v1';
  const enc = encodeURIComponent;

  async function rest(method, path, { body, prefer } = {}) {
    const res = await doFetch(base + path, {
      method,
      headers: {
        apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {})
      },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
    return { status: res.status, ok: res.ok, data };
  }
  function must(r, what) {
    if (!r.ok) {
      const detail = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      throw new Error(`Supabase: ${what} gagal (HTTP ${r.status}) ${String(detail).slice(0, 200)}`);
    }
    return r;
  }
  const firstRow = r => (Array.isArray(r.data) ? r.data[0] || null : null);

  async function backup(prevJson, rev, reason) {
    try {
      // prevJson sudah berupa teks JSON dokumen sebelum perubahan; disisipkan apa adanya
      const body = `{"rev":${Number(rev) || 0},"reason":${JSON.stringify(reason)},"doc":${prevJson}}`;
      must(await rest('POST', '/league_backups', { body, prefer: 'return=minimal' }), 'simpan backup');
      const old = await rest('GET', `/league_backups?select=id&order=id.desc&offset=${BACKUP_KEEP}&limit=500`);
      if (old.ok && Array.isArray(old.data) && old.data.length) {
        await rest('DELETE', `/league_backups?id=in.(${old.data.map(x => Number(x.id)).join(',')})`);
      }
    } catch (e) { console.warn('Backup gagal:', e.message); }
  }

  return {
    async load() {
      const row = firstRow(must(await rest('GET', '/league_state?id=eq.1&select=doc,rev'), 'baca data'));
      return row ? { doc: row.doc, rev: Number(row.rev) } : null;
    },
    async getRev() {
      const row = firstRow(must(await rest('GET', '/league_state?id=eq.1&select=rev'), 'baca revisi'));
      return row ? Number(row.rev) : null;
    },
    // Compare-and-swap: hanya menimpa bila revisi di database masih sama dengan yang dibaca perintah ini.
    async save(doc, expectedRev, opts = {}) {
      if (expectedRev === null) {
        const r = await rest('POST', '/league_state', { body: { id: 1, doc, rev: doc.rev }, prefer: 'return=minimal' });
        if (r.status === 409) return false; // sudah dibuat oleh permintaan lain
        must(r, 'membuat data awal');
        return true;
      }
      if (opts.prev && (opts.backup || doc.rev % 25 === 0)) await backup(opts.prev, doc.rev, opts.backup ? 'aksi penting' : 'berkala');
      const r = must(await rest('PATCH', `/league_state?id=eq.1&rev=eq.${Number(expectedRev)}&select=rev`, {
        body: { doc, rev: doc.rev, updated_at: new Date().toISOString() }, prefer: 'return=representation'
      }), 'menyimpan data');
      return Array.isArray(r.data) && r.data.length > 0;
    },
    session: {
      async create(hash, playerId, expires) {
        must(await rest('POST', '/app_sessions', {
          body: { token_hash: hash, player_id: playerId, expires_at: new Date(expires).toISOString() }, prefer: 'return=minimal'
        }), 'membuat sesi');
        // sekalian bersihkan sesi yang sudah kedaluwarsa
        await rest('DELETE', `/app_sessions?expires_at=lt.${enc(new Date().toISOString())}`);
      },
      async get(hash) {
        const row = firstRow(must(await rest('GET', `/app_sessions?token_hash=eq.${enc(hash)}&select=player_id,expires_at`), 'membaca sesi'));
        return row ? { player_id: row.player_id, expires: Date.parse(row.expires_at) } : null;
      },
      async extend(hash, expires) {
        await rest('PATCH', `/app_sessions?token_hash=eq.${enc(hash)}`, { body: { expires_at: new Date(expires).toISOString() }, prefer: 'return=minimal' });
      },
      async delete(hash) { await rest('DELETE', `/app_sessions?token_hash=eq.${enc(hash)}`); },
      async prune(validIds) {
        const filter = validIds.length
          ? 'not.in.' + enc('(' + validIds.map(id => '"' + String(id).replace(/"/g, '') + '"').join(',') + ')')
          : 'not.is.null';
        await rest('DELETE', `/app_sessions?player_id=${filter}`);
      }
    },
    limit: {
      async locked(key) {
        const row = firstRow(must(await rest('GET', `/app_limits?key=eq.${enc(key)}&select=locked_until`), 'membaca pembatas'));
        if (!row || !row.locked_until) return 0;
        const left = Date.parse(row.locked_until) - Date.now();
        return left > 0 ? Math.ceil(left / 1000) : 0;
      },
      async fail(key, max = 5, lockMs = 5 * 60 * 1000) {
        const row = firstRow(must(await rest('GET', `/app_limits?key=eq.${enc(key)}&select=fails,locked_until`), 'membaca pembatas'));
        let fails = row ? Number(row.fails) || 0 : 0;
        let until = row && row.locked_until ? Date.parse(row.locked_until) : 0;
        if (until && until <= Date.now()) { fails = 0; until = 0; }
        fails++;
        if (fails >= max) { until = Date.now() + lockMs; fails = 0; }
        must(await rest('POST', '/app_limits?on_conflict=key', {
          body: { key, fails, locked_until: until ? new Date(until).toISOString() : null },
          prefer: 'resolution=merge-duplicates,return=minimal'
        }), 'mencatat percobaan');
      },
      async clear(key) { await rest('DELETE', `/app_limits?key=eq.${enc(key)}`); },
      async throttle(key, max, windowMs) {
        const row = firstRow(must(await rest('GET', `/app_limits?key=eq.${enc(key)}&select=hits,window_reset`), 'membaca pembatas'));
        const now = Date.now();
        let hits = 1, reset = now + windowMs;
        if (row && row.window_reset && Date.parse(row.window_reset) > now) { hits = (Number(row.hits) || 0) + 1; reset = Date.parse(row.window_reset); }
        must(await rest('POST', '/app_limits?on_conflict=key', {
          body: { key, hits, window_reset: new Date(reset).toISOString() },
          prefer: 'resolution=merge-duplicates,return=minimal'
        }), 'mencatat permintaan');
        return hits <= max;
      }
    }
  };
}
