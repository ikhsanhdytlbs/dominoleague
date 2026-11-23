import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { target, ROOT } from './helpers.mjs';
import { calculateDailyMVP, pickMvpDate, matchDay } from '../dominoLogic.js';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dlc3-'));
const T = target({ port: 4800, dataDir: DIR });
await T.start();
const B = T.base;
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(String(u).startsWith('/') ? B + u : u, o);
const els = {}; const inputs = {};
const mk = id => els[id] ||= { id, value:'', innerHTML:'', innerText:'', textContent:'', className:'', classList:{ _h:false, add(c){ if(c==='hidden') this._h=true }, remove(c){ if(c==='hidden') this._h=false }, contains(c){ return c==='hidden' && this._h } }, addEventListener(){}, querySelectorAll(){return []}, focus(){}, checked:false };
globalThis.document = { getElementById: id => (id in inputs ? inputs[id] : mk(id)), querySelectorAll: () => [], addEventListener(){}, createElement: () => ({click(){}}), body: { appendChild(){}, removeChild(){} }, visibilityState: 'visible', activeElement: null };
globalThis.window = { addEventListener(){} };
const mkStore = () => { const s = {}; return { getItem: k => s[k] ?? null, setItem: (k,v) => { s[k] = String(v) }, removeItem: k => { delete s[k] }, _s: s }; };
globalThis.localStorage = mkStore(); globalThis.sessionStorage = mkStore();
let alerts = [], confirms = []; globalThis.alert = m => alerts.push(String(m)); globalThis.confirm = m => { confirms.push(String(m)); return true; };
globalThis.setInterval = () => 0;
await import(pathToFileURL(path.join(ROOT, 'app.js')).href);
await new Promise(r => setTimeout(r, 300));
const app = window.app;
let ok = 0, bad = 0;
const t = (n, c, x) => { c ? ok++ : bad++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + String(JSON.stringify(x)).slice(0, 240))); };
const ev = { preventDefault(){} };
const modal = () => els['modal-host'].innerHTML;
const typePin = async pin => { app._pin = ''; for (const d of pin) app.pinKey(d); await app.submitLogin(); };
function fill(players, loss = {}, s100 = {}, s1000 = {}) {
  Object.keys(inputs).forEach(k => delete inputs[k]);
  players.forEach((p, i) => inputs[`match-player-${i+1}`] = { value: p });
  inputs['match-notes'] = { value: '' }; inputs['btn-submit-match'] = { disabled: false, innerHTML: '' };
  players.forEach(p => { inputs[`loss-${p}`] = { value: String(loss[p]||0) }; inputs[`s100-${p}`] = { value: String(s100[p]||0) }; inputs[`s1000-${p}`] = { value: String(s1000[p]||0) }; });
}
const dash = () => { app.state.current_tab = 'dashboard'; app.renderDashboard(); return els['view-dashboard'].innerHTML; };

// ---- chip akun
t('sebelum login chip netral', els['account-name'] === undefined || els['account-name'].textContent !== 'Admin Gaple');
await typePin('0001');
t('chip kanan atas: nama pemain yang login, bukan "Admin Gaple"', els['account-name'].textContent === 'Andi' && els['account-avatar'].textContent === 'AN' && els['account-sub'].textContent === 'Pemain · PL01', [els['account-name'].textContent, els['account-avatar'].textContent, els['account-sub'].textContent]);
app.state.me = { ...app.state.me, name: 'Andi Pratama' }; app.updateAccountBadge();
t('inisial dari dua kata nama', els['account-avatar'].textContent === 'AP');
app.state.me = { ...app.state.me, name: 'Andi' }; app.updateAccountBadge();
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
t('index.html: tidak ada lagi teks tetap "Admin Gaple"; chip bisa diklik membuka akun', !html.includes('Admin Gaple') && html.includes('id="account-chip"') && html.includes('openAccountModal()'));

// ---- dashboard: kartu MVP menggantikan Achievements
let d = dash();
t('Achievements hilang, kartu MVP muncul dengan karakter beranimasi', !d.includes('Achievements') && d.includes('MVP') && d.includes('mvp-char') && d.includes('mvp-arm-l') && d.includes('mvp-conf') && d.includes('mvp-crown'));
const sid = app.state.current_season_id;
const date = pickMvpDate(app.state.matches.filter(m => m.season_id === sid).map(m => matchDay(m, app.state.sessions)), app.state.today);
const exp = calculateDailyMVP(sid, date, app.state.players, app.state.matches, app.state.sessions, app.state.loss_events, app.state.special_events, 3);
t('data demo: hari terakhir bukan hari ini -> judul memakai tanggal & jujur soal itu', date === '2026-07-26' && d.includes('MVP 26 Jul 2026') && d.includes('Belum ada game hari ini'), d.match(/MVP [^<]{0,30}/));
t('nama MVP di kartu = hasil hitungan logika', exp.mvp && d.includes(`>${exp.mvp.display_name}<`) && d.includes(`Ratus ${exp.mvp.ratus}`) && d.includes(`Ribu ${exp.mvp.ribu}`) && d.includes(`Kalah ${exp.mvp.loss}`), exp.mvp);
t('kartu lain di dashboard tetap ada (Musim Aktif)', d.includes('Musim Aktif') && d.includes('Anggota Terdaftar'));

// ---- tambah game hari ini -> "MVP Hari Ini"
const ses = app.state.sessions.find(s => s.status === 'active');
for (const [pl, loss, r100, r1000] of [[['PL05','PL06','PL07','PL08'], { PL08: 1 }, { PL05: 2 }, { PL05: 1 }], [['PL05','PL06','PL07','PL08'], { PL08: 1 }, { PL05: 1 }, {}], [['PL05','PL06','PL07','PL09'], { PL09: 1 }, {}, {}]]) {
  fill(pl, loss, r100, r1000); await app.handleSaveMatch(ev, ses.session_id);
}
d = dash();
t('ada game hari ini: judul "MVP Hari Ini"', d.includes('MVP Hari Ini') && d.includes('3 game dimainkan hari ini') && !d.includes('Belum ada game hari ini'), d.match(/MVP[^<]{0,40}/g));
t('MVP hari ini = Eko (PL05: Ratus & Ribu, tak pernah kalah)', d.includes('>Eko<') && d.includes('Ratus 3') && d.includes('Ribu 1') && d.includes('Kalah 0'), d.match(/Ratus \d|Ribu \d|Kalah \d|>[A-Za-z]+<\/p>/g));
t('nama aman dari HTML', !dash().includes('<script'));
// nama berbahaya tidak lolos
const nm = app.state.players.find(p => p.player_id === 'PL05'); const keep = nm.display_name; nm.display_name = '<img src=x onerror=1>';
const card = app.mvpCardHtml(); t('nama pemain di kartu MVP di-escape', !card.includes('<img src=x') && card.includes('&lt;img')); nm.display_name = keep;

// ---- season baru kosong: karakter tidur
app.askFinal = async () => true;
await app.executeFinalizeSeason();
inputs['new-season-name'] = { value: 'Season 3' }; inputs['new-season-start'] = { value: app.state.today }; await app.handleCreateSeason(ev);
d = dash();
t('season tanpa game: karakter tertidur & ajakan input', d.includes('mvp-idle') && d.includes('Belum ada game di season ini') && !d.includes('mvp-conf') && d.includes('mvp-zzz'));

// ---- kelola sesi (di season baru yang aktif)
inputs['new-ses-date'] = { value: app.state.today }; inputs['new-ses-label'] = { value: 'Sesi <b>Uji</b>' }; inputs['new-ses-notes'] = { value: 'catatan "awal" <script>' };
await app.handleCreateSession(ev);
const s1 = app.state.sessions.at(-1);
app.state.current_tab = 'input-game'; app.renderInputGame();
let ig = els['view-input-game'].innerHTML;
t('kartu sesi punya tombol edit & hapus', ig.includes(`openEditSessionModal('${s1.session_id}')`) && ig.includes(`deleteSession('${s1.session_id}')`));
t('server membersihkan tag HTML dari nama & catatan sesi', !ig.includes('<b>Uji</b>') && !ig.includes('<script>') && ig.includes('Sesi bUji/b') && s1.session_label === 'Sesi bUji/b' && !s1.notes.includes('<') && !s1.notes.includes('"'), s1);
app.openEditSessionModal(s1.session_id);
t('modal edit terisi nilai sekarang', modal().includes('Ubah Sesi') && modal().includes('value="Sesi bUji/b"') && modal().includes('catatan awal script'), modal().match(/edit-ses-label[^>]*>/));
inputs['edit-ses-label'] = { value: '  ' }; inputs['edit-ses-date'] = { value: app.state.today }; inputs['edit-ses-notes'] = { value: '' };
alerts = []; await app.handleEditSession(ev, s1.session_id);
t('nama kosong ditolak di klien', alerts.some(a => a.includes('wajib')) && app.state.sessions.find(s => s.session_id === s1.session_id).session_label.includes('Uji'));
inputs['edit-ses-label'] = { value: 'Malam Minggu Warkop' }; inputs['edit-ses-notes'] = { value: 'Keterangan baru' };
await app.handleEditSession(ev, s1.session_id);
const e1 = app.state.sessions.find(s => s.session_id === s1.session_id);
t('rename & keterangan tersimpan di server', e1.session_label === 'Malam Minggu Warkop' && e1.notes === 'Keterangan baru');
app.state.current_tab = 'history'; app.renderHistory();
t('Riwayat menampilkan perubahan sesi', els['view-history'].innerHTML.includes('mengubah sesi') && els['view-history'].innerHTML.includes('Malam Minggu Warkop'));

// hapus sesi kosong
confirms = []; await app.deleteSession(s1.session_id);
t('hapus sesi kosong: konfirmasi lalu hilang', confirms[0].includes('belum memiliki game') && !app.state.sessions.some(s => s.session_id === s1.session_id));

// hapus sesi berisi game: wajib paksa (pakai sesi di season terkunci tak bisa; buat baru)
inputs['new-ses-label'] = { value: 'Sesi Berisi' }; inputs['new-ses-notes'] = { value: '' }; await app.handleCreateSession(ev);
const s2 = app.state.sessions.at(-1);
fill(['PL01','PL02','PL03','PL04'], { PL02: 1 }); await app.handleSaveMatch(ev, s2.session_id);
await app.deleteSession(s2.session_id);
t('sesi berisi game: modal paksa menjelaskan SEMUA game ikut dihapus, tanpa opsi usulan', modal().includes('SEMUA 1 game') && modal().includes('Paksa:') && !modal().includes('Ajukan persetujuan') && modal().includes('>Batal<'), modal().slice(0, 200));
inputs['force-password'] = { value: 'salah' }; inputs['force-reason'] = { value: 'tes hapus' }; inputs['force-msg'] = { textContent: '' };
await app.submitForce(ev);
t('kata sandi salah: pesan inline, sesi utuh', inputs['force-msg'].textContent.includes('salah') && app.state.sessions.some(s => s.session_id === s2.session_id));
inputs['force-password'] = { value: 'CURANGDOSA' }; await app.submitForce(ev);
t('paksa benar: sesi & game terhapus, riwayat PAKSA', !app.state.sessions.some(s => s.session_id === s2.session_id) && !app.state.matches.some(m => m.session_id === s2.session_id) && app.state.audit_log[0].mode === 'force' && app.state.audit_log[0].action === 'delete_session');

// tanpa kata sandi paksa di server: pesan alternatif
const keepCfg = app.state.config;
fill(['PL01','PL02','PL03','PL04']); inputs['new-ses-label'] = { value: 'Sesi Lagi' }; await app.handleCreateSession(ev);
const s3 = app.state.sessions.at(-1); fill(['PL01','PL02','PL03','PL04']); await app.handleSaveMatch(ev, s3.session_id);
app.state.config = { ...keepCfg, force_enabled: false }; alerts = []; const n3 = app.state.matches.filter(m => m.session_id === s3.session_id).length; await app.deleteSession(s3.session_id);
t('paksa nonaktif: pesan arahkan hapus game dulu', alerts.length && alerts.at(-1).includes('berisi 1 game') && alerts.at(-1).includes('pengesahan'), { n3, alerts, sessions: app.state.sessions.map(x => [x.session_id, x.season_id, x.status]), cur: app.state.current_season_id });
app.state.config = keepCfg;

// ---- season terkunci menyembunyikan tombol
await app.executeFinalizeSeason();
app.state.current_tab = 'input-game'; app.renderInputGame();
ig = els['view-input-game'].innerHTML;
t('season terkunci: tombol edit/hapus sesi tidak tampil', !ig.includes('openEditSessionModal') && !ig.includes('deleteSession'));
let err = null; try { for (const tab of ['dashboard','input-game','players','stats','h2h','awards','archive','history','settings']) app.switchTab(tab); } catch (e) { err = e; }
t('semua tab render' + (err ? ': ' + err.message : ''), !err);

// ---- alamat API (server sendiri vs Supabase) ----
t('tanpa config: API di server yang sama (/api)', !app.remoteApi() && app.apiUrl('state', 'rev=3') === '/api/state?rev=3' && app.apiUrl('login') === '/api/login');
window.DOMINO_CONFIG = { API_URL: 'https://abc.supabase.co/functions/v1/api/' };
t('dengan config: API di alamat Supabase (garis miring akhir dibuang)', app.remoteApi() && app.apiUrl('state', 'rev=3') === 'https://abc.supabase.co/functions/v1/api/state?rev=3' && app.apiUrl('command') === 'https://abc.supabase.co/functions/v1/api/command');
t('pesan diagnosis menyebut API_URL, bukan "npm start"', app.describeBadReply({ status: 404 }).includes('API_URL') && !app.describeBadReply({ status: 404 }).includes('npm start'));
delete window.DOMINO_CONFIG;
t('kembali ke server sendiri saat config dihapus', !app.remoteApi());

// ---- cadangan data: unduh & pulihkan ----
app.state.config = { ...app.state.config, force_enabled: true };
app.state.current_tab = 'settings'; app.renderSettings();
t('Pengaturan punya kartu Cadangan Data', els['view-settings'].innerHTML.includes('Cadangan Data') && els['view-settings'].innerHTML.includes('downloadBackup') && els['view-settings'].innerHTML.includes('importBackupFile'));
let saved = null; app.saveJsonFile = obj => { saved = obj; };
app.downloadBackup();
t('unduh cadangan meminta kata sandi paksa', modal().includes('Paksa:') && modal().includes('tanpa PIN pemain') && modal().includes('>Batal<'));
inputs['force-password'] = { value: 'salah' }; inputs['force-reason'] = { value: 'cadangan rutin' }; inputs['force-msg'] = { textContent: '' };
await app.submitForce(ev);
t('kata sandi salah: tidak ada file', saved === null && inputs['force-msg'].textContent.includes('salah'));
inputs['force-password'] = { value: 'CURANGDOSA' }; await app.submitForce(ev);
t('cadangan terunduh: lengkap, tanpa rahasia PIN', saved && Array.isArray(saved.players) && saved.matches.length > 0 && Array.isArray(saved.audit_log) && !('auth' in saved) && !JSON.stringify(saved).includes('"secret"'), saved && Object.keys(saved));
t('riwayat mencatat unduhan cadangan', app.state.audit_log[0].action === 'export_all' && app.state.audit_log[0].mode === 'force' && app.state.audit_log[0].reason === 'cadangan rutin');

const backup = JSON.parse(JSON.stringify(saved));
const nPlayersBefore = app.state.players.length, nMatchesBefore = app.state.matches.length;
await app.cmd('add_player', { name: 'Tamu Baru' });
t('ada perubahan setelah cadangan dibuat', app.state.players.length === nPlayersBefore + 1);
alerts = [];
await app.importBackupFile({ files: [{ text: async () => 'bukan json' }], value: 'x' });
t('file bukan JSON ditolak', alerts.at(-1).includes('bukan cadangan'));
await app.importBackupFile({ files: [{ text: async () => JSON.stringify({ players: [] }) }], value: 'x' });
t('JSON asing ditolak', alerts.at(-1).includes('bukan cadangan'));
const askedBefore = app.askFinal; let askedWith = ''; app.askFinal = async (title, desc) => { askedWith = desc; return true; };
await app.importBackupFile({ files: [{ text: async () => JSON.stringify(backup) }], value: 'x' });
t('pulihkan: meminta FINAL dan menyebut jumlah data', askedWith.includes(`${backup.players.length} pemain`) && askedWith.includes('PIN'));
t('data kembali ke isi cadangan (pemain baru hilang), game utuh', app.state.players.length === nPlayersBefore && app.state.matches.length === nMatchesBefore && !app.state.players.some(p => p.display_name === 'Tamu Baru'));
t('riwayat tetap ada setelah pulihkan', app.state.audit_log.some(a => a.action === 'import_legacy'));
app.askFinal = askedBefore;

await app.logout();
t('keluar: chip kembali netral', els['account-name'].textContent === 'Belum masuk' && els['account-avatar'].textContent === '?');

console.log(`\n${ok} lulus, ${bad} gagal`);
T.kill(); fs.rmSync(DIR, { recursive: true, force: true }); process.exit(bad ? 1 : 0);
