// Uji asap untuk deployment Supabase Anda yang sebenarnya.
//   node scripts/smoke-test.mjs <API_URL> [--pin 0001] [--origin https://USER.github.io]
//        [--supabase-url https://REF.supabase.co --anon-key ANON_KEY] [--write]
// Memeriksa: fungsi hidup, CORS, login PIN, data terbaca, DAN bahwa kunci anon tidak bisa membaca/menulis tabel
// (ini pemeriksaan keamanan terpenting). --write juga mencoba menulis (membuat lalu menghapus satu sesi kosong).
const args = process.argv.slice(2);
const api = (args.find(a => !a.startsWith('--')) || '').replace(/\/+$/, '');
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
if (!api) { console.error('Pemakaian: node scripts/smoke-test.mjs <API_URL> [--pin 0001] [--origin URL] [--supabase-url URL --anon-key KEY] [--write]'); process.exit(2); }
const pin = opt('pin') || '0001', origin = opt('origin') || 'https://contoh.github.io';
let ok = 0, bad = 0, warn = 0;
const t = (name, cond, detail) => { cond ? ok++ : bad++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + String(detail ?? '').slice(0, 200))); };
const info = (m) => { warn++; console.log('INFO ' + m); };
const call = async (path, o = {}) => { try { const r = await fetch(api + path, o); let j = null; try { j = await r.clone().json(); } catch (_) { /* bukan JSON */ } return { status: r.status, headers: r.headers, json: j, text: j ? '' : await r.text() }; } catch (e) { return { status: 0, error: e.message }; } };

let r = await call('/ping');
t('fungsi hidup (/ping)', r.status === 200 && r.json && r.json.ok === true, r.error || r.status + ' ' + (r.text || JSON.stringify(r.json)));
if (!(r.status === 200)) { console.log('\nFungsi tidak terjangkau. Periksa API_URL dan apakah Edge Function "api" sudah di-deploy.'); process.exit(1); }

r = await call('/command', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-session' } });
const allow = r.headers && r.headers.get('access-control-allow-origin');
t('CORS: preflight diizinkan dari ' + origin, r.status === 204 && (allow === '*' || allow === origin), `status ${r.status}, allow-origin=${allow}`);
t('CORS: header X-Session diizinkan', /x-session/i.test((r.headers && r.headers.get('access-control-allow-headers')) || ''));

r = await call('/state'); t('data tertutup tanpa login (401)', r.status === 401, r.status);
r = await call('/login', { method: 'POST', body: JSON.stringify({ pin: '9999' }) }); t('PIN salah ditolak', r.status === 401 || r.status === 429, r.status);
r = await call('/login', { method: 'POST', body: JSON.stringify({ pin }) });
const token = r.json && r.json.token;
t(`login PIN ${pin}`, r.status === 200 && !!token, r.status + ' ' + JSON.stringify(r.json));
if (token) {
  const H = { 'X-Session': token, 'Content-Type': 'application/json' };
  r = await call('/state', { headers: H });
  const s = r.json || {};
  t('data terbaca (pemain, game, identitas)', r.status === 200 && Array.isArray(s.players) && Array.isArray(s.matches) && s.me && s.me.name, r.status);
  t('rahasia tidak ikut terkirim ke klien', !/"secret"|"pins"|"token_hash"/.test(JSON.stringify(s)));
  console.log(`INFO ${s.players ? s.players.length : '?'} pemain, ${s.matches ? s.matches.length : '?'} game, rev ${s.rev}, login sebagai ${s.me && s.me.name}; kata sandi paksa ${s.config && s.config.force_enabled ? 'AKTIF' : 'NONAKTIF'}`);
  if (s.config && !s.config.force_enabled) info('FORCE_PASSWORD belum diatur di Supabase (fitur paksa/cadangan nonaktif).');
  if (s.me && !s.me.pin_custom) info('Akun ini masih memakai PIN bawaan (mudah ditebak). Minta pemain menggantinya.');
  r = await call('/state?rev=' + s.rev, { headers: H }); t('pemeriksaan "tidak berubah" bekerja', r.json && r.json.unchanged === true, JSON.stringify(r.json).slice(0, 80));

  if (args.includes('--write')) {
    const season = (s.seasons || []).find(x => x.status === 'active');
    if (!season) info('Tidak ada season aktif: uji tulis dilewati.');
    else {
      r = await call('/command', { method: 'POST', headers: H, body: JSON.stringify({ command: 'add_session', payload: { season_id: season.season_id, label: 'UJI ASAP (dihapus otomatis)' } }) });
      const sid = r.json && r.json.data && r.json.data.session_id;
      t('tulis: membuat sesi uji', r.status === 200 && !!sid, JSON.stringify(r.json).slice(0, 150));
      if (sid) {
        r = await call('/command', { method: 'POST', headers: H, body: JSON.stringify({ command: 'delete_session', payload: { session_id: sid } }) });
        t('tulis: menghapus sesi uji', r.status === 200 && r.json.ok === true, JSON.stringify(r.json).slice(0, 150));
      }
    }
  } else info('Uji tulis dilewati (tambahkan --write untuk mencobanya).');
  await call('/logout', { method: 'POST', headers: H });
  r = await call('/state', { headers: H }); t('keluar membatalkan sesi', r.status === 401, r.status);
}

// ---- Keamanan: kunci anon (yang ada di browser) tidak boleh bisa menyentuh tabel ----
const sbUrl = (opt('supabase-url') || '').replace(/\/+$/, ''), anon = opt('anon-key');
if (sbUrl && anon) {
  const rest = async (path, o = {}) => { try { const x = await fetch(sbUrl + '/rest/v1' + path, { ...o, headers: { apikey: anon, Authorization: 'Bearer ' + anon, 'Content-Type': 'application/json', ...(o.headers || {}) } }); let j = null; try { j = await x.json(); } catch (_) { /* kosong */ } return { status: x.status, json: j }; } catch (e) { return { status: 0, error: e.message }; } };
  for (const tbl of ['league_state', 'league_backups', 'app_sessions', 'app_limits']) {
    const g = await rest(`/${tbl}?select=*&limit=1`);
    const leaked = g.status === 200 && Array.isArray(g.json) && g.json.length > 0;
    t(`RLS: anon TIDAK bisa membaca ${tbl}`, !leaked, `status ${g.status}, baris bocor: ${leaked ? g.json.length : 0}`);
  }
  const w = await rest('/app_limits', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ key: 'smoke-anon-write' }) });
  t('RLS: anon TIDAK bisa menulis', w.status >= 400 || w.status === 0, 'status ' + w.status + ' (penulisan berhasil!)');
  if (w.status >= 200 && w.status < 300) await rest('/app_limits?key=eq.smoke-anon-write', { method: 'DELETE' });
} else {
  info('Pemeriksaan RLS dilewati. Tambahkan --supabase-url dan --anon-key untuk memastikan database terkunci (sangat disarankan).');
}

console.log(`\n${ok} lulus, ${bad} gagal` + (warn ? `, ${warn} catatan` : ''));
process.exit(bad ? 1 : 0);
