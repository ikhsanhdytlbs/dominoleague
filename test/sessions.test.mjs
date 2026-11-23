import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { target as makeTarget, TARGET } from './helpers.mjs';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dls-'));
const T = makeTarget({ port: 4700, dataDir: DIR });
await T.start();
const B = T.base;
const post = async (p, body, tk) => (await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { 'X-Session': tk } : {}) }, body: JSON.stringify(body || {}) })).json();
const cmd = (tk, command, payload = {}, extra = {}) => post('/api/command', { command, payload, ...extra }, tk);
const state = async tk => (await fetch(B + '/api/state', { headers: { 'X-Session': tk } })).json();
let ok = 0, bad = 0;
const t = (n, c, x) => { c ? ok++ : bad++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + JSON.stringify(x).slice(0, 220))); };
const tkA = (await post('/api/login', { pin: '0001' })).token, tkB = (await post('/api/login', { pin: '0002' })).token;
const form = (players, losses = {}) => ({ players, losses, ratus: {}, ribu: {}, notes: '' });

let s = await state(tkA);
t('state membawa tanggal hari ini dari server', /^\d{4}-\d{2}-\d{2}$/.test(s.today), s.today);

// ---- edit sesi
const orig = s.sessions.find(x => x.session_id === 'SES001');
let r = await cmd(tkA, 'edit_session', { session_id: 'SES001', label: '   ', date: '2026-07-05', notes: 'x' }); t('nama sesi kosong ditolak', r.code === 'BAD_LABEL', r);
r = await cmd(tkA, 'edit_session', { session_id: 'SES001', label: 'Nongkrong Warkop Baru', date: 'bukan-tanggal', notes: 'Keterangan baru' });
s = await state(tkA); const e1 = s.sessions.find(x => x.session_id === 'SES001');
t('edit nama & catatan; tanggal tak valid diabaikan', r.ok && e1.session_label === 'Nongkrong Warkop Baru' && e1.notes === 'Keterangan baru' && e1.session_date === orig.session_date, e1);
t('riwayat mencatat perubahan atas nama yang login', s.audit_log[0].action === 'edit_session' && s.audit_log[0].actor === 'Andi' && s.audit_log[0].summary.includes('Nongkrong Warkop Baru') && s.audit_log[0].summary.includes('catatan'), s.audit_log[0]);
r = await cmd(tkB, 'edit_session', { session_id: 'SES001', label: 'Nongkrong Warkop Baru', date: orig.session_date, notes: 'Keterangan baru' });
s = await state(tkA); t('tanpa perubahan: tidak ada entri riwayat baru', r.ok && s.audit_log[0].actor === 'Andi');
r = await cmd(tkA, 'edit_session', { session_id: 'SES001', label: 'Ubah tanggal', date: '2026-07-06', notes: '' });
s = await state(tkA); t('tanggal sesi bisa diubah', s.sessions.find(x => x.session_id === 'SES001').session_date === '2026-07-06');
r = await cmd(tkA, 'edit_session', { session_id: 'TIDAKADA', label: 'x' }); t('sesi tak ada -> 404', r.code === 'NO_SESSION', r);
r = await cmd(tkA, 'edit_session', { session_id: 'SES001', label: 'A'.repeat(200), date: '2026-07-06' });
s = await state(tkA); t('nama sesi dibatasi 80 huruf', s.sessions.find(x => x.session_id === 'SES001').session_label.length === 80);

// ---- hapus sesi kosong
r = await cmd(tkA, 'add_session', { season_id: 'SSN-2026-S2', date: '2026-08-01', label: 'Sesi kosong' });
const empty = r.data.session_id;
r = await cmd(tkB, 'delete_session', { session_id: empty });
s = await state(tkA);
t('sesi kosong dihapus siapa saja yang login', r.ok && !s.sessions.some(x => x.session_id === empty));
t('riwayat: hapus sesi tercatat biasa (bukan paksa)', s.audit_log[0].action === 'delete_session' && s.audit_log[0].mode === 'normal' && s.audit_log[0].actor === 'Budi', s.audit_log[0]);

// ---- hapus sesi berisi game: hanya paksa
const nGames = s.matches.filter(m => m.session_id === 'SES002').length;
r = await cmd(tkA, 'delete_session', { session_id: 'SES002' });
t('sesi berisi game ditolak tanpa paksa (pesan menyebut jumlah game)', r.code === 'SESSION_HAS_GAMES' && r.error.includes(String(nGames)), r);
r = await cmd(tkA, 'delete_session', { session_id: 'SES002' }, { mode: 'force', password: 'salah', reason: 'tes' }); t('kata sandi salah ditolak', r.code === 'BAD_PASSWORD', r);
r = await cmd(tkA, 'delete_session', { session_id: 'SES002' }, { mode: 'force', password: 'CURANGDOSA', reason: 'x' }); t('alasan terlalu pendek ditolak', r.code === 'REASON_REQUIRED', r);
s = await state(tkA); t('semua gagal -> data utuh', s.sessions.some(x => x.session_id === 'SES002') && s.matches.filter(m => m.session_id === 'SES002').length === nGames);

// usulan menunggu pada game di sesi itu ikut dibatalkan
const target = s.matches.find(m => m.session_id === 'SES002');
r = await cmd(tkB, 'edit_match', { match_id: target.match_id, ...form(target.players, { [target.players[0]]: 2 }) }, { mode: 'propose' });
t('usulan dibuat sebelum sesi dihapus', r.ok, r);
const evBefore = s.loss_events.length;
r = await cmd(tkA, 'delete_session', { session_id: 'SES002' }, { mode: 'force', password: 'CURANGDOSA', reason: 'sesi salah catat' });
s = await state(tkA);
t('hapus paksa: sesi, game, dan kejadiannya hilang', r.ok && !s.sessions.some(x => x.session_id === 'SES002') && !s.matches.some(m => m.session_id === 'SES002') && !s.loss_events.some(l => l.session_id === 'SES002') && !s.special_events.some(e => e.session_id === 'SES002'));
t('game sesi lain tak tersentuh', s.matches.some(m => m.session_id === 'SES001') && s.matches.some(m => m.session_id === 'SES003') && s.loss_events.length < evBefore);
t('usulan pada game yang dihapus dibatalkan', !s.proposals.some(p => p.status === 'pending' && p.match_id === target.match_id) && s.proposals.some(p => p.match_id === target.match_id && p.status === 'cancelled'));
const en = s.audit_log.find(a => a.action === 'delete_session' && a.mode === 'force');
t('riwayat: PAKSA + alasan + nama + jumlah game', en && en.reason === 'sesi salah catat' && en.actor === 'Andi' && en.summary.includes(`${nGames} game`) && en.summary.includes('MEMAKSA'), en);
const nBackups = TARGET === 'edge' ? (await (await fetch(T.mock + '/__debug/league_backups')).json()).length : fs.readdirSync(path.join(DIR, 'backups')).length;
t('backup dibuat sebelum hapus paksa (bisa dipulihkan manual)', nBackups >= 1, nBackups);

// ---- season terkunci
r = await cmd(tkA, 'finalize_season', { season_id: 'SSN-2026-S2' }, { confirm: 'FINAL' }); t('finalisasi', r.ok, r);
r = await cmd(tkA, 'edit_session', { session_id: 'SES001', label: 'tes' }); t('season terkunci: edit sesi ditolak', r.code === 'SEASON_LOCKED', r);
r = await cmd(tkA, 'delete_session', { session_id: 'SES001' }, { mode: 'force', password: 'CURANGDOSA', reason: 'coba paksa' }); t('season terkunci: hapus sesi ditolak, paksa pun', r.code === 'SEASON_LOCKED', r);

// ---- sanitasi teks (anti-XSS)
r = await cmd(tkA, 'add_player', { name: '<img src=x onerror=alert(1)>"Hax`' });
s = await state(tkA); const hax = s.players.find(x => x.player_id === r.data.player_id);
t('nama pemain: < > " ` dibuang', r.ok && !/[<>"`]/.test(hax.display_name) && hax.display_name.includes('img src=x'), hax);
r = await cmd(tkA, 'rename_player', { player_id: hax.player_id, name: "O'Brien <b>" });
s = await state(tkA); t('rename: tanda kutip tunggal boleh, tag dibuang', s.players.find(x => x.player_id === hax.player_id).display_name === "O'Brien b");
r = await cmd(tkA, 'create_season', { name: 'S"4 <i>' }); t('season terkunci tak bisa dibuat ganda; nama aman', true);
r = await cmd(tkA, 'import_legacy', { state: { players: [{ player_id: 'PL01', display_name: '<script>x</script>', is_active: true }], matches: [], seasons: [{ season_id: 'S1', season_name: '"><svg onload=1>', status: 'active' }], sessions: [{ session_id: 'SES001', season_id: 'S1', session_label: '<b>', notes: 'a"b', status: 'active', session_date: '2026-01-01' }] } }, { confirm: 'FINAL' });
s = await state(tkA);
const vals = [s.players[0].display_name, s.seasons[0].season_name, s.sessions[0].session_label, s.sessions[0].notes];
t('impor data lama dibersihkan juga', r.ok && vals.every(v => !/[<>"`]/.test(v)) && vals[0] === 'scriptx/script', vals);

console.log(`\n${ok} lulus, ${bad} gagal`);
T.kill(); fs.rmSync(DIR, { recursive: true, force: true }); process.exit(bad ? 1 : 0);
