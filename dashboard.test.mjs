// Dashboard yang murni dari data (aktivitas per lokasi, dominasi klasemen, rasio), lokasi pada sesi,
// kata "Gaple" sudah diganti, dan menu samping yang bisa disembunyikan.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { target, ROOT } from './helpers.mjs';
import { groupActivityByLocation, leaderTrend, calculateSeasonStats } from '../dominoLogic.js';

let ok = 0, bad = 0;
const t = (n, c, x) => { c ? ok++ : bad++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + String(JSON.stringify(x)).slice(0, 240))); };

// =============== bagian 1: logika murni ===============
const S = (id, date, location, status = 'closed', label = 'Sesi ' + id) => ({ session_id: id, season_id: 'X', session_date: date, session_label: label, location, status });
let n = 0;
const M = (sid, players = ['A', 'B', 'C', 'D']) => ({ match_id: 'M' + (++n), session_id: sid, season_id: 'X', players });

t('tanpa sesi: mode kosong, tidak ada batang', groupActivityByLocation([], []).mode === 'empty' && groupActivityByLocation([], []).bars.length === 0);

let r = groupActivityByLocation([S('S1', '2026-11-01'), S('S2', '2026-11-08', undefined, 'active')], [M('S1'), M('S1'), M('S2')]);
t('belum ada lokasi: satu batang per sesi, jumlah mengikuti data', r.mode === 'session' && r.bars.length === 2 && r.bars[0].games === 2 && r.bars[1].games === 1 && r.bars[1].active === true, r);

const sess = [S('S1', '2026-11-01', 'Warkop Sabar'), S('S2', '2026-11-08', 'Kafe Pojok'), S('S3', '2026-11-15', ' warkop   sabar '), S('S4', '2026-11-22', 'Kafe Pojok', 'active'), S('S5', '2026-11-29', 'KAFE POJOK')];
const ms = [M('S1'), M('S1'), M('S2'), M('S3'), M('S4'), M('S4'), M('S5')];
r = groupActivityByLocation(sess, ms);
t('5 sesi di 2 lokasi -> tepat 2 batang', r.mode === 'location' && r.bars.length === 2, r.bars.map(b => b.label));
t('penulisan berbeda (huruf besar/kecil, spasi) digabung ke lokasi yang sama', r.bars.find(b => b.label === 'Warkop Sabar').games === 3 && r.bars.find(b => /pojok/i.test(b.label)).games === 4, r.bars);
t('urutan batang mengikuti waktu pemakaian terakhir', r.bars[0].label === 'Warkop Sabar' && r.bars[1].label === 'Kafe Pojok');
t('batang yang punya sesi aktif ditandai', r.bars.find(b => /pojok/i.test(b.label)).active === true && r.bars[0].active === false);
t('menghitung banyaknya sesi per lokasi', r.bars[0].sessions === 2 && r.bars[1].sessions === 3);

r = groupActivityByLocation([S('S0', '2026-10-01'), ...sess], ms);
t('sesi lama tanpa lokasi yang kosong tidak jadi batang sendiri', r.bars.length === 2 && !r.bars.some(b => /tanpa/i.test(b.label)), r.bars.map(b => b.label));
r = groupActivityByLocation([S('S0', '2026-10-01'), ...sess], [...ms, M('S0')]);
t('sesi tanpa lokasi yang berisi game tetap tampil (data tidak hilang diam-diam)', r.bars.length === 3 && r.bars.find(b => /tanpa/i.test(b.label)).games === 1, r.bars.map(b => b.label));

const many = Array.from({ length: 10 }, (_, i) => S('L' + i, `2026-11-${String(i + 1).padStart(2, '0')}`, 'Tempat ' + i));
r = groupActivityByLocation(many, []);
t('lebih dari 7 lokasi: hanya 7 terbaru, total dilaporkan', r.bars.length === 7 && r.total === 10 && r.bars.at(-1).label === 'Tempat 9' && r.bars[0].label === 'Tempat 3', r);

// ---- tren pemuncak ----
const P = ['A', 'B', 'C', 'D'].map(id => ({ player_id: id, display_name: 'Pemain ' + id, is_active: true }));
const sets = { min_games_champion: 3, min_sessions_worst_record: 1, min_sessions_consistent: 1 };
const ts = [S('T1', '2026-11-01', 'X'), S('T2', '2026-11-08', 'X'), S('T3', '2026-11-15', 'X')].map(x => ({ ...x, season_id: 'SX' }));
let k = 100;
const TM = sid => ({ match_id: 'TM' + (++k), session_id: sid, season_id: 'SX', players: ['A', 'B', 'C', 'D'] });
const tm = [TM('T1'), TM('T1'), TM('T2'), TM('T2'), TM('T3'), TM('T3')];
const loss = tm.map(m => ({ match_id: m.match_id, player_id: 'B', loss_count: 1 }));
const spec = tm.map(m => ({ match_id: m.match_id, player_id: 'A', event_type: 'S100', quantity: 1 }));
const finalStats = calculateSeasonStats('SX', P, tm, loss, spec, sets).playerStats;
const lead = finalStats.find(p => p.eligible_champion);
const tr = leaderTrend('SX', lead.player_id, P, ts, tm, loss, spec, sets, 7);
t('tren: satu titik per sesi yang punya game', tr.length === 3 && tr.map(x => x.session_id).join() === 'T1,T2,T3', tr);
t('tren: belum ada pembanding (belum ada yang memenuhi syarat) -> null', tr[0].pi === null, tr[0]);
t('tren: titik terakhir sama dengan skor pemuncak saat ini', tr[2].pi === lead.performance_index && tr[2].pi !== null, [tr, lead.performance_index]);
t('tren: dibatasi maxPoints', leaderTrend('SX', lead.player_id, P, ts, tm, loss, spec, sets, 2).length === 2);
t('tren: sesi tanpa game dilewati', leaderTrend('SX', lead.player_id, P, [...ts, { ...S('T4', '2026-11-22'), season_id: 'SX' }], tm, loss, spec, sets).length === 3);

// =============== bagian 2: tampilan klien terhadap server ===============
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dld-'));
const T = target({ port: 4850, dataDir: DIR });
await T.start();
const B = T.base;
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(String(u).startsWith('/') ? B + u : u, o);
const els = {}; const inputs = {};
const mk = id => els[id] ||= { id, value: '', innerHTML: '', innerText: '', textContent: '', className: '', classList: { _h: false, add(c) { if (c === 'hidden') this._h = true; }, remove(c) { if (c === 'hidden') this._h = false; }, contains(c) { return c === 'hidden' && this._h; } }, addEventListener() {}, querySelectorAll() { return []; }, focus() {}, setAttribute(k, v) { (this.attrs ||= {})[k] = v; }, checked: false };
const mkBody = () => { const cls = new Set(); return { cls, classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: c => { if (cls.has(c)) { cls.delete(c); return false; } cls.add(c); return true; }, contains: c => cls.has(c) }, appendChild() {}, removeChild() {} }; };
globalThis.document = { getElementById: id => (id in inputs ? inputs[id] : mk(id)), querySelectorAll: () => [], addEventListener() {}, createElement: () => ({ click() {} }), body: mkBody(), visibilityState: 'visible', activeElement: null };
let mobile = false;
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: mobile }) };
const mkStore = () => { const st = {}; return { getItem: key => st[key] ?? null, setItem: (key, v) => { st[key] = String(v); }, removeItem: key => { delete st[key]; }, _s: st }; };
globalThis.localStorage = mkStore(); globalThis.sessionStorage = mkStore();
let alerts = []; globalThis.alert = m => alerts.push(String(m)); globalThis.confirm = () => true;
globalThis.setInterval = () => 0;
await import(pathToFileURL(path.join(ROOT, 'app.js')).href);
await new Promise(r => setTimeout(r, 300));
const app = window.app;
const ev = { preventDefault() {} };
const typePin = async pin => { app._pin = ''; for (const d of pin) app.pinKey(d); await app.submitLogin(); };
const dash = () => { app.state.current_tab = 'dashboard'; app.renderDashboard(); return els['view-dashboard'].innerHTML; };
const count = (str, re) => (str.match(re) || []).length;
const fill = (players, loss = {}, s100 = {}, s1000 = {}) => {
  Object.keys(inputs).forEach(key => delete inputs[key]);
  players.forEach((p, i) => inputs[`match-player-${i + 1}`] = { value: p });
  inputs['match-notes'] = { value: '' }; inputs['btn-submit-match'] = { disabled: false, innerHTML: '' };
  players.forEach(p => { inputs[`loss-${p}`] = { value: String(loss[p] || 0) }; inputs[`s100-${p}`] = { value: String(s100[p] || 0) }; inputs[`s1000-${p}`] = { value: String(s1000[p] || 0) }; });
};

await typePin('0001');

// ---- data demo: 4 sesi di 2 lokasi, banyak game ----
let d = dash();
t('Aktivitas: 4 sesi di 2 lokasi -> tepat 2 batang, judul per tempat', d.includes('Aktivitas Tempat Nongkrong') && count(d, /\d+ gm<\/span>/g) === 2, count(d, /\d+ gm<\/span>/g));
t('Aktivitas: nama lokasi tampil di batang', d.includes('>Warkop Sabar<') && d.includes('>Kafe Pojok<'));
const calc = app.getCalculations();
const eligible = calc.stats.filter(p => p.eligible_champion);
const leader = eligible[0];
t('data demo punya pemuncak yang memenuhi syarat (prasyarat uji)', eligible.length >= 2 && !!leader, eligible.length);
t('Dominasi: nilai PI = hitungan sebenarnya pemuncak', d.includes(`${leader.performance_index.toFixed(1)}%`) && d.includes('#1 Top'), leader.performance_index);
t('Dominasi: nama pemuncak dan "memegang skor tertinggi"', d.includes(`${leader.display_name} memegang skor tertinggi`));
t('Dominasi: Ratus/Ribu/Loss Control = nilai pemuncak (bukan angka contoh)', d.includes(`>${Math.round(leader.s100_rate)}%</span>`) && d.includes(`>${Math.round(leader.s1000_rate)}%</span>`) && d.includes(`>${Math.round(Math.max(0, 100 - leader.loss_rate))}%</span>`));
const trend = leaderTrend(app.state.current_season_id, leader.player_id, app.state.players, app.state.sessions, app.state.matches, app.state.loss_events, app.state.special_events, app.state.settings, 7);
const plotted = trend.filter(x => x.pi !== null);
t('Dominasi: grafik tren hanya digambar bila ada >= 2 titik nyata', plotted.length >= 2 ? (d.includes('<path d="M ') && d.includes(`PI: ${leader.performance_index}`)) : d.includes('Grafik tren muncul'), [plotted.length]);
t('Dominasi: label sumbu x memakai tanggal sesi nyata, bukan S1..S7', !d.includes('<span>S1</span>') && !d.includes('<span>S7</span>'));
const played = calc.stats.filter(p => p.total_matches > 0);
const avgRatus = Math.round(played.reduce((a, p) => a + p.s100_rate, 0) / played.length);
t('Rasio (ada game): tiga cincin berisi angka nyata, bukan "—"', count(d, /text-xs text-domino-black">—<\/span>/g) === 0 && d.includes(`text-xs text-domino-black">${Math.min(avgRatus, 999)}%</span>`) || avgRatus > 100, [count(d, /text-xs text-domino-black">—<\/span>/g), avgRatus]);

// ---- kosong: season/data baru ----
app.askFinal = async () => true;
const reset = await app.cmd('reset_real', {}, { confirm: 'FINAL' });
t('data direset ke kosong (prasyarat uji)', reset.ok && app.state.matches.length === 0 && app.state.is_demo === false, reset.error);
d = dash();
t('Kosong: Dominasi tidak menampilkan angka contoh 91.7 / 54 / 84', !d.includes('91.7') && !d.includes('>54%<') && !d.includes('>84%<') && !d.includes('>78%<'));
t('Kosong: PI "—", tanpa lencana #1 Top, pesan jelas', d.includes('<h3 class="text-3xl font-black text-domino-black">—</h3>') && !d.includes('#1 Top') && d.includes('Belum ada game di season ini'));
t('Kosong: nama pemain tidak dipajang sebagai "pemegang skor tertinggi"', !d.includes('memegang skor tertinggi') && !d.includes('Rihardi'));
t('Kosong: grafik tren diganti pesan, bukan gelombang hiasan', d.includes('Grafik muncul setelah ada game') && !d.includes('M 0 60 C 40 70') && !d.includes('<span>S1</span>'));
t('Kosong: tiga cincin Rasio menampilkan "—" (bukan 0%/100% palsu)', count(d, /text-xs text-domino-black">—<\/span>/g) === 3 && !d.includes('>100%<'), count(d, /text-xs text-domino-black">—<\/span>/g));
t('Kosong: Aktivitas = 1 batang (satu sesi), 0 game, tanpa 7 batang tetap', count(d, /\d+ gm<\/span>/g) === 1 && d.includes('0 gm') && d.includes('Aktivitas Sesi Nongkrong'));

// ---- lokasi pada sesi ----
app.openNewSessionModal();
const html = els['modal-host'].innerHTML;
t('form sesi baru punya kolom Lokasi + saran', html.includes('id="new-ses-location"') && html.includes('datalist'));
const first = app.state.sessions[0];
inputs['new-ses-date'] = { value: app.state.today }; inputs['new-ses-notes'] = { value: '' };
inputs['new-ses-label'] = { value: 'Malam A' }; inputs['new-ses-location'] = { value: 'Warkop Sabar' }; await app.handleCreateSession(ev);
inputs['new-ses-label'] = { value: 'Malam B' }; inputs['new-ses-location'] = { value: 'warkop  sabar' }; await app.handleCreateSession(ev);
inputs['new-ses-label'] = { value: 'Malam C' }; inputs['new-ses-location'] = { value: 'Kafe <b>Pojok</b>' }; await app.handleCreateSession(ev);
const created = app.state.sessions.filter(s => s.session_label.startsWith('Malam'));
t('lokasi tersimpan di server', created.length === 3 && created[0].location === 'Warkop Sabar' && created[2].location === 'Kafe bPojok/b', created.map(s => s.location));
const ids = created.map(s => s.session_id);
for (const [sid, n] of [[ids[0], 2], [ids[1], 1], [ids[2], 1]]) for (let i = 0; i < n; i++) { fill(['PL01', 'PL02', 'PL03', 'PL04'], { PL02: 1 }); await app.handleSaveMatch(ev, sid); }
d = dash();
t('Aktivitas: sesi lama kosong tanpa lokasi tidak jadi batang; 2 lokasi = 2 batang', count(d, /\d+ gm<\/span>/g) === 2 && d.includes('>Warkop Sabar<') && d.includes('>Kafe bPojok/b<'), count(d, /\d+ gm<\/span>/g));
t('Aktivitas: "Warkop Sabar" dan "warkop  sabar" digabung (3 game)', d.includes('3 gm') && d.includes('1 gm'));
t('Aktivitas: tanpa tag HTML mentah di nama lokasi', !d.includes('<b>Pojok</b>'));
app.openNewSessionModal();
t('saran lokasi memuat lokasi yang sudah pernah dipakai', els['modal-host'].innerHTML.includes('value="Warkop Sabar"') && els['modal-host'].innerHTML.includes('value="Kafe bPojok/b"'));
app.closeModal();
app.openEditSessionModal(ids[1]);
t('form ubah sesi memuat lokasi sekarang', els['modal-host'].innerHTML.includes('id="edit-ses-location"') && els['modal-host'].innerHTML.includes('value="warkop sabar"'), els['modal-host'].innerHTML.match(/edit-ses-location[^>]*>/));
inputs['edit-ses-label'] = { value: 'Malam B' }; inputs['edit-ses-date'] = { value: app.state.today }; inputs['edit-ses-notes'] = { value: '' }; inputs['edit-ses-location'] = { value: 'Rumah Budi' };
await app.handleEditSession(ev, ids[1]);
t('ubah lokasi sesi tersimpan dan dicatat di Riwayat', app.state.sessions.find(s => s.session_id === ids[1]).location === 'Rumah Budi' && app.state.audit_log[0].summary.includes('lokasi'), app.state.audit_log[0]);
d = dash();
t('Aktivitas: sekarang 3 lokasi = 3 batang', count(d, /\d+ gm<\/span>/g) === 3 && d.includes('>Rumah Budi<'));
app.state.current_tab = 'input-game'; app.renderInputGame();
t('kartu sesi menampilkan lokasi', els['view-input-game'].innerHTML.includes('📍 Rumah Budi'));

// ---- tidak ada lagi kata "Gaple" ----
const sources = ['app.js', 'index.html', 'demoData.js', 'dominoLogic.js', 'README.md', 'SUPABASE-GITHUB.md', 'DEPLOY.md', 'google-apps-script.js', 'engine/engine.js'];
const hits = sources.filter(f => /gaple/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
t('kata "Gaple" tidak ada lagi di kode dan dokumen', hits.length === 0, hits);
t('teks pengganti memakai "Domino"', app.state.current_tab && /Domino League/.test(dash()));

// ---- menu samping ----
const body = document.body;
mobile = true;
t('HP: menu tertutup secara bawaan', !body.cls.has('menu-open') && app.isMobileLayout() === true);
app.toggleSidebar();
t('HP: tombol membuka laci menu', body.cls.has('menu-open') && els['btn-open-menu'].attrs['aria-expanded'] === 'true');
app.closeSidebarOnMobile();
t('HP: memilih menu menutup laci', !body.cls.has('menu-open'));
app.toggleSidebar(); app.toggleSidebar();
t('HP: tombol yang sama menutup lagi', !body.cls.has('menu-open') && els['btn-open-menu'].attrs['aria-expanded'] === 'false');
app.toggleSidebar(); app.closeSidebar();
t('HP: closeSidebar (Esc / latar gelap) menutup laci', !body.cls.has('menu-open'));
t('HP: tidak mengubah status "disembunyikan" milik layar lebar', !body.cls.has('menu-collapsed') && localStorage.getItem('domino_menu_collapsed') === null);
mobile = false;
app.toggleSidebar();
t('Layar lebar: tombol menyembunyikan menu dan mengingat pilihan', body.cls.has('menu-collapsed') && localStorage.getItem('domino_menu_collapsed') === '1');
body.cls.clear(); app.restoreSidebarState();
t('Layar lebar: pilihan "disembunyikan" dipulihkan saat dibuka lagi', body.cls.has('menu-collapsed'));
app.toggleSidebar();
t('Layar lebar: tombol menampilkan menu lagi dan mengingatnya', !body.cls.has('menu-collapsed') && localStorage.getItem('domino_menu_collapsed') === '0');
body.cls.add('menu-open'); app.closeSidebarOnMobile();
t('Layar lebar: closeSidebarOnMobile tidak berefek', body.cls.has('menu-open'));
app.closeSidebar();

console.log(`\n${ok} lulus, ${bad} gagal`);
T.kill(); fs.rmSync(DIR, { recursive: true, force: true }); process.exit(bad ? 1 : 0);
