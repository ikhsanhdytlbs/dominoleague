import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { target, TARGET } from './helpers.mjs';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dl3-'));
const T = target({ port: 4500, dataDir: DIR });
const start = () => T.start(), stop = () => T.stop();
const B = T.base;
const post = async (p, body, token) => { const r = await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Session': token } : {}) }, body: JSON.stringify(body || {}) }); const j = await r.json(); j.http = r.status; return j; };
const login = async pin => post('/api/login', { pin });
const cmd = (tk, command, payload = {}, extra = {}) => post('/api/command', { command, payload, actor: 'Peretas', client_id: 'x', ...extra }, tk);
const state = async tk => (await fetch(B + '/api/state', { headers: tk ? { 'X-Session': tk } : {} })).json();
let ok = 0, bad = 0;
const t = (n, c, x) => { c ? ok++ : bad++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + String(JSON.stringify(x)).slice(0, 200))); };
const form = (players, losses = {}, ratus = {}, ribu = {}, notes = '') => ({ players, losses, ratus, ribu, notes });

await start();
// ---- login
let r = await fetch(B + '/api/state'); t('tanpa login: state ditolak 401', r.status === 401);
r = await post('/api/command', { command: 'add_player', payload: { name: 'X' }, client_id: 'x' }); t('tanpa login: perintah ditolak 401', r.http === 401 && r.code === 'AUTH', r);
if (TARGET === 'node') t('halaman statis tetap terbuka (untuk layar login)', (await fetch(B + '/')).status === 200 && (await fetch(B + '/app.js')).status === 200);
r = await login('9999'); t('PIN salah ditolak', r.http === 401 && r.code === 'BAD_PIN', r);
r = await login('1'); t('PIN terlalu pendek ditolak', r.http === 401, r);
const tk = {};
for (const [k, pin, nm] of [['A','0001','Andi'],['B','0002','Budi'],['C','0003','Candra'],['D','0004','Dedi'],['E','0005','Eko'],['F','0006','Fajar'],['G','0007','Gilang']]) {
  const x = await login(pin); tk[k] = x.token; t(`PIN ${pin} -> ${nm}`, x.ok && x.player.name === nm && x.player.player_id === 'PL0' + pin.slice(-1), x);
}
let s = await state(tk.A);
t('state memuat identitas pemain yang login', s.me && s.me.name === 'Andi' && s.me.pin_custom === false);
t('state tak membocorkan rahasia', !/"secret"|"auth"|created_by_player|proposer_player_id|"h":/.test(JSON.stringify(s)));

// ---- identitas dari sesi, bukan dari klien
r = await cmd(tk.A, 'add_match', { session_id: 'SES004', ...form(['PL01','PL02','PL03','PL04'], { PL02: 1 }) });
s = await state(tk.A);
t('pencatat = pemain yang login (klien tak bisa memalsukan)', r.ok && s.audit_log[0].actor === 'Andi' && !JSON.stringify(s.audit_log).includes('Peretas'), s.audit_log[0]);
const mine = r.data.match_id;

// ---- serentak
const rs = await Promise.all(['A','B','C','D','E'].map(k => cmd(tk[k], 'add_match', { session_id: 'SES004', ...form(['PL01','PL02','PL03','PL04']) })));
const ids = rs.map(x => x.data && x.data.match_id);
t('5 pemain input serentak -> ID unik', rs.every(x => x.ok) && new Set(ids).size === 5, ids);

// ---- koreksi cepat berdasar pemain
r = await cmd(tk.A, 'edit_match', { match_id: mine, ...form(['PL01','PL02','PL03','PL05'], { PL05: 2 }) }, { mode: 'direct' });
t('pembuat boleh koreksi langsung', r.ok, r);
r = await cmd(tk.B, 'edit_match', { match_id: mine, ...form(['PL01','PL02','PL03','PL04']) }, { mode: 'direct' });
t('pemain lain tidak boleh langsung', !r.ok && r.code === 'NEEDS_APPROVAL', r);
s = await state(tk.A); t('masa koreksi terlihat hanya oleh pembuat', s.matches.find(m => m.match_id === mine).grace_left_ms > 0 && !(await state(tk.B)).matches.find(m => m.match_id === mine).grace_left_ms);

// ---- 1 pengesah cukup
r = await cmd(tk.B, 'edit_match', { match_id: 'M001', ...form(['PL01','PL02','PL03','PL04'], { PL01: 3 }, {}, {}, 'koreksi') }, { mode: 'propose' });
const pr = r.data.proposal_id; t('usulan dibuat Budi', r.ok && pr, r);
s = await state(tk.B); const prop = s.proposals.find(p => p.id === pr);
t('usulan: butuh 1 pengesah, pengusul tak termasuk', prop.required === 1 && !prop.eligible.some(e => e.player_id === 'PL02') && prop.eligible.length === 3 && prop.mine === true, prop);
t('config melaporkan 1 pengesah', s.config.approvals_required === 1);
r = await cmd(tk.B, 'vote', { proposal_id: pr, vote: 'approve' }); t('pengusul tak bisa mengesahkan sendiri', !r.ok && r.code === 'SELF_VOTE', r);
r = await cmd(tk.E, 'vote', { proposal_id: pr, vote: 'approve' }); t('bukan pemain game itu ditolak', !r.ok && r.code === 'NOT_ELIGIBLE', r);
s = await state(tk.A); t('usulan belum mengubah data', !s.loss_events.some(l => l.match_id === 'M001' && l.player_id === 'PL01'));
r = await cmd(tk.A, 'vote', { proposal_id: pr, vote: 'approve' });
t('satu pengesah -> langsung berlaku', r.ok && r.data.status === 'applied', r);
s = await state(tk.A);
t('data berubah & riwayat mencatat pengesah', s.loss_events.some(l => l.match_id === 'M001' && l.player_id === 'PL01' && l.loss_count === 3) && s.audit_log[0].mode === 'approved' && s.audit_log[0].summary.includes('Andi'), s.audit_log[0]);

// ---- pengusul bukan pemain game itu
r = await cmd(tk.G, 'edit_match', { match_id: 'M002', ...form(['PL01','PL02','PL05','PL06'], { PL06: 1 }) }, { mode: 'propose' });
s = await state(tk.G); const p2 = s.proposals.find(p => p.id === r.data.proposal_id);
t('pengusul di luar game: 4 pemain berhak', p2.eligible.length === 4);
r = await cmd(tk.G, 'vote', { proposal_id: p2.id, vote: 'approve' }); t('pengusul tetap tak bisa mengesahkan', r.code === 'SELF_VOTE', r);
r = await cmd(tk.F, 'vote', { proposal_id: p2.id, vote: 'approve' }); t('pemain game itu mengesahkan', r.ok && r.data.status === 'applied', r);

// ---- tolak
r = await cmd(tk.B, 'delete_match', { match_id: 'M007' }, { mode: 'propose' });
r = await cmd(tk.C, 'vote', { proposal_id: r.data.proposal_id, vote: 'reject' });
t('satu penolakan membatalkan', r.ok && r.data.status === 'rejected' && (await state(tk.A)).matches.some(m => m.match_id === 'M007'), r);

// ---- basi
r = await cmd(tk.B, 'edit_match', { match_id: 'M010', ...form(['PL02','PL03','PL04','PL05'], { PL02: 5 }) }, { mode: 'propose' });
const pr4 = r.data.proposal_id;
r = await cmd(tk.B, 'edit_match', { match_id: 'M010', ...form(['PL02','PL03','PL04','PL05'], { PL03: 1 }) }, { mode: 'force', password: 'CURANGDOSA', reason: 'tes basi' });
t('paksa dengan kata sandi benar', r.ok, r);
r = await cmd(tk.D, 'vote', { proposal_id: pr4, vote: 'approve' }); t('usulan basi tidak menimpa', r.ok && r.data.status === 'stale', r);

// ---- paksa & undo
r = await cmd(tk.B, 'delete_match', { match_id: 'M011' }, { mode: 'force', password: 'salah', reason: 'tes' }); t('kata sandi salah ditolak', r.code === 'BAD_PASSWORD', r);
r = await cmd(tk.B, 'delete_match', { match_id: 'M011' }, { mode: 'force', password: 'CURANGDOSA', reason: 'tes hapus' });
s = await state(tk.A); const en = s.audit_log.find(a => a.action === 'delete_match');
t('hapus paksa tercatat PAKSA + alasan', r.ok && en.mode === 'force' && en.reason === 'tes hapus' && en.actor === 'Budi', en);
r = await cmd(tk.B, 'restore_match', { record: en.details.before_record }, { mode: 'force', password: 'CURANGDOSA', reason: 'undo' });
t('pulihkan (undo) game', r.ok && (await state(tk.A)).matches.some(m => m.match_id === 'M011'), r);

// ---- tambah pemain & PIN bawaan
r = await cmd(tk.A, 'add_player', { name: 'Kiki' });
t('pemain baru dapat PIN bawaan dari ID-nya', r.ok && r.data.player_id === 'PL11' && r.data.default_pin === '0011', r);
r = await login('0011'); t('pemain baru bisa login dengan PIN bawaan', r.ok && r.player.name === 'Kiki', r);

// ---- ganti PIN
r = await cmd(tk.A, 'change_pin', { current_pin: '1111', new_pin: '123456' }); t('ganti PIN: PIN lama salah ditolak', r.code === 'BAD_PIN', r);
r = await cmd(tk.A, 'change_pin', { current_pin: '0001', new_pin: '1234' }); t('PIN baru 4 angka ditolak (khusus bawaan)', r.code === 'BAD_NEW_PIN', r);
r = await cmd(tk.A, 'change_pin', { current_pin: '0001', new_pin: '123456' }); t('ganti PIN berhasil', r.ok, r);
r = await login('0001'); t('PIN bawaan tak berlaku lagi setelah diganti', r.http === 401, r);
r = await login('123456'); t('PIN baru dipakai login', r.ok && r.player.name === 'Andi', r);
r = await cmd(tk.B, 'change_pin', { current_pin: '0002', new_pin: '123456' }); t('PIN sama dengan pemain lain ditolak', r.code === 'PIN_TAKEN', r);
r = await cmd(tk.B, 'reset_pin', { player_id: 'PL01' }); t('reset PIN tanpa kata sandi ditolak', r.code === 'BAD_MODE', r);
r = await cmd(tk.B, 'reset_pin', { player_id: 'PL01' }, { mode: 'force', password: 'CURANGDOSA', reason: 'lupa PIN' });
t('reset PIN dengan kata sandi paksa', r.ok && r.data.default_pin === '0001', r);
r = await login('0001'); t('PIN bawaan kembali berlaku', r.ok, r);

// ---- keluar
const tkOut = (await login('0003')).token;
await post('/api/logout', {}, tkOut);
r = await fetch(B + '/api/state', { headers: { 'X-Session': tkOut } }); t('keluar membatalkan sesi', r.status === 401);

// ---- FINAL, season
r = await cmd(tk.B, 'finalize_season', { season_id: 'SSN-2026-S2' }); t('finalisasi tanpa FINAL ditolak', r.code === 'NEED_FINAL', r);
r = await cmd(tk.B, 'finalize_season', { season_id: 'SSN-2026-S2' }, { confirm: 'final' }); t('finalisasi dengan FINAL', r.ok, r);
r = await cmd(tk.A, 'add_match', { session_id: 'SES004', ...form(['PL01','PL02','PL03','PL04']) }); t('season terkunci menolak input', r.code === 'SEASON_LOCKED', r);
r = await cmd(tk.B, 'create_season', { name: 'Season 3', start: '2026-12-01' }); t('season baru', r.ok, r);
r = await cmd(tk.B, 'update_settings', { settings: { min_games_champion: 5 } }); t('pengaturan tanpa FINAL ditolak', r.code === 'NEED_FINAL', r);
r = await cmd(tk.B, 'update_settings', { settings: { sheets_webhook_url: 'https://evil.example.com/x' } }, { confirm: 'FINAL' }); t('webhook non-Google ditolak', r.code === 'BAD_WEBHOOK', r);
r = await cmd(tk.B, 'update_settings', { settings: { sheets_webhook_url: 'https://script.google.com/macros/s/RAHASIA123/exec' } }, { confirm: 'FINAL' });
s = await state(tk.B); t('URL webhook tidak bocor', r.ok && !JSON.stringify(s).includes('RAHASIA123') && s.settings.sheets_webhook_set);

// ---- impor data lama: sesi pemain yang tak ada lagi gugur
r = await cmd(tk.B, 'import_legacy', { state: { players: [{ player_id: 'PL01', display_name: 'Lama', is_active: true }], matches: [], seasons: [{ season_id: 'S1', season_name: 'Lama', status: 'active' }], sessions: [] } }, { confirm: 'FINAL' });
t('impor data lama', r.http === 401 || r.ok, r);
r = await fetch(B + '/api/state', { headers: { 'X-Session': tk.B } }); t('sesi pemain yang hilang dibatalkan', r.status === 401);
r = await fetch(B + '/api/state', { headers: { 'X-Session': tk.A } }); const sa = await r.json();
t('sesi pemain yang masih ada tetap berlaku (PIN dikembalikan ke bawaan)', r.status === 200 && sa.players.length === 1 && sa.me.pin_custom === false, sa.me);

// ---- persistensi
const revNow = sa.rev;
r = await login('0001'); const tkAfter0 = r.token;
r = await cmd(tkAfter0, 'change_pin', { current_pin: '0001', new_pin: '654321' });
await stop(); await start();
r = await fetch(B + '/api/state', { headers: { 'X-Session': tkAfter0 } });
if (TARGET === 'node') t('restart server -> login ulang (sesi di memori)', r.status === 401);
else t('restart fungsi -> sesi tetap berlaku (sesi di database)', r.status === 200);
r = await login('654321'); t('PIN sendiri bertahan setelah restart', r.ok && r.player.name === 'Lama', r);
s = await state(r.token); t('data bertahan setelah restart', s.rev >= revNow && s.players[0].display_name === 'Lama');

// ---- keamanan file
if (TARGET === 'node') {
  t('database.json tidak bisa diunduh', (await fetch(B + '/database.json')).status === 404);
  t('traversal ditolak', (await fetch(B + '/..%2fserver.cjs')).status === 404);
}
t('endpoint lama /api/data hilang', (await fetch(B + '/api/data')).status === 404);

// ---- kunci login (terakhir)
let codes = []; for (let i = 0; i < 14; i++) { codes.push((await login('99' + String(i).padStart(2, '0'))).code); }
t('login dikunci setelah banyak PIN salah', codes.slice(0, 12).every(c => c === 'BAD_PIN') && codes[12] === 'LOCKED', codes);
r = await login('654321'); t('selama dikunci, PIN benar pun ditolak sementara', r.code === 'LOCKED', r);

console.log(`\n${ok} lulus, ${bad} gagal`);
await stop(); T.kill(); fs.rmSync(DIR, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
