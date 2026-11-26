// Mesin aturan Domino League.
// Dipakai bersama oleh server Node (server.cjs) dan Supabase Edge Function (supabase/functions/api).
// Mesin TIDAK menyentuh disk atau jaringan secara langsung: semua penyimpanan lewat objek `store`
// (lihat store-file.js dan store-supabase.js), sehingga aturannya sama persis di mana pun dijalankan.
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

export const GRACE_MS = 10 * 60 * 1000;            // jendela koreksi pembuat game
export const PROPOSAL_TTL_MS = 48 * 3600 * 1000;   // usulan kedaluwarsa
export const APPROVALS_REQUIRED = 1;               // jumlah pemain lain yang harus mengesahkan
export const SESSION_MS = 12 * 3600 * 1000;        // masa berlaku login
const AUDIT_MAX = 500;

export class CmdError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new CmdError(status, code, message); };

// Teks dari pengguna (nama, label, catatan) dibersihkan di server supaya tak ada kode HTML/skrip
// yang bisa disisipkan dan dijalankan di browser pemain lain.
function clean(v, max = 200) {
  return String(v ?? '').replace(/[<>"`\\]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function deepClean(v) {
  if (typeof v === 'string') return clean(v, 2000);
  if (Array.isArray(v)) return v.map(deepClean);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = deepClean(v[k]); return o; }
  return v;
}

function nextId(prefix, items, key, pad) {
  let max = 0;
  items.forEach(it => {
    const m = String(it[key] || '').match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return prefix + String(max + 1).padStart(pad, '0');
}

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function safeEqual(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }
const tokenHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const json = (status, body) => ({ status, body });

/**
 * Membuat mesin untuk SATU permintaan (state `db` hidup selama permintaan itu saja).
 * deps: { store, L (dominoLogic), D (demoData), config: { forcePassword, timezone, webhookHosts, allowInsecureWebhook },
 *         fetch, background(promise) }
 */
export function makeEngine(deps) {
  const { store, L, D } = deps;
  const config = deps.config || {};
  const CFG = { forcePassword: String(config.forcePassword || ''), timezone: config.timezone || 'Asia/Jakarta' };
  const WEBHOOK_HOSTS = new Set(config.webhookHosts || ['script.google.com', 'script.googleusercontent.com']);
  const fetchImpl = deps.fetch || globalThis.fetch;
  const background = deps.background || (p => { p.catch(() => {}); });

  let db = null;
  let loadedRev = null;
  let needPrune = false;

  function localTime() {
    return new Date().toLocaleString('sv-SE', { timeZone: CFG.timezone }).slice(0, 16);
  }

  // ---- pembatasan percobaan (disimpan oleh store) ----
  const lockedSeconds = key => store.limit.locked(key);
  const recordFail = (key, max, lockMs) => store.limit.fail(key, max, lockMs);
  const clearFail = key => store.limit.clear(key);

  // ---------------------------------------------------------------
  // Login dengan PIN pemain
  //   PIN bawaan : 4 angka dari nomor Player ID (PL01 -> 0001, PL02 -> 0002, ...)
  //   PIN sendiri: 5 atau 6 angka (diubah pemain), tidak boleh sama dengan pemain lain
  //   Dengan begitu PIN bawaan dan PIN sendiri tidak pernah bentrok.
  // ---------------------------------------------------------------
function defaultPin(pid) {
  const m = String(pid).match(/(\d+)$/);
  const n = m ? parseInt(m[1], 10) : db.players.findIndex(p => p.player_id === pid) + 1;
  return String(n % 10000).padStart(4, '0');
}
function pinHash(pin) { return crypto.createHmac('sha256', db.auth.secret).update(String(pin)).digest('hex'); }
function checkPin(pid, pin) {
  const rec = db.auth.pins[pid];
  if (rec) return crypto.timingSafeEqual(Buffer.from(rec.h, 'hex'), Buffer.from(pinHash(pin), 'hex'));
  return String(pin) === defaultPin(pid);
}
function findPlayerByPin(pin) {
  pin = String(pin || '');
  if (/^\d{4}$/.test(pin)) return db.players.find(p => !db.auth.pins[p.player_id] && defaultPin(p.player_id) === pin) || null;
  if (/^\d{5,6}$/.test(pin)) {
    const h = pinHash(pin);
    return db.players.find(p => db.auth.pins[p.player_id] && db.auth.pins[p.player_id].h === h) || null;
  }
  return null;
}

  // ---------------------------------------------------------------
  // Database: bentuk data, upgrade, data awal
  // ---------------------------------------------------------------
function upgrade(d) {
  const oldSchema = Number(d.schema) || 0;
  d.schema = 3;
  d.rev = Number(d.rev) || 0;
  ['seasons', 'players', 'sessions', 'matches', 'loss_events', 'special_events', 'season_snapshots', 'proposals', 'audit_log']
    .forEach(k => { if (!Array.isArray(d[k])) d[k] = []; });
  d.settings = { ...L.DEFAULT_SETTINGS, ...(d.settings || {}) };
  if (d.settings.sheets_webhook_url && !webhookAllowed(d.settings.sheets_webhook_url)) d.settings.sheets_webhook_url = '';
  if (oldSchema < 3 || !d.auth || typeof d.auth !== 'object') d.auth = { pins: {} }; // PIN skema lama tidak dipakai lagi
  if (!d.auth.pins || typeof d.auth.pins !== 'object') d.auth.pins = {};
  if (!d.auth.secret) d.auth.secret = crypto.randomBytes(32).toString('hex');
  d.is_demo = !!d.is_demo;
  delete d.saved_at;
  delete d.current_season_id;
  ['seasons', 'players', 'sessions', 'matches', 'loss_events', 'special_events', 'season_snapshots'].forEach(k => { d[k] = deepClean(d[k]); });
  return d;
}

function freshDemo() {
  const c = JSON.parse(JSON.stringify(D.DEMO_DATA));
  return upgrade({
    is_demo: true, seasons: c.seasons, players: c.players, sessions: c.sessions, matches: c.matches,
    loss_events: c.loss_events, special_events: c.special_events, season_snapshots: c.season_snapshots,
    settings: { ...L.DEFAULT_SETTINGS, ...c.settings }
  });
}

function freshRealParts() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    is_demo: false,
    seasons: [{ season_id: 'SSN-01', season_name: 'Season 1 - ' + today.slice(0, 4), start_date: today, end_date: null, status: 'active', closed_at: null }],
    players: JSON.parse(JSON.stringify(L.DEFAULT_PLAYERS)).map(p => ({ ...p, created_at: today })),
    sessions: [{ session_id: 'SES001', season_id: 'SSN-01', session_date: today, session_label: 'Sesi Perdana', status: 'active', notes: 'Sesi nongkrong pembuka.' }],
    matches: [], loss_events: [], special_events: [], season_snapshots: []
  };
}

// ---------------------------------------------------------------
// Helper domain
// ---------------------------------------------------------------
const nm = pid => (db.players.find(p => p.player_id === pid) || {}).display_name || pid;
const findMatch = id => db.matches.find(m => m.match_id === id);
const seasonLocked = id => { const s = db.seasons.find(x => x.season_id === id); return !!s && s.status === 'finalized'; };
function assertUnlocked(seasonId) {
  if (seasonLocked(seasonId)) fail(409, 'SEASON_LOCKED', 'Season ini sudah difinalisasi dan terkunci.');
}
function inGrace(m, pid) {
  return !!(m && m.created_by_player && m.created_by_player === pid && Date.now() - Date.parse(m.created_at) < GRACE_MS);
}

function parseForm(p, sessionId) {
  const players = p.players;
  if (!Array.isArray(players) || players.length !== 4 || new Set(players).size !== 4) {
    fail(400, 'BAD_PLAYERS', 'Satu game wajib tepat 4 pemain berbeda.');
  }
  players.forEach(pid => { if (!db.players.some(x => x.player_id === pid)) fail(400, 'BAD_PLAYERS', 'Pemain tidak dikenal: ' + pid); });
  const counts = obj => {
    const out = {};
    players.forEach(pid => {
      const n = Math.floor(Number(obj && obj[pid])) || 0;
      out[pid] = Math.min(99, Math.max(0, n));
    });
    return out;
  };
  return {
    session_id: sessionId,
    players: players.slice(),
    notes: clean(p.notes, 200),
    losses: counts(p.losses), ratus: counts(p.ratus), ribu: counts(p.ribu)
  };
}

function formFromMatch(m) {
  const f = { session_id: m.session_id, players: m.players.slice(), notes: m.notes || '', losses: {}, ratus: {}, ribu: {} };
  m.players.forEach(p => { f.losses[p] = 0; f.ratus[p] = 0; f.ribu[p] = 0; });
  db.loss_events.filter(l => l.match_id === m.match_id).forEach(l => { if (l.player_id in f.losses) f.losses[l.player_id] += Number(l.loss_count) || 0; });
  db.special_events.filter(e => e.match_id === m.match_id).forEach(e => {
    const key = e.event_type === 'S1000' ? 'ribu' : 'ratus';
    if (e.player_id in f[key]) f[key][e.player_id] += Number(e.quantity) || 0;
  });
  return f;
}

function describe(form) {
  const part = (label, obj) => {
    const t = Object.entries(obj).filter(([, v]) => v > 0).map(([p, v]) => `${nm(p)} ${v}`).join(', ');
    return t ? ` | ${label}: ${t}` : '';
  };
  return form.players.map(nm).join(', ') + part('Kalah', form.losses) + part('Ratus', form.ratus) + part('Ribu', form.ribu) +
    (form.notes ? ` | Catatan: ${form.notes}` : '');
}

function buildEvents(matchId, sessionId, form) {
  const loss = [], special = [];
  form.players.forEach(pid => {
    const name = nm(pid);
    if (form.losses[pid] > 0) {
      loss.push({ loss_id: nextId('L', [...db.loss_events, ...loss], 'loss_id', 3), match_id: matchId, session_id: sessionId, player_id: pid, player_name: name, loss_count: form.losses[pid] });
    }
    [['S100', 'ratus'], ['S1000', 'ribu']].forEach(([type, key]) => {
      if (form[key][pid] > 0) {
        special.push({ event_id: nextId('EV', [...db.special_events, ...special], 'event_id', 3), match_id: matchId, session_id: sessionId, player_id: pid, player_name: name, event_type: type, quantity: form[key][pid] });
      }
    });
  });
  return { loss, special };
}

function recordOf(m) {
  return {
    match: JSON.parse(JSON.stringify(m)),
    loss_events: db.loss_events.filter(l => l.match_id === m.match_id).map(x => ({ ...x })),
    special_events: db.special_events.filter(e => e.match_id === m.match_id).map(x => ({ ...x }))
  };
}

function dropEvents(matchId) {
  db.loss_events = db.loss_events.filter(l => l.match_id !== matchId);
  db.special_events = db.special_events.filter(e => e.match_id !== matchId);
}

// Menerapkan perubahan game yang sudah lolos aturan (langsung / disetujui / paksa)
function applyChange(type, matchId, payload) {
  if (type === 'edit_match') {
    const m = findMatch(matchId);
    const before = formFromMatch(m);
    dropEvents(matchId);
    const ev = buildEvents(matchId, m.session_id, payload);
    db.loss_events.push(...ev.loss); db.special_events.push(...ev.special);
    m.players = payload.players.slice();
    m.notes = payload.notes;
    m.rev = (m.rev || 0) + 1;
    m.updated_at = new Date().toISOString();
    return { action: 'edit_match', details: { before_form: before, after_form: payload } };
  }
  if (type === 'delete_match') {
    const m = findMatch(matchId);
    const rec = recordOf(m);
    const before = formFromMatch(m);
    dropEvents(matchId);
    db.matches = db.matches.filter(x => x.match_id !== matchId);
    return { action: 'delete_match', details: { before_record: rec, before_form: before } };
  }
  if (type === 'restore_match') {
    const rec = payload.record;
    db.matches.push({ ...rec.match, rev: (rec.match.rev || 0) + 1, updated_at: new Date().toISOString() });
    db.loss_events.push(...rec.loss_events);
    db.special_events.push(...rec.special_events);
    return { action: 'restore_match', details: { after_form: formFromMatch(rec.match) } };
  }
  fail(400, 'BAD_TYPE', 'Jenis perubahan tidak dikenal.');
}

function audit(ctx, o) {
  db.audit_log.push({
    id: nextId('A', db.audit_log, 'id', 4), at: new Date().toISOString(), actor: ctx.actor, player_id: ctx.pid,
    mode: o.mode || 'normal', action: o.action, match_id: o.match_id || null, summary: o.summary,
    reason: o.reason || '', changed: o.changed !== false, details: o.details || null
  });
  if (db.audit_log.length > AUDIT_MAX) db.audit_log.splice(0, db.audit_log.length - AUDIT_MAX);
}

function requireFinal(ctx) {
  if (String(ctx.body.confirm || '').trim().toUpperCase() !== 'FINAL') {
    fail(400, 'NEED_FINAL', 'Ketik "FINAL" untuk mengonfirmasi aksi ini.');
  }
}

async function checkForce(ctx) {
  if (!CFG.forcePassword) fail(403, 'FORCE_DISABLED', 'Fitur paksa belum diaktifkan di server (FORCE_PASSWORD belum diatur).');
  const key = 'force:' + ctx.ip;
  const wait = await lockedSeconds(key);
  if (wait) fail(429, 'LOCKED', `Terlalu banyak kata sandi salah. Coba lagi dalam ${Math.ceil(wait / 60)} menit.`);
  if (!safeEqual(ctx.body.password || '', CFG.forcePassword)) { await recordFail(key); fail(403, 'BAD_PASSWORD', 'Kata sandi salah.'); }
  await clearFail(key);
}

// ---------------------------------------------------------------
// Gerbang aturan untuk edit / hapus / pulihkan game
//   direct  : pembuat game dari perangkat yang sama, dalam 10 menit pertama
//   propose : usulan, berlaku setelah 2 pemain lain di game itu setuju
//   force   : kata sandi paksa + alasan wajib
// ---------------------------------------------------------------
async function gate(ctx, spec) {
  const mode = String(ctx.body.mode || '');
  if (mode === 'force') {
    await checkForce(ctx);
    const reason = clean(ctx.body.reason, 200);
    if (reason.length < 3) fail(400, 'REASON_REQUIRED', 'Alasan wajib diisi (minimal 3 huruf).');
    const d = spec.apply();
    audit(ctx, { mode: 'force', action: d.action, match_id: spec.matchId, summary: `${ctx.actor} MEMAKSA ${spec.summary}`, reason, details: d.details });
    return { data: { applied: true }, backup: true };
  }
  if (mode === 'direct') {
    if (!spec.match || !inGrace(spec.match, ctx.pid)) fail(403, 'NEEDS_APPROVAL', 'Perubahan ini perlu persetujuan 2 pemain lain.');
    const d = spec.apply();
    audit(ctx, { mode: 'grace', action: d.action, match_id: spec.matchId, summary: `${ctx.actor} mengoreksi ${spec.summary}`, details: d.details });
    return { data: { applied: true } };
  }
  if (mode === 'propose') {
    if (db.proposals.some(p => p.status === 'pending' && p.match_id === spec.matchId)) {
      fail(409, 'PENDING_EXISTS', 'Sudah ada usulan yang menunggu persetujuan untuk game ini.');
    }
    // Pengusul tidak bisa mengesahkan usulannya sendiri
    const eligible = spec.eligible.filter(pid => pid !== ctx.pid);
    if (!eligible.length) fail(409, 'NO_VOTERS', 'Tidak ada pemain lain yang bisa mengesahkan.');
    const prop = {
      id: nextId('PR', db.proposals, 'id', 3), type: spec.type, match_id: spec.matchId, season_id: spec.seasonId,
      payload: spec.payload, summary: spec.summary, before_text: spec.beforeText, after_text: spec.afterText,
      proposer: ctx.actor, proposer_player_id: ctx.pid, created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(), base_rev: spec.baseRev,
      eligible: eligible.map(pid => ({ player_id: pid, name: nm(pid) })),
      required: Math.min(APPROVALS_REQUIRED, eligible.length),
      approvals: [], rejections: [], status: 'pending'
    };
    db.proposals.push(prop);
    audit(ctx, { mode: 'proposal', action: 'propose', changed: false, match_id: spec.matchId, summary: `${ctx.actor} mengajukan ${spec.summary}` });
    return { data: { proposal_id: prop.id } };
  }
  fail(400, 'BAD_MODE', 'Mode tidak valid.');
}

function sweep() {
  let changed = false;
  const now = Date.now();
  db.proposals.forEach(p => {
    if (p.status === 'pending' && Date.parse(p.expires_at) < now) { p.status = 'expired'; p.resolved_at = new Date().toISOString(); changed = true; }
  });
  const resolved = db.proposals.filter(p => p.status !== 'pending');
  if (resolved.length > 50) {
    const drop = new Set(resolved.slice(0, resolved.length - 50).map(p => p.id));
    db.proposals = db.proposals.filter(p => !drop.has(p.id));
    changed = true;
  }
  if (changed) db.rev++;
  return changed;
}

// ---------------------------------------------------------------
// Perintah (command)
// ---------------------------------------------------------------
const COMMANDS = {};

COMMANDS.add_match = ctx => {
  const p = ctx.payload;
  const session = db.sessions.find(s => s.session_id === p.session_id) || fail(404, 'NO_SESSION', 'Sesi tidak ditemukan.');
  assertUnlocked(session.season_id);
  if (session.status !== 'active') fail(409, 'SESSION_CLOSED', 'Sesi sudah ditutup. Buka kembali sesi untuk menambah game.');
  const form = parseForm(p, session.session_id);
  const matchId = nextId('M', db.matches, 'match_id', 3);
  const sessionMatches = db.matches.filter(m => m.session_id === session.session_id);
  db.matches.push({
    match_id: matchId, session_id: session.session_id, season_id: session.season_id,
    match_number: Math.max(0, ...sessionMatches.map(m => Number(m.match_number) || 0)) + 1,
    players: form.players, played_at: localTime(), notes: form.notes, rev: 1,
    created_at: new Date().toISOString(), created_by: ctx.actor, created_by_player: ctx.pid
  });
  const ev = buildEvents(matchId, session.session_id, form);
  db.loss_events.push(...ev.loss); db.special_events.push(...ev.special);
  audit(ctx, { action: 'add_match', match_id: matchId, summary: `${ctx.actor} menambah game ${matchId}: ${describe(form)}`, details: { after_form: form } });
  return { data: { match_id: matchId } };
};

COMMANDS.edit_match = ctx => {
  const p = ctx.payload;
  const m = findMatch(p.match_id) || fail(404, 'NO_MATCH', 'Game tidak ditemukan.');
  assertUnlocked(m.season_id);
  const form = parseForm(p, m.session_id);
  const before = formFromMatch(m);
  return gate(ctx, {
    type: 'edit_match', matchId: m.match_id, match: m, seasonId: m.season_id, eligible: m.players.slice(), payload: form,
    baseRev: m.rev || 0, summary: `perubahan game ${m.match_id}`, beforeText: describe(before), afterText: describe(form),
    apply: () => applyChange('edit_match', m.match_id, form)
  });
};

COMMANDS.delete_match = ctx => {
  const m = findMatch(ctx.payload.match_id) || fail(404, 'NO_MATCH', 'Game tidak ditemukan.');
  assertUnlocked(m.season_id);
  return gate(ctx, {
    type: 'delete_match', matchId: m.match_id, match: m, seasonId: m.season_id, eligible: m.players.slice(), payload: null,
    baseRev: m.rev || 0, summary: `penghapusan game ${m.match_id}`, beforeText: describe(formFromMatch(m)), afterText: '(game dihapus)',
    apply: () => applyChange('delete_match', m.match_id, null)
  });
};

COMMANDS.restore_match = ctx => {
  const rec = ctx.payload.record;
  if (!rec || !rec.match || !rec.match.match_id || !Array.isArray(rec.match.players) || !Array.isArray(rec.loss_events) || !Array.isArray(rec.special_events)) {
    fail(400, 'BAD_RECORD', 'Data pemulihan tidak valid.');
  }
  if (findMatch(rec.match.match_id)) fail(409, 'EXISTS', 'Game ini sudah ada.');
  assertUnlocked(rec.match.season_id);
  rec.match.players.forEach(pid => { if (!db.players.some(x => x.player_id === pid)) fail(400, 'BAD_PLAYERS', 'Pemain tidak dikenal: ' + pid); });
  const form = { session_id: rec.match.session_id, players: rec.match.players, notes: rec.match.notes || '', losses: {}, ratus: {}, ribu: {} };
  rec.match.players.forEach(p => { form.losses[p] = 0; form.ratus[p] = 0; form.ribu[p] = 0; });
  rec.loss_events.forEach(l => { if (l.player_id in form.losses) form.losses[l.player_id] += Number(l.loss_count) || 0; });
  rec.special_events.forEach(e => { const k = e.event_type === 'S1000' ? 'ribu' : 'ratus'; if (e.player_id in form[k]) form[k][e.player_id] += Number(e.quantity) || 0; });
  return gate(ctx, {
    type: 'restore_match', matchId: rec.match.match_id, match: null, seasonId: rec.match.season_id, eligible: rec.match.players.slice(),
    payload: { record: rec }, baseRev: 0, summary: `pemulihan game ${rec.match.match_id}`, beforeText: '(game tidak ada)', afterText: describe(form),
    apply: () => applyChange('restore_match', rec.match.match_id, { record: rec })
  });
};

COMMANDS.vote = ctx => {
  const p = ctx.payload;
  const prop = db.proposals.find(x => x.id === p.proposal_id) || fail(404, 'NO_PROPOSAL', 'Usulan tidak ditemukan.');
  if (prop.status !== 'pending') fail(409, 'NOT_PENDING', `Usulan ini sudah ${prop.status}.`);
  if (ctx.pid === prop.proposer_player_id) fail(403, 'SELF_VOTE', 'Anda adalah pengusul. Usulan harus disahkan pemain lain (keluar, lalu masuk dengan PIN pemain itu).');
  if (!prop.eligible.some(e => e.player_id === ctx.pid)) fail(403, 'NOT_ELIGIBLE', 'Hanya pemain yang bermain di game ini yang boleh mengesahkan.');
  if (prop.approvals.includes(ctx.pid) || prop.rejections.includes(ctx.pid)) fail(409, 'ALREADY_VOTED', 'Anda sudah memberi suara.');
  const vote = p.vote === 'reject' ? 'reject' : p.vote === 'approve' ? 'approve' : fail(400, 'BAD_VOTE', 'Suara tidak valid.');

  if (vote === 'reject') {
    prop.rejections.push(ctx.pid);
    prop.status = 'rejected';
    prop.resolved_at = new Date().toISOString();
    audit(ctx, { mode: 'vote', action: 'reject', changed: false, match_id: prop.match_id, summary: `${ctx.actor} menolak ${prop.summary} (diajukan ${prop.proposer})` });
    return { data: { status: 'rejected' } };
  }

  prop.approvals.push(ctx.pid);
  if (prop.approvals.length < prop.required) {
    audit(ctx, { mode: 'vote', action: 'approve', changed: false, match_id: prop.match_id, summary: `${ctx.actor} mengesahkan ${prop.summary} (${prop.approvals.length}/${prop.required})` });
    return { data: { status: 'pending', approvals: prop.approvals.length, required: prop.required } };
  }

  // Cukup pengesahan: terapkan bila game belum berubah sejak diajukan
  const m = findMatch(prop.match_id);
  let stale = false;
  if (prop.type === 'restore_match') stale = !!m;
  else stale = !m || (m.rev || 0) !== prop.base_rev;
  if (!stale && seasonLocked(prop.season_id)) stale = true;
  prop.resolved_at = new Date().toISOString();
  if (stale) {
    prop.status = 'stale';
    audit(ctx, { mode: 'vote', action: 'stale', changed: false, match_id: prop.match_id, summary: `${prop.summary} batal: game sudah berubah atau season terkunci. Ajukan ulang.` });
    return { data: { status: 'stale' } };
  }
  const d = applyChange(prop.type, prop.match_id, prop.payload);
  prop.status = 'applied';
  audit(ctx, {
    mode: 'approved', action: d.action, match_id: prop.match_id,
    summary: `${prop.summary} disahkan ${prop.approvals.map(nm).join(' & ')} (diajukan ${prop.proposer})`, details: d.details
  });
  return { data: { status: 'applied' }, backup: true };
};

COMMANDS.cancel_proposal = ctx => {
  const prop = db.proposals.find(x => x.id === ctx.payload.proposal_id) || fail(404, 'NO_PROPOSAL', 'Usulan tidak ditemukan.');
  if (prop.status !== 'pending') fail(409, 'NOT_PENDING', `Usulan ini sudah ${prop.status}.`);
  if (prop.proposer_player_id !== ctx.pid) fail(403, 'NOT_OWNER', 'Hanya pengusul yang bisa membatalkan.');
  prop.status = 'cancelled';
  prop.resolved_at = new Date().toISOString();
  audit(ctx, { action: 'cancel', changed: false, match_id: prop.match_id, summary: `${ctx.actor} membatalkan usulan ${prop.summary}` });
  return {};
};

// ---- sesi & pemain ----
COMMANDS.add_session = ctx => {
  const p = ctx.payload;
  const season = db.seasons.find(s => s.season_id === p.season_id) || fail(404, 'NO_SEASON', 'Season tidak ditemukan.');
  assertUnlocked(season.season_id);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? p.date : new Date().toISOString().slice(0, 10);
  const id = nextId('SES', db.sessions, 'session_id', 3);
  db.sessions.push({ session_id: id, season_id: season.season_id, session_date: date, session_label: clean(p.label, 80), location: clean(p.location, 60), status: 'active', notes: clean(p.notes, 200) });
  audit(ctx, { action: 'add_session', summary: `${ctx.actor} membuat sesi ${id}` });
  return { data: { session_id: id } };
};

COMMANDS.edit_session = ctx => {
  const p = ctx.payload;
  const s = db.sessions.find(x => x.session_id === p.session_id) || fail(404, 'NO_SESSION', 'Sesi tidak ditemukan.');
  assertUnlocked(s.season_id);
  const label = clean(p.label, 80);
  if (!label) fail(400, 'BAD_LABEL', 'Nama sesi wajib diisi.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? p.date : s.session_date;
  const notes = clean(p.notes, 200);
  // Klien lama tidak mengirim lokasi: biarkan yang sudah ada
  const location = ('location' in p) ? clean(p.location, 60) : (s.location || '');
  const changes = [];
  if (label !== s.session_label) changes.push(`nama "${s.session_label || '-'}" → "${label}"`);
  if (date !== s.session_date) changes.push(`tanggal ${s.session_date} → ${date}`);
  if (notes !== (s.notes || '')) changes.push('catatan');
  if (location !== (s.location || '')) changes.push(`lokasi "${s.location || '-'}" → "${location || '-'}"`);
  if (!changes.length) return {};
  const before = { label: s.session_label, date: s.session_date, notes: s.notes || '', location: s.location || '' };
  s.session_label = label; s.session_date = date; s.notes = notes; s.location = location;
  audit(ctx, { action: 'edit_session', summary: `${ctx.actor} mengubah sesi ${s.session_id}: ${changes.join(', ')}`, details: { before, after: { label, date, notes, location } } });
  return {};
};

// Sesi kosong boleh dihapus siapa saja yang login. Sesi berisi game hanya dengan kata sandi paksa
// (menghapus sesi beserta semua game-nya; backup otomatis dibuat sebelum penghapusan).
COMMANDS.delete_session = async ctx => {
  const s = db.sessions.find(x => x.session_id === ctx.payload.session_id) || fail(404, 'NO_SESSION', 'Sesi tidak ditemukan.');
  assertUnlocked(s.season_id);
  const ms = db.matches.filter(m => m.session_id === s.session_id);
  let reason = '';
  const forced = ms.length > 0;
  if (forced) {
    if (String(ctx.body.mode || '') !== 'force') {
      fail(409, 'SESSION_HAS_GAMES', `Sesi ini berisi ${ms.length} game. Hapus game-nya dulu (butuh pengesahan pemain lain), atau hapus paksa dengan kata sandi.`);
    }
    await checkForce(ctx);
    reason = clean(ctx.body.reason, 200);
    if (reason.length < 3) fail(400, 'REASON_REQUIRED', 'Alasan wajib diisi (minimal 3 huruf).');
  }
  const ids = new Set(ms.map(m => m.match_id));
  const record = {
    session: JSON.parse(JSON.stringify(s)), matches: JSON.parse(JSON.stringify(ms)),
    loss_events: db.loss_events.filter(l => ids.has(l.match_id)), special_events: db.special_events.filter(e => ids.has(e.match_id))
  };
  db.loss_events = db.loss_events.filter(l => !ids.has(l.match_id));
  db.special_events = db.special_events.filter(e => !ids.has(e.match_id));
  db.matches = db.matches.filter(m => !ids.has(m.match_id));
  db.sessions = db.sessions.filter(x => x.session_id !== s.session_id);
  db.proposals.forEach(pr => { if (pr.status === 'pending' && ids.has(pr.match_id)) { pr.status = 'cancelled'; pr.resolved_at = new Date().toISOString(); } });
  audit(ctx, {
    mode: forced ? 'force' : 'normal', action: 'delete_session', reason,
    summary: `${ctx.actor} ${forced ? 'MEMAKSA ' : ''}menghapus sesi ${s.session_id} "${s.session_label || '-'}" (${ms.length} game)`,
    details: { before_record: record }
  });
  return { backup: forced };
};

COMMANDS.toggle_session = ctx => {
  const s = db.sessions.find(x => x.session_id === ctx.payload.session_id) || fail(404, 'NO_SESSION', 'Sesi tidak ditemukan.');
  assertUnlocked(s.season_id);
  s.status = s.status === 'active' ? 'closed' : 'active';
  audit(ctx, { action: 'toggle_session', summary: `${ctx.actor} ${s.status === 'active' ? 'membuka kembali' : 'menutup'} sesi ${s.session_id}` });
  return {};
};

COMMANDS.add_player = ctx => {
  const name = clean(ctx.payload.name, 40);
  if (!name) fail(400, 'BAD_NAME', 'Nama wajib diisi.');
  if (db.players.some(p => p.display_name.toLowerCase() === name.toLowerCase())) fail(409, 'DUP_NAME', 'Sudah ada pemain dengan nama tersebut.');
  const id = nextId('PL', db.players, 'player_id', 2);
  db.players.push({ player_id: id, display_name: name, is_active: true, created_at: new Date().toISOString() });
  audit(ctx, { action: 'add_player', summary: `${ctx.actor} menambah anggota ${name} (${id})` });
  return { data: { player_id: id, default_pin: defaultPin(id) } };
};

COMMANDS.rename_player = ctx => {
  const p = db.players.find(x => x.player_id === ctx.payload.player_id) || fail(404, 'NO_PLAYER', 'Pemain tidak ditemukan.');
  const name = clean(ctx.payload.name, 40);
  if (!name) fail(400, 'BAD_NAME', 'Nama wajib diisi.');
  if (db.players.some(x => x.player_id !== p.player_id && x.display_name.toLowerCase() === name.toLowerCase())) fail(409, 'DUP_NAME', 'Sudah ada pemain lain dengan nama tersebut.');
  const old = p.display_name;
  p.display_name = name;
  db.loss_events.forEach(l => { if (l.player_id === p.player_id) l.player_name = name; });
  db.special_events.forEach(e => { if (e.player_id === p.player_id) e.player_name = name; });
  audit(ctx, { action: 'rename_player', summary: `${ctx.actor} mengubah nama ${old} menjadi ${name}` });
  return {};
};

COMMANDS.toggle_player = ctx => {
  const p = db.players.find(x => x.player_id === ctx.payload.player_id) || fail(404, 'NO_PLAYER', 'Pemain tidak ditemukan.');
  p.is_active = !p.is_active;
  audit(ctx, { action: 'toggle_player', summary: `${ctx.actor} ${p.is_active ? 'mengaktifkan' : 'menonaktifkan'} ${p.display_name}` });
  return {};
};

// ---- PIN ----
COMMANDS.change_pin = async ctx => {
  const p = ctx.payload;
  const cur = String(p.current_pin || '');
  const next = String(p.new_pin || '');
  const key = 'pinchg:' + ctx.pid;
  const wait = await lockedSeconds(key);
  if (wait) fail(429, 'LOCKED', `Terlalu banyak PIN salah. Coba lagi dalam ${Math.ceil(wait / 60)} menit.`);
  if (!checkPin(ctx.pid, cur)) { await recordFail(key); fail(403, 'BAD_PIN', 'PIN saat ini salah.'); }
  await clearFail(key);
  if (!/^\d{5,6}$/.test(next)) fail(400, 'BAD_NEW_PIN', 'PIN baru harus 5 atau 6 angka.');
  const h = pinHash(next);
  if (Object.entries(db.auth.pins).some(([pid, r]) => pid !== ctx.pid && r.h === h)) fail(409, 'PIN_TAKEN', 'PIN itu sudah dipakai pemain lain. Pilih angka lain.');
  db.auth.pins[ctx.pid] = { h };
  audit(ctx, { action: 'change_pin', changed: false, summary: `${ctx.actor} mengganti PIN` });
  return {};
};

// Lupa PIN: dikembalikan ke PIN bawaan, hanya dengan kata sandi paksa
COMMANDS.reset_pin = async ctx => {
  if (String(ctx.body.mode || '') !== 'force') fail(400, 'BAD_MODE', 'Reset PIN memakai mode paksa (kata sandi).');
  await checkForce(ctx);
  const reason = clean(ctx.body.reason, 200);
  if (reason.length < 3) fail(400, 'REASON_REQUIRED', 'Alasan wajib diisi (minimal 3 huruf).');
  const pl = db.players.find(x => x.player_id === ctx.payload.player_id) || fail(404, 'NO_PLAYER', 'Pemain tidak ditemukan.');
  delete db.auth.pins[pl.player_id];
  audit(ctx, { mode: 'force', action: 'reset_pin', changed: false, summary: `${ctx.actor} mereset PIN ${pl.display_name}`, reason });
  return { data: { default_pin: defaultPin(pl.player_id) } };
};

// Unduh seluruh data sebagai cadangan (tanpa rahasia PIN). Hanya dengan kata sandi paksa.
COMMANDS.export_all = async ctx => {
  if (String(ctx.body.mode || '') !== 'force') fail(400, 'BAD_MODE', 'Unduh cadangan memakai mode paksa (kata sandi).');
  await checkForce(ctx);
  const reason = clean(ctx.body.reason, 200);
  if (reason.length < 3) fail(400, 'REASON_REQUIRED', 'Alasan wajib diisi (minimal 3 huruf).');
  const { auth, ...rest } = db;
  audit(ctx, { mode: 'force', action: 'export_all', changed: false, summary: `${ctx.actor} mengunduh cadangan data`, reason });
  return { data: { backup: JSON.parse(JSON.stringify(rest)) } };
};

// ---- season (aksi besar: wajib ketik FINAL) ----
COMMANDS.create_season = ctx => {
  if (db.seasons.some(s => s.status === 'active')) fail(409, 'ACTIVE_EXISTS', 'Masih ada season yang aktif. Finalisasi dulu.');
  const name = clean(ctx.payload.name, 80);
  if (!name) fail(400, 'BAD_NAME', 'Nama season wajib diisi.');
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.payload.start || '')) ? ctx.payload.start : new Date().toISOString().slice(0, 10);
  const year = start.slice(0, 4);
  let n = db.seasons.length + 1;
  while (db.seasons.some(s => s.season_id === `SSN-${year}-S${n}`)) n++;
  const id = `SSN-${year}-S${n}`;
  db.seasons.push({ season_id: id, season_name: name, start_date: start, end_date: null, status: 'active', closed_at: null });
  audit(ctx, { action: 'create_season', summary: `${ctx.actor} memulai ${name}` });
  return { data: { season_id: id }, backup: true };
};

COMMANDS.finalize_season = ctx => {
  requireFinal(ctx);
  const season = db.seasons.find(s => s.season_id === ctx.payload.season_id) || fail(404, 'NO_SEASON', 'Season tidak ditemukan.');
  if (season.status === 'finalized') fail(409, 'ALREADY_FINAL', 'Season ini sudah difinalisasi.');
  const seasonMatches = db.matches.filter(m => m.season_id === season.season_id);
  if (seasonMatches.length === 0) fail(409, 'NO_MATCHES', 'Season ini belum memiliki game sama sekali.');

  const stats = L.calculateSeasonStats(season.season_id, db.players, db.matches, db.loss_events, db.special_events, db.settings).playerStats;
  const cons = L.calculateConsistency(stats, seasonMatches, db.loss_events, db.special_events, db.settings);
  const awards = L.calculateSeasonAwards(stats, cons, db.settings);

  season.status = 'finalized';
  season.closed_at = new Date().toISOString();
  season.end_date = season.closed_at.slice(0, 10);
  db.sessions.forEach(s => { if (s.season_id === season.season_id && s.status === 'active') s.status = 'closed'; });
  db.proposals.forEach(p => { if (p.status === 'pending' && p.season_id === season.season_id) { p.status = 'cancelled'; p.resolved_at = season.closed_at; } });
  db.season_snapshots = db.season_snapshots.filter(s => s.season_id !== season.season_id);
  db.season_snapshots.push({
    snapshot_id: 'SNAP-' + season.season_id + '-' + Date.now(), season_id: season.season_id, season_name: season.season_name,
    finalized_at: season.closed_at,
    champion: awards[0] && awards[0].winners[0] ? awards[0].winners[0].name : '-',
    champion_score: awards[0] && awards[0].winners[0] ? awards[0].winners[0].value : '-',
    awards: awards.map(a => ({ title: a.title, winner: a.winners.map(w => w.name).join(', ') || '-', value: (a.winners[0] && a.winners[0].value) || '-' }))
  });
  audit(ctx, { mode: 'admin', action: 'finalize_season', summary: `${ctx.actor} memfinalisasi ${season.season_name}` });
  return { backup: true };
};

COMMANDS.reopen_season = ctx => {
  requireFinal(ctx);
  const season = db.seasons.find(s => s.season_id === ctx.payload.season_id) || fail(404, 'NO_SEASON', 'Season tidak ditemukan.');
  if (season.status !== 'finalized') fail(409, 'NOT_FINAL', 'Season ini tidak sedang terkunci.');
  if (db.seasons.some(s => s.status === 'active')) fail(409, 'ACTIVE_EXISTS', 'Ada season aktif lain. Hanya satu season boleh aktif.');
  season.status = 'active'; season.closed_at = null; season.end_date = null;
  db.season_snapshots = db.season_snapshots.filter(s => s.season_id !== season.season_id);
  audit(ctx, { mode: 'admin', action: 'reopen_season', summary: `${ctx.actor} membuka kunci ${season.season_name}` });
  return { backup: true };
};

COMMANDS.update_settings = ctx => {
  requireFinal(ctx);
  const s = ctx.payload.settings || {};
  const out = {};
  ['min_games_champion', 'min_sessions_worst_record', 'min_sessions_consistent'].forEach(k => {
    if (k in s) { const n = parseInt(s[k], 10); if (!(n >= 1 && n <= 999)) fail(400, 'BAD_SETTING', `Nilai ${k} tidak valid.`); out[k] = n; }
  });
  if ('auto_sync_sheets' in s) out.auto_sync_sheets = !!s.auto_sync_sheets;
  if ('sheets_webhook_url' in s) {
    const u = String(s.sheets_webhook_url || '').trim();
    if (u && !webhookAllowed(u)) fail(400, 'BAD_WEBHOOK', 'URL harus berupa https://script.google.com/macros/s/.../exec');
    out.sheets_webhook_url = u;
  }
  Object.assign(db.settings, out);
  audit(ctx, { mode: 'admin', action: 'update_settings', summary: `${ctx.actor} mengubah pengaturan (${Object.keys(out).join(', ')})` });
  return {};
};

function replaceState(parts) {
  ['is_demo', 'seasons', 'players', 'sessions', 'matches', 'loss_events', 'special_events', 'season_snapshots'].forEach(k => { db[k] = parts[k]; });
  db.proposals = [];
  db.auth.pins = {};
  needPrune = true; // sesi pemain yang sudah tidak ada dibatalkan setelah data tersimpan
}

COMMANDS.reset_real = ctx => {
  requireFinal(ctx);
  replaceState(freshRealParts());
  audit(ctx, { mode: 'admin', action: 'reset_real', summary: `${ctx.actor} mereset ke data asli (kosong)` });
  return { backup: true };
};

COMMANDS.load_demo = ctx => {
  requireFinal(ctx);
  const d = freshDemo();
  replaceState(d);
  audit(ctx, { mode: 'admin', action: 'load_demo', summary: `${ctx.actor} memuat dataset DEMO` });
  return { backup: true };
};

COMMANDS.import_legacy = ctx => {
  requireFinal(ctx);
  const s = ctx.payload.state;
  if (!s || !Array.isArray(s.players) || !Array.isArray(s.matches) || !Array.isArray(s.seasons)) fail(400, 'BAD_IMPORT', 'Data impor tidak valid.');
  const d = upgrade({ ...JSON.parse(JSON.stringify(s)), is_demo: false, settings: db.settings });
  replaceState(d);
  audit(ctx, { mode: 'admin', action: 'import_legacy', summary: `${ctx.actor} mengimpor data lama (${d.matches.length} game)` });
  return { backup: true };
};


  // ---------------------------------------------------------------
  // Google Sheets (URL diambil dari pengaturan di database, bukan dari klien)
  // ---------------------------------------------------------------
  function hostAllowed(host) { return WEBHOOK_HOSTS.has(host) || host.endsWith('.googleusercontent.com'); }
  function webhookAllowed(u) {
    try {
      const x = new URL(u);
      const okProto = x.protocol === 'https:' || (config.allowInsecureWebhook === true && x.protocol === 'http:');
      return okProto && WEBHOOK_HOSTS.has(x.hostname);
    } catch (_) { return false; }
  }

  // Apps Script membalas POST dengan redirect (302) ke alamat Google lain; hasil asli ada di tujuan redirect.
  async function postWebhook(url, bodyJson) {
    let target = url, method = 'POST', body = bodyJson;
    for (let i = 0; i < 6; i++) {
      const u = new URL(target);
      if (!(u.protocol === 'https:' || config.allowInsecureWebhook === true) || !hostAllowed(u.hostname)) {
        throw new Error('Alamat tujuan tidak diizinkan.');
      }
      const res = await fetchImpl(target, {
        method, redirect: 'manual', signal: AbortSignal.timeout(30000),
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: method === 'POST' ? body : undefined
      });
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
        target = new URL(res.headers.get('location'), target).toString();
        if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; }
        continue;
      }
      return { status: res.status, body: await res.text() };
    }
    throw new Error('Terlalu banyak redirect dari Google.');
  }

  async function callWebhook(payload) {
    const url = db.settings.sheets_webhook_url;
    if (!url) return { success: false, error: 'URL Webhook belum diisi di Pengaturan.' };
    if (!webhookAllowed(url)) return { success: false, error: 'URL Webhook harus dari script.google.com.' };
    let result;
    try { result = await postWebhook(url, JSON.stringify(payload)); } catch (e) { return { success: false, error: e.message }; }
    let g = null;
    try { g = JSON.parse(result.body); } catch (_) { /* bukan JSON */ }
    if (g && g.status === 'success') return { success: true };
    if (g && g.status === 'error') return { success: false, error: g.message || 'Apps Script mengembalikan error.' };
    return { success: false, error: 'Balasan bukan dari Apps Script (HTTP ' + result.status + '). Pastikan URL berakhiran /exec, deployment diset "Anyone", dan sudah di-deploy ulang setelah kode diubah.' };
  }

function sheetsPayload() {
  const season = db.seasons.find(s => s.status === 'active') || db.seasons[db.seasons.length - 1];
  const sid = season ? season.season_id : '';
  const seasonMatches = db.matches.filter(m => m.season_id === sid);
  const stats = L.calculateSeasonStats(sid, db.players, db.matches, db.loss_events, db.special_events, db.settings).playerStats;
  const cons = L.calculateConsistency(stats, seasonMatches, db.loss_events, db.special_events, db.settings);
  const awards = L.calculateSeasonAwards(stats, cons, db.settings);
  return {
    action: 'sync_all',
    data: {
      season_name: season ? season.season_name : 'Domino League',
      players: db.players, sessions: db.sessions, matches: db.matches, loss_events: db.loss_events, special_events: db.special_events,
      leaderboard: stats.map(p => ({
        player_id: p.player_id, display_name: p.display_name, total_matches: p.total_matches, total_sessions: p.total_sessions,
        total_s100: p.total_s100, total_s1000: p.total_s1000, total_loss: p.total_loss, s100_rate: p.s100_rate,
        s1000_rate: p.s1000_rate, loss_rate: p.loss_rate, performance_index: p.performance_index, eligible: p.eligible_champion
      })),
      awards: awards.map(a => ({ title: a.title, winner_name: a.winners.map(w => w.name).join(', ') || '-', value: (a.winners[0] && a.winners[0].value) || '-', criteria: a.desc }))
    }
  };
}

  function autoSync() {
    if (!db.settings.auto_sync_sheets || !db.settings.sheets_webhook_url) return;
    background(callWebhook(sheetsPayload()).then(r => { if (!r.success) console.warn('Auto-sync Sheets gagal:', r.error); }));
  }

  async function sheetsCommand(command, ctx) {
    if (!(await store.limit.throttle('sheets:' + ctx.ip, 10, 60 * 1000))) fail(429, 'RATE', 'Terlalu sering. Tunggu sebentar.');
    const r = await callWebhook(command === 'ping_sheets' ? { action: 'ping' } : sheetsPayload());
    return r.success ? { ok: true, data: {} } : { ok: false, code: 'SHEETS_ERROR', error: r.error };
  }

  // ---------------------------------------------------------------
  // State publik (yang dikirim ke klien)
  // ---------------------------------------------------------------
function publicState(pid) {
  const now = Date.now();
  const matches = db.matches.map(m => {
    const { created_by_client, created_by_player, ...rest } = m;
    const left = created_by_player && created_by_player === pid ? GRACE_MS - (now - Date.parse(m.created_at)) : 0;
    return left > 0 ? { ...rest, grace_left_ms: left } : rest;
  });
  const proposals = db.proposals
    .filter(p => p.status === 'pending' || now - Date.parse(p.resolved_at || p.created_at) < 24 * 3600 * 1000)
    .map(p => { const { proposer_client_id, proposer_player_id, payload, ...rest } = p; return { ...rest, mine: proposer_player_id === pid }; });
  const { sheets_webhook_url, ...settings } = db.settings;
  const me = db.players.find(p => p.player_id === pid);
  return {
    rev: db.rev, server_time: new Date().toISOString(), today: localTime().slice(0, 10), is_demo: db.is_demo,
    me: me ? { player_id: me.player_id, name: me.display_name, pin_custom: !!db.auth.pins[pid] } : null,
    seasons: db.seasons, players: db.players, sessions: db.sessions, matches,
    loss_events: db.loss_events, special_events: db.special_events, season_snapshots: db.season_snapshots,
    settings: { ...settings, sheets_webhook_set: !!sheets_webhook_url, sheets_webhook_hint: sheets_webhook_url ? '…' + sheets_webhook_url.slice(-14) : '' },
    proposals,
    audit_log: db.audit_log.slice(-100).reverse().map(({ player_id, client_id, ...rest }) => rest),
    config: { force_enabled: !!CFG.forcePassword, grace_minutes: GRACE_MS / 60000, approvals_required: APPROVALS_REQUIRED }
  };
}

  // ---------------------------------------------------------------
  // Muat data, sesi login, dan rute
  // ---------------------------------------------------------------
  async function loadDb() {
    let r = await store.load();
    if (!r) {
      // Data awal: contoh [DEMO] (bawaan) atau langsung kosong untuk liga sungguhan (INITIAL_DATA=real)
      const fresh = config.initialData === 'real' ? upgrade({ ...freshRealParts(), settings: {} }) : freshDemo();
      const ok = await store.save(fresh, null, {});
      r = ok ? { doc: fresh, rev: fresh.rev } : await store.load();
      if (!r) fail(503, 'STORE', 'Penyimpanan data tidak tersedia.');
    }
    db = r.doc;
    loadedRev = r.rev;
    if (db.schema !== 3) {
      // Data dari versi lama: ubah ke bentuk terbaru dan simpan segera (rahasia PIN harus tetap sama sesudahnya).
      db = upgrade(db);
      db.rev++;
      if (await store.save(db, loadedRev, {})) { loadedRev = db.rev; } else { return loadDb(); }
    }
  }

  async function sessionFor(token) {
    if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return null;
    const h = tokenHash(token);
    const s = await store.session.get(h);
    if (!s) return null;
    if (s.expires < Date.now()) { await store.session.delete(h); return null; }
    if (s.expires - Date.now() < SESSION_MS / 2) await store.session.extend(h, Date.now() + SESSION_MS);
    return { hash: h, player_id: s.player_id };
  }

  async function loginRoute(req) {
    const body = req.body || {};
    const key = 'login:' + req.ip;
    const wait = await lockedSeconds(key);
    if (wait) return json(429, { ok: false, code: 'LOCKED', error: `Terlalu banyak PIN salah. Coba lagi dalam ${Math.ceil(wait / 60)} menit.` });
    await loadDb();
    const player = findPlayerByPin(body.pin);
    if (!player) {
      await recordFail(key, 12, 3 * 60 * 1000);
      return json(401, { ok: false, code: 'BAD_PIN', error: 'PIN tidak dikenal.' });
    }
    await clearFail(key);
    const token = crypto.randomBytes(24).toString('hex');
    await store.session.create(tokenHash(token), player.player_id, Date.now() + SESSION_MS);
    return json(200, { ok: true, token, player: { player_id: player.player_id, name: player.display_name } });
  }

  async function stateRoute(req) {
    const sess = await sessionFor(req.token);
    if (!sess) return json(401, { ok: false, code: 'AUTH', error: 'Silakan masuk dengan PIN.' });
    const qrev = req.query.get('rev');
    if (qrev !== null && qrev !== '') {
      const cur = await store.getRev();
      if (cur !== null && Number(qrev) === cur) return json(200, { unchanged: true, rev: cur });
    }
    await loadDb();
    if (!db.players.some(p => p.player_id === sess.player_id)) return json(401, { ok: false, code: 'AUTH', error: 'Silakan masuk dengan PIN.' });
    if (sweep()) { await store.save(db, loadedRev, {}); }
    return json(200, publicState(sess.player_id));
  }

  async function commandRoute(req) {
    const sess = await sessionFor(req.token);
    if (!sess) return json(401, { ok: false, code: 'AUTH', error: 'Sesi berakhir. Silakan masuk lagi dengan PIN.' });
    if (!(await store.limit.throttle('cmd:' + req.ip, 240, 60 * 1000))) {
      return json(429, { ok: false, code: 'RATE', error: 'Terlalu banyak permintaan. Tunggu sebentar.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const command = String(body.command || '');

    for (let attempt = 0; attempt < 5; attempt++) {
      await loadDb();
      const me = db.players.find(p => p.player_id === sess.player_id);
      if (!me) return json(401, { ok: false, code: 'AUTH', error: 'Sesi tidak valid. Silakan masuk lagi.' });
      const loadedJson = JSON.stringify(db);   // keadaan sebelum perintah (untuk backup)
      sweep();
      const ctx = { body, ip: req.ip, pid: me.player_id, actor: me.display_name, payload: body.payload && typeof body.payload === 'object' ? body.payload : {} };
      try {
        if (command === 'ping_sheets' || command === 'sync_sheets') {
          const r = await sheetsCommand(command, ctx);
          return json(200, r);
        }
        const fn = COMMANDS[command];
        if (!fn) fail(400, 'UNKNOWN', 'Perintah tidak dikenal: ' + command);

        const snapshot = JSON.stringify(db);
        let result;
        try {
          result = (await fn(ctx)) || {};
        } catch (e) {
          db = JSON.parse(snapshot); // batalkan perubahan sebagian bila gagal
          throw e;
        }
        db.rev++;
        const saved = await store.save(db, loadedRev, { backup: !!result.backup, prev: loadedJson });
        if (!saved) continue;   // data berubah oleh orang lain saat ini: ulangi dari data terbaru
        if (needPrune) { needPrune = false; await store.session.prune(db.players.map(p => p.player_id)); }
        autoSync();
        return json(200, { ok: true, data: result.data || {}, state: publicState(ctx.pid) });
      } catch (e) {
        if (e instanceof CmdError) {
          return json(e.status, { ok: false, code: e.code, error: e.message, state: publicState(ctx.pid) });
        }
        throw e;
      }
    }
    return json(503, { ok: false, code: 'BUSY', error: 'Server sedang sibuk. Coba lagi sebentar lagi.' });
  }

  async function handle(req) {
    try {
      const route = req.route;
      if (route === 'ping') { const rev = await store.getRev(); return json(200, { ok: true, rev }); }
      if (route === 'login' && req.method === 'POST') return await loginRoute(req);
      if (route === 'logout' && req.method === 'POST') {
        const sess = await sessionFor(req.token);
        if (sess) await store.session.delete(sess.hash);
        return json(200, { ok: true });
      }
      if (route === 'state' && req.method === 'GET') return await stateRoute(req);
      if (route === 'command' && req.method === 'POST') return await commandRoute(req);
      return json(404, { ok: false, code: 'NOT_FOUND', error: 'Endpoint tidak ada.' });
    } catch (e) {
      if (e instanceof CmdError) return json(e.status, { ok: false, code: e.code, error: e.message });
      console.error(e);
      return json(500, { ok: false, code: 'SERVER', error: 'Terjadi kesalahan di server.' });
    }
  }

  return { handle };
}
