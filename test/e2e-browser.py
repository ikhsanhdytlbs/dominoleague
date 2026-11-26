"""
Uji end-to-end di browser sungguhan (Chromium via Playwright), meniru produksi:
  tampilan statis di satu alamat (seperti GitHub Pages)  +  API di alamat lain (seperti Supabase Edge Function).
Dijalankan oleh test/e2e-browser.sh. Opsional: butuh `pip install playwright` dan `playwright install chromium`.
"""
import os, sys
from playwright.sync_api import sync_playwright

SITE = os.environ.get('SITE_URL', 'http://127.0.0.1:4950')
EXPECT_CORS_BLOCK = os.environ.get('EXPECT_CORS_BLOCK') == '1'
ok = bad = 0
def t(name, cond, detail=''):
    global ok, bad
    ok, bad = (ok + 1, bad) if cond else (ok, bad + 1)
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else '  -> ' + str(detail)[:200]))

def login(page, pin):
    page.wait_for_selector('#pin-dots', state='attached', timeout=8000)
    for d in pin: page.click(f'#login-overlay button:text-is("{d}")')
    page.click('#login-overlay button:text-is("Masuk")')

with sync_playwright() as p:
    b = p.chromium.launch()
    def new_page(origin_tag='', viewport=None):
        ctx = b.new_context(viewport=viewport or {'width': 1280, 'height': 900})
        pg = ctx.new_page()
        pg.route('**/cdn.tailwindcss.com/**', lambda r: r.abort())
        pg.route('**/fonts.*/**', lambda r: r.abort())
        pg.errors = []; pg.requests = []
        pg.on('pageerror', lambda e: pg.errors.append(str(e)))
        pg.on('request', lambda r: pg.requests.append((r.method, r.url)))
        pg.goto(SITE)
        pg.add_style_tag(content='.hidden{display:none !important}')
        return pg

    a = new_page()
    t('config.js terbaca: API di alamat lain', a.evaluate("app.remoteApi()") is True and 'config.js' in ''.join(u for _, u in a.requests))
    login(a, '0001')

    if EXPECT_CORS_BLOCK:
        a.wait_for_timeout(1500)
        msg = a.inner_text('#login-msg')
        t('origin tidak diizinkan: browser memblokir, pesan jelas (bukan layar kosong)', 'Server tidak terjangkau' in msg or 'API' in msg or 'terjangkau' in msg, msg)
        t('tidak ada sesi tersimpan', a.evaluate("sessionStorage.getItem('domino_token')") is None)
        b.close(); print(f'\n{ok} lulus, {bad} gagal'); sys.exit(1 if bad else 0)

    a.wait_for_function("document.getElementById('account-name').textContent === 'Andi'", timeout=10000)
    api_calls = [(m, u) for m, u in a.requests if '/functions/v1/api/' in u]
    t('semua panggilan API lintas-origin ke alamat API', len(api_calls) >= 2 and all(not u.startswith(SITE) for _, u in api_calls), api_calls[:3])
    t('token dikirim lewat header X-Session (CORS preflight lolos)', a.evaluate("app.token") is not None and a.evaluate("app.state.me.name") == 'Andi')
    a.wait_for_selector('.mvp-svg', state='attached', timeout=8000)
    t('dashboard & kartu MVP tampil dari data Supabase (tiruan)', 'MVP' in a.inner_text('.mvp-svg >> xpath=ancestor::div[contains(@class,"rounded-[24px]")][1]'))

    dash_html = a.evaluate("document.getElementById('view-dashboard').innerHTML")
    t('dashboard (browser): tidak ada "NaN"/"undefined" tercetak', 'NaN' not in dash_html and 'undefined' not in dash_html)
    t('dashboard (browser): batang aktivitas = jumlah lokasi pada data (2)', dash_html.count(' gm</span>') == 2, dash_html.count(' gm</span>'))
    import re as _re
    paths = _re.findall(r'<path d="(M [^"]+)"', dash_html)
    t('dashboard (browser): grafik tren memakai titik nyata (angka valid)', bool(paths) and all(_re.fullmatch(r'[ML0-9. Z]+', x) for x in paths), paths[:1])

    # tulis lewat UI: tambah game
    a.evaluate("app.switchTab('input-game')")
    a.wait_for_timeout(300)
    n0 = a.evaluate("app.state.matches.length")
    a.once('dialog', lambda d: d.accept())
    a.evaluate("app.openInputMatchModal(app.state.sessions.find(s=>s.status==='active').session_id)")
    a.wait_for_timeout(200)
    a.click('#btn-submit-match')
    a.wait_for_function(f"app.state.matches.length === {n0 + 1}", timeout=8000)
    t('game baru tersimpan lewat form (menulis lintas-origin)', a.evaluate("app.state.matches.length") == n0 + 1 and a.evaluate("app.state.audit_log[0].actor") == 'Andi')

    # perangkat kedua (pemain lain) melihat perubahan
    c = new_page()
    login(c, '0002')
    c.wait_for_function("document.getElementById('account-name').textContent === 'Budi'", timeout=10000)
    t('HP kedua login sebagai pemain lain', c.evaluate("app.state.me.player_id") == 'PL02')
    a.evaluate("app.cmd('add_session', { season_id: app.state.current_season_id, label: 'Dari HP pertama' })")
    a.wait_for_timeout(800)
    c.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    c.wait_for_timeout(1000)
    t('HP kedua melihat sesi baru dari HP pertama', c.evaluate("app.state.sessions.some(s => s.session_label === 'Dari HP pertama')"))

    # pengesahan lintas perangkat: A mengusulkan, B mengesahkan
    mid = 'M001'
    a.evaluate("""app.cmd('edit_match', { match_id: 'M001', players: ['PL01','PL02','PL03','PL04'], notes: 'diubah dari browser', losses: {PL01: 2}, ratus: {}, ribu: {} }, { mode: 'propose' })""")
    a.wait_for_timeout(800)
    c.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); c.wait_for_timeout(1000)
    pid = c.evaluate("(app.state.proposals.find(p => p.status === 'pending') || {}).id")
    t('usulan dari HP pertama muncul di HP kedua', bool(pid), pid)
    res = c.evaluate("app.cmd('vote', { proposal_id: app.state.proposals.find(p => p.status === 'pending').id, vote: 'approve' }).then(r => r.data && r.data.status)")
    t('HP kedua (pemain lain) mengesahkan -> berlaku', res == 'applied', res)
    a.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); a.wait_for_timeout(1000)
    t('HP pertama melihat perubahan yang sudah disahkan', a.evaluate("app.state.matches.find(m => m.match_id === 'M001').notes") == 'diubah dari browser')

    # keluar
    a.evaluate("app.logout()"); a.wait_for_timeout(600)
    t('keluar: layar PIN tampil, token dihapus', a.evaluate("!document.getElementById('login-overlay').classList.contains('hidden') && sessionStorage.getItem('domino_token') === null"))
    # ---------- menu samping: laci di HP, bisa disembunyikan di layar lebar ----------
    def css(pg, sel, prop):
        return pg.evaluate("([s, p]) => getComputedStyle(document.querySelector(s))[p]", [sel, prop])
    def rect(pg, sel):
        return pg.evaluate("(s) => { const r = document.querySelector(s).getBoundingClientRect(); return {left: r.left, right: r.right, width: r.width}; }", sel)
    def has(pg, cls):
        return pg.evaluate("(c) => document.body.classList.contains(c)", cls)

    m = new_page(viewport={'width': 390, 'height': 800})
    login(m, '0001')
    m.wait_for_function("document.getElementById('account-name').textContent === 'Andi'", timeout=10000)
    t('HP: menu terlepas dari alur halaman (fixed) dan di luar layar', css(m, '#app-sidebar', 'position') == 'fixed' and rect(m, '#app-sidebar')['right'] <= 0, rect(m, '#app-sidebar'))
    t('HP: menu yang tertutup tidak bisa difokus (visibility hidden)', css(m, '#app-sidebar', 'visibility') == 'hidden')
    t('HP: tombol ☰ tampil di header', css(m, '#btn-open-menu', 'display') != 'none' and rect(m, '#btn-open-menu')['width'] > 30)
    m.click('#btn-open-menu'); m.wait_for_timeout(450)
    r = rect(m, '#app-sidebar')
    t('HP: tombol ☰ membuka laci menu (masuk ke layar, tidak melebihi 320px)', has(m, 'menu-open') and r['left'] >= -1 and 100 < r['width'] <= 321 and css(m, '#app-sidebar', 'visibility') == 'visible', r)
    t('HP: latar gelap tampil menutupi isi halaman', css(m, '.sidebar-backdrop', 'display') == 'block' and css(m, '.sidebar-backdrop', 'position') == 'fixed')
    t('HP: halaman di belakang tidak ikut bergulir (overflow hidden)', css(m, 'body', 'overflow') == 'hidden')
    m.mouse.click(385, 400); m.wait_for_timeout(450)
    t('HP: mengetuk latar gelap menutup laci', not has(m, 'menu-open') and rect(m, '#app-sidebar')['right'] <= 1)
    m.click('#btn-open-menu'); m.wait_for_timeout(450)
    m.click('#app-sidebar [data-tab="players"]'); m.wait_for_timeout(450)
    t('HP: memilih menu pindah halaman dan menutup laci', m.evaluate("app.state.current_tab") == 'players' and not has(m, 'menu-open'))
    m.click('#btn-open-menu'); m.wait_for_timeout(450)
    m.keyboard.press('Escape'); m.wait_for_timeout(450)
    t('HP: tombol Esc menutup laci', not has(m, 'menu-open'))
    m.click('#btn-open-menu'); m.wait_for_timeout(450)
    m.click('#btn-toggle-menu'); m.wait_for_timeout(450)
    t('HP: tombol panah di dalam menu juga menutupnya', not has(m, 'menu-open'))
    m.click('#btn-open-menu'); m.wait_for_timeout(450)
    m.set_viewport_size({'width': 1280, 'height': 900}); m.wait_for_timeout(500)
    t('Memperbesar layar saat laci terbuka: laci ditutup otomatis', not has(m, 'menu-open') and css(m, '#app-sidebar', 'position') != 'fixed')

    t('Layar lebar: menu tampil di tempatnya, tombol ☰ tersembunyi', css(m, '#app-sidebar', 'display') != 'none' and css(m, '#btn-open-menu', 'display') == 'none')
    m.click('#btn-toggle-menu'); m.wait_for_timeout(200)
    t('Layar lebar: tombol panah menyembunyikan menu, tombol ☰ muncul', css(m, '#app-sidebar', 'display') == 'none' and css(m, '#btn-open-menu', 'display') != 'none' and has(m, 'menu-collapsed'))
    m.reload(); m.add_style_tag(content='.hidden{display:none !important}')
    m.wait_for_function("document.getElementById('account-name').textContent === 'Andi'", timeout=10000)
    t('Layar lebar: pilihan "disembunyikan" diingat setelah halaman dimuat ulang', css(m, '#app-sidebar', 'display') == 'none' and has(m, 'menu-collapsed'))
    m.click('#btn-open-menu'); m.wait_for_timeout(200)
    t('Layar lebar: tombol ☰ menampilkan menu lagi', css(m, '#app-sidebar', 'display') != 'none' and not has(m, 'menu-collapsed'))
    m.evaluate("app.logout()"); m.wait_for_timeout(300)

    errs = [e for e in a.errors + c.errors + m.errors if 'tailwind' not in e.lower()]  # CDN Tailwind sengaja diblokir di sandbox
    t('tidak ada error JavaScript di halaman', not errs, errs)
    b.close()
print(f'\n{ok} lulus, {bad} gagal'); sys.exit(1 if bad else 0)
