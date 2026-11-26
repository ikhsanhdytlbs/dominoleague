// Kunci Supabase format baru: fungsi harus membaca SUPABASE_SECRET_KEYS dan mengirimnya hanya lewat header apikey.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const MOCK = 5700, PORT = 4700 + 80;
const KEY = 'sb_secret_contohKunciUji';
const kids = [];
process.on('exit', () => kids.forEach(k => { try { k.kill(); } catch (_) { /* abaikan */ } }));
const start = (file, env) => { const c = spawn('node', [path.join(ROOT, 'test', file)], { env: { ...process.env, ...env }, stdio: 'ignore', cwd: ROOT }); kids.push(c); return c; };
let ok = 0, bad = 0;
const t = (n, c, x) => { c ? ok++ : bad++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + String(JSON.stringify(x)).slice(0, 200))); };
const post = async (base, p, body, tk) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { 'X-Session': tk } : {}) }, body: JSON.stringify(body || {}) }); const j = await r.json(); j.http = r.status; return j; };

async function scenario(name, env, expectOk) {
  const edge = start('edge-harness.mjs', { PORT: String(PORT), SUPABASE_URL: `http://127.0.0.1:${MOCK}`, FORCE_PASSWORD: 'X', ...env });
  await new Promise(r => setTimeout(r, 1300));
  const base = `http://127.0.0.1:${PORT}`;
  const login = await post(base, '/functions/v1/api/login', { pin: '0001' });
  t(`${name}: login ${expectOk ? 'berhasil' : 'gagal dengan pesan konfigurasi'}`, expectOk ? (login.ok === true) : (login.http === 500 && login.code === 'CONFIG'), login);
  if (expectOk) {
    const st = await (await fetch(base + '/functions/v1/api/state', { headers: { 'X-Session': login.token } })).json();
    t(`${name}: data terbaca`, Array.isArray(st.players) && st.players.length > 0);
    const w = await post(base, '/functions/v1/api/command', { command: 'add_session', payload: { season_id: 'SSN-2026-S2', label: 'uji kunci' } }, login.token);
    t(`${name}: menulis berhasil`, w.ok === true, w);
  }
  edge.kill(); await new Promise(r => setTimeout(r, 300));
  return login;
}

start('mock-postgrest.mjs', { MOCK_PORT: String(MOCK), MOCK_SERVICE_KEY: KEY });
await new Promise(r => setTimeout(r, 600));

await scenario('kunci baru (SUPABASE_SECRET_KEYS, kamus JSON)', { SUPABASE_SECRET_KEYS: JSON.stringify({ default: KEY }) }, true);
await scenario('kunci baru bernama lain (bukan "default")', { SUPABASE_SECRET_KEYS: JSON.stringify({ server: KEY }) }, true);
await scenario('kunci baru berupa teks biasa', { SUPABASE_SECRET_KEYS: KEY }, true);
await scenario('kunci lama (SUPABASE_SERVICE_ROLE_KEY) berformat sb_', { SUPABASE_SERVICE_ROLE_KEY: KEY }, true);
await scenario('tanpa kunci sama sekali', {}, false);

const stats = await (await fetch(`http://127.0.0.1:${MOCK}/__debug/stats`)).json();
t('kunci sb_ tidak pernah dikirim sebagai Authorization Bearer', stats.withAuthorization === 0 && stats.badBearer === 0, stats);
t('mock benar-benar menerima permintaan', stats.requests > 20, stats);

console.log(`\n${ok} lulus, ${bad} gagal`);
kids.forEach(k => { try { k.kill(); } catch (_) { /* abaikan */ } });
process.exit(bad ? 1 : 0);
