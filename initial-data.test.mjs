// Data awal liga sungguhan: INITIAL_DATA=real -> mulai kosong (bukan data demo).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { target } from './helpers.mjs';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dli-'));
const T = target({ port: 4400, dataDir: DIR, extraEnv: { INITIAL_DATA: 'real' } });
await T.start();
const B = T.base;
const post = async (p, body, tk) => (await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { 'X-Session': tk } : {}) }, body: JSON.stringify(body || {}) })).json();
let ok = 0, bad = 0;
const t = (n, c, x) => { c ? ok++ : bad++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + JSON.stringify(x).slice(0, 200))); };

const login = await post('/api/login', { pin: '0001' });
t('login pemain pertama (PIN bawaan)', login.ok && login.player.player_id === 'PL01', login);
const s = await (await fetch(B + '/api/state', { headers: { 'X-Session': login.token } })).json();
t('mulai kosong: bukan data demo', s.is_demo === false && s.matches.length === 0 && s.audit_log.length === 0, [s.is_demo, s.matches.length]);
t('satu season aktif, satu sesi, 10 pemain', s.seasons.length === 1 && s.seasons[0].status === 'active' && s.sessions.length === 1 && s.players.length === 10, [s.seasons, s.sessions.length, s.players.length]);
t('tidak ada sisa teks [DEMO]', !JSON.stringify(s).includes('[DEMO]'));
const r = await post('/api/command', { command: 'add_match', payload: { session_id: s.sessions[0].session_id, players: ['PL01', 'PL02', 'PL03', 'PL04'], losses: { PL02: 1 }, ratus: {}, ribu: {}, notes: '' } }, login.token);
t('game pertama bisa dicatat', r.ok && r.data.match_id === 'M001', r);
console.log(`\n${ok} lulus, ${bad} gagal`);
T.kill(); fs.rmSync(DIR, { recursive: true, force: true }); process.exit(bad ? 1 : 0);
