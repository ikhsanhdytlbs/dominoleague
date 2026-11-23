import { calculateDailyMVP, pickMvpDate, matchDay } from '../dominoLogic.js';
let ok = 0, bad = 0;
const t = (n, c, x) => { c ? ok++ : bad++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + JSON.stringify(x).slice(0, 250))); };
const P = id => ({ player_id: id, display_name: id.replace('PL', 'P') });
const players = ['PL01','PL02','PL03','PL04','PL05'].map(P);
const sessions = [{ session_id: 'S1', session_date: '2026-11-20' }, { session_id: 'S2', session_date: '2026-11-21' }];
let n = 0;
const mk = (day, ps, sid = 'S1', season = 'X') => ({ match_id: 'M' + (++n), session_id: sid, season_id: season, players: ps, played_at: day + ' 20:00' });
// Hari 20: PL01 menang telak (ratus+ribu, tak kalah), PL02 sering kalah
const d20 = [mk('2026-11-20', ['PL01','PL02','PL03','PL04']), mk('2026-11-20', ['PL01','PL02','PL03','PL05']), mk('2026-11-20', ['PL01','PL02','PL04','PL05']), mk('2026-11-20', ['PL03','PL04','PL05','PL02'])];
const d21 = [mk('2026-11-21', ['PL03','PL04','PL05','PL01'], 'S2'), mk('2026-11-21', ['PL03','PL04','PL05','PL02'], 'S2')];
const other = mk('2026-11-20', ['PL01','PL02','PL03','PL04'], 'S1', 'LAIN');
const matches = [...d20, ...d21, other];
const loss = [
  { match_id: d20[0].match_id, player_id: 'PL02', loss_count: 1 }, { match_id: d20[1].match_id, player_id: 'PL02', loss_count: 1 },
  { match_id: d20[2].match_id, player_id: 'PL02', loss_count: 1 }, { match_id: d20[3].match_id, player_id: 'PL04', loss_count: 1 },
  { match_id: other.match_id, player_id: 'PL01', loss_count: 9 }
];
const special = [
  { match_id: d20[0].match_id, player_id: 'PL01', event_type: 'S100', quantity: 2 }, { match_id: d20[1].match_id, player_id: 'PL01', event_type: 'S1000', quantity: 1 },
  { match_id: d20[2].match_id, player_id: 'PL01', event_type: 'S100', quantity: 1 }, { match_id: d20[3].match_id, player_id: 'PL05', event_type: 'S100', quantity: 1 },
  { match_id: other.match_id, player_id: 'PL02', event_type: 'S1000', quantity: 50 }
];
let r = calculateDailyMVP('X', '2026-11-20', players, matches, sessions, loss, special, 3);
t('MVP hari 20 = PL01 (Ratus+Ribu tinggi, tak pernah kalah)', r.mvp && r.mvp.player_id === 'PL01', r.ranking.map(x => [x.player_id, x.performance_index]));
t('hanya game hari itu & season itu yang dihitung (data season lain diabaikan)', r.totalGames === 4 && r.mvp.loss === 0 && r.mvp.ratus === 3 && r.mvp.ribu === 1 && r.mvp.games === 3, r.mvp);
t('pembanding tersedia & skor 0-100', r.comparable && r.ranking.every(x => x.performance_index >= 0 && x.performance_index <= 100));
t('PL02 (sering kalah) bukan MVP & berada di bawah', r.ranking.findIndex(x => x.player_id === 'PL02') > r.ranking.findIndex(x => x.player_id === 'PL01'));
t('ambang min 3 game: PL02 (4 game) dan PL01 (3) memenuhi', r.threshold === 3 && r.ranking.some(x => x.player_id === 'PL01'));

r = calculateDailyMVP('X', '2026-11-21', players, matches, sessions, loss, special, 3);
t('hari dengan 2 game: ambang turun menyesuaikan, tetap ada MVP', r.totalGames === 2 && r.threshold === 2 && !!r.mvp, r);
t('pemain yang main 1 game tidak ikut dinilai bila ambang 2', !r.ranking.some(x => x.player_id === 'PL01'));

r = calculateDailyMVP('X', '2026-11-22', players, matches, sessions, loss, special, 3);
t('hari tanpa game: tidak ada MVP', r.mvp === null && r.totalGames === 0);
r = calculateDailyMVP('KOSONG', '2026-11-20', players, matches, sessions, loss, special, 3);
t('season tanpa game: tidak ada MVP', r.mvp === null);

// seri: nilai sama persis -> kalah lebih sedikit menang, lalu nama
const m2 = [mk('2026-12-01', ['PL01','PL02','PL03','PL04']), mk('2026-12-01', ['PL01','PL02','PL03','PL04']), mk('2026-12-01', ['PL01','PL02','PL03','PL04'])];
r = calculateDailyMVP('X', '2026-12-01', players, m2, sessions, [], [], 3);
t('semua sama: seri diputus deterministik (nama), tidak error', r.mvp && r.mvp.player_id === 'PL01' && r.ranking.length === 4, r.ranking.map(x => x.player_id));
const m3 = [mk('2026-12-02', ['PL01','PL02','PL03','PL04'])];
r = calculateDailyMVP('X', '2026-12-02', players, m3, sessions, [{ match_id: m3[0].match_id, player_id: 'PL01', loss_count: 1 }], [], 3);
t('1 game: ambang menyesuaikan jadi 1, kalah 1 tidak jadi MVP', r.threshold === 1 && r.mvp.player_id !== 'PL01', r.ranking.map(x => [x.player_id, x.performance_index]));

// tanggal
t('matchDay dari played_at', matchDay({ played_at: '2026-11-20 19:30' }, []) === '2026-11-20');
t('matchDay jatuh ke tanggal sesi', matchDay({ session_id: 'S2' }, sessions) === '2026-11-21');
t('matchDay tak diketahui -> kosong', matchDay({ session_id: 'ZZ' }, sessions) === '');
t('pickMvpDate: hari ini bila ada game', pickMvpDate(['2026-11-19','2026-11-21'], '2026-11-21') === '2026-11-21');
t('pickMvpDate: kalau tidak, hari terbaru sebelum hari ini', pickMvpDate(['2026-11-10','2026-11-19','2026-11-25'], '2026-11-21') === '2026-11-19');
t('pickMvpDate: semua di masa depan -> yang terbaru', pickMvpDate(['2026-12-01','2026-12-05'], '2026-11-21') === '2026-12-05');
t('pickMvpDate: tanpa game -> null', pickMvpDate([], '2026-11-21') === null && pickMvpDate(['', undefined], '2026-11-21') === null);
console.log(`\n${ok} lulus, ${bad} gagal`); process.exit(bad ? 1 : 0);
