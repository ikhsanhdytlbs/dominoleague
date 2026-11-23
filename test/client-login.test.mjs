import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { target, ROOT } from './helpers.mjs';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dlc2-'));
const T = target({ port: 4600, dataDir: DIR });
await T.start();
const B = T.base;
const realFetch = globalThis.fetch;
let mode = 'online'; // online | offline | oldserver
globalThis.fetch = (u, o) => {
  if (mode === 'offline') return Promise.reject(new Error('offline'));
  if (mode === 'oldserver') return Promise.resolve(new Response('404 Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } }));
  return realFetch(String(u).startsWith('/') ? B + u : u, o);
};
const els = {}; const inputs = {};
const mk = id => els[id] ||= { id, value:'', innerHTML:'', innerText:'', textContent:'', className:'', classList:{ _h:false, add(c){ if(c==='hidden') this._h=true }, remove(c){ if(c==='hidden') this._h=false }, contains(c){ return c==='hidden' && this._h } }, addEventListener(){}, querySelectorAll(){return []}, focus(){}, checked:false };
els['login-overlay'] = mk('login-overlay');
globalThis.document = { getElementById: id => (id in inputs ? inputs[id] : mk(id)), querySelectorAll: () => [], addEventListener(){}, createElement: () => ({click(){}}), body: { appendChild(){}, removeChild(){} }, visibilityState: 'visible', activeElement: null };
globalThis.window = { addEventListener(){} };
const mkStore = () => { const s = {}; return { getItem: k => s[k] ?? null, setItem: (k,v) => { s[k] = String(v) }, removeItem: k => { delete s[k] }, _s: s }; };
globalThis.localStorage = mkStore(); globalThis.sessionStorage = mkStore();
let alerts = []; globalThis.alert = m => alerts.push(String(m)); globalThis.confirm = () => true;
globalThis.setInterval = () => 0;
await import(pathToFileURL(path.join(ROOT, 'app.js')).href);
await new Promise(r => setTimeout(r, 300));
const app = window.app;
let ok = 0, bad = 0;
const t = (n, c, x) => { c ? ok++ : bad++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + String(JSON.stringify(x)).slice(0, 220))); };
const ev = { preventDefault(){} };
const modal = () => els['modal-host'].innerHTML;
const raw = async (p, body, tk) => (await realFetch(B + p, { method:'POST', headers:{'Content-Type':'application/json', ...(tk?{Authorization:'Bearer '+tk}:{})}, body: JSON.stringify(body||{}) })).json();
const typePin = async (pin) => { app._pin = ''; for (const d of pin) app.pinKey(d); await app.submitLogin(); };
function fill(players, loss = {}, s100 = {}, s1000 = {}, notes = '') {
  Object.keys(inputs).forEach(k => delete inputs[k]);
  players.forEach((p, i) => inputs[`match-player-${i+1}`] = { value: p });
  inputs['match-notes'] = { value: notes }; inputs['btn-submit-match'] = { disabled: false, innerHTML: '' };
  players.forEach(p => { inputs[`loss-${p}`] = { value: String(loss[p]||0) }; inputs[`s100-${p}`] = { value: String(s100[p]||0) }; inputs[`s1000-${p}`] = { value: String(s1000[p]||0) }; });
}

// ---- login
t('tanpa sesi: layar PIN tampil', !els['login-overlay'].classList.contains('hidden') && els['login-overlay'].innerHTML.includes('Masukkan PIN') && els['login-overlay'].innerHTML.includes('Lupa?'));
t('belum login: data tidak dimuat', app.state.rev === null && app.state.matches.length === 0);
app.pinKey('1'); app.pinKey('2'); t('titik PIN bertambah', (els['pin-dots'].innerHTML.match(/bg-domino-red/g) || []).length === 2);
app.pinBack(); t('hapus mengurangi titik', (els['pin-dots'].innerHTML.match(/bg-domino-red/g) || []).length === 1);
await typePin('9999');
t('PIN salah: pesan & PIN dikosongkan', els['login-msg'].textContent.includes('tidak dikenal') && app._pin === '' && !app.token, els['login-msg']);
app._pin = '12'; await app.submitLogin(); t('PIN < 4 angka ditolak', els['login-msg'].textContent.includes('minimal 4'));
app.pinForgot(); t('"Lupa?" menjelaskan PIN bawaan', alerts.at(-1).includes('PL01 = 0001'));
await typePin('0001');
t('login berhasil: token tersimpan hanya untuk tab ini', !!app.token && sessionStorage._s.domino_token === app.token && !localStorage._s.domino_token);
t('layar PIN tertutup & data dimuat', els['login-overlay'].classList.contains('hidden') && app.state.matches.length === 21 && app.state.me.name === 'Andi');
t('lencana akun menampilkan nama', els['actor-badge'].textContent.includes('Andi'));

// ---- game
fill(['PL01','PL02','PL03','PL04'], { PL02: 1 }, { PL01: 2 });
await app.handleSaveMatch(ev, 'SES004');
t('game baru atas nama pemain yang login', app.state.matches.at(-1).match_id === 'M022' && app.state.audit_log[0].actor === 'Andi', app.state.audit_log[0]);
app.openInputMatchModal('SES004', 'M022'); fill(['PL01','PL02','PL03','PL05'], { PL05: 2 });
await app.handleSaveMatch(ev, 'SES004', 'M022');
t('koreksi cepat oleh pembuat', app.state.matches.find(m => m.match_id === 'M022').players.includes('PL05'));

// ---- usulan & pengesahan 1 orang
app.openInputMatchModal('SES001', 'M001');
t('game lama: info perlu pengesahan', modal().includes('sudah lewat masa koreksi cepat'));
fill(['PL01','PL02','PL03','PL04'], { PL01: 3 }, {}, {}, 'koreksi');
await app.handleSaveMatch(ev, 'SES001', 'M001');
t('pilihan ajukan / paksa muncul (angka dinamis 1)', modal().includes('Ajukan persetujuan') && modal().includes('setelah 1 pemain lain') && modal().includes('Paksa dengan kata sandi'));
await app.submitProposal();
const pr = app.state.proposals.find(p => p.status === 'pending');
t('usulan tercatat, eligible 3 (pengusul tak termasuk)', pr && pr.mine && pr.required === 1 && pr.eligible.length === 3 && !pr.eligible.some(e => e.player_id === 'PL01'), pr);
app.state.current_tab = 'input-game'; app.renderInputGame();
const panel = els['view-input-game'].innerHTML;
t('panel: pengusul tak melihat tombol Sahkan, melihat petunjuk', panel.includes('Menunggu Persetujuan') && !panel.includes('openVoteModal') && panel.includes('Anda pengusul'));

// pemain lain login di perangkat lain & mengesahkan
const hpC = await raw('/api/login', { pin: '0003' });
const rv = await raw('/api/command', { command: 'vote', payload: { proposal_id: pr.id, vote: 'approve' } }, hpC.token);
t('Candra (HP lain) mengesahkan -> langsung berlaku', rv.ok && rv.data.status === 'applied', rv);
await app.loadState();
t('klien Andi melihat perubahan berlaku', app.state.loss_events.some(l => l.match_id === 'M001' && l.player_id === 'PL01' && l.loss_count === 3));

// pemain tak terkait melihat tombol sesuai haknya
await raw('/api/command', { command: 'edit_match', payload: { match_id: 'M002', players: ['PL01','PL02','PL05','PL06'], notes: '', losses: { PL06: 1 }, ratus: {}, ribu: {} }, mode: 'propose' }, hpC.token);
await app.loadState(true);
app.renderInputGame();
t('Andi (pemain di M002) melihat tombol Sahkan/Tolak', els['view-input-game'].innerHTML.includes("openVoteModal('PR002','approve')"));
app.openVoteModal('PR002', 'approve');
t('modal suara tanpa PIN, atas nama login', modal().includes('Sahkan perubahan') && modal().includes('Andi') && !modal().includes('vote-pin'));
await app.submitVote();
t('Andi mengesahkan -> diterapkan', app.state.proposals.find(p => p.id === 'PR002').status === 'applied');

// ---- paksa & riwayat
await app.deleteMatch('M005');
app.openForceModal();
inputs['force-password'] = { value: 'CURANGDOSA' }; inputs['force-reason'] = { value: 'salah catat' }; inputs['force-msg'] = { textContent: '' };
await app.submitForce(ev);
t('hapus paksa berhasil', !app.state.matches.some(m => m.match_id === 'M005'));
app.state.current_tab = 'history'; app.renderHistory();
const hh = els['view-history'].innerHTML;
t('riwayat: PAKSA, alasan, DISAHKAN/nama', hh.includes('PAKSA') && hh.includes('salah catat') && hh.includes('Andi'));

// ---- akun: ubah PIN, keluar, masuk lagi
app.openAccountModal();
t('modal akun menyarankan ganti PIN bawaan', modal().includes('PIN bawaan') && modal().includes('Keluar'));
app.openChangePinModal();
inputs['pin-current'] = { value: '0001' }; inputs['pin-new'] = { value: '1234' }; inputs['pin-new2'] = { value: '1234' }; inputs['pin-msg'] = { textContent: '' };
await app.submitChangePin(ev);
t('PIN baru 4 angka ditolak di klien', inputs['pin-msg'].textContent.includes('5 atau 6'));
inputs['pin-new'] = { value: '246810' }; inputs['pin-new2'] = { value: '246811' };
await app.submitChangePin(ev);
t('pengulangan tak sama ditolak', inputs['pin-msg'].textContent.includes('tidak sama'));
inputs['pin-new2'] = { value: '246810' }; inputs['pin-current'] = { value: '0009' };
await app.submitChangePin(ev);
t('PIN saat ini salah -> pesan dari server', inputs['pin-msg'].textContent.includes('salah'), inputs['pin-msg']);
inputs['pin-current'] = { value: '0001' };
await app.submitChangePin(ev);
t('PIN berhasil diganti', app.state.me.pin_custom === true && alerts.at(-1).includes('berhasil diubah'));
await app.logout();
t('keluar: token dihapus & layar PIN muncul', !app.token && !sessionStorage._s.domino_token && !els['login-overlay'].classList.contains('hidden') && app.state.rev === null);
await typePin('0001'); t('PIN bawaan lama tak berlaku lagi', !app.token);
await typePin('246810'); t('masuk dengan PIN baru', !!app.token && app.state.me.name === 'Andi');

// ---- sesi berakhir di server (mis. server restart)
app.token = 'a'.repeat(48);
await app.cmd('toggle_player', { player_id: 'PL01' });
t('token kedaluwarsa -> kembali ke layar PIN dengan pesan', !els['login-overlay'].classList.contains('hidden') && els['login-overlay'].innerHTML.includes('Sesi berakhir'));
await typePin('246810');

// ---- pemain baru & PIN bawaan
inputs['new-p-name'] = { value: 'Kiki' }; await app.handleCreatePlayer(ev);
t('pemain baru: PIN bawaan ditampilkan', alerts.at(-1).includes('0011'));

// ---- FINAL, season
let fr = null; const pf = app.askFinal('Tes', 'x').then(v => { fr = v; });
t('kotak FINAL memakai kalimat yang diminta', modal().includes('ketik "FINAL" di box bawah ini'));
inputs['final-input'] = { value: 'oke' }; inputs['final-msg'] = { textContent: '' }; app.submitFinal(ev); t('selain FINAL ditolak', fr === null);
inputs['final-input'] = { value: 'final' }; app.submitFinal(ev); await pf; t('FINAL diterima', fr === true);
app.askFinal = async () => true;
await app.executeFinalizeSeason();
t('season terkunci', app.isSeasonLocked());
inputs['new-season-name'] = { value: 'Season 3' }; inputs['new-season-start'] = { value: '2026-12-01' };
await app.handleCreateSeason(ev);
t('season baru', app.state.current_season_id === 'SSN-2026-S3');
let err = null; try { for (const tab of ['dashboard','input-game','players','stats','h2h','awards','archive','history','settings']) app.switchTab(tab); } catch (e) { err = e; }
t('semua tab render' + (err ? ': ' + err.message : ''), !err);

// ---- diagnosis server lama / offline (kasus gambar 1)
mode = 'oldserver'; alerts = [];
const r1 = await app.cmd('toggle_player', { player_id: 'PL01' });
t('server lama: pesan menyebut VERSI LAMA, bukan sekadar "tidak terjangkau"', r1.code === 'OFFLINE' && alerts.at(-1).includes('VERSI LAMA'), alerts);
app.state.rev = 5; await app.loadState(true);
t('server lama: status memuat gagal dengan penjelasan', app._loadErr.includes('VERSI LAMA') && app.connected === false);
app.state.rev = null; app.state.current_tab = 'settings'; app.switchTab('settings');
t('belum terhubung: tab apa pun menampilkan penjelasan, bukan form kosong', els['view-settings'].innerHTML.includes('Belum terhubung ke server') && els['view-settings'].innerHTML.includes('VERSI LAMA'));
mode = 'offline'; alerts = [];
await app.cmd('toggle_player', { player_id: 'PL01' });
t('offline: pesan jelas', alerts.at(-1).includes('Server tidak terjangkau'));
mode = 'online'; app.state.rev = null; await app.loadState(true); app.render();
t('pulih saat server kembali', app.connected && app.state.rev !== null);

console.log(`\n${ok} lulus, ${bad} gagal`);
T.kill(); fs.rmSync(DIR, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
