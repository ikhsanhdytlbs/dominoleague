// Menjalankan seluruh uji untuk dua target: server Node (data di file) dan Edge Function (data di Supabase tiruan).
// Pemakaian: npm test
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const files = ['mvp', 'server', 'sessions', 'initial-data', 'client-login', 'client-features', 'keys'];
let failed = 0;
const sync = spawnSync('node', ['scripts/sync-supabase.mjs', '--check'], { cwd: root, encoding: 'utf8' });
console.log((sync.status === 0 ? 'OK   ' : 'GAGAL') + ' file bersama supabase/functions/_shared ' + (sync.status === 0 ? 'sinkron' : 'TIDAK sinkron (jalankan: npm run sync)'));
if (sync.status !== 0) failed++;
for (const target of ['node', 'edge']) {
  for (const f of files) {
    if (target === 'edge' && f === 'mvp') continue;   // logika murni, cukup sekali
    if (target === 'node' && f === 'keys') continue;  // khusus Edge Function
    const r = spawnSync('node', [`test/${f}.test.mjs`], { cwd: root, env: { ...process.env, TARGET: target }, encoding: 'utf8', timeout: 180000 });
    const lines = (r.stdout || '').trim().split('\n');
    const summary = lines.filter(l => /lulus/.test(l)).pop() || (r.stderr || '').split('\n').slice(0, 3).join(' ');
    const fails = lines.filter(l => l.startsWith('FAIL'));
    console.log(`${r.status === 0 ? 'OK   ' : 'GAGAL'} [${target}] ${f.padEnd(16)} ${summary.trim()}`);
    fails.forEach(l => console.log('       ' + l.slice(0, 200)));
    if (r.status !== 0) failed++;
  }
}
console.log(failed ? `\n${failed} suite gagal.` : '\nSemua suite lulus.');
process.exit(failed ? 1 : 0);
