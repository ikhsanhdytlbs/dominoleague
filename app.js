// DOMINO LEAGUE - Main Application Logic & UI Controller
// Palet Warna: Domino Kartu Domino Indonesia (Kuning Kartu, Merah Balak/Titik, Biru ACBC, Hitam Arang)
import { 
  DEFAULT_PLAYERS, 
  DEFAULT_SETTINGS, 
  calculatePercentiles, 
  calculateSeasonStats, 
  calculateConsistency, 
  calculateSeasonAwards, 
  calculateHeadToHead,
  calculateDailyMVP,
  pickMvpDate,
  matchDay,
  groupActivityByLocation,
  leaderTrend
} from './dominoLogic.js';
import { DEMO_DATA } from './demoData.js';

class DominoLeagueApp {
  constructor() {
    this.state = {
      is_demo: true,
      current_tab: 'dashboard',
      current_season_id: 'SSN-2026-S2',
      seasons: [],
      players: [],
      sessions: [],
      matches: [],
      loss_events: [],
      special_events: [],
      season_snapshots: [],
      settings: { ...DEFAULT_SETTINGS },
      h2h_player1: 'PL01',
      h2h_player2: 'PL02',
      certificate_data: null,
      rev: null,
      proposals: [],
      audit_log: [],
      me: null,
      config: {}
    };

    this.connected = false;
    this.token = null;
    this._loadErr = '';
    this._pin = '';
    this._fetchedAt = 0;
    this._renderPending = false;
    this._eventDraft = {};
    this._finalResolve = null;
    this._change = null;
    this._vote = null;

    this.init();
  }

  // ==========================================
  // KONEKSI KE SERVER (server adalah sumber data tunggal)
  // ==========================================
  async init() {
    this.token = null;
    try { this.token = sessionStorage.getItem('domino_token'); } catch (e) { /* abaikan */ }
    this.setupEventListeners();
    this.setupBackgroundSync();
    if (!this.token) { this.showLogin(); return; }
    this.hideLogin();
    await this.loadState(true);
    this.render();
    if (this.state.rev !== null) { this.updateAccountBadge(); this.afterLogin(); }
  }

  afterLogin() {
    this.checkLegacyImport();
  }

  // API di alamat lain (Supabase Edge Function) bila config.js mengisi API_URL; kalau tidak, server yang sama (/api)
  remoteApi() {
    return !!(typeof window !== 'undefined' && window.DOMINO_CONFIG && window.DOMINO_CONFIG.API_URL);
  }

  apiUrl(route, query = '') {
    const base = this.remoteApi() ? String(window.DOMINO_CONFIG.API_URL).replace(/\/+$/, '') : '/api';
    return `${base}/${route}${query ? '?' + query : ''}`;
  }

  authHeaders(extra = {}) {
    return this.token ? { ...extra, 'X-Session': this.token } : extra;
  }

  describeBadReply(res) {
    if (this.remoteApi()) {
      if (res.status === 404) return 'Alamat API tidak ditemukan. Periksa API_URL di config.js dan pastikan Edge Function "api" sudah di-deploy.';
      return `Layanan API membalas dengan kesalahan (HTTP ${res.status}).`;
    }
    if (res.status === 404) {
      return 'Server yang berjalan adalah VERSI LAMA (tidak punya alamat /api yang baru). Hentikan server (Ctrl+C), pastikan memakai file server.cjs terbaru, lalu jalankan: npm start';
    }
    return `Server membalas dengan kesalahan (HTTP ${res.status}).`;
  }

  async loadState(force = false) {
    if (!this.token) return false;
    try {
      const q = new URLSearchParams();
      if (!force && this.state.rev !== null && this.state.rev !== undefined) q.set('rev', this.state.rev);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      let res;
      try {
        res = await fetch(this.apiUrl('state', q.toString()), { cache: 'no-store', signal: ctrl.signal, headers: this.authHeaders() });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 401) { this.handleAuthLost('Sesi berakhir. Silakan masuk lagi.'); return false; }
      let json = null;
      try { json = await res.json(); } catch (e) { /* bukan JSON */ }
      if (!res.ok || !json) {
        this._loadErr = this.describeBadReply(res);
        this.setConnected(false);
        return false;
      }
      this._loadErr = '';
      this.setConnected(true);
      if (json.unchanged) return false;
      this.applyServerState(json);
      return true;
    } catch (e) {
      this._loadErr = this.remoteApi()
        ? 'Tidak bisa menghubungi layanan API. Periksa koneksi internet dan API_URL di config.js.'
        : 'Tidak bisa menghubungi server. Pastikan server berjalan ("npm start") dan alamatnya benar.';
      this.setConnected(false);
      return false;
    }
  }

  applyServerState(s) {
    if (!s || !Array.isArray(s.players)) return;
    Object.assign(this.state, {
      rev: s.rev,
      is_demo: !!s.is_demo,
      me: s.me || null,
      today: s.today || '',
      seasons: s.seasons || [],
      players: s.players || [],
      sessions: s.sessions || [],
      matches: s.matches || [],
      loss_events: s.loss_events || [],
      special_events: s.special_events || [],
      season_snapshots: s.season_snapshots || [],
      settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
      proposals: s.proposals || [],
      audit_log: s.audit_log || [],
      config: s.config || {}
    });
    this._fetchedAt = Date.now();
    this.updateAccountBadge();

    // Season yang sedang dilihat disimpan per perangkat (bukan dibagi ke semua orang)
    const ids = this.state.seasons.map(x => x.season_id);
    let want = null;
    try { want = localStorage.getItem('domino_season'); } catch (e) { /* abaikan */ }
    if (!ids.includes(want)) want = ids.includes(this.state.current_season_id) ? this.state.current_season_id : null;
    if (!want) {
      const active = this.state.seasons.find(x => x.status === 'active');
      want = active ? active.season_id : (ids[ids.length - 1] || '');
    }
    this.state.current_season_id = want;
  }

  selectSeason(id) {
    this.state.current_season_id = id;
    try { localStorage.setItem('domino_season', id); } catch (e) { /* abaikan */ }
  }

  setConnected(ok) {
    this.connected = ok;
    const el = document.getElementById('storage-status');
    if (!el) return;
    if (ok) {
      el.className = 'text-[10px] font-bold mt-2 text-emerald-700';
      el.textContent = '🟢 Terhubung ke server';
    } else {
      el.className = 'text-[10px] font-bold mt-2 text-domino-red';
      el.textContent = '⚠️ Server tidak terjangkau. Perubahan tidak bisa disimpan.';
    }
  }

  async cmd(command, payload = {}, extra = {}) {
    if (!this.token) { this.showLogin(); return { ok: false, code: 'AUTH' }; }
    let res, json;
    try {
      res = await fetch(this.apiUrl('command'), {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ command, payload, ...extra })
      });
    } catch (e) {
      this.setConnected(false);
      alert('Server tidak terjangkau, perubahan tidak tersimpan. Periksa koneksi lalu coba lagi.');
      return { ok: false, code: 'OFFLINE' };
    }
    if (res.status === 401) { this.handleAuthLost('Sesi berakhir. Silakan masuk lagi.'); return { ok: false, code: 'AUTH' }; }
    try {
      json = await res.json();
    } catch (e) {
      this.setConnected(false);
      alert(this.describeBadReply(res));
      return { ok: false, code: 'OFFLINE' };
    }
    this.setConnected(true);
    if (json && json.state) {
      this.applyServerState(json.state);
      if (!json.ok) this.renderIfIdle();
    }
    return json || { ok: false, error: 'Balasan server tidak valid.' };
  }

  showError(res) {
    if (!res || ['OFFLINE', 'AUTH'].includes(res.code)) return;
    alert(res.error || 'Terjadi kesalahan.');
  }

  setupBackgroundSync() {
    const tick = async () => {
      if (document.visibilityState !== 'visible' || !this.token) return;
      const changed = await this.loadState();
      if (changed) this.renderIfIdle();
    };
    document.addEventListener('visibilitychange', tick);
    // Lewat internet (Supabase) cukup tiap 15 detik agar hemat kuota; di server sendiri tiap 4 detik
    setInterval(tick, this.remoteApi() ? 15000 : 4000);
  }

  // Jangan merender ulang saat ada form terbuka atau orang sedang mengetik
  renderIfIdle() {
    const host = document.getElementById('modal-host');
    const ae = document.activeElement;
    const typing = ae && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName);
    if ((host && host.innerHTML.trim()) || typing) { this._renderPending = true; return; }
    this.render();
  }

  renderOffline() {
    const el = document.getElementById(`view-${this.state.current_tab || 'dashboard'}`) || document.getElementById('view-dashboard');
    if (!el) return;
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="bg-white rounded-[26px] p-8 border border-domino-border shadow-card text-center">
        <p class="text-3xl mb-2">📡</p>
        <h3 class="text-lg font-black text-domino-black mb-2">Belum terhubung ke server</h3>
        <p class="text-xs text-amber-900 max-w-md mx-auto">${this.esc(this._loadErr || 'Menunggu koneksi ke server...')}</p>
        <p class="text-[11px] text-amber-800 mt-3">Aplikasi akan terbuka otomatis begitu server terjangkau.</p>
      </div>`;
  }

  // ---------- Login PIN ----------
  showLogin(msg = '') {
    this._pin = '';
    const el = document.getElementById('login-overlay');
    if (!el) return;
    el.classList.remove('hidden');
    const key = d => `<button type="button" onclick="app.pinKey('${d}')" class="w-16 h-16 mx-auto rounded-full text-2xl font-black text-domino-black hover:bg-amber-50 active:bg-amber-100">${d}</button>`;
    el.innerHTML = `
      <div class="w-full max-w-xs px-6 text-center">
        <p class="text-4xl mb-2">🀄</p>
        <h2 class="text-xl font-black text-domino-black">Masukkan PIN</h2>
        <p class="text-xs text-amber-800 mb-6">Gunakan PIN pemain Anda</p>
        <div id="pin-dots" class="flex justify-center gap-3 h-4 mb-2"></div>
        <p id="login-msg" class="text-[11px] text-domino-red font-bold min-h-[1.25rem] mb-3">${this.esc(msg)}</p>
        <div class="grid grid-cols-3 gap-y-3 mb-5">
          ${['1','2','3','4','5','6','7','8','9'].map(key).join('')}
          <button type="button" onclick="app.pinForgot()" class="mx-auto h-16 text-xs font-bold text-slate-500">Lupa?</button>
          ${key('0')}
          <button type="button" onclick="app.pinBack()" class="w-16 h-16 mx-auto rounded-full text-xl text-slate-500 hover:bg-amber-50" aria-label="Hapus">⌫</button>
        </div>
        <button type="button" onclick="app.submitLogin()" class="w-full py-3 bg-domino-red hover:bg-domino-redHover text-white rounded-2xl font-black text-sm shadow-pill">Masuk</button>
      </div>`;
    this.renderPinDots();
    if (!this._pinKeyBound) {
      this._pinKeyBound = true;
      document.addEventListener('keydown', (e) => {
        const ov = document.getElementById('login-overlay');
        if (!ov || ov.classList.contains('hidden')) return;
        if (/^\d$/.test(e.key)) this.pinKey(e.key);
        else if (e.key === 'Backspace') this.pinBack();
        else if (e.key === 'Enter') this.submitLogin();
      });
    }
  }

  hideLogin() {
    const el = document.getElementById('login-overlay');
    if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
  }

  renderPinDots() {
    const el = document.getElementById('pin-dots');
    if (!el) return;
    const n = Math.max(4, (this._pin || '').length);
    el.innerHTML = Array.from({ length: n }, (_, i) =>
      `<span class="w-3 h-3 rounded-full ${i < this._pin.length ? 'bg-domino-red' : 'bg-amber-200'}"></span>`).join('');
  }

  setLoginMsg(text) {
    const el = document.getElementById('login-msg');
    if (el) el.textContent = text;
  }

  pinKey(d) {
    if ((this._pin || '').length >= 6) return;
    this._pin = (this._pin || '') + d;
    this.renderPinDots();
    this.setLoginMsg('');
  }

  pinBack() {
    this._pin = (this._pin || '').slice(0, -1);
    this.renderPinDots();
  }

  pinForgot() {
    alert('PIN bawaan adalah 4 angka dari nomor Player ID Anda.\nContoh: PL01 = 0001, PL02 = 0002, PL10 = 0010.\n\nJika sudah mengganti PIN dan lupa, minta ketua liga mereset PIN Anda.');
  }

  async submitLogin() {
    const pin = this._pin || '';
    if (pin.length < 4) { this.setLoginMsg('PIN minimal 4 angka.'); return; }
    this.setLoginMsg('Memeriksa...');
    let res, json;
    try {
      res = await fetch(this.apiUrl('login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    } catch (e) {
      this._pin = ''; this.renderPinDots();
      this.setLoginMsg('Server tidak terjangkau. Pastikan server berjalan ("npm start").');
      return;
    }
    try {
      json = await res.json();
    } catch (e) {
      this._pin = ''; this.renderPinDots();
      this.setLoginMsg(this.describeBadReply(res));
      return;
    }
    if (!json.ok) {
      this._pin = ''; this.renderPinDots();
      this.setLoginMsg(json.error || 'PIN tidak dikenal.');
      return;
    }
    this.token = json.token;
    try { sessionStorage.setItem('domino_token', json.token); } catch (e) { /* abaikan */ }
    this._pin = '';
    this.hideLogin();
    this.state.rev = null;
    await this.loadState(true);
    this.render();
    if (this.state.rev !== null) { this.updateAccountBadge(); this.afterLogin(); }
  }

  handleAuthLost(msg) {
    this.token = null;
    try { sessionStorage.removeItem('domino_token'); } catch (e) { /* abaikan */ }
    this.state.rev = null;
    this.state.me = null;
    this.updateAccountBadge();
    this.showLogin(msg);
  }

  async logout() {
    try { await fetch(this.apiUrl('logout'), { method: 'POST', headers: this.authHeaders() }); } catch (e) { /* abaikan */ }
    this.closeModal();
    this.handleAuthLost('');
  }

  // ---------- Util ----------
  nextId(prefix, items, key, pad) {
    let max = 0;
    items.forEach(it => {
      const m = String(it[key] || '').match(/(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return prefix + String(max + 1).padStart(pad, '0');
  }

  // Kode data internal tetap "S100"/"S1000"; yang tampil ke pengguna adalah "Ratus"/"Ribu"
  eventLabel(type) {
    return type === 'S1000' ? 'Ribu' : type === 'S100' ? 'Ratus' : type;
  }

  // Untuk teks lama yang tersimpan (misal judul penghargaan di arsip)
  relabel(text) {
    return String(text ?? '').replace(/S1000/g, 'Ribu').replace(/S100/g, 'Ratus');
  }

  attr(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  esc(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  isSeasonLocked(seasonId = this.state.current_season_id) {
    const s = this.state.seasons.find(x => x.season_id === seasonId);
    return !!s && s.status === 'finalized';
  }

  guardLocked() {
    if (this.isSeasonLocked()) {
      alert('Season ini sudah difinalisasi dan terkunci. Mulai season baru di menu "Arsip & Finalisasi" untuk lanjut mencatat game.');
      return true;
    }
    return false;
  }

  // Pembuat game boleh mengoreksi langsung selama masa koreksi cepat (dihitung server)
  isInGrace(m) {
    return !!(m && m.grace_left_ms > 0 && Date.now() - (this._fetchedAt || 0) < m.grace_left_ms);
  }

  // ---------- Akun & PIN ----------
  updateAccountBadge() {
    const me = this.state.me;
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const parts = me ? me.name.trim().split(/\s+/) : [];
    const initials = me ? (parts.length > 1 ? parts[0][0] + parts[1][0] : me.name.trim().slice(0, 2)).toUpperCase() : '?';
    set('actor-badge', me ? `👤 ${me.name} · akun` : '');
    set('account-avatar', initials);
    set('account-name', me ? me.name : 'Belum masuk');
    set('account-sub', me ? `Pemain · ${me.player_id}` : '');
  }

  openAccountModal() {
    const me = this.state.me;
    if (!me) return;
    this.showModal(`
      <div class="modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-[26px] max-w-sm w-full p-6 shadow-2xl border border-domino-border">
          <h3 class="text-lg font-black text-domino-black mb-1">Akun: ${this.esc(me.name)}</h3>
          <p class="text-xs text-amber-800 mb-4">Semua perubahan yang Anda buat tercatat atas nama ini. ${me.pin_custom ? 'Anda memakai PIN sendiri.' : 'Anda masih memakai PIN bawaan (mudah ditebak), sebaiknya ganti.'}</p>
          <div class="space-y-2">
            <button onclick="app.openChangePinModal()" class="w-full px-4 py-3 bg-amber-50 hover:bg-amber-100 text-amber-950 border border-amber-300 rounded-2xl font-black text-xs text-left">🔐 Ubah PIN</button>
            <button onclick="app.logout()" class="w-full px-4 py-3 bg-domino-red hover:bg-domino-redHover text-white rounded-2xl font-black text-xs text-left">🚪 Keluar</button>
            <button data-close-modal class="w-full px-4 py-2 text-xs font-bold text-slate-400">Tutup</button>
          </div>
        </div>
      </div>`);
  }

  openChangePinModal() {
    this.showModal(`
      <div class="modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-[26px] max-w-sm w-full p-6 shadow-2xl border border-domino-border">
          <h3 class="text-lg font-black text-domino-black mb-1">Ubah PIN</h3>
          <p class="text-xs text-amber-800 mb-4">PIN baru terdiri dari 5 atau 6 angka dan tidak boleh sama dengan PIN pemain lain.</p>
          <form onsubmit="app.submitChangePin(event)">
            <label class="block text-xs font-black text-amber-950 mb-1">PIN saat ini</label>
            <input type="password" id="pin-current" inputmode="numeric" maxlength="6" autocomplete="off" required class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-sm font-black tracking-widest text-domino-black mb-3">
            <label class="block text-xs font-black text-amber-950 mb-1">PIN baru (5 atau 6 angka)</label>
            <input type="password" id="pin-new" inputmode="numeric" maxlength="6" autocomplete="off" required class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-sm font-black tracking-widest text-domino-black mb-3">
            <label class="block text-xs font-black text-amber-950 mb-1">Ulangi PIN baru</label>
            <input type="password" id="pin-new2" inputmode="numeric" maxlength="6" autocomplete="off" required class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-sm font-black tracking-widest text-domino-black">
            <p id="pin-msg" class="text-[11px] text-domino-red font-bold mt-1 min-h-[1rem]"></p>
            <div class="flex justify-end gap-2 pt-3 border-t border-amber-100">
              <button type="button" data-close-modal class="px-4 py-2 text-xs font-bold text-slate-400">Batal</button>
              <button type="submit" class="px-5 py-2.5 bg-domino-red hover:bg-domino-redHover text-white rounded-xl font-black text-xs shadow-pill">Simpan PIN</button>
            </div>
          </form>
        </div>
      </div>`);
  }

  async submitChangePin(e) {
    e.preventDefault();
    const cur = (document.getElementById('pin-current')?.value || '').trim();
    const nw = (document.getElementById('pin-new')?.value || '').trim();
    const nw2 = (document.getElementById('pin-new2')?.value || '').trim();
    const msg = document.getElementById('pin-msg');
    const say = t => { if (msg) msg.textContent = t; };
    if (!/^\d{5,6}$/.test(nw)) { say('PIN baru harus 5 atau 6 angka.'); return; }
    if (nw !== nw2) { say('Pengulangan PIN baru tidak sama.'); return; }
    const res = await this.cmd('change_pin', { current_pin: cur, new_pin: nw });
    if (!res.ok) { if (!['OFFLINE', 'AUTH'].includes(res.code)) say(res.error || 'Gagal.'); return; }
    this.closeModal();
    alert('✅ PIN berhasil diubah. Gunakan PIN baru saat masuk berikutnya.');
    this.render();
  }

  // Data dari versi lama aplikasi (tersimpan di browser) ditawarkan untuk diimpor ke server
  async checkLegacyImport() {
    try {
      if (localStorage.getItem('domino_legacy_done')) return;
      const raw = localStorage.getItem('domino_league_data');
      if (!raw) { localStorage.setItem('domino_legacy_done', '1'); return; }
      const d = JSON.parse(raw);
      const hasData = d && !d.is_demo && Array.isArray(d.matches) && d.matches.length > 0;
      const serverHasReal = !this.state.is_demo && this.state.matches.length > 0;
      if (!hasData || serverHasReal) { localStorage.setItem('domino_legacy_done', '1'); return; }
      if (!confirm(`Ditemukan data lama di browser ini (${d.matches.length} game).\n\nImpor ke server sekarang? Data di server akan diganti dengan data ini.\n(Batal = lewati, akan ditanyakan lagi nanti)`)) return;
      const res = await this.cmd('import_legacy', { state: d }, { confirm: 'FINAL' });
      if (res.ok) {
        localStorage.setItem('domino_legacy_done', '1');
        this.render();
        alert('✅ Data lama berhasil diimpor ke server.');
      } else {
        this.showError(res);
      }
    } catch (e) { /* abaikan */ }
  }

  // ---------- Konfirmasi "FINAL" ----------
  askFinal(title, desc) {
    return new Promise(resolve => {
      this._finalResolve = resolve;
      this.showModal(`
        <div class="modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div class="bg-white rounded-[26px] max-w-md w-full p-6 shadow-2xl border border-domino-border">
            <h3 class="text-lg font-black text-domino-black mb-2">${this.esc(title)}</h3>
            <p class="text-xs text-amber-900 mb-4">${this.esc(desc)}</p>
            <form onsubmit="app.submitFinal(event)">
              <label class="block text-xs font-black text-domino-red mb-2">Jika Anda yakin dengan perubahan, ketik "FINAL" di box bawah ini</label>
              <input type="text" id="final-input" autocomplete="off" placeholder="FINAL" class="w-full bg-white border border-amber-300 rounded-xl p-2.5 text-sm font-black tracking-widest text-domino-black">
              <p id="final-msg" class="text-[11px] text-domino-red font-bold mt-1 min-h-[1rem]"></p>
              <div class="flex justify-end gap-2 pt-3">
                <button type="button" data-close-modal class="px-4 py-2 text-xs font-bold text-slate-400">Batal</button>
                <button type="submit" class="px-5 py-2.5 bg-domino-red hover:bg-domino-redHover text-white rounded-xl font-black text-xs shadow-pill">Lanjutkan</button>
              </div>
            </form>
          </div>
        </div>`);
      setTimeout(() => { const i = document.getElementById('final-input'); if (i && i.focus) i.focus(); }, 50);
    });
  }

  submitFinal(e) {
    e.preventDefault();
    const v = (document.getElementById('final-input')?.value || '').trim();
    if (v.toUpperCase() !== 'FINAL') {
      const m = document.getElementById('final-msg');
      if (m) m.textContent = 'Ketik persis: FINAL';
      return;
    }
    const r = this._finalResolve;
    this._finalResolve = null;
    this.closeModal();
    if (r) r(true);
  }

  // ---------- Edit/hapus game: usulan 2 pemain atau paksa dengan kata sandi ----------
  openGameChangeChoice(command, payload, title, desc) {
    this._change = { command, payload, title, desc };
    const force = this.state.config && this.state.config.force_enabled;
    this.showModal(`
      <div class="modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-[26px] max-w-md w-full p-6 shadow-2xl border border-domino-border">
          <h3 class="text-lg font-black text-domino-black mb-2">${this.esc(title)}</h3>
          <p class="text-xs text-amber-900 mb-4">${this.esc(desc)}</p>
          <div class="space-y-2">
            <button onclick="app.submitProposal()" class="w-full px-4 py-3 bg-domino-red hover:bg-domino-redHover text-white rounded-2xl font-black text-xs shadow-pill text-left">
              📨 Ajukan persetujuan <span class="block font-bold opacity-90">Berlaku setelah ${(this.state.config && this.state.config.approvals_required) || 1} pemain lain di game ini mengesahkan</span>
            </button>
            ${force ? `<button onclick="app.openForceModal()" class="w-full px-4 py-3 bg-amber-50 hover:bg-amber-100 text-amber-950 border border-amber-300 rounded-2xl font-black text-xs text-left">
              🔑 Paksa dengan kata sandi <span class="block font-bold text-amber-800">Langsung berlaku, tercatat sebagai PAKSA di Riwayat</span>
            </button>` : ''}
            <button data-close-modal class="w-full px-4 py-2 text-xs font-bold text-slate-400">Batal</button>
          </div>
        </div>
      </div>`);
  }

  async submitProposal() {
    const c = this._change;
    if (!c) return;
    const res = await this.cmd(c.command, c.payload, { mode: 'propose' });
    if (!res.ok) { this.showError(res); return; }
    this.closeModal();
    alert('✅ Usulan dikirim. Perubahan berlaku setelah pemain lain di game ini mengesahkannya (ia harus masuk dengan PIN-nya sendiri).');
    this.switchTab('input-game');
    this.render();
  }

  openForceModal() {
    const c = this._change;
    if (!c) return;
    this.showModal(`
      <div class="modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-[26px] max-w-md w-full p-6 shadow-2xl border border-domino-border">
          <h3 class="text-lg font-black text-domino-black mb-1">Paksa: ${this.esc(c.title)}</h3>
          <p class="text-xs text-amber-900 mb-4">${this.esc(c.intro || 'Perubahan langsung berlaku tanpa pengesahan pemain.')} Nama Anda, waktu, dan alasan akan tercatat dan terlihat oleh semua orang.</p>
          <form onsubmit="app.submitForce(event)">
            <label class="block text-xs font-black text-amber-950 mb-1">Kata sandi</label>
            <input type="password" id="force-password" autocomplete="off" required class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-xs font-bold text-domino-black mb-3">
            <label class="block text-xs font-black text-amber-950 mb-1">Alasan (wajib)</label>
            <input type="text" id="force-reason" maxlength="200" required placeholder="Contoh: salah catat, pemain sudah pulang" class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-xs font-bold text-domino-black">
            <p id="force-msg" class="text-[11px] text-domino-red font-bold mt-1 min-h-[1rem]"></p>
            <div class="flex justify-end gap-2 pt-3 border-t border-amber-100">
              <button type="button" onclick="${c.forceOnly ? 'app.closeModal()' : 'app.openGameChangeChoice(app._change.command, app._change.payload, app._change.title, app._change.desc)'}" class="px-4 py-2 text-xs font-bold text-slate-400">${c.forceOnly ? 'Batal' : 'Kembali'}</button>
              <button type="submit" class="px-5 py-2.5 bg-domino-red hover:bg-domino-redHover text-white rounded-xl font-black text-xs shadow-pill">Paksa Simpan</button>
            </div>
          </form>
        </div>
      </div>`);
  }

  async submitForce(e) {
    e.preventDefault();
    const c = this._change;
    if (!c) return;
    const password = document.getElementById('force-password')?.value || '';
    const reason = (document.getElementById('force-reason')?.value || '').trim();
    const res = await this.cmd(c.command, c.payload, { mode: 'force', password, reason });
    if (!res.ok) {
      const m = document.getElementById('force-msg');
      if (m && !['OFFLINE', 'AUTH'].includes(res.code)) m.textContent = res.error || 'Gagal.';
      return;
    }
    this.closeModal();
    if (c.command === 'reset_pin') alert(`✅ PIN dikembalikan ke bawaan: ${res.data.default_pin}. Tercatat di Riwayat.`);
    else if (c.command === 'export_all') this.saveJsonFile(res.data.backup);
    else alert('✅ Perubahan dipaksakan dan tercatat di Riwayat.');
    this.render();
  }

  saveJsonFile(obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `domino-league-cadangan-${(this.state.today || new Date().toISOString().slice(0, 10))}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  downloadBackup() {
    if (!(this.state.config && this.state.config.force_enabled)) {
      alert('Unduh cadangan memakai kata sandi paksa. Atur FORCE_PASSWORD di server terlebih dahulu.');
      return;
    }
    this._change = { command: 'export_all', payload: {}, title: 'Unduh cadangan data', desc: '', forceOnly: true, intro: 'Seluruh data liga akan diunduh sebagai file JSON (tanpa PIN pemain).' };
    this.openForceModal();
  }

  async importBackupFile(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    let data = null;
    try { data = JSON.parse(await file.text()); } catch (e) { /* bukan JSON */ }
    input.value = '';
    if (!data || !Array.isArray(data.players) || !Array.isArray(data.matches) || !Array.isArray(data.seasons)) {
      alert('File ini bukan cadangan Domino League yang valid.');
      return;
    }
    const ok = await this.askFinal('Pulihkan dari cadangan', `Seluruh data sekarang akan DIGANTI dengan isi file (${data.players.length} pemain, ${data.matches.length} game). PIN semua pemain kembali ke PIN bawaan.`);
    if (!ok) return;
    const res = await this.cmd('import_legacy', { state: data }, { confirm: 'FINAL' });
    if (!res.ok) { this.showError(res); return; }
    alert('✅ Data berhasil dipulihkan dari file cadangan.');
    this.render();
  }

  openResetPin(pid) {
    const p = this.state.players.find(x => x.player_id === pid);
    if (!p) return;
    this._change = { command: 'reset_pin', payload: { player_id: pid }, title: `Reset PIN ${p.display_name}`, desc: '', forceOnly: true, intro: 'PIN pemain ini dikembalikan ke PIN bawaan (4 angka dari nomor ID).' };
    this.openForceModal();
  }

  // ---------- Persetujuan ----------
  pendingProposalsHtml() {
    const sid = this.state.current_season_id;
    const list = (this.state.proposals || []).filter(p => p.status === 'pending' && p.season_id === sid);
    if (!list.length) return '';
    const me = this.state.me;
    const canVote = p => !!me && p.eligible.some(e => e.player_id === me.player_id) && !p.approvals.includes(me.player_id) && !p.rejections.includes(me.player_id);
    const names = ids => ids.map(id => (this.state.players.find(p => p.player_id === id) || {}).display_name || id).join(', ');
    return `
      <div class="bg-white rounded-[26px] p-5 shadow-card border-2 border-amber-400 mb-5">
        <h4 class="font-black text-domino-black text-sm mb-1">⏳ Menunggu Persetujuan (${list.length})</h4>
        <p class="text-[11px] text-amber-800 mb-3">Perubahan baru berlaku setelah ${(this.state.config && this.state.config.approvals_required) || 1} pemain lain di game itu mengesahkan. Satu penolakan membatalkan usulan.</p>
        ${list.map(p => {
          const hoursLeft = Math.max(1, Math.round((Date.parse(p.expires_at) - Date.now()) / 3600000));
          return `
          <div class="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 mb-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <p class="text-xs font-black text-domino-black">${this.esc(p.summary)} <span class="text-amber-800 font-bold">· diajukan ${this.esc(p.proposer)} · sisa ±${hoursLeft} jam</span></p>
                <p class="text-[11px] text-slate-500 mt-1"><b>Sebelum:</b> ${this.esc(p.before_text)}</p>
                <p class="text-[11px] text-slate-800"><b>Sesudah:</b> ${this.esc(p.after_text)}</p>
                <p class="text-[11px] font-black text-amber-900 mt-1">Persetujuan ${p.approvals.length}/${p.required}${p.approvals.length ? ' · ' + this.esc(names(p.approvals)) : ''}</p>
                ${p.mine ? '<p class="text-[10px] font-bold text-domino-red mt-0.5">Anda pengusul. Pemain lain yang harus mengesahkan (keluar, lalu masuk dengan PIN pemain itu).</p>' : ''}
                <p class="text-[10px] text-slate-400 mt-0.5">Yang boleh memberi suara: ${this.esc(p.eligible.map(e => e.name).join(', '))}</p>
              </div>
              <div class="flex flex-wrap gap-2">
                ${canVote(p) ? `<button onclick="app.openVoteModal('${p.id}','approve')" class="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black text-xs">✅ Sahkan</button>
                <button onclick="app.openVoteModal('${p.id}','reject')" class="px-3 py-2 bg-white hover:bg-rose-50 text-domino-red border border-rose-200 rounded-xl font-black text-xs">❌ Tolak</button>` : ''}
                ${p.mine ? `<button onclick="app.cancelProposal('${p.id}')" class="px-3 py-2 text-xs font-bold text-slate-400 hover:text-domino-black">Batalkan usulan</button>` : ''}
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>`;
  }

  openVoteModal(proposalId, vote) {
    const p = (this.state.proposals || []).find(x => x.id === proposalId);
    const me = this.state.me;
    if (!p || !me) return;
    this._vote = { id: proposalId, vote };
    this.showModal(`
      <div class="modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-[26px] max-w-md w-full p-6 shadow-2xl border border-domino-border">
          <h3 class="text-lg font-black text-domino-black mb-1">${vote === 'approve' ? '✅ Sahkan' : '❌ Tolak'} perubahan</h3>
          <p class="text-xs text-amber-900 mb-1">${this.esc(p.summary)} (diajukan ${this.esc(p.proposer)})</p>
          <p class="text-[11px] text-slate-500 mb-0.5"><b>Sebelum:</b> ${this.esc(p.before_text)}</p>
          <p class="text-[11px] text-slate-800 mb-4"><b>Sesudah:</b> ${this.esc(p.after_text)}</p>
          <p class="text-xs font-bold text-amber-950 mb-3">Anda memberi suara sebagai <span class="text-domino-red">${this.esc(me.name)}</span>.</p>
          <p id="vote-msg" class="text-[11px] text-domino-red font-bold min-h-[1rem]"></p>
          <div class="flex justify-end gap-2 pt-3 border-t border-amber-100">
            <button type="button" data-close-modal class="px-4 py-2 text-xs font-bold text-slate-400">Batal</button>
            <button type="button" onclick="app.submitVote()" class="px-5 py-2.5 bg-domino-red hover:bg-domino-redHover text-white rounded-xl font-black text-xs shadow-pill">Kirim Suara</button>
          </div>
        </div>
      </div>`);
  }

  async submitVote() {
    const v = this._vote;
    if (!v) return;
    const res = await this.cmd('vote', { proposal_id: v.id, vote: v.vote });
    if (!res.ok) {
      const m = document.getElementById('vote-msg');
      if (m && !['OFFLINE', 'AUTH'].includes(res.code)) m.textContent = res.error || 'Gagal.';
      return;
    }
    this.closeModal();
    const st = res.data.status;
    if (st === 'applied') alert('✅ Disahkan. Perubahan sudah diterapkan.');
    else if (st === 'pending') alert(`✅ Suara tercatat (${res.data.approvals}/${res.data.required}). Menunggu pemain lain.`);
    else if (st === 'rejected') alert('Usulan ditolak dan dibatalkan.');
    else if (st === 'stale') alert('Usulan batal: game sudah berubah sejak diajukan. Silakan ajukan ulang.');
    this.render();
  }

  async cancelProposal(id) {
    if (!confirm('Batalkan usulan ini?')) return;
    const res = await this.cmd('cancel_proposal', { proposal_id: id });
    if (!res.ok) { this.showError(res); return; }
    this.render();
  }

  // ---------- Riwayat perubahan ----------
  undoDescriptor(a) {
    if (!a.changed || !a.details || !a.match_id) return null;
    const exists = this.state.matches.some(m => m.match_id === a.match_id);
    if ((a.action === 'add_match' || a.action === 'restore_match') && exists) {
      return { command: 'delete_match', payload: { match_id: a.match_id }, title: `Batalkan game ${a.match_id}` };
    }
    if (a.action === 'edit_match' && exists && a.details.before_form) {
      return { command: 'edit_match', payload: { match_id: a.match_id, ...a.details.before_form }, title: `Kembalikan game ${a.match_id} ke kondisi sebelumnya` };
    }
    if (a.action === 'delete_match' && !exists && a.details.before_record) {
      return { command: 'restore_match', payload: { record: a.details.before_record }, title: `Pulihkan game ${a.match_id}` };
    }
    return null;
  }

  undoEntry(entryId) {
    const a = (this.state.audit_log || []).find(x => x.id === entryId);
    const d = a && this.undoDescriptor(a);
    if (!d) { alert('Perubahan ini tidak bisa dikembalikan lagi.'); return; }
    if (this.guardLocked()) return;
    this.openGameChangeChoice(d.command, d.payload, d.title, 'Mengembalikan perubahan juga harus disahkan pemain lain di game itu (atau dipaksa dengan kata sandi).');
  }

  renderHistory() {
    const c = document.getElementById('view-history');
    if (!c) return;
    const badge = {
      force: ['PAKSA', 'bg-rose-100 text-rose-800'], approved: ['DISETUJUI', 'bg-emerald-100 text-emerald-800'],
      grace: ['KOREKSI CEPAT', 'bg-sky-100 text-sky-800'], proposal: ['USULAN', 'bg-amber-100 text-amber-900'],
      vote: ['SUARA', 'bg-slate-100 text-slate-700'], admin: ['ADMIN', 'bg-violet-100 text-violet-800']
    };
    const rows = (this.state.audit_log || []).map(a => {
      const b = badge[a.mode];
      const undo = this.undoDescriptor(a);
      const when = new Date(a.at).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `
        <div class="flex flex-wrap items-start justify-between gap-3 py-3 border-b border-amber-100 last:border-0">
          <div class="min-w-0 flex-1">
            <p class="text-xs text-domino-black">
              ${b ? `<span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-black mr-1 ${b[1]}">${b[0]}</span>` : ''}
              ${this.esc(a.summary)}
            </p>
            ${a.reason ? `<p class="text-[11px] text-domino-red font-bold mt-0.5">Alasan: ${this.esc(a.reason)}</p>` : ''}
            <p class="text-[10px] text-slate-400 mt-0.5">${when} · ${this.esc(a.actor)}</p>
          </div>
          ${undo ? `<button onclick="app.undoEntry('${a.id}')" class="px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-950 border border-amber-200 rounded-xl text-[11px] font-black">↩️ Kembalikan</button>` : ''}
        </div>`;
    }).join('');
    c.innerHTML = `
      <div class="mb-5">
        <h3 class="text-xl font-black text-domino-black tracking-tight">Riwayat Perubahan</h3>
        <p class="text-xs text-amber-800 mt-1">Semua penambahan, usulan, persetujuan, dan perubahan paksa tercatat di sini dan terlihat oleh semua orang (100 terbaru).</p>
      </div>
      <div class="bg-white rounded-[26px] p-5 shadow-card border border-domino-border">
        ${rows || '<p class="text-xs text-amber-800 py-6 text-center">Belum ada riwayat.</p>'}
      </div>`;
  }

  getCalculations() {
    const seasonId = this.state.current_season_id;
    const season = this.state.seasons.find(s => s.season_id === seasonId) || this.state.seasons[0];
    const seasonMatches = this.state.matches.filter(m => m.season_id === seasonId);
    
    const statsResult = calculateSeasonStats(
      seasonId,
      this.state.players,
      this.state.matches,
      this.state.loss_events,
      this.state.special_events,
      this.state.settings
    );

    const consistencyList = calculateConsistency(
      statsResult.playerStats,
      seasonMatches,
      this.state.loss_events,
      this.state.special_events,
      this.state.settings
    );

    const awards = calculateSeasonAwards(
      statsResult.playerStats,
      consistencyList,
      this.state.settings
    );

    return {
      season,
      seasonMatches,
      stats: statsResult.playerStats,
      totalSeasonMatches: statsResult.totalSeasonMatches,
      consistencyList,
      awards
    };
  }

  setupEventListeners() {
    document.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.currentTarget.getAttribute('data-tab');
        this.switchTab(tab);
        this.closeSidebarOnMobile();
      });
    });

    const seasonSelect = document.getElementById('season-selector');
    if (seasonSelect) {
      seasonSelect.addEventListener('change', (e) => {
        this.selectSeason(e.target.value);
        this.render();
      });
    }

    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop') || e.target.closest('[data-close-modal]')) {
        this.closeModal();
      }
    });

    // Menu samping: tombol panah di menu, tombol ☰ di header, Esc, dan penyesuaian saat layar berubah ukuran
    const arrow = document.getElementById('btn-toggle-menu');
    if (arrow) arrow.addEventListener('click', () => this.toggleSidebar());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeSidebar(); });
    window.addEventListener('resize', () => { if (!this.isMobileLayout()) this.closeSidebar(); this.setMenuAria(); });
    this.restoreSidebarState();
  }

  // ---------- Menu samping (laci geser di HP, bisa disembunyikan di layar lebar) ----------
  isMobileLayout() {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1023px)').matches;
  }

  setMenuAria() {
    const b = document.body;
    if (!b || !b.classList) return;
    const open = this.isMobileLayout() ? b.classList.contains('menu-open') : !b.classList.contains('menu-collapsed');
    ['btn-open-menu', 'btn-toggle-menu'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.setAttribute) el.setAttribute('aria-expanded', String(open));
    });
  }

  toggleSidebar() {
    const b = document.body;
    if (!b || !b.classList) return;
    if (this.isMobileLayout()) {
      b.classList.toggle('menu-open');
    } else {
      const collapsed = b.classList.toggle('menu-collapsed');
      try { localStorage.setItem('domino_menu_collapsed', collapsed ? '1' : '0'); } catch (e) { /* abaikan */ }
    }
    this.setMenuAria();
  }

  closeSidebar() {
    const b = document.body;
    if (!b || !b.classList) return;
    b.classList.remove('menu-open');
    this.setMenuAria();
  }

  closeSidebarOnMobile() {
    if (this.isMobileLayout()) this.closeSidebar();
  }

  restoreSidebarState() {
    const b = document.body;
    if (!b || !b.classList) return;
    try {
      if (!this.isMobileLayout() && localStorage.getItem('domino_menu_collapsed') === '1') b.classList.add('menu-collapsed');
    } catch (e) { /* abaikan */ }
    this.setMenuAria();
  }

  switchTab(tabName) {
    this.state.current_tab = tabName;
    document.querySelectorAll('[data-tab]').forEach(el => {
      if (el.getAttribute('data-tab') === tabName) {
        el.className = 'nav-item w-full flex items-center justify-between px-4 py-3 rounded-2xl text-sm font-bold transition bg-domino-black text-white shadow-darkPill';
      } else {
        el.className = 'nav-item w-full flex items-center justify-between px-4 py-3 rounded-2xl text-sm font-bold text-slate-600 hover:bg-amber-50 hover:text-amber-900 transition';
      }
    });

    const views = ['dashboard', 'input-game', 'players', 'stats', 'h2h', 'awards', 'archive', 'history', 'settings'];
    views.forEach(v => {
      const container = document.getElementById(`view-${v}`);
      if (container) {
        if (v === tabName) {
          container.classList.remove('hidden');
        } else {
          container.classList.add('hidden');
        }
      }
    });

    const titles = {
      'dashboard': { title: 'Dashboard', subtitle: 'Ringkasan & Statistik Performa Domino' },
      'input-game': { title: 'Sesi & Input Skor', subtitle: 'Kelola sesi nongkrong & catat skor pertandingan meja' },
      'players': { title: 'Master Data Pemain', subtitle: 'Kelola 10 Anggota & Tambah Pemain Baru' },
      'stats': { title: 'Statistik & Rasio', subtitle: 'Komparasi Akumulatif vs Rasio per 100 Game' },
      'h2h': { title: 'Head to Head', subtitle: 'Duel Dua Pemain Khusus Game Bersama' },
      'awards': { title: '8 Penghargaan Season', subtitle: 'Kalkulasi Otomatis & Cetak Sertifikat Resmi' },
      'archive': { title: 'Arsip & Finalisasi', subtitle: 'Riwayat Juara Season & Snapshot Terkunci' },
      'history': { title: 'Riwayat Perubahan', subtitle: 'Siapa mengubah apa, kapan, dan atas persetujuan siapa' },
      'settings': { title: 'Pengaturan & Sync', subtitle: 'Sinkronisasi Google Sheets & Ambang Batas' }
    };

    const t = titles[tabName] || { title: 'Dashboard', subtitle: '' };
    const titleEl = document.getElementById('top-view-title');
    const subEl = document.getElementById('top-view-subtitle');
    if (titleEl) titleEl.innerText = t.title;
    if (subEl) subEl.innerText = t.subtitle;

    this.renderCurrentView();
  }

  render() {
    if (this.state.rev === null) { this.renderOffline(); return; }
    this.renderHeader();
    this.renderCurrentView();
  }

  renderHeader() {
    const seasonSelect = document.getElementById('season-selector');
    if (seasonSelect) {
      seasonSelect.innerHTML = this.state.seasons.map(s => `
        <option value="${s.season_id}" ${s.season_id === this.state.current_season_id ? 'selected' : ''}>
          ${s.season_name} (${s.status === 'active' ? 'Aktif' : 'Arsip'})
        </option>
      `).join('');
    }

    const demoBadge = document.getElementById('demo-mode-badge');
    if (demoBadge) {
      if (this.state.is_demo) {
        demoBadge.classList.remove('hidden');
      } else {
        demoBadge.classList.add('hidden');
      }
    }

    const calc = this.getCalculations();
    const leaderStat = document.getElementById('header-leader-stat');
    if (leaderStat) {
      const top1 = calc.stats.find(p => p.eligible_champion);
      leaderStat.innerText = top1 ? `${top1.display_name} (${top1.performance_index} pts)` : 'Belum cukup data';
    }

    const syncBadge = document.getElementById('sidebar-sync-badge');
    if (syncBadge) {
      if (this.state.settings.sheets_webhook_set) {
        syncBadge.innerHTML = '<span class="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block animate-pulse" title="Google Sheets Terhubung"></span>';
      } else {
        syncBadge.innerHTML = '<span class="w-2.5 h-2.5 rounded-full bg-domino-red inline-block" title="Google Sheets Belum Terhubung"></span>';
      }
    }
  }

  renderCurrentView() {
    if (this.state.rev === null) { this.renderOffline(); return; }
    switch (this.state.current_tab) {
      case 'dashboard':
        this.renderDashboard();
        break;
      case 'input-game':
        this.renderInputGame();
        break;
      case 'players':
        this.renderPlayers();
        break;
      case 'stats':
        this.renderStats();
        break;
      case 'h2h':
        this.renderHeadToHead();
        break;
      case 'awards':
        this.renderAwards();
        break;
      case 'history':
        this.renderHistory();
        break;
      case 'archive':
        this.renderArchive();
        break;
      case 'settings':
        this.renderSettings();
        break;
    }
  }

  // ==========================================
  // VIEW 01: DASHBOARD (DOMINO ACBC THEME)
  // ==========================================
  renderDashboard() {
    const calc = this.getCalculations();
    const container = document.getElementById('view-dashboard');
    if (!container) return;

    const totalGames = calc.totalSeasonMatches;
    const sid = this.state.current_season_id;
    const settings = this.state.settings || {};
    const minG = settings.min_games_champion || 10;

    // ---- Kartu Aktivitas: jumlah batang mengikuti data (per tempat nongkrong) ----
    const seasonSessions = this.state.sessions.filter(x => x.season_id === sid);
    const act = groupActivityByLocation(seasonSessions, this.state.matches, 7);
    const maxBarGames = Math.max(1, ...act.bars.map(b => b.games));

    // ---- Kartu Dominasi Klasemen: murni dari data, tanpa angka contoh ----
    const eligibleList = calc.stats.filter(p => p.eligible_champion);
    let dom;
    if (totalGames === 0) dom = { kind: 'empty', leader: null };
    else if (eligibleList.length === 0) dom = { kind: 'progress', leader: null, top: [...calc.stats].sort((a, b) => b.total_matches - a.total_matches)[0] };
    else if (eligibleList.length === 1) dom = { kind: 'single', leader: eligibleList[0] };
    else dom = { kind: 'ranked', leader: eligibleList[0] };
    const leader = dom.leader;
    const trend = dom.kind === 'ranked'
      ? leaderTrend(sid, leader.player_id, this.state.players, this.state.sessions, this.state.matches, this.state.loss_events, this.state.special_events, settings, 7)
      : [];
    const plotted = trend.filter(pt => pt.pi !== null);
    const domPi = dom.kind === 'ranked' ? `${leader.performance_index.toFixed(1)}%` : '—';
    const domSub = dom.kind === 'empty' ? 'Belum ada game di season ini'
      : dom.kind === 'progress' ? `${this.esc(dom.top.display_name)} baru ${dom.top.total_matches} dari ${minG} game (syarat juara)`
      : dom.kind === 'single' ? `${this.esc(leader.display_name)} satu-satunya yang memenuhi syarat, belum ada pembanding`
      : `${this.esc(leader.display_name)} memegang skor tertinggi`;
    const domPct = v => (leader ? `${Math.round(v)}%` : '—');
    const domW = v => (leader ? Math.max(0, Math.min(100, v)) : 0);
    const domLossCtl = leader ? Math.max(0, 100 - leader.loss_rate) : 0;
    let domChart = '';
    let domAxis = '';
    if (plotted.length >= 2) {
      const W = 300, H = 80, PAD = 8, n = trend.length;
      const xAt = i => (n === 1 ? W / 2 : (i * W) / (n - 1));
      const yAt = v => H - PAD - (Math.max(0, Math.min(100, v)) / 100) * (H - 2 * PAD);
      const pts = trend.map((pt, i) => (pt.pi === null ? null : [xAt(i), yAt(pt.pi)])).filter(Boolean);
      const line = pts.map((q, i) => `${i ? 'L' : 'M'} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(' ');
      const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${H} L ${pts[0][0].toFixed(1)} ${H} Z`;
      const lastPct = Math.min(88, Math.max(12, (pts[pts.length - 1][0] / W) * 100));
      domChart = `
            <div class="relative mt-4 h-24">
              <div class="absolute -top-2 transform -translate-x-1/2 z-10" style="left: ${lastPct.toFixed(1)}%">
                <span class="px-2.5 py-1 rounded-xl bg-domino-red text-white text-[11px] font-black shadow-pill flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full bg-domino-yellow"></span>
                  <span>PI: ${leader.performance_index}</span>
                </span>
                <div class="w-2 h-2 bg-amber-400 rounded-full border-2 border-white mx-auto mt-0.5 shadow-sm"></div>
              </div>
              <svg viewBox="0 0 ${W} ${H}" class="w-full h-full overflow-visible" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="dominoWaveGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#FACC15" stop-opacity="0.45"/>
                    <stop offset="100%" stop-color="#FACC15" stop-opacity="0.0"/>
                  </linearGradient>
                </defs>
                <path d="${area}" fill="url(#dominoWaveGradient)"></path>
                <path d="${line}" fill="none" stroke="#EAB308" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
              </svg>
            </div>`;
      domAxis = `
          <div class="flex justify-between text-[11px] font-black text-amber-900/60 pt-2 border-t border-amber-100">
            ${trend.map(pt => `<span title="${this.attr(pt.label)}">${pt.date ? `${pt.date.slice(8, 10)}/${pt.date.slice(5, 7)}` : '·'}</span>`).join('')}
          </div>`;
    } else {
      const msg = dom.kind === 'empty' ? 'Grafik muncul setelah ada game'
        : dom.kind === 'progress' ? `Grafik muncul setelah ada pemain yang memenuhi syarat (min. ${minG} game)`
        : dom.kind === 'single' ? 'Grafik muncul setelah ada pembanding (min. 2 pemain memenuhi syarat)'
        : 'Grafik tren muncul setelah beberapa sesi';
      domChart = `
            <div class="relative mt-4 h-24 flex items-center justify-center rounded-2xl border border-dashed border-amber-200 bg-amber-50/40">
              <p class="text-[11px] font-bold text-amber-800/70 text-center px-4">${msg}</p>
            </div>`;
    }

    // ---- Kartu Rasio: rata-rata pemain yang sudah bermain (— bila belum ada game) ----
    const played = calc.stats.filter(pl => pl.total_matches > 0);
    const avgOf = k => (played.length ? played.reduce((a, pl) => a + pl[k], 0) / played.length : null);
    const ringVal = v => (v === null ? 0 : Math.max(0, Math.min(100, v)));
    const ringLabel = v => (v === null ? '—' : `${Math.round(v)}%`);
    const aS100 = avgOf('s100_rate'), aS1000 = avgOf('s1000_rate'), aLoss = avgOf('loss_rate');
    const aLossCtl = aLoss === null ? null : Math.max(0, 100 - aLoss);
    const avgS100Rate = ringVal(aS100).toFixed(0), avgS100Label = ringLabel(aS100);
    const avgS1000Rate = ringVal(aS1000).toFixed(0), avgS1000Label = ringLabel(aS1000);
    const lossControlRate = ringVal(aLossCtl).toFixed(0), lossControlLabel = ringLabel(aLossCtl);

    const recentMatches = [...calc.seasonMatches].reverse().slice(0, 5);

    container.innerHTML = `
      <!-- GRID ROW 1: Bar Chart (Aktivitas Sesi) + Wave Chart (Dominasi Performa) -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
        
        <!-- CARD 1: AKTIVITAS (batang per tempat nongkrong; jumlahnya mengikuti data) -->
        <div class="lg:col-span-7 bg-white rounded-[26px] p-6 shadow-card border border-domino-border flex flex-col justify-between">
          <div class="flex items-center justify-between mb-6">
            <div>
              <h3 class="font-black text-lg text-domino-black tracking-tight">${act.mode === 'location' ? 'Aktivitas Tempat Nongkrong' : 'Aktivitas Sesi Nongkrong'}</h3>
              <p class="text-xs text-amber-800/80 mt-0.5">${act.mode === 'location' ? 'Jumlah game per lokasi nongkrong' : 'Jumlah game per sesi duduk. Isi lokasi pada sesi agar dikelompokkan per tempat'}</p>
            </div>
            <div class="flex items-baseline gap-1 bg-amber-50 px-3 py-1 rounded-xl border border-amber-200">
              <span class="text-xl font-black text-domino-red">${totalGames}</span>
              <span class="text-xs font-black text-amber-900">Total Game</span>
            </div>
          </div>

          ${act.bars.length === 0 ? `
          <div class="h-44 flex items-center justify-center rounded-2xl border border-dashed border-amber-200 bg-amber-50/40">
            <p class="text-xs font-bold text-amber-800/70">Belum ada sesi di season ini</p>
          </div>` : `
          <div style="display: grid; grid-template-columns: repeat(${act.bars.length}, minmax(0, 1fr));" class="gap-2.5 sm:gap-3 items-end h-44 pt-4 pb-2">
            ${act.bars.map(b => {
              const fillPct = b.games > 0 ? Math.max(18, Math.round((b.games / maxBarGames) * 100)) : 0;
              const barW = act.bars.length <= 3 ? 64 : 40;
              return `
                <div class="flex flex-col items-center h-full justify-end group min-w-0" title="${this.attr(b.label)}: ${b.games} game dalam ${b.sessions} sesi">
                  <span class="text-[10px] font-black ${b.active ? 'text-domino-red' : 'text-amber-800'} mb-1.5">${b.games} gm</span>
                  <div style="max-width: ${barW}px" class="w-full h-32 bg-domino-yellowLight rounded-2xl p-1 flex flex-col justify-end border border-amber-200/80 transition-all group-hover:bg-amber-100">
                    <div style="height: ${fillPct}%" class="w-full ${b.active ? 'bg-gradient-to-t from-domino-red to-rose-500 shadow-pill' : 'bg-domino-yellowDark'} rounded-xl transition-all duration-500 flex items-start justify-center pt-1.5 min-h-[6px]">
                      ${b.games > 0 ? `<span class="w-1.5 h-1.5 ${b.active ? 'bg-white' : 'bg-domino-red'} rounded-full"></span>` : ''}
                    </div>
                  </div>
                  <span class="text-xs font-black ${b.active ? 'text-domino-red' : 'text-slate-600'} mt-2 w-full text-center truncate">${this.esc(b.label)}</span>
                </div>`;
            }).join('')}
          </div>
          ${act.total > act.bars.length ? `<p class="text-[10px] text-amber-800/70 mt-1">Menampilkan ${act.bars.length} dari ${act.total} yang terbaru</p>` : ''}`}
        </div>

        <!-- CARD 2: DOMINASI KLASEMEN (murni dari data) -->
        <div class="lg:col-span-5 bg-white rounded-[26px] p-6 shadow-card border border-domino-border flex flex-col justify-between">
          <div>
            <div class="flex items-start justify-between">
              <div>
                <span class="text-[10px] font-black text-amber-800 uppercase tracking-widest block">Dominasi Klasemen</span>
                <div class="flex items-baseline gap-2 mt-1">
                  <h3 class="text-3xl font-black text-domino-black">${domPi}</h3>
                  ${dom.kind === 'ranked' ? '<span class="text-xs font-black text-domino-red px-2 py-0.5 bg-rose-50 rounded-full border border-rose-200">#1 Top</span>' : ''}
                </div>
                <p class="text-xs text-slate-500 font-medium mt-0.5">${domSub}</p>
              </div>

              <div class="w-36 space-y-2">
                <div>
                  <div class="flex justify-between text-[10px] font-black text-slate-600 mb-0.5">
                    <span>Ratus Rate</span>
                    <span class="text-domino-red font-black">${leader ? domPct(leader.s100_rate) : '—'}</span>
                  </div>
                  <div class="w-full h-1.5 bg-amber-100 rounded-full overflow-hidden">
                    <div style="width: ${leader ? domW(leader.s100_rate) : 0}%" class="h-full bg-domino-red rounded-full"></div>
                  </div>
                </div>

                <div>
                  <div class="flex justify-between text-[10px] font-black text-slate-600 mb-0.5">
                    <span>Ribu Rate</span>
                    <span class="text-domino-blue font-black">${leader ? domPct(leader.s1000_rate) : '—'}</span>
                  </div>
                  <div class="w-full h-1.5 bg-amber-100 rounded-full overflow-hidden">
                    <div style="width: ${leader ? domW(leader.s1000_rate) : 0}%" class="h-full bg-domino-blue rounded-full"></div>
                  </div>
                </div>

                <div>
                  <div class="flex justify-between text-[10px] font-black text-slate-600 mb-0.5">
                    <span>Loss Control</span>
                    <span class="text-amber-600 font-black">${leader ? domPct(domLossCtl) : '—'}</span>
                  </div>
                  <div class="w-full h-1.5 bg-amber-100 rounded-full overflow-hidden">
                    <div style="width: ${leader ? domW(domLossCtl) : 0}%" class="h-full bg-amber-500 rounded-full"></div>
                  </div>
                </div>
              </div>
            </div>
${domChart}
          </div>
${domAxis}
        </div>

      </div>

      <!-- GRID ROW 2: Table + Right Widgets -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
        
        <!-- CARD 3: PERTANDINGAN TERAKHIR (Table) -->
        <div class="lg:col-span-7 bg-white rounded-[26px] p-6 shadow-card border border-domino-border flex flex-col justify-between">
          <div>
            <div class="mb-5">
              <h3 class="font-black text-lg text-domino-black tracking-tight">Pertandingan Terakhir Meja</h3>
              <p class="text-xs text-amber-800/80 mt-0.5">${totalGames} pertandingan resmi tersimpan</p>
            </div>

            <!-- Table -->
            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse text-xs">
                <thead>
                  <tr class="text-amber-900/70 font-black text-[11px] border-b border-amber-100 uppercase tracking-wider">
                    <th class="py-2.5 px-3">
                      <span class="w-3.5 h-3.5 rounded-full bg-domino-red inline-block"></span>
                    </th>
                    <th class="py-2.5 px-3">Match</th>
                    <th class="py-2.5 px-3">4 Pemain di Meja</th>
                    <th class="py-2.5 px-3 text-center">Status</th>
                    <th class="py-2.5 px-3 text-center">Hasil</th>
                    <th class="py-2.5 px-3 text-right">Waktu</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-amber-50/80 text-slate-700 font-semibold">
                  ${recentMatches.length > 0 ? recentMatches.map(m => {
                    const matchLosses = this.state.loss_events.filter(le => le.match_id === m.match_id);
                    const matchSpecial = this.state.special_events.filter(se => se.match_id === m.match_id);
                    const hasSpecial = matchSpecial.length > 0;
                    const pNames = m.players.map(pId => {
                      const p = this.state.players.find(pl => pl.player_id === pId);
                      return p ? p.display_name : pId;
                    });

                    return `
                      <tr class="hover:bg-amber-50/50 transition">
                        <td class="py-3 px-3">
                          <span class="w-2 h-2 rounded-full bg-amber-400 inline-block"></span>
                        </td>
                        <td class="py-3 px-3 font-black text-domino-black font-mono">
                          ${m.match_id}
                        </td>
                        <td class="py-3 px-3">
                          <div class="flex items-center gap-2">
                            <div class="w-6 h-6 rounded-md bg-domino-yellow border border-amber-400 text-domino-red font-black text-[10px] flex items-center justify-center shrink-0 shadow-sm">
                              ${pNames[0].substring(0, 1)}
                            </div>
                            <span class="font-bold text-domino-black truncate max-w-[140px]">${pNames.join(', ')}</span>
                          </div>
                        </td>
                        <td class="py-3 px-3 text-center">
                          ${hasSpecial ? `
                            <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-black bg-sky-100 text-domino-blue border border-sky-200">
                              Ratus / Ribu
                            </span>
                          ` : `
                            <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-black bg-amber-100 text-amber-900 border border-amber-300">
                              Selesai
                            </span>
                          `}
                        </td>
                        <td class="py-3 px-3 text-center">
                          <span class="text-[11px] font-black text-domino-red">
                            ${matchLosses.reduce((a, b) => a + Number(b.loss_count), 0)} kalah
                            ${hasSpecial ? ` • <span class="text-domino-blue font-bold">${matchSpecial.reduce((a, b) => a + Number(b.quantity), 0)} S-Event</span>` : ''}
                          </span>
                        </td>
                        <td class="py-3 px-3 text-right text-slate-400 text-[11px] whitespace-nowrap">
                          ${m.played_at ? m.played_at.split(' ')[0] : 'Selesai'}
                        </td>
                      </tr>
                    `;
                  }).join('') : `
                    <tr><td colspan="6" class="py-6 text-center text-slate-400 font-medium">Belum ada pertandingan dicatat.</td></tr>
                  `}
                </tbody>
              </table>
            </div>
          </div>

          <div class="mt-4 pt-3 border-t border-amber-100 flex items-center justify-between text-xs text-amber-800">
            <span>Satu game wajib tepat 4 pemain berbeda.</span>
            <button onclick="app.switchTab('stats')" class="text-domino-red hover:text-red-800 font-black flex items-center gap-1">
              Lihat Klasemen Lengkap &rarr;
            </button>
          </div>
        </div>

        <!-- RIGHT COLUMN: Progress Circulars + Split Bottom Cards -->
        <div class="lg:col-span-5 space-y-5">
          
          <!-- CARD 4: PROGRESS CIRCULAR DONUTS (Domino Red, ACBC Blue, Domino Gold) -->
          <div class="bg-white rounded-[26px] p-6 shadow-card border border-domino-border">
            <div class="flex items-center justify-between mb-5">
              <h3 class="font-black text-base text-domino-black tracking-tight">Rasio & Efisiensi Musim</h3>
              <span class="text-amber-800 font-black text-sm tracking-widest cursor-pointer">•••</span>
            </div>

            <!-- 3 Donut Rings -->
            <div class="grid grid-cols-3 gap-2 text-center">
              <!-- Donut 1: Domino Red (Ratus Rate) -->
              <div class="flex flex-col items-center">
                <div class="relative w-16 h-16 flex items-center justify-center">
                  <svg class="w-full h-full transform -rotate-90" viewBox="0 0 36 36">
                    <path class="text-amber-100" stroke-width="3.5" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                    <path class="text-domino-red" stroke-width="3.5" stroke-dasharray="${avgS100Rate}, 100" stroke-linecap="round" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                  </svg>
                  <span class="absolute font-black text-xs text-domino-black">${avgS100Label}</span>
                </div>
                <span class="text-[11px] font-black text-domino-red mt-2">Ratus Rate</span>
              </div>

              <!-- Donut 2: ACBC Blue (Ribu Rate) -->
              <div class="flex flex-col items-center">
                <div class="relative w-16 h-16 flex items-center justify-center">
                  <svg class="w-full h-full transform -rotate-90" viewBox="0 0 36 36">
                    <path class="text-amber-100" stroke-width="3.5" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                    <path class="text-domino-blue" stroke-width="3.5" stroke-dasharray="${avgS1000Rate}, 100" stroke-linecap="round" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                  </svg>
                  <span class="absolute font-black text-xs text-domino-black">${avgS1000Label}</span>
                </div>
                <span class="text-[11px] font-black text-domino-blue mt-2">Ribu Rate</span>
              </div>

              <!-- Donut 3: Domino Golden Yellow (Loss Control) -->
              <div class="flex flex-col items-center">
                <div class="relative w-16 h-16 flex items-center justify-center">
                  <svg class="w-full h-full transform -rotate-90" viewBox="0 0 36 36">
                    <path class="text-amber-100" stroke-width="3.5" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                    <path class="text-amber-500" stroke-width="3.5" stroke-dasharray="${lossControlRate}, 100" stroke-linecap="round" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                  </svg>
                  <span class="absolute font-black text-xs text-domino-black">${lossControlLabel}</span>
                </div>
                <span class="text-[11px] font-black text-amber-700 mt-2">Loss Control</span>
              </div>
            </div>
          </div>

          <!-- SPLIT BOTTOM CARDS: Dark Card + MVP Card -->
          <div class="grid grid-cols-2 gap-4">
            
            <!-- CARD 5: DARK CARD (Charcoal Black ala Kartu Domino) -->
            <div class="bg-domino-black text-white rounded-[24px] p-5 shadow-lg flex flex-col justify-between relative overflow-hidden border border-stone-800">
              <div class="flex items-center justify-between mb-3">
                <span class="text-xs font-bold text-amber-400">Musim Aktif</span>
                <!-- Mini Bar Sparkline in Yellow & Red -->
                <div class="flex items-end gap-1 h-6">
                  <div class="w-1.5 h-3 bg-domino-yellow rounded-full"></div>
                  <div class="w-1.5 h-5 bg-domino-red rounded-full"></div>
                  <div class="w-1.5 h-4 bg-domino-blue rounded-full"></div>
                  <div class="w-1.5 h-6 bg-domino-yellow rounded-full"></div>
                </div>
              </div>

              <div class="space-y-3">
                <div>
                  <h4 class="text-2xl font-black text-white leading-none">${totalGames}+</h4>
                  <span class="text-[11px] text-amber-200/70 font-semibold">Pertandingan Resmi</span>
                </div>
                <div>
                  <h4 class="text-xl font-black text-white leading-none">${this.state.players.length}</h4>
                  <span class="text-[11px] text-amber-200/70 font-semibold">Anggota Terdaftar</span>
                </div>
              </div>

              <div class="mt-4 pt-2 border-t border-stone-800 flex items-center justify-between text-[10px] text-amber-300">
                <span>Domino League</span>
                <span class="text-domino-yellow font-bold">100% Valid</span>
              </div>
            </div>

            ${this.mvpCardHtml()}

          </div>

        </div>

      </div>
    `;
  }

  // ==========================================
  // VIEW: INPUT SKOR & SESI NONGKRONG (TERPADU)
  // Alur: Tambah Sesi Dulu -> Lalu Input Skor di Sesi Tersebut
  // ==========================================
  handleQuickInputSkor() {
    if (this.guardLocked()) return;
    const seasonId = this.state.current_season_id;
    const seasonSessions = this.state.sessions.filter(s => s.season_id === seasonId);
    const activeSession = seasonSessions.find(s => s.status === 'active');

    if (activeSession) {
      this.openInputMatchModal(activeSession.session_id);
    } else {
      this.switchTab('input-game');
      if (seasonSessions.length === 0) {
        this.openNewSessionModal();
      } else {
        alert('Belum ada sesi nongkrong yang sedang aktif. Silakan buat sesi baru atau buka kembali sesi sebelumnya untuk memasukkan skor!');
      }
    }
  }

  renderInputGame() {
    const container = document.getElementById('view-input-game');
    if (!container) return;
    const locked = this.isSeasonLocked();

    const seasonId = this.state.current_season_id;
    const seasonSessions = this.state.sessions.filter(s => s.season_id === seasonId);

    container.innerHTML = `
      <div class="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 class="text-xl font-black text-domino-black tracking-tight">Sesi Nongkrong & Input Skor</h3>
          <p class="text-xs text-amber-800 font-medium mt-0.5">
            Buat sesi nongkrong terlebih dahulu saat mulai kumpul, lalu klik tombol "+ Input Skor Game" pada sesi yang aktif.
          </p>
          ${locked ? '<p class="text-xs font-black text-domino-red mt-1.5">🔒 Season ini sudah difinalisasi dan terkunci. Mulai season baru di menu Arsip & Finalisasi untuk lanjut mencatat game.</p>' : ''}
        </div>
        ${locked ? '' : `<button onclick="app.openNewSessionModal()" class="px-5 py-2.5 bg-domino-red hover:bg-domino-redHover text-white font-black text-xs rounded-2xl shadow-pill transition flex items-center gap-1.5 active:scale-95">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
          <span>+ Buat Sesi Nongkrong Baru</span>
        </button>`}
      </div>

      ${this.pendingProposalsHtml()}

      ${seasonSessions.length === 0 ? `
        <!-- Empty State: Wajib Tambah Sesi Terlebih Dahulu -->
        <div class="bg-white rounded-[26px] p-10 text-center shadow-card border border-domino-border max-w-lg mx-auto my-6">
          <div class="w-16 h-16 rounded-full bg-amber-100 text-domino-red flex items-center justify-center text-3xl mx-auto mb-4 border border-amber-300">
            📅
          </div>
          <h4 class="text-lg font-black text-domino-black">Belum Ada Sesi Nongkrong</h4>
          <p class="text-xs text-amber-900/80 mt-1 mb-6 leading-relaxed">
            Untuk mulai memasukkan skor pertandingan, Anda harus membuat sesi nongkrong terlebih dahulu (misal: "Nongkrong Warkop Sabar Malam Ini").
          </p>
          <button onclick="app.openNewSessionModal()" class="px-6 py-3 bg-domino-red hover:bg-domino-redHover text-white font-black text-xs rounded-2xl shadow-pill transition">
            + Buat Sesi Nongkrong Pertama
          </button>
        </div>
      ` : `
        <!-- List Sesi Nongkrong dengan Tombol Input Skor Terintegrasi -->
        <div class="space-y-5">
          ${seasonSessions.map(session => {
            const sMatches = this.state.matches.filter(m => m.session_id === session.session_id);
            const sMatchIds = new Set(sMatches.map(m => m.match_id));
            
            // Rekap total kalah pemain di sesi ini
            const sessionPlayerLoss = {};
            this.state.loss_events.forEach(le => {
              if (sMatchIds.has(le.match_id)) {
                sessionPlayerLoss[le.player_id] = (sessionPlayerLoss[le.player_id] || 0) + (Number(le.loss_count) || 0);
              }
            });

            const isActive = session.status === 'active';

            return `
              <div class="bg-white rounded-[26px] p-6 shadow-card border ${isActive ? 'border-amber-400 ring-2 ring-amber-400/20' : 'border-domino-border'} transition">
                
                <!-- Sesi Header Bar -->
                <div class="flex flex-wrap items-center justify-between gap-3 border-b border-amber-100 pb-4 mb-4">
                  <div class="flex items-center gap-3.5">
                    <span class="px-3 py-1.5 text-xs font-mono font-black rounded-xl ${isActive ? 'bg-domino-yellow text-amber-950 border border-amber-400' : 'bg-slate-100 text-slate-600'}">
                      ${session.session_id}
                    </span>
                    <div>
                      <h4 class="font-black text-domino-black text-base flex items-center gap-2">
                        <span>${this.esc(session.session_label || 'Sesi Tanpa Judul')}</span>
                        ${isActive ? '<span class="text-[10px] font-black px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">🟢 AKTIF</span>' : '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">🔒 DITUTUP</span>'}
                      </h4>
                      <p class="text-xs text-amber-800/80 font-medium">Tanggal: ${session.session_date}${session.location ? ' · 📍 ' + this.esc(session.location) : ''}</p>
                    </div>
                  </div>

                  <!-- Actions Tombol Input Skor di Sesi Ini -->
                  <div class="flex items-center gap-2.5">
                    ${locked ? '<span class="text-[11px] font-black text-slate-400">🔒 Season terkunci</span>' : isActive ? `
                      <button onclick="app.openInputMatchModal('${session.session_id}')" class="px-5 py-2.5 bg-domino-red hover:bg-domino-redHover text-white font-black text-xs rounded-2xl shadow-pill transition flex items-center gap-2 active:scale-95">
                        <span class="text-sm">⚡</span>
                        <span>+ Input Skor Game di Sesi Ini</span>
                      </button>
                      <button onclick="app.toggleSessionStatus('${session.session_id}')" title="Tutup Sesi jika nongkrong selesai" class="px-3.5 py-2 bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-900 font-bold text-xs rounded-2xl transition">
                        Tutup Sesi
                      </button>
                    ` : `
                      <button onclick="app.toggleSessionStatus('${session.session_id}')" class="px-4 py-2 bg-amber-100 hover:bg-amber-200 text-amber-950 font-black text-xs rounded-2xl border border-amber-300 transition">
                        Buka Kembali Sesi
                      </button>
                    `}
                    ${locked ? '' : `
                      <button onclick="app.openEditSessionModal('${session.session_id}')" title="Ubah nama, tanggal, dan catatan sesi" class="w-9 h-9 rounded-2xl bg-white hover:bg-amber-50 border border-amber-200 text-sm transition">✏️</button>
                      <button onclick="app.deleteSession('${session.session_id}')" title="Hapus sesi" class="w-9 h-9 rounded-2xl bg-white hover:bg-rose-50 border border-amber-200 text-sm transition">🗑️</button>
                    `}
                  </div>
                </div>

                ${session.notes ? `<p class="text-xs text-amber-900/80 italic mb-3.5">Catatan: "${this.esc(session.notes)}"</p>` : ''}

                <!-- Rekap Total Kalah Pemain pada Sesi Ini -->
                <div class="bg-domino-yellowLight p-4 rounded-2xl border border-amber-200/90 mb-4">
                  <div class="flex items-center justify-between mb-2">
                    <p class="text-[11px] font-black text-amber-900 uppercase tracking-wider">
                      Rekap Total Kekalahan Pemain di Sesi Ini:
                    </p>
                    <span class="text-xs font-black text-amber-950">${sMatches.length} Game Dimainkan</span>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    ${Object.keys(sessionPlayerLoss).length > 0 ? Object.entries(sessionPlayerLoss).map(([pId, count]) => {
                      const p = this.state.players.find(pl => pl.player_id === pId) || { display_name: pId };
                      return `
                        <span class="inline-flex items-center px-3 py-1.5 rounded-xl text-xs font-black bg-white text-domino-red border border-amber-300 shadow-sm">
                          <strong class="mr-1.5 text-domino-black">${p.display_name}:</strong> ${count} kalah
                        </span>
                      `;
                    }).join('') : '<span class="text-xs text-amber-800 italic">Belum ada game yang dicatat di sesi ini. Klik tombol merah di atas untuk input skor!</span>'}
                  </div>
                </div>

                <!-- Daftar Pertandingan di Sesi Ini -->
                ${sMatches.length > 0 ? `
                  <div class="mt-3">
                    <p class="text-[11px] font-black text-slate-500 uppercase tracking-wider mb-2">Game yang Telah Tercatat:</p>
                    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                      ${sMatches.map(m => {
                        const mLoss = this.state.loss_events.filter(le => le.match_id === m.match_id);
                        const mSpecial = this.state.special_events.filter(se => se.match_id === m.match_id);
                        const pNames = m.players.map(pId => {
                          const p = this.state.players.find(pl => pl.player_id === pId);
                          return p ? p.display_name : pId;
                        });

                        return `
                          <div class="bg-white border border-slate-200 p-3 rounded-2xl flex items-center justify-between shadow-sm">
                            <div>
                              <div class="flex items-center gap-1.5">
                                <span class="font-black text-xs text-domino-black font-mono">${m.match_id}</span>
                                <span class="text-[10px] text-slate-400">• ${m.played_at ? m.played_at.split(' ')[1] : ''}</span>
                              </div>
                              <p class="text-[11px] font-bold text-slate-700 truncate max-w-[170px]">${pNames.join(', ')}</p>
                              <p class="text-[10px] text-domino-red font-black mt-0.5">
                                ${mLoss.reduce((a,b)=>a+Number(b.loss_count),0)} kalah
                                ${mSpecial.length > 0 ? `• <span class="text-domino-blue">${mSpecial.reduce((a,b)=>a+Number(b.quantity),0)} S-Event</span>` : ''}
                              </p>
                            </div>
                            ${locked ? '' : `<div class="flex items-center">
                              <button onclick="app.openInputMatchModal('${session.session_id}', '${m.match_id}')" title="Edit Game" class="w-7 h-7 rounded-xl hover:bg-amber-50 text-slate-300 hover:text-amber-900 flex items-center justify-center transition text-xs">✏️</button>
                              <button onclick="app.deleteMatch('${m.match_id}')" title="Hapus Game" class="w-7 h-7 rounded-xl hover:bg-rose-50 text-slate-300 hover:text-domino-red flex items-center justify-center transition">&times;</button>
                            </div>`}
                          </div>
                        `;
                      }).join('')}
                    </div>
                  </div>
                ` : ''}

              </div>
            `;
          }).join('')}
        </div>
      `}
    `;
  }

  // ==========================================
  // MODAL FORM INPUT SKOR PERTANDINGAN
  // ==========================================
  openInputMatchModal(sessionId, matchId = null) {
    if (this.guardLocked()) return;
    const session = this.state.sessions.find(s => s.session_id === sessionId);
    const editMatch = matchId ? this.state.matches.find(m => m.match_id === matchId) : null;
    // Saat edit, pemain nonaktif yang ikut game tetap harus muncul di daftar
    const activePlayers = this.state.players.filter(p => p.is_active || (editMatch && editMatch.players.includes(p.player_id)));

    this._eventDraft = {};
    if (editMatch) {
      this.state.loss_events.filter(le => le.match_id === editMatch.match_id).forEach(le => {
        this._eventDraft[`loss-${le.player_id}`] = (this._eventDraft[`loss-${le.player_id}`] || 0) + (Number(le.loss_count) || 0);
      });
      this.state.special_events.filter(se => se.match_id === editMatch.match_id).forEach(se => {
        const key = (se.event_type === 'S1000' ? 's1000-' : 's100-') + se.player_id;
        this._eventDraft[key] = (this._eventDraft[key] || 0) + (Number(se.quantity) || 0);
      });
    }

    const modalHtml = `
      <div class="modal-backdrop fixed inset-0 bg-black/60 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
        <div class="bg-white rounded-[28px] max-w-2xl w-full p-6 sm:p-7 shadow-2xl border border-domino-border my-8">
          
          <!-- Header Modal -->
          <div class="border-b border-amber-100 pb-4 mb-5 flex items-center justify-between">
            <div>
              <div class="flex items-center gap-2">
                <span class="w-7 h-7 rounded-xl bg-domino-red text-white flex items-center justify-center font-black text-xs shadow-sm">⚡</span>
                <h3 class="text-xl font-black text-domino-black tracking-tight">${editMatch ? 'Edit Game ' + editMatch.match_id : 'Input Skor Game'}</h3>
              </div>
              <p class="text-xs text-amber-900 font-bold mt-1">
                Sesi: <span class="text-domino-red">${session ? session.session_id + ' - ' + (session.session_label || 'Sesi') : sessionId}</span> (${session ? session.session_date : ''})
              </p>
            </div>
            <button data-close-modal class="text-slate-400 hover:text-domino-black text-xl font-bold">&times;</button>
          </div>

          <form id="form-add-match" onsubmit="app.handleSaveMatch(event, '${sessionId}', ${editMatch ? `'${editMatch.match_id}'` : 'null'})">
            ${editMatch && !this.isInGrace(editMatch) ? '<div class="mb-4 p-3 rounded-2xl bg-amber-50 border border-amber-300 text-[11px] font-bold text-amber-900">ℹ️ Game ini sudah lewat masa koreksi cepat. Perubahan akan diajukan dan baru berlaku setelah pemain lain di game ini mengesahkan.</div>' : ''}
            <!-- 4 Pemain Berbeda -->
            <div class="mb-6">
              <label class="block text-xs font-black text-amber-950 uppercase tracking-wider mb-2">
                Pilih 4 Pemain di Meja <span class="text-domino-red">*</span>
              </label>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                ${[1, 2, 3, 4].map(seat => `
                  <div class="p-3 rounded-2xl bg-domino-yellowLight border border-amber-200">
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-[11px] font-black text-amber-900 uppercase">Kursi ${seat}</span>
                      <span class="text-[10px] text-amber-700 font-mono font-bold">Seat #${seat}</span>
                    </div>
                    <select id="match-player-${seat}" onchange="app.validateMatchPlayerSelections()" class="match-player-select w-full bg-white border border-amber-300 rounded-xl px-3 py-2 text-xs font-black text-domino-black focus:outline-none focus:ring-2 focus:ring-amber-500/40">
                      <option value="">-- Pilih Pemain --</option>
                      ${activePlayers.map((p, idx) => `
                        <option value="${p.player_id}" ${(editMatch ? editMatch.players[seat - 1] === p.player_id : idx === (seat - 1)) ? 'selected' : ''}>
                          ${p.display_name} (${p.player_id})
                        </option>
                      `).join('')}
                    </select>
                  </div>
                `).join('')}
              </div>
              <p id="player-validation-msg" class="text-xs text-domino-red font-bold mt-2 hidden">
                ⚠️ Keempat pemain harus orang yang berbeda!
              </p>
            </div>

            <!-- Detail Kekalahan & Ratus/Ribu per Pemain -->
            <div class="mb-6">
              <label class="block text-xs font-black text-amber-950 uppercase tracking-wider mb-2">
                Catat Kekalahan & Kejadian Ratus / Ribu
              </label>
              <div class="space-y-3" id="match-events-container"></div>
            </div>

            <!-- Catatan Game -->
            <div class="mb-6">
              <label class="block text-xs font-black text-amber-950 uppercase tracking-wider mb-1.5">
                Catatan Pertandingan (Opsional)
              </label>
              <input type="text" id="match-notes" value="${editMatch ? this.attr(editMatch.notes) : ''}" placeholder="Contoh: Balak 6 jatuh, Andi Ratus spektakuler" class="w-full bg-amber-50/70 border border-amber-200 rounded-2xl px-4 py-2.5 text-xs text-domino-black font-semibold focus:outline-none focus:ring-2 focus:ring-amber-500/30">
            </div>

            <!-- Buttons -->
            <div class="pt-4 border-t border-amber-100 flex items-center justify-end gap-3">
              <button type="button" data-close-modal class="px-5 py-2.5 text-xs font-black text-slate-500 hover:text-domino-black transition">
                Batal
              </button>
              <button type="submit" id="btn-submit-match" class="px-6 py-2.5 bg-domino-red hover:bg-domino-redHover text-white font-black text-xs rounded-2xl shadow-pill transition active:scale-95 flex items-center gap-2">
                <span>💾</span> ${editMatch ? (this.isInGrace(editMatch) ? 'Simpan Perubahan' : 'Lanjut: Ajukan Perubahan') : 'Simpan Hasil Game'}
              </button>
            </div>
          </form>
        </div>
      </div>
    `;

    this.showModal(modalHtml);
    this.updateMatchEventsUI();
  }

  async deleteMatch(matchId) {
    if (this.guardLocked()) return;
    const m = this.state.matches.find(x => x.match_id === matchId);
    if (!m) return;
    if (this.isInGrace(m)) {
      if (!confirm(`Hapus game ${matchId}? Tindakan ini mengubah statistik.`)) return;
      const res = await this.cmd('delete_match', { match_id: matchId }, { mode: 'direct' });
      if (res.ok) { this.render(); return; }
      if (res.code !== 'NEEDS_APPROVAL') { this.showError(res); return; }
    }
    this.openGameChangeChoice('delete_match', { match_id: matchId }, `Hapus game ${matchId}`, 'Game ini sudah lewat masa koreksi cepat, jadi penghapusan harus disahkan pemain lain di game ini.');
  }

  async toggleSessionStatus(sessionId) {
    if (this.guardLocked()) return;
    const res = await this.cmd('toggle_session', { session_id: sessionId });
    if (!res.ok) { this.showError(res); return; }
    this.render();
  }

  updateMatchEventsUI() {
    const container = document.getElementById('match-events-container');
    if (!container) return;

    // Simpan angka yang sudah diisi supaya tidak hilang saat pemain di kursi diganti
    container.querySelectorAll('input[type="number"]').forEach(inp => {
      this._eventDraft[inp.id] = parseInt(inp.value, 10) || 0;
    });

    const p1 = document.getElementById('match-player-1')?.value;
    const p2 = document.getElementById('match-player-2')?.value;
    const p3 = document.getElementById('match-player-3')?.value;
    const p4 = document.getElementById('match-player-4')?.value;

    const selectedPlayerIds = [p1, p2, p3, p4].filter(Boolean);

    if (selectedPlayerIds.length === 0) {
      container.innerHTML = `<p class="text-xs text-amber-800 italic p-3 text-center">Pilih 4 pemain di atas untuk memasukkan hasil.</p>`;
      return;
    }

    container.innerHTML = selectedPlayerIds.map(pId => {
      const player = this.state.players.find(p => p.player_id === pId) || { display_name: pId };
      return `
        <div class="p-3.5 rounded-2xl bg-white border border-amber-200 shadow-sm flex flex-wrap items-center justify-between gap-3">
          <div class="w-28">
            <p class="font-black text-xs text-domino-black">${player.display_name}</p>
            <span class="text-[10px] text-amber-700 font-mono font-bold">${pId}</span>
          </div>

          <!-- Input Kalah -->
          <div class="flex items-center gap-2">
            <label class="text-[11px] text-domino-red font-black">Kalah:</label>
            <div class="flex items-center bg-rose-50 rounded-xl border border-rose-200 overflow-hidden">
              <button type="button" onclick="app.adjustCounter('loss-${pId}', -1)" class="w-7 h-7 hover:bg-rose-200 text-domino-red font-black text-xs">-</button>
              <input type="number" id="loss-${pId}" value="${this._eventDraft['loss-' + pId] || 0}" min="0" class="w-8 h-7 bg-transparent text-center text-xs font-black text-domino-red focus:outline-none">
              <button type="button" onclick="app.adjustCounter('loss-${pId}', 1)" class="w-7 h-7 hover:bg-rose-200 text-domino-red font-black text-xs">+</button>
            </div>
          </div>

          <!-- Input Ratus -->
          <div class="flex items-center gap-2">
            <label class="text-[11px] text-amber-700 font-black" title="Ratus (2 kartu: 1 balak + 1 bukan)">Ratus:</label>
            <div class="flex items-center bg-amber-50 rounded-xl border border-amber-300 overflow-hidden">
              <button type="button" onclick="app.adjustCounter('s100-${pId}', -1)" class="w-7 h-7 hover:bg-amber-200 text-amber-900 font-black text-xs">-</button>
              <input type="number" id="s100-${pId}" value="${this._eventDraft['s100-' + pId] || 0}" min="0" class="w-8 h-7 bg-transparent text-center text-xs font-black text-amber-900 focus:outline-none">
              <button type="button" onclick="app.adjustCounter('s100-${pId}', 1)" class="w-7 h-7 hover:bg-amber-200 text-amber-900 font-black text-xs">+</button>
            </div>
          </div>

          <!-- Input Ribu -->
          <div class="flex items-center gap-2">
            <label class="text-[11px] text-domino-blue font-black" title="Ribu (3 kartu serentak)">Ribu:</label>
            <div class="flex items-center bg-sky-50 rounded-xl border border-sky-300 overflow-hidden">
              <button type="button" onclick="app.adjustCounter('s1000-${pId}', -1)" class="w-7 h-7 hover:bg-sky-200 text-domino-blue font-black text-xs">-</button>
              <input type="number" id="s1000-${pId}" value="${this._eventDraft['s1000-' + pId] || 0}" min="0" class="w-8 h-7 bg-transparent text-center text-xs font-black text-domino-blue focus:outline-none">
              <button type="button" onclick="app.adjustCounter('s1000-${pId}', 1)" class="w-7 h-7 hover:bg-sky-200 text-domino-blue font-black text-xs">+</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  adjustCounter(id, delta) {
    const el = document.getElementById(id);
    if (!el) return;
    const current = parseInt(el.value, 10) || 0;
    el.value = Math.max(0, current + delta);
  }

  validateMatchPlayerSelections() {
    const p1 = document.getElementById('match-player-1')?.value;
    const p2 = document.getElementById('match-player-2')?.value;
    const p3 = document.getElementById('match-player-3')?.value;
    const p4 = document.getElementById('match-player-4')?.value;

    const set = new Set([p1, p2, p3, p4]);
    const isValid = set.size === 4 && !set.has('');
    const msg = document.getElementById('player-validation-msg');
    const submitBtn = document.getElementById('btn-submit-match');

    if (msg) {
      if (!isValid) msg.classList.remove('hidden');
      else msg.classList.add('hidden');
    }
    if (submitBtn) submitBtn.disabled = !isValid;

    this.updateMatchEventsUI();
  }

  collectMatchForm(sessionId) {
    const players = [1, 2, 3, 4].map(i => document.getElementById(`match-player-${i}`)?.value || '');
    if (new Set(players).size !== 4 || players.includes('')) {
      alert('Peringatan: Satu game wajib tepat 4 pemain berbeda!');
      return null;
    }
    const n = id => Math.max(0, parseInt(document.getElementById(id)?.value || '0', 10) || 0);
    const losses = {}, ratus = {}, ribu = {};
    players.forEach(p => { losses[p] = n(`loss-${p}`); ratus[p] = n(`s100-${p}`); ribu[p] = n(`s1000-${p}`); });
    return {
      session_id: sessionId || document.getElementById('match-session-id')?.value,
      players, notes: document.getElementById('match-notes')?.value || '', losses, ratus, ribu
    };
  }

  async handleSaveMatch(event, targetSessionId, editMatchId = null) {
    event.preventDefault();
    if (this.guardLocked()) return;
    const form = this.collectMatchForm(targetSessionId);
    if (!form) return;

    const btn = document.getElementById('btn-submit-match');
    const label = editMatchId ? '<span>💾</span> Simpan Perubahan' : '<span>💾</span> Simpan Hasil Game';
    const busy = (b) => { if (btn) { btn.disabled = b; btn.innerHTML = b ? 'Menyimpan...' : label; } };

    if (!editMatchId) {
      busy(true);
      const res = await this.cmd('add_match', form);
      if (!res.ok) { busy(false); this.showError(res); return; }
      this.closeModal();
      alert(`✅ Pertandingan ${res.data.match_id} berhasil disimpan pada sesi ${form.session_id}!`);
      this.render();
      return;
    }

    const m = this.state.matches.find(x => x.match_id === editMatchId);
    if (!m) { alert('Game yang akan diedit tidak ditemukan.'); this.closeModal(); return; }
    const payload = { match_id: editMatchId, ...form, session_id: m.session_id };

    if (this.isInGrace(m)) {
      busy(true);
      const res = await this.cmd('edit_match', payload, { mode: 'direct' });
      if (res.ok) { this.closeModal(); alert(`✅ Game ${editMatchId} berhasil diperbarui!`); this.render(); return; }
      busy(false);
      if (res.code !== 'NEEDS_APPROVAL') { this.showError(res); return; }
    }
    this.openGameChangeChoice('edit_match', payload, `Ubah game ${editMatchId}`, 'Game ini sudah lewat masa koreksi cepat, jadi perubahan harus disahkan pemain lain di game ini.');
  }

  openNewSessionModal() {
    if (this.guardLocked()) return;
    const nextId = this.nextId('SES', this.state.sessions, 'session_id', 3);
    const today = this.state.today || new Date().toISOString().split('T')[0];

    const modalHtml = `
      <div class="modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-[26px] max-w-md w-full p-6 shadow-2xl border border-domino-border">
          <h3 class="text-lg font-black text-domino-black mb-4">Buat Sesi Nongkrong Baru</h3>
          <form onsubmit="app.handleCreateSession(event)">
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-900 mb-1">Session ID</label>
              <input type="text" id="new-ses-id" value="Otomatis" readonly class="w-full bg-amber-50/70 border border-amber-200 rounded-xl p-2.5 text-xs text-amber-900 font-mono font-bold">
            </div>
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-950 mb-1">Tanggal</label>
              <input type="date" id="new-ses-date" value="${today}" required class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-xs font-bold text-domino-black">
            </div>
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-950 mb-1">Nama / Label Sesi</label>
              <input type="text" id="new-ses-label" placeholder="Contoh: Malam Minggu Warkop Sabar" class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-xs text-domino-black font-semibold">
            </div>
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-950 mb-1">Lokasi / Tempat Nongkrong</label>
              <input type="text" id="new-ses-location" list="location-options" maxlength="60" placeholder="Contoh: Warkop Sabar" class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-xs text-domino-black font-semibold">
              <datalist id="location-options">${this.knownLocations().map(l => `<option value="${this.attr(l)}"></option>`).join('')}</datalist>
              <p class="text-[10px] text-amber-800/70 mt-1">Opsional. Grafik di Dashboard dikelompokkan per lokasi.</p>
            </div>
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-950 mb-1">Catatan</label>
              <textarea id="new-ses-notes" rows="2" placeholder="Catatan tambahan..." class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-xs text-domino-black font-medium"></textarea>
            </div>
            <div class="flex justify-end gap-2 pt-3 border-t border-amber-100">
              <button type="button" data-close-modal class="px-4 py-2 text-xs font-bold text-slate-400">Batal</button>
              <button type="submit" class="px-5 py-2.5 bg-domino-red hover:bg-domino-redHover text-white rounded-xl font-black text-xs shadow-pill">Simpan Sesi</button>
            </div>
          </form>
        </div>
      </div>
    `;
    this.showModal(modalHtml);
  }

  openEditSessionModal(sessionId) {
    if (this.guardLocked()) return;
    const s = this.state.sessions.find(x => x.session_id === sessionId);
    if (!s) return;
    this.showModal(`
      <div class="modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-[26px] max-w-md w-full p-6 shadow-2xl border border-domino-border">
          <h3 class="text-lg font-black text-domino-black mb-4">Ubah Sesi ${this.esc(s.session_id)}</h3>
          <form onsubmit="app.handleEditSession(event, '${s.session_id}')">
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-950 mb-1">Tanggal</label>
              <input type="date" id="edit-ses-date" value="${this.attr(s.session_date)}" required class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-xs font-bold text-domino-black">
            </div>
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-950 mb-1">Nama / Label Sesi</label>
              <input type="text" id="edit-ses-label" value="${this.attr(s.session_label)}" maxlength="80" required class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-xs text-domino-black font-semibold">
            </div>
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-950 mb-1">Lokasi / Tempat Nongkrong</label>
              <input type="text" id="edit-ses-location" list="location-options" value="${this.attr(s.location || '')}" maxlength="60" placeholder="Contoh: Warkop Sabar" class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-xs text-domino-black font-semibold">
              <datalist id="location-options">${this.knownLocations().map(l => `<option value="${this.attr(l)}"></option>`).join('')}</datalist>
            </div>
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-950 mb-1">Keterangan / Catatan</label>
              <textarea id="edit-ses-notes" rows="3" maxlength="200" class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-xs text-domino-black font-medium">${this.esc(s.notes || '')}</textarea>
            </div>
            <div class="flex justify-end gap-2 pt-3 border-t border-amber-100">
              <button type="button" data-close-modal class="px-4 py-2 text-xs font-bold text-slate-400">Batal</button>
              <button type="submit" class="px-5 py-2.5 bg-domino-red hover:bg-domino-redHover text-white rounded-xl font-black text-xs shadow-pill">Simpan Perubahan</button>
            </div>
          </form>
        </div>
      </div>`);
  }

  async handleEditSession(e, sessionId) {
    e.preventDefault();
    if (this.guardLocked()) return;
    const label = (document.getElementById('edit-ses-label')?.value || '').trim();
    if (!label) { alert('Nama sesi wajib diisi.'); return; }
    const res = await this.cmd('edit_session', {
      session_id: sessionId, label,
      location: (document.getElementById('edit-ses-location')?.value || '').trim(),
      date: document.getElementById('edit-ses-date')?.value,
      notes: document.getElementById('edit-ses-notes')?.value || ''
    });
    if (!res.ok) { this.showError(res); return; }
    this.closeModal();
    this.render();
  }

  async deleteSession(sessionId) {
    if (this.guardLocked()) return;
    const s = this.state.sessions.find(x => x.session_id === sessionId);
    if (!s) return;
    const n = this.state.matches.filter(m => m.session_id === sessionId).length;
    const name = s.session_label || s.session_id;
    if (n === 0) {
      if (!confirm(`Hapus sesi "${name}"? Sesi ini belum memiliki game.`)) return;
      const res = await this.cmd('delete_session', { session_id: sessionId });
      if (!res.ok) { this.showError(res); return; }
      this.render();
      return;
    }
    if (!(this.state.config && this.state.config.force_enabled)) {
      alert(`Sesi "${name}" berisi ${n} game, jadi tidak bisa dihapus langsung.\n\nHapus game-nya satu per satu (butuh pengesahan pemain lain), lalu hapus sesinya.`);
      return;
    }
    this._change = {
      command: 'delete_session', payload: { session_id: sessionId }, title: `Hapus sesi ${name}`, desc: '', forceOnly: true,
      intro: `Sesi "${name}" dan SEMUA ${n} game di dalamnya akan dihapus permanen. Server membuat backup otomatis sebelum menghapus.`
    };
    this.openForceModal();
  }

  // Lokasi yang pernah dipakai (untuk saran isian, agar penulisannya seragam)
  knownLocations() {
    const seen = new Map();
    (this.state.sessions || []).forEach(x => {
      const l = String(x.location || '').trim().replace(/\s+/g, ' ');
      if (l && !seen.has(l.toLowerCase())) seen.set(l.toLowerCase(), l);
    });
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }

  async handleCreateSession(e) {
    e.preventDefault();
    if (this.guardLocked()) return;
    const res = await this.cmd('add_session', {
      season_id: this.state.current_season_id,
      date: document.getElementById('new-ses-date')?.value,
      label: (document.getElementById('new-ses-label')?.value || '').trim(),
      location: (document.getElementById('new-ses-location')?.value || '').trim(),
      notes: document.getElementById('new-ses-notes')?.value || ''
    });
    if (!res.ok) { this.showError(res); return; }
    this.closeModal();
    this.render();
  }

  formatDay(d) {
    const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return d;
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // Karakter domino: bersorak melompat (MVP ada) atau tertidur (belum ada game)
  mascotSvg(mode) {
    const cheer = mode === 'cheer';
    const ink = '#1c1917';
    const confetti = ['#dc2626', '#facc15', '#2563eb', '#16a34a', '#f97316', '#db2777', '#facc15', '#2563eb']
      .map((c, i) => `<rect class="mvp-conf c${i + 1}" x="${10 + i * 14}" y="0" width="5" height="8" rx="1.5" fill="${c}"/>`).join('');
    const star = (x, y, cls) => `<path class="mvp-star ${cls}" d="M${x} ${y - 7} L${x + 2} ${y - 2} L${x + 7} ${y} L${x + 2} ${y + 2} L${x} ${y + 7} L${x - 2} ${y + 2} L${x - 7} ${y} L${x - 2} ${y - 2} Z" fill="#facc15" stroke="#f59e0b" stroke-width="1"/>`;
    const eyes = cheer
      ? `<path d="M43 52 Q49 43 55 52" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"/><path d="M65 52 Q71 43 77 52" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>`
      : `<path d="M43 51 Q49 57 55 51" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"/><path d="M65 51 Q71 57 77 51" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>`;
    const mouth = cheer
      ? `<path d="M46 75 Q60 98 74 75 Z" fill="#7f1d1d" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/><ellipse cx="60" cy="87" rx="7" ry="3.5" fill="#fb7185"/>`
      : `<path d="M52 78 Q60 84 68 78" fill="none" stroke="${ink}" stroke-width="3.5" stroke-linecap="round"/>`;
    const hand = (x, y) => `<circle cx="${x}" cy="${y}" r="6.5" fill="#fde047" stroke="${ink}" stroke-width="2.5"/>`;
    const arms = cheer
      ? `<g class="mvp-arm-l"><path d="M34 60 Q22 54 15 36" fill="none" stroke="${ink}" stroke-width="5.5" stroke-linecap="round"/>${hand(14, 33)}</g>
         <g class="mvp-arm-r"><path d="M86 60 Q98 54 105 36" fill="none" stroke="${ink}" stroke-width="5.5" stroke-linecap="round"/>${hand(106, 33)}</g>`
      : `<path d="M34 62 Q24 74 22 88" fill="none" stroke="${ink}" stroke-width="5.5" stroke-linecap="round"/>${hand(22, 91)}
         <path d="M86 62 Q96 74 98 88" fill="none" stroke="${ink}" stroke-width="5.5" stroke-linecap="round"/>${hand(98, 91)}`;
    const crown = cheer
      ? `<g class="mvp-crown"><path d="M43 36 L46 20 L54 29 L60 15 L66 29 L74 20 L77 36 Z" fill="#facc15" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/><circle cx="60" cy="26" r="2.6" fill="#dc2626"/></g>`
      : `<text class="mvp-zzz" x="84" y="32" font-size="15" font-weight="900" fill="#b45309">z</text><text class="mvp-zzz z2" x="96" y="20" font-size="11" font-weight="900" fill="#b45309">z</text>`;
    return `
      <svg class="mvp-svg ${cheer ? '' : 'mvp-idle'}" viewBox="0 -12 120 142" width="112" height="132" role="img" aria-label="${cheer ? 'Karakter domino bersorak gembira' : 'Karakter domino tertidur'}">
        ${cheer ? confetti + star(12, 20, 's1') + star(108, 16, 's2') + star(104, 72, 's3') : ''}
        <ellipse class="mvp-shadow" cx="60" cy="124" rx="24" ry="4.5" fill="rgba(28,25,23,0.15)"/>
        <g class="mvp-char">
          <path d="M50 96 L47 113" stroke="${ink}" stroke-width="6" stroke-linecap="round"/>
          <path d="M70 96 L73 113" stroke="${ink}" stroke-width="6" stroke-linecap="round"/>
          <ellipse cx="44" cy="116" rx="8" ry="4.5" fill="${ink}"/><ellipse cx="76" cy="116" rx="8" ry="4.5" fill="${ink}"/>
          ${arms}
          <rect x="34" y="34" width="52" height="64" rx="13" fill="#fffbeb" stroke="${ink}" stroke-width="4"/>
          <line x1="40" y1="66" x2="80" y2="66" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>
          ${eyes}
          <circle cx="41" cy="60" r="4.5" fill="#fda4af" opacity="0.75"/><circle cx="79" cy="60" r="4.5" fill="#fda4af" opacity="0.75"/>
          ${mouth}
          ${crown}
        </g>
      </svg>`;
  }

  mvpCardHtml() {
    const sid = this.state.current_season_id;
    const days = this.state.matches.filter(m => m.season_id === sid).map(m => matchDay(m, this.state.sessions));
    const date = pickMvpDate(days, this.state.today || '');
    const res = date
      ? calculateDailyMVP(sid, date, this.state.players, this.state.matches, this.state.sessions, this.state.loss_events, this.state.special_events, 3)
      : null;
    const mvp = res && res.mvp;

    if (!mvp) {
      return `
            <div class="bg-white rounded-[24px] p-5 shadow-card border border-domino-border flex flex-col">
              <div class="flex items-center justify-between mb-1">
                <h4 class="font-black text-sm text-domino-black tracking-tight">MVP Hari Ini</h4>
                <span class="text-[10px] font-black px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300">MVP</span>
              </div>
              <p class="text-[10px] text-amber-800 font-semibold">Belum ada game di season ini</p>
              <div class="flex justify-center -my-1">${this.mascotSvg('idle')}</div>
              <p class="text-center text-[11px] font-bold text-amber-900">Mulai input skor, MVP muncul setelah ada game.</p>
            </div>`;
    }

    const isToday = date === this.state.today;
    const title = isToday ? 'MVP Hari Ini' : `MVP ${this.formatDay(date)}`;
    const sub = isToday
      ? `${res.totalGames} game dimainkan hari ini`
      : `Belum ada game hari ini · game terakhir ${this.formatDay(date)}`;
    const score = res.comparable ? `Skor ${mvp.performance_index.toFixed(1)}` : 'Belum ada pembanding';
    const chip = (text, cls) => `<span class="px-2 py-0.5 rounded-full text-[10px] font-black ${cls}">${text}</span>`;
    return `
            <div class="bg-gradient-to-b from-amber-50 to-white rounded-[24px] p-5 shadow-card border border-amber-300 flex flex-col relative overflow-hidden">
              <div class="flex items-center justify-between mb-1">
                <h4 class="font-black text-sm text-domino-black tracking-tight">${this.esc(title)}</h4>
                <span class="text-[10px] font-black px-2 py-0.5 rounded-full bg-domino-yellow text-amber-950 border border-amber-400">👑 MVP</span>
              </div>
              <p class="text-[10px] text-amber-800 font-semibold">${this.esc(sub)}</p>
              <div class="flex justify-center -my-1">${this.mascotSvg('cheer')}</div>
              <div class="text-center">
                <p class="text-xl font-black text-domino-black leading-tight truncate" title="${this.attr(mvp.display_name)}">${this.esc(mvp.display_name)}</p>
                <p class="text-[11px] font-bold text-amber-800">${score}</p>
                <div class="flex flex-wrap justify-center gap-1.5 mt-2">
                  ${chip(`${mvp.games} game`, 'bg-stone-100 text-stone-700')}
                  ${chip(`Ratus ${mvp.ratus}`, 'bg-rose-100 text-domino-red')}
                  ${chip(`Ribu ${mvp.ribu}`, 'bg-sky-100 text-domino-blue')}
                  ${chip(`Kalah ${mvp.loss}`, 'bg-amber-100 text-amber-900')}
                </div>
              </div>
              <p class="text-[9px] text-amber-800/70 text-center mt-2">Dinilai dari game pada hari itu: Ratus dan Ribu tinggi, kalah rendah.</p>
            </div>`;
  }

  renderPlayers() {
    const container = document.getElementById('view-players');
    if (!container) return;

    container.innerHTML = `
      <div class="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 class="text-xl font-black text-domino-black tracking-tight">Master Data Anggota (${this.state.players.length} Pemain)</h3>
          <p class="text-xs text-amber-800 font-medium mt-0.5">Konfigurasi 10 anggota awal, dapat ditambah kapan saja dengan Player ID stabil.</p>
        </div>
        <button onclick="app.openNewPlayerModal()" class="px-4 py-2.5 bg-domino-red hover:bg-domino-redHover text-white font-black text-xs rounded-2xl shadow-pill transition">
          + Tambah Anggota
        </button>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        ${this.state.players.map(p => {
          const pMatches = this.state.matches.filter(m => m.players.includes(p.player_id));
          return `
            <div class="bg-white rounded-[24px] p-5 shadow-card border border-domino-border flex items-center justify-between">
              <div class="flex items-center gap-3.5">
                <div class="w-11 h-11 rounded-2xl bg-domino-yellow border border-amber-400 flex items-center justify-center font-black text-domino-red text-sm shadow-sm">
                  ${p.display_name.substring(0, 2).toUpperCase()}
                </div>
                <div>
                  <h4 class="font-black text-domino-black text-sm">${p.display_name}</h4>
                  <p class="text-[10px] text-amber-800 font-mono font-bold">${p.player_id} • ${pMatches.length} game</p>
                </div>
              </div>
              <div class="flex items-center gap-1.5">
                <button onclick="app.openEditPlayerModal('${p.player_id}')" title="Ubah nama" class="w-7 h-7 rounded-xl hover:bg-amber-50 text-slate-400 hover:text-amber-900 flex items-center justify-center text-sm">✏️</button>
                <button onclick="app.togglePlayerStatus('${p.player_id}')" class="px-3 py-1 text-xs rounded-xl font-black ${p.is_active ? 'bg-amber-100 text-amber-950 border border-amber-300' : 'bg-slate-100 text-slate-400'}">
                ${p.is_active ? 'Aktif' : 'Nonaktif'}
              </button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  openNewPlayerModal() {
    const nextId = this.nextId('PL', this.state.players, 'player_id', 2);

    const modalHtml = `
      <div class="modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-[26px] max-w-sm w-full p-6 shadow-2xl border border-domino-border">
          <h3 class="text-lg font-black text-domino-black mb-4">Tambah Anggota Baru</h3>
          <form onsubmit="app.handleCreatePlayer(event)">
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-900 mb-1">Player ID</label>
              <input type="text" id="new-p-id" value="Otomatis" readonly class="w-full bg-amber-50/70 border border-amber-200 rounded-xl p-2.5 text-xs text-amber-900 font-mono font-bold">
            </div>
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-950 mb-1">Nama Tampilan</label>
              <input type="text" id="new-p-name" placeholder="Nama pemain" required class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-xs font-bold text-domino-black">
            </div>
            <div class="flex justify-end gap-2 pt-3 border-t border-amber-100">
              <button type="button" data-close-modal class="px-4 py-2 text-xs font-bold text-slate-400">Batal</button>
              <button type="submit" class="px-5 py-2.5 bg-domino-red hover:bg-domino-redHover text-white rounded-xl font-black text-xs shadow-pill">Simpan</button>
            </div>
          </form>
        </div>
      </div>
    `;
    this.showModal(modalHtml);
  }

  async handleCreatePlayer(e) {
    e.preventDefault();
    const name = (document.getElementById('new-p-name')?.value || '').trim();
    if (!name) return;
    const res = await this.cmd('add_player', { name });
    if (!res.ok) { this.showError(res); return; }
    this.closeModal();
    this.render();
    alert(`✅ ${name} ditambahkan.\nPIN bawaan untuk masuk: ${res.data.default_pin}`);
  }

  openEditPlayerModal(pId) {
    const p = this.state.players.find(x => x.player_id === pId);
    if (!p) return;
    const modalHtml = `
      <div class="modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-[26px] max-w-sm w-full p-6 shadow-2xl border border-domino-border">
          <h3 class="text-lg font-black text-domino-black mb-4">Ubah Nama Anggota</h3>
          <form onsubmit="app.handleEditPlayer(event, '${p.player_id}')">
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-900 mb-1">Player ID</label>
              <input type="text" value="${p.player_id}" readonly class="w-full bg-amber-50/70 border border-amber-200 rounded-xl p-2.5 text-xs text-amber-900 font-mono font-bold">
            </div>
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-950 mb-1">Nama Tampilan</label>
              <input type="text" id="edit-p-name" value="${this.attr(p.display_name)}" required class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-xs font-bold text-domino-black">
            </div>
            <p class="text-[11px] text-amber-800 mb-4">Hanya nama yang berubah. Player ID dan seluruh riwayat game tetap sama.</p>
            ${this.state.config && this.state.config.force_enabled ? `<button type="button" onclick="app.openResetPin('${p.player_id}')" class="mb-4 px-3 py-2 bg-amber-50 hover:bg-amber-100 text-amber-950 border border-amber-300 rounded-xl text-[11px] font-black">🔑 Reset PIN ke bawaan (kata sandi paksa)</button>` : ''}
            <div class="flex justify-end gap-2 pt-3 border-t border-amber-100">
              <button type="button" data-close-modal class="px-4 py-2 text-xs font-bold text-slate-400">Batal</button>
              <button type="submit" class="px-5 py-2.5 bg-domino-red hover:bg-domino-redHover text-white rounded-xl font-black text-xs shadow-pill">Simpan</button>
            </div>
          </form>
        </div>
      </div>
    `;
    this.showModal(modalHtml);
  }

  async handleEditPlayer(e, pId) {
    e.preventDefault();
    const name = (document.getElementById('edit-p-name')?.value || '').trim();
    if (!name) return;
    const res = await this.cmd('rename_player', { player_id: pId, name });
    if (!res.ok) { this.showError(res); return; }
    this.closeModal();
    this.render();
  }

  async togglePlayerStatus(pId) {
    const res = await this.cmd('toggle_player', { player_id: pId });
    if (!res.ok) { this.showError(res); return; }
    this.render();
  }

  renderStats() {
    const calc = this.getCalculations();
    const container = document.getElementById('view-stats');
    if (!container) return;

    container.innerHTML = `
      <div class="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 class="text-xl font-black text-domino-black tracking-tight">Statistik Akumulatif & Rasio Pemain</h3>
          <p class="text-xs text-amber-800 font-medium mt-0.5">Statistik absolut dan rasio per 100 game ditampilkan berdampingan.</p>
        </div>
        <button onclick="app.exportToExcel()" class="px-4 py-2 bg-white border border-amber-300 hover:bg-amber-50 text-amber-950 text-xs font-black rounded-2xl shadow-sm transition flex items-center gap-1.5">
          <span>📥</span> Unduh Format Excel
        </button>
      </div>

      <div class="bg-white rounded-[26px] overflow-hidden shadow-card border border-domino-border">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse text-xs">
            <thead>
              <tr class="bg-amber-50/80 border-b border-amber-200 text-amber-900 text-[10px] uppercase font-black tracking-wider">
                <th rowspan="2" class="py-3 px-3.5 border-r border-amber-200">Pemain</th>
                <th colspan="5" class="py-2 px-3 text-center bg-domino-yellowLight border-r border-amber-200 text-amber-950 font-black">
                  Statistik Akumulatif
                </th>
                <th colspan="4" class="py-2 px-3 text-center bg-sky-50 border-r border-sky-200 text-domino-blue font-black">
                  Statistik Rasio (per 100 Game)
                </th>
                <th colspan="2" class="py-2 px-3 text-center bg-rose-50 text-domino-red font-black">
                  Rekor & Indeks
                </th>
              </tr>
              <tr class="bg-amber-50/40 border-b border-amber-200 text-amber-900/80 text-[9px] uppercase font-bold">
                <th class="py-2 px-2.5 text-center">Main</th>
                <th class="py-2 px-2.5 text-center">Sesi</th>
                <th class="py-2 px-2.5 text-center text-amber-700">Ratus</th>
                <th class="py-2 px-2.5 text-center text-domino-blue">Ribu</th>
                <th class="py-2 px-2.5 text-center text-domino-red border-r border-amber-200">Kalah</th>
                
                <th class="py-2 px-2.5 text-center text-amber-700">Ratus Rate</th>
                <th class="py-2 px-2.5 text-center text-domino-blue">Ribu Rate</th>
                <th class="py-2 px-2.5 text-center text-domino-red">Loss Rate</th>
                <th class="py-2 px-2.5 text-center border-r border-sky-200">Partisipasi</th>

                <th class="py-2 px-2.5 text-center">Worst Record</th>
                <th class="py-2 px-2.5 text-right font-black text-domino-black">PI</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-amber-100/60 text-slate-700 font-semibold">
              ${calc.stats.map(p => `
                <tr class="hover:bg-amber-50/40 transition ${!p.eligible_champion ? 'opacity-70' : ''}">
                  <td class="py-3 px-3.5 font-black text-domino-black border-r border-amber-200">
                    ${p.display_name}
                    ${!p.eligible_champion ? '<span class="block text-[8px] text-amber-700 font-normal">Belum bersyarat</span>' : ''}
                  </td>
                  
                  <td class="py-3 px-2.5 text-center font-mono font-bold">${p.total_matches}</td>
                  <td class="py-3 px-2.5 text-center font-mono">${p.total_sessions}</td>
                  <td class="py-3 px-2.5 text-center font-mono text-amber-700 font-bold">${p.total_s100}</td>
                  <td class="py-3 px-2.5 text-center font-mono text-domino-blue font-bold">${p.total_s1000}</td>
                  <td class="py-3 px-2.5 text-center font-mono text-domino-red font-bold border-r border-amber-200">${p.total_loss}</td>

                  <td class="py-3 px-2.5 text-center font-mono font-black text-amber-800">${p.s100_rate}%</td>
                  <td class="py-3 px-2.5 text-center font-mono font-black text-domino-blue">${p.s1000_rate}%</td>
                  <td class="py-3 px-2.5 text-center font-mono font-black text-domino-red">${p.loss_rate}%</td>
                  <td class="py-3 px-2.5 text-center font-mono border-r border-sky-200">${p.participation_rate}%</td>

                  <td class="py-3 px-2.5 text-center text-[10px]">
                    <span class="font-black text-domino-red">${p.worst_record.count}</span> <span class="text-amber-800">/ sesi</span>
                  </td>
                  <td class="py-3 px-2.5 text-right font-black ${p.eligible_champion ? 'text-domino-red text-sm' : 'text-slate-400'}">
                    ${p.eligible_champion ? p.performance_index : '-'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ==========================================
  // VIEW 08: HEAD TO HEAD
  // ==========================================
  renderHeadToHead() {
    const container = document.getElementById('view-h2h');
    if (!container) return;

    const p1Id = this.state.h2h_player1;
    const p2Id = this.state.h2h_player2;

    const h2h = calculateHeadToHead(
      p1Id, 
      p2Id, 
      this.state.matches.filter(m => m.season_id === this.state.current_season_id),
      this.state.loss_events,
      this.state.special_events
    );

    const player1 = this.state.players.find(p => p.player_id === p1Id) || { display_name: p1Id };
    const player2 = this.state.players.find(p => p.player_id === p2Id) || { display_name: p2Id };

    container.innerHTML = `
      <div class="max-w-3xl mx-auto">
        <div class="mb-6 text-center">
          <h3 class="text-xl font-black text-domino-black tracking-tight">Head to Head (Duel Statistik)</h3>
          <p class="text-xs text-amber-800 font-medium mt-1">Perbandingan khusus pada game yang mereka mainkan bersama.</p>
        </div>

        <div class="bg-white rounded-[26px] p-6 shadow-card border border-domino-border mb-6">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
            <div>
              <label class="block text-xs font-black text-domino-blue uppercase mb-1">Pemain 1</label>
              <select onchange="app.state.h2h_player1 = this.value; app.renderHeadToHead();" class="w-full bg-amber-50/70 border border-amber-200 rounded-2xl px-3.5 py-2.5 text-xs text-domino-black font-black">
                ${this.state.players.map(p => `
                  <option value="${p.player_id}" ${p.player_id === p1Id ? 'selected' : ''}>${p.display_name} (${p.player_id})</option>
                `).join('')}
              </select>
            </div>
            <div>
              <label class="block text-xs font-black text-domino-red uppercase mb-1">Pemain 2</label>
              <select onchange="app.state.h2h_player2 = this.value; app.renderHeadToHead();" class="w-full bg-amber-50/70 border border-amber-200 rounded-2xl px-3.5 py-2.5 text-xs text-domino-black font-black">
                ${this.state.players.map(p => `
                  <option value="${p.player_id}" ${p.player_id === p2Id ? 'selected' : ''}>${p.display_name} (${p.player_id})</option>
                `).join('')}
              </select>
            </div>
          </div>
        </div>

        <div class="bg-white rounded-[26px] p-6 shadow-card border border-domino-border">
          <div class="text-center pb-6 border-b border-amber-100">
            <span class="px-4 py-1.5 rounded-full text-xs font-black bg-amber-100 text-amber-950 border border-amber-300">
              ${h2h.shared_matches_count} Pertandingan Bersama
            </span>
          </div>

          <div class="py-6 space-y-6">
            <div>
              <div class="flex justify-between text-xs font-black mb-1.5">
                <span class="text-domino-blue">${player1.display_name}: ${h2h.player_a.losses} kalah</span>
                <span class="text-amber-900">Total Kalah di Game Bersama</span>
                <span class="text-domino-red">${player2.display_name}: ${h2h.player_b.losses} kalah</span>
              </div>
              <div class="w-full h-3 bg-amber-100 rounded-full overflow-hidden flex">
                <div style="width: ${h2h.player_a.losses + h2h.player_b.losses > 0 ? (h2h.player_a.losses / (h2h.player_a.losses + h2h.player_b.losses)) * 100 : 50}%" class="bg-domino-blue h-full"></div>
                <div style="width: ${h2h.player_a.losses + h2h.player_b.losses > 0 ? (h2h.player_b.losses / (h2h.player_a.losses + h2h.player_b.losses)) * 100 : 50}%" class="bg-domino-red h-full"></div>
              </div>
            </div>

            <div>
              <div class="flex justify-between text-xs font-black mb-1.5">
                <span class="text-amber-800">${player1.display_name}: ${h2h.player_a.s100} kali</span>
                <span class="text-amber-900">Ratus di Game Bersama</span>
                <span class="text-amber-800">${player2.display_name}: ${h2h.player_b.s100} kali</span>
              </div>
              <div class="w-full h-3 bg-amber-100 rounded-full overflow-hidden flex">
                <div style="width: ${h2h.player_a.s100 + h2h.player_b.s100 > 0 ? (h2h.player_a.s100 / (h2h.player_a.s100 + h2h.player_b.s100)) * 100 : 50}%" class="bg-domino-yellowDark h-full"></div>
                <div style="width: ${h2h.player_a.s100 + h2h.player_b.s100 > 0 ? (h2h.player_b.s100 / (h2h.player_a.s100 + h2h.player_b.s100)) * 100 : 50}%" class="bg-amber-400 h-full"></div>
              </div>
            </div>

            <div>
              <div class="flex justify-between text-xs font-black mb-1.5">
                <span class="text-domino-blue">${player1.display_name}: ${h2h.player_a.s1000} kali</span>
                <span class="text-amber-900">Ribu di Game Bersama</span>
                <span class="text-domino-blue">${player2.display_name}: ${h2h.player_b.s1000} kali</span>
              </div>
              <div class="w-full h-3 bg-amber-100 rounded-full overflow-hidden flex">
                <div style="width: ${h2h.player_a.s1000 + h2h.player_b.s1000 > 0 ? (h2h.player_a.s1000 / (h2h.player_a.s1000 + h2h.player_b.s1000)) * 100 : 50}%" class="bg-domino-blue h-full"></div>
                <div style="width: ${h2h.player_a.s1000 + h2h.player_b.s1000 > 0 ? (h2h.player_b.s1000 / (h2h.player_a.s1000 + h2h.player_b.s1000)) * 100 : 50}%" class="bg-sky-400 h-full"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================
  // VIEW 09: PENGHARGAAN
  // ==========================================
  renderAwards() {
    const calc = this.getCalculations();
    const container = document.getElementById('view-awards');
    if (!container) return;

    container.innerHTML = `
      <div class="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 class="text-xl font-black text-domino-black tracking-tight">Delapan Penghargaan Season</h3>
          <p class="text-xs text-amber-800 font-medium mt-0.5">Dihitung otomatis sesuai kriteria matematis & persentil Domino League v1.0.</p>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
        ${calc.awards.map(aw => `
          <div class="bg-white rounded-[26px] p-6 shadow-card border border-domino-border flex flex-col justify-between">
            <div>
              <div class="flex items-center justify-between mb-2">
                <h4 class="font-black text-domino-black text-base flex items-center gap-2">
                  <span class="text-xl">${this.getAwardEmoji(aw.id)}</span> ${aw.title}
                </h4>
                ${aw.is_tie ? '<span class="text-[10px] bg-amber-100 text-amber-950 px-2.5 py-0.5 rounded-full font-black border border-amber-300">SERI</span>' : ''}
              </div>
              <p class="text-xs text-amber-900/80 mb-4 leading-relaxed font-medium">${aw.desc}</p>

              ${aw.winners.length > 0 ? `
                <div class="space-y-2 mb-4">
                  ${aw.winners.map(w => `
                    <div class="bg-domino-yellowLight border border-amber-200 p-3.5 rounded-2xl flex items-center justify-between">
                      <div>
                        <span class="text-sm font-black text-domino-black">${w.name}</span>
                        <p class="text-[11px] text-amber-800 font-bold">${w.extra}</p>
                      </div>
                      <span class="text-sm font-black text-domino-red px-3 py-1 bg-white rounded-xl shadow-sm border border-amber-200">
                        ${w.value}
                      </span>
                    </div>
                  `).join('')}
                </div>
              ` : `
                <div class="p-4 rounded-2xl bg-amber-50/50 border border-dashed border-amber-300 text-center text-xs text-amber-800 font-medium mb-4">
                  ${aw.note || 'Belum memenuhi syarat ambang batas minimal'}
                </div>
              `}
            </div>

            ${aw.winners.length > 0 ? `
              <button onclick="app.openCertificateModal('${aw.id}')" class="w-full py-2.5 bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-400 text-amber-950 font-black text-xs rounded-2xl shadow-sm transition flex items-center justify-center gap-1.5 active:scale-95 border border-amber-400">
                <span>📜</span> Cetak Sertifikat Digital
              </button>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  getAwardEmoji(id) {
    const map = {
      domino_champion: '👑',
      s100_master: '⚡',
      s1000_master: '💎',
      most_unlucky: '🔥',
      worst_record: '💀',
      lowest_performance: '📉',
      most_active: '🏃',
      most_consistent: '🛡️'
    };
    return map[id] || '🏆';
  }

  openCertificateModal(awardId) {
    // Data penghargaan diambil dari hitungan, bukan dari teks di atribut HTML (aman dari nama berbahaya)
    const aw = this.getCalculations().awards.find(a => a.id === awardId);
    if (!aw || !aw.winners.length) return;
    const title = this.esc(aw.title);
    const winnerName = this.esc(aw.winners[0].name);
    const value = this.esc(aw.winners[0].value);
    const desc = this.esc(aw.desc);
    const season = this.state.seasons.find(s => s.season_id === this.state.current_season_id);
    const dateStr = new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' });

    const modalHtml = `
      <div class="modal-backdrop fixed inset-0 bg-black/60 backdrop-blur-md z-50 flex items-center justify-center p-4 overflow-y-auto">
        <div class="bg-white rounded-[28px] max-w-2xl w-full p-6 shadow-2xl border border-domino-border">
          <div class="flex items-center justify-between pb-3 border-b border-amber-100 mb-4">
            <h3 class="text-base font-black text-domino-black">Sertifikat Digital Resmi</h3>
            <button data-close-modal class="text-slate-400 hover:text-domino-black text-lg">&times;</button>
          </div>

          <div id="printable-certificate" class="relative bg-[#FFFDF0] text-slate-900 p-8 rounded-2xl border-8 border-double border-domino-red shadow-inner text-center font-serif">
            <div class="border-2 border-amber-600/40 p-6 rounded-xl">
              <p class="text-xs uppercase tracking-widest font-sans font-black text-domino-red mb-1">
                ${this.state.settings.league_name || 'DOMINO LEAGUE INDONESIA (ACBC)'}
              </p>
              <h2 class="text-2xl font-black text-slate-900 uppercase tracking-wide mb-1 font-serif">
                SERTIFIKAT PENGHARGAAN
              </h2>
              <p class="text-xs italic text-amber-900 mb-5 font-sans">Diberikan secara terhormat kepada:</p>

              <h1 class="text-3xl font-black text-domino-red tracking-wider mb-2 font-serif uppercase border-b-2 border-amber-400 pb-2 inline-block px-8">
                ${winnerName}
              </h1>

              <p class="text-xs text-slate-600 mt-4 font-sans font-semibold">Atas pencapaian luar biasa sebagai peraih:</p>
              <h3 class="text-xl font-black text-domino-black uppercase tracking-wide mt-1">
                ${title}
              </h3>
              <p class="text-xs text-amber-900 font-sans italic mt-1 max-w-md mx-auto">
                "${desc}" (Pencapaian: ${value})
              </p>

              <p class="text-[11px] text-slate-500 font-sans mt-4">
                Kompetisi: <strong>${season ? season.season_name : ''}</strong>
              </p>

              <div class="mt-8 pt-6 border-t border-amber-800/20 grid grid-cols-2 gap-8 text-xs font-sans">
                <div>
                  <p class="text-slate-400 text-[10px]">Tanggal:</p>
                  <p class="font-bold text-slate-800 mt-1">${dateStr}</p>
                </div>
                <div>
                  <p class="text-slate-400 text-[10px]">Ketua / Penyelenggara:</p>
                  <p class="font-bold text-slate-800 mt-1">${this.state.settings.organizer_name || 'Panitia Domino League'}</p>
                  <div class="w-24 h-0.5 bg-domino-red mx-auto mt-4"></div>
                </div>
              </div>
            </div>
          </div>

          <div class="mt-6 flex justify-between items-center pt-3 border-t border-amber-100">
            <span class="text-xs text-amber-800">Siap cetak atau simpan ke PDF.</span>
            <div class="flex gap-2">
              <button type="button" data-close-modal class="px-4 py-2 text-xs font-bold text-slate-500">Tutup</button>
              <button onclick="window.print()" class="px-5 py-2.5 bg-domino-red hover:bg-domino-redHover text-white font-black text-xs rounded-xl shadow transition">
                🖨️ Cetak / Simpan PDF
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
    this.showModal(modalHtml);
  }

  // ==========================================
  // VIEW 10: ARSIP SEASON
  // ==========================================
  renderArchive() {
    const container = document.getElementById('view-archive');
    if (!container) return;

    container.innerHTML = `
      <div class="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 class="text-xl font-black text-domino-black tracking-tight">Pengelolaan & Arsip Season</h3>
          <p class="text-xs text-amber-800 font-medium mt-0.5">Finalisasi season mengunci statistik dan mencatat snapshot permanen.</p>
        </div>
        ${this.archiveActionsHtml()}
      </div>

      <div class="space-y-4">
        ${this.state.season_snapshots.map(snap => `
          <div class="bg-white rounded-[24px] p-5 shadow-card border border-domino-border">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-amber-100 pb-3 mb-3">
              <div>
                <h4 class="font-black text-domino-black text-base">${snap.season_name}</h4>
                <p class="text-xs text-amber-800/80">Finalisasi: ${snap.finalized_at || 'Selesai'}</p>
              </div>
              <span class="px-3.5 py-1 bg-domino-yellow text-amber-950 rounded-full text-xs font-black border border-amber-400">
                👑 Juara: ${snap.champion || snap.awards?.[0]?.winner || '-'}
              </span>
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              ${snap.awards ? snap.awards.map(aw => `
                <div class="p-2.5 rounded-xl bg-domino-yellowLight border border-amber-200">
                  <span class="text-[10px] text-amber-800 block">${this.relabel(aw.title)}</span>
                  <span class="font-black text-domino-black">${aw.winner}</span>
                </div>
              `).join('') : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  openFinalizeModal() {
    if (this.guardLocked()) return;
    const calc = this.getCalculations();
    if (calc.totalSeasonMatches === 0) {
      alert('Season ini belum memiliki game sama sekali, jadi belum bisa difinalisasi.');
      return;
    }
    const modalHtml = `
      <div class="modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-[26px] max-w-md w-full p-6 shadow-2xl border border-domino-border">
          <h3 class="text-lg font-black text-domino-black mb-2">Konfirmasi Finalisasi Season</h3>
          <p class="text-xs text-amber-900 mb-4">
            Proses ini akan mengunci season <strong>${calc.season ? calc.season.season_name : ''}</strong> dan menyimpan snapshot hasil akhir.
          </p>
          <div class="bg-amber-50 p-3.5 rounded-2xl border border-amber-200 text-xs text-amber-900 mb-4 space-y-1 font-semibold">
            <p><strong>Total Pertandingan:</strong> ${calc.totalSeasonMatches} game</p>
            <p><strong>Calon Juara:</strong> ${calc.awards[0]?.winners[0]?.name || 'Belum ada'}</p>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" data-close-modal class="px-4 py-2 text-xs font-bold text-slate-400">Batal</button>
            <button onclick="app.executeFinalizeSeason()" class="px-5 py-2.5 bg-domino-red hover:bg-domino-redHover text-white rounded-xl font-black text-xs shadow-pill">
              Ya, Finalisasi & Kunci
            </button>
          </div>
        </div>
      </div>
    `;
    this.showModal(modalHtml);
  }

  archiveActionsHtml() {
    const locked = this.isSeasonLocked();
    const hasActive = this.state.seasons.some(s => s.status === 'active');
    const btnNew = `<button onclick="app.openNewSeasonModal()" class="px-4 py-2.5 bg-domino-red hover:bg-domino-redHover text-white font-black text-xs rounded-2xl shadow transition">＋ Mulai Season Baru</button>`;
    const btnFinalize = `<button onclick="app.openFinalizeModal()" class="px-4 py-2.5 bg-domino-red hover:bg-domino-redHover text-white font-black text-xs rounded-2xl shadow transition">🔒 Finalisasi Season Ini</button>`;
    const btnReopen = `<button onclick="app.reopenSeason()" class="px-4 py-2.5 bg-amber-50 hover:bg-amber-100 text-amber-950 border border-amber-300 font-black text-xs rounded-2xl transition">↩️ Buka Kunci Season</button>`;

    if (locked) {
      if (hasActive) return '<span class="text-xs font-bold text-amber-800">Season ini terkunci. Pilih season aktif di menu atas untuk lanjut mencatat game.</span>';
      return `<div class="flex flex-wrap items-center gap-2">${btnNew}${btnReopen}</div>`;
    }
    return `<div class="flex flex-wrap items-center gap-2">${btnFinalize}${hasActive ? '' : btnNew}</div>`;
  }

  async executeFinalizeSeason() {
    const season = this.state.seasons.find(s => s.season_id === this.state.current_season_id);
    if (!season || season.status === 'finalized') {
      alert('Season ini sudah difinalisasi.');
      this.closeModal();
      return;
    }
    const ok = await this.askFinal(`Finalisasi ${season.season_name}`, 'Season akan dikunci (input, edit, dan hapus game dimatikan) dan hasil akhirnya disimpan sebagai arsip.');
    if (!ok) return;
    const res = await this.cmd('finalize_season', { season_id: season.season_id }, { confirm: 'FINAL' });
    if (!res.ok) { this.showError(res); return; }
    this.render();
    if (confirm('✅ Season berhasil difinalisasi!\n\nMulai season baru sekarang?')) {
      this.openNewSeasonModal();
    }
  }

  openNewSeasonModal() {
    if (this.state.seasons.some(s => s.status === 'active')) {
      alert('Masih ada season yang aktif. Finalisasi season tersebut terlebih dahulu.');
      return;
    }
    const n = this.state.seasons.length + 1;
    const today = new Date().toISOString().split('T')[0];
    const modalHtml = `
      <div class="modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-[26px] max-w-md w-full p-6 shadow-2xl border border-domino-border">
          <h3 class="text-lg font-black text-domino-black mb-1">Mulai Season Baru</h3>
          <p class="text-xs text-amber-800 mb-4">Semua pemain dibawa ke season baru. Statistik dimulai dari nol; riwayat season lama tetap aman di arsip.</p>
          <form onsubmit="app.handleCreateSeason(event)">
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-950 mb-1">Nama Season</label>
              <input type="text" id="new-season-name" value="Season ${n} - ${new Date().getFullYear()}" required class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-xs font-bold text-domino-black">
            </div>
            <div class="mb-4">
              <label class="block text-xs font-black text-amber-950 mb-1">Tanggal Mulai</label>
              <input type="date" id="new-season-start" value="${today}" required class="w-full bg-white border border-amber-200 rounded-xl p-2.5 text-xs font-bold text-domino-black">
            </div>
            <div class="flex justify-end gap-2 pt-3 border-t border-amber-100">
              <button type="button" data-close-modal class="px-4 py-2 text-xs font-bold text-slate-400">Batal</button>
              <button type="submit" class="px-5 py-2.5 bg-domino-red hover:bg-domino-redHover text-white rounded-xl font-black text-xs shadow-pill">Mulai Season</button>
            </div>
          </form>
        </div>
      </div>
    `;
    this.showModal(modalHtml);
  }

  async handleCreateSeason(e) {
    e.preventDefault();
    const name = (document.getElementById('new-season-name')?.value || '').trim();
    const start = document.getElementById('new-season-start')?.value;
    if (!name) return;
    const res = await this.cmd('create_season', { name, start });
    if (!res.ok) { this.showError(res); return; }
    this.selectSeason(res.data.season_id);
    this.closeModal();
    this.renderHeader();
    this.switchTab('input-game');
    this.openNewSessionModal();
  }

  async reopenSeason() {
    const season = this.state.seasons.find(s => s.season_id === this.state.current_season_id);
    if (!season || season.status !== 'finalized') return;
    const ok = await this.askFinal(`Buka kunci ${season.season_name}?`, 'Snapshot hasil akhirnya akan dihapus dan Anda perlu finalisasi ulang nanti.');
    if (!ok) return;
    const res = await this.cmd('reopen_season', { season_id: season.season_id }, { confirm: 'FINAL' });
    if (!res.ok) { this.showError(res); return; }
    this.render();
  }

  renderSettings() {
    const container = document.getElementById('view-settings');
    if (!container) return;

    container.innerHTML = `
      <div class="max-w-3xl mx-auto space-y-6">
        <div>
          <h3 class="text-xl font-black text-domino-black tracking-tight">Pengaturan Liga & Auto-Sync Google Sheets</h3>
          <p class="text-xs text-amber-800 font-medium mt-1">Konfigurasi URL Webhook Google Apps Script, ambang batas, dan dataset.</p>
        </div>

        <div class="bg-white rounded-[26px] p-6 shadow-card border border-domino-border">
          <div class="flex items-center justify-between pb-4 border-b border-amber-100 mb-4">
            <div class="flex items-center gap-3">
              <span class="w-10 h-10 rounded-2xl bg-amber-100 text-domino-red flex items-center justify-center font-black text-lg border border-amber-300">📊</span>
              <div>
                <h4 class="font-black text-domino-black text-base">Sinkronisasi Otomatis Google Sheets</h4>
                <p class="text-xs text-amber-800">Data otomatis terkirim setiap kali game disimpan.</p>
              </div>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" id="setting-auto-sync" ${this.state.settings.auto_sync_sheets ? 'checked' : ''} onchange="app.toggleAutoSync(this.checked, this)" class="sr-only peer">
              <div class="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-domino-red"></div>
            </label>
          </div>

          <div class="space-y-4">
            <div>
              <label class="block text-xs font-black text-amber-950 uppercase mb-1">
                Google Apps Script Webhook URL${this.state.settings.sheets_webhook_set ? ' (tersimpan ' + this.esc(this.state.settings.sheets_webhook_hint) + ', isi ulang untuk mengganti)' : ''}
              </label>
              <div class="flex gap-2">
                <input type="url" id="setting-webhook-url" value="" placeholder="https://script.google.com/macros/s/.../exec" class="flex-1 bg-amber-50/70 border border-amber-200 rounded-2xl px-3.5 py-2.5 text-xs text-domino-black font-mono focus:outline-none focus:ring-2 focus:ring-amber-500/30">
                <button onclick="app.saveWebhookUrl()" class="px-5 py-2.5 bg-domino-black text-white rounded-2xl text-xs font-black shadow-pill">
                  Simpan URL
                </button>
              </div>
            </div>

            <div class="flex flex-wrap gap-2 pt-2">
              <button onclick="app.testSheetsConnection()" class="px-4 py-2 bg-amber-50 hover:bg-amber-100 text-amber-950 border border-amber-200 text-xs font-black rounded-2xl transition flex items-center gap-1.5">
                <span>⚡</span> Uji Koneksi (Ping)
              </button>
              <button onclick="app.syncToGoogleSheets(true)" class="px-4 py-2 bg-domino-red hover:bg-domino-redHover text-white text-xs font-black rounded-2xl shadow transition flex items-center gap-1.5">
                <span>🔄</span> Sinkronkan Seluruh Data Sekarang
              </button>
              <button onclick="app.openScriptGuideModal()" class="px-4 py-2 bg-amber-50 hover:bg-amber-100 text-amber-950 border border-amber-200 text-xs font-black rounded-2xl transition flex items-center gap-1.5">
                <span>📋</span> Salin Skrip Apps Script
              </button>
            </div>

            <div id="sync-result-box" class="hidden p-3.5 rounded-2xl text-xs"></div>
          </div>
        </div>

        <div class="bg-white rounded-[26px] p-6 shadow-card border border-domino-border">
          <h4 class="font-black text-domino-black text-base mb-4">Pengaturan Ambang Batas Minimal</h4>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label class="block text-xs font-black text-amber-950 mb-1">Min. Game Champion</label>
              <input type="number" id="setting-min-champ" value="${this.state.settings.min_games_champion}" min="1" class="w-full bg-amber-50/70 border border-amber-200 rounded-xl p-2.5 text-xs font-bold text-domino-black">
            </div>
            <div>
              <label class="block text-xs font-black text-amber-950 mb-1">Min. Sesi Worst Record</label>
              <input type="number" id="setting-min-worst" value="${this.state.settings.min_sessions_worst_record}" min="1" class="w-full bg-amber-50/70 border border-amber-200 rounded-xl p-2.5 text-xs font-bold text-domino-black">
            </div>
            <div>
              <label class="block text-xs font-black text-amber-950 mb-1">Min. Sesi Consistent</label>
              <input type="number" id="setting-min-cons-ses" value="${this.state.settings.min_sessions_consistent}" min="1" class="w-full bg-amber-50/70 border border-amber-200 rounded-xl p-2.5 text-xs font-bold text-domino-black">
            </div>
          </div>
          <button onclick="app.saveThresholds()" class="mt-4 px-4 py-2 bg-domino-black text-white font-black text-xs rounded-xl shadow-pill">
            Simpan Ambang Batas
          </button>
        </div>

        <div class="bg-white rounded-[26px] p-6 shadow-card border border-domino-border">
          <h4 class="font-black text-domino-black text-base mb-2">Cadangan Data</h4>
          <p class="text-xs text-amber-800 font-medium mb-4">
            Unduh seluruh data liga sebagai file JSON dan simpan di tempat lain (misalnya Google Drive). Bila data hilang,
            file ini bisa dipulihkan lewat tombol di samping. PIN pemain tidak ikut tersimpan.
          </p>
          <div class="flex flex-wrap gap-3">
            <button onclick="app.downloadBackup()" class="px-4 py-2.5 bg-domino-yellow hover:bg-amber-300 text-amber-950 font-black text-xs rounded-2xl border border-amber-400">
              💾 Unduh Cadangan (kata sandi paksa)
            </button>
            <label class="px-4 py-2.5 bg-amber-50 hover:bg-amber-100 text-amber-950 border border-amber-200 font-black text-xs rounded-2xl cursor-pointer">
              📥 Pulihkan dari File Cadangan
              <input type="file" accept="application/json,.json" class="hidden" onchange="app.importBackupFile(this)">
            </label>
          </div>
        </div>

        <div class="bg-white rounded-[26px] p-6 shadow-card border border-domino-border">
          <h4 class="font-black text-domino-black text-base mb-2">Manajemen Dataset</h4>
          <p class="text-xs text-amber-800 font-medium mb-4">
            Pilih apakah ingin menggunakan dataset [DEMO] lengkap untuk pengujian atau beralih ke data riil baru yang bersih.
          </p>
          <div class="flex flex-wrap gap-3">
            <button onclick="app.confirmLoadDemo()" class="px-4 py-2.5 bg-domino-yellow hover:bg-amber-300 text-amber-950 font-black text-xs rounded-2xl border border-amber-400">
              🧪 Muat Ulang Dataset [DEMO]
            </button>
            <button onclick="app.switchToRealDataConfirm()" class="px-4 py-2.5 bg-amber-50 hover:bg-amber-100 text-amber-950 border border-amber-200 font-black text-xs rounded-2xl">
              🧹 Beralih ke Data Asli (Kosong)
            </button>
          </div>
        </div>
      </div>
    `;
  }

  async saveWebhookUrl() {
    const url = (document.getElementById('setting-webhook-url')?.value || '').trim();
    if (url && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
      alert('URL harus berupa alamat Google Apps Script (https://script.google.com/macros/s/.../exec).');
      return;
    }
    if (!url && this.state.settings.sheets_webhook_set && !confirm('Kolom kosong akan MENGHAPUS URL yang tersimpan. Lanjutkan?')) return;
    const ok = await this.askFinal('Simpan URL Webhook', 'URL ini menentukan ke Google Spreadsheet mana data liga dikirim.');
    if (!ok) return;
    const res = await this.cmd('update_settings', { settings: { sheets_webhook_url: url } }, { confirm: 'FINAL' });
    if (!res.ok) { this.showError(res); return; }
    alert('✅ URL Google Apps Script Webhook berhasil disimpan!');
    this.render();
  }

  async saveThresholds() {
    const settings = {
      min_games_champion: parseInt(document.getElementById('setting-min-champ')?.value, 10) || 10,
      min_sessions_worst_record: parseInt(document.getElementById('setting-min-worst')?.value, 10) || 3,
      min_sessions_consistent: parseInt(document.getElementById('setting-min-cons-ses')?.value, 10) || 3
    };
    const ok = await this.askFinal('Ubah ambang batas', 'Ambang batas memengaruhi siapa yang memenuhi syarat juara dan penghargaan.');
    if (!ok) return;
    const res = await this.cmd('update_settings', { settings }, { confirm: 'FINAL' });
    if (!res.ok) { this.showError(res); return; }
    alert('✅ Pengaturan ambang batas berhasil diperbarui!');
    this.render();
  }

  async toggleAutoSync(checked, el) {
    const ok = await this.askFinal(checked ? 'Aktifkan Auto-Sync' : 'Matikan Auto-Sync', 'Auto-Sync mengirim data liga ke Google Spreadsheet setiap ada perubahan.');
    const res = ok ? await this.cmd('update_settings', { settings: { auto_sync_sheets: checked } }, { confirm: 'FINAL' }) : { ok: false };
    if (!res.ok) {
      if (el) el.checked = !checked;
      if (ok) this.showError(res);
      return;
    }
    this.render();
  }

  async confirmLoadDemo() {
    const ok = await this.askFinal('Muat dataset DEMO', 'Seluruh data yang ada sekarang, termasuk data asli, akan DIGANTI dengan data contoh. Riwayat perubahan tetap tersimpan.');
    if (!ok) return;
    const res = await this.cmd('load_demo', {}, { confirm: 'FINAL' });
    if (!res.ok) { this.showError(res); return; }
    try { localStorage.removeItem('domino_season'); } catch (e) { /* abaikan */ }
    this.applyServerState({ ...this.state, players: this.state.players });
    alert('Data [DEMO] berhasil dimuat!');
    this.render();
  }

  async switchToRealDataConfirm() {
    const ok = await this.askFinal('Beralih ke Data Asli', 'Seluruh data yang ada sekarang (game, sesi, season, arsip) akan DIHAPUS dan dimulai dari nol. PIN pemain ikut direset.');
    if (!ok) return;
    const res = await this.cmd('reset_real', {}, { confirm: 'FINAL' });
    if (!res.ok) { this.showError(res); return; }
    try { localStorage.removeItem('domino_season'); } catch (e) { /* abaikan */ }
    alert('✅ Mode Data Asli aktif! Anda dapat mulai menginput game riil.');
    await this.loadState(true);
    this.render();
  }

  openScriptGuideModal() {
    const modalHtml = `
      <div class="modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-[28px] max-w-2xl w-full p-6 shadow-2xl border border-domino-border">
          <div class="flex items-center justify-between pb-3 border-b border-amber-100 mb-4">
            <h3 class="text-base font-black text-domino-black">Panduan Skrip Google Apps Script</h3>
            <button data-close-modal class="text-slate-400 hover:text-domino-black">&times;</button>
          </div>

          <div class="text-xs text-amber-950 font-medium space-y-2 mb-4 leading-relaxed">
            <p>1. Buka Google Spreadsheet baru.</p>
            <p>2. Klik menu <strong>Extensions > Apps Script</strong>.</p>
            <p>3. Tempelkan seluruh kode skrip di bawah ini.</p>
            <p>4. Klik <strong>Deploy > New deployment</strong>, pilih jenis <strong>Web app</strong>.</p>
            <p>5. Atur akses: <em>Who has access:</em> <strong>Anyone</strong>.</p>
            <p>6. Salin Web App URL dan simpan di form Pengaturan Web App ini.</p>
          </div>

          <div class="relative mb-4">
            <textarea id="script-code-box" readonly class="w-full h-48 bg-amber-50/70 border border-amber-200 rounded-2xl p-3 text-[11px] font-mono text-domino-red font-bold">Loading script...</textarea>
            <button onclick="app.copyScriptCode()" class="absolute top-2 right-2 px-3 py-1 bg-domino-black text-white rounded-xl font-bold text-xs shadow-pill">
              Salin Skrip
            </button>
          </div>

          <div class="flex justify-end">
            <button type="button" data-close-modal class="px-4 py-2 bg-amber-100 text-amber-950 rounded-xl text-xs font-bold">Tutup</button>
          </div>
        </div>
      </div>
    `;
    this.showModal(modalHtml);
    this.loadScriptFileContent();
  }

  async loadScriptFileContent() {
    try {
      const res = await fetch('google-apps-script.js');
      const text = await res.text();
      const el = document.getElementById('script-code-box');
      if (el) el.value = text;
    } catch (e) {
      console.error(e);
    }
  }

  copyScriptCode() {
    const el = document.getElementById('script-code-box');
    if (el) {
      el.select();
      navigator.clipboard.writeText(el.value);
      alert('✅ Skrip Google Apps Script berhasil disalin!');
    }
  }

  async testSheetsConnection() {
    const box = document.getElementById('sync-result-box');
    if (!this.state.settings.sheets_webhook_set) {
      alert('Masukkan Webhook URL terlebih dahulu!');
      return;
    }
    if (box) {
      box.classList.remove('hidden');
      box.className = 'p-3.5 rounded-2xl text-xs bg-amber-50 border border-amber-200 text-amber-900 font-bold';
      box.innerHTML = 'Sedang menguji koneksi ke Google Sheets...';
    }
    const res = await this.cmd('ping_sheets');
    if (!box) return;
    if (res.ok) {
      box.className = 'p-3.5 rounded-2xl text-xs bg-emerald-50 border border-emerald-200 text-emerald-800 font-bold';
      box.innerHTML = '✅ Berhasil terhubung ke Google Sheets!';
    } else if (!['OFFLINE', 'AUTH'].includes(res.code)) {
      box.className = 'p-3.5 rounded-2xl text-xs bg-rose-50 border border-rose-200 text-rose-800 font-bold';
      box.innerHTML = `❌ Gagal menghubungi Webhook: ${this.esc(res.error || 'tidak diketahui')}`;
    }
  }

  async syncToGoogleSheets(showNotification = true) {
    if (!this.state.settings.sheets_webhook_set) {
      if (showNotification) alert('URL Google Apps Script belum diisi di menu Pengaturan!');
      return;
    }
    const res = await this.cmd('sync_sheets');
    if (res.ok) {
      if (showNotification) alert('✅ Seluruh data berhasil disinkronkan ke Google Spreadsheet!');
    } else if (showNotification) {
      this.showError({ ...res, error: 'Gagal menyinkronkan ke Google Sheets: ' + (res.error || 'alasan tidak diketahui') });
    }
  }

  exportToExcel() {
    const calc = this.getCalculations();
    const seasonId = this.state.current_season_id;
    const seasonName = calc.season ? calc.season.season_name : seasonId;
    const q = v => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const row = arr => arr.map(q).join(',') + '\n';
    const nameOf = id => (this.state.players.find(p => p.player_id === id) || {}).display_name || id;
    const matchIds = new Set(calc.seasonMatches.map(m => m.match_id));

    let csv = row([`=== DOMINO LEAGUE - ${seasonName} ===`]) + '\n';

    csv += row(['=== 01 DASHBOARD LEADERBOARD ===']);
    csv += row(['Peringkat', 'Player ID', 'Nama Pemain', 'Total Main', 'Total Sesi', 'Total Ratus', 'Total Ribu', 'Total Kalah', 'Ratus Rate %', 'Ribu Rate %', 'Loss Rate %', 'Performance Index']);
    calc.stats.forEach((p, i) => {
      csv += row([i + 1, p.player_id, p.display_name, p.total_matches, p.total_sessions, p.total_s100, p.total_s1000, p.total_loss, p.s100_rate, p.s1000_rate, p.loss_rate, p.eligible_champion ? p.performance_index : 'Belum memenuhi syarat']);
    });

    csv += '\n' + row(['=== 02 DATA PEMAIN ===']);
    csv += row(['Player ID', 'Nama Pemain', 'Status']);
    this.state.players.forEach(p => { csv += row([p.player_id, p.display_name, p.is_active ? 'Aktif' : 'Nonaktif']); });

    csv += '\n' + row(['=== 03 DATA SESI ===']);
    csv += row(['Session ID', 'Tanggal', 'Label', 'Lokasi', 'Status', 'Catatan']);
    this.state.sessions.filter(s => s.season_id === seasonId).forEach(s => {
      csv += row([s.session_id, s.session_date, s.session_label, s.location || '', s.status, s.notes]);
    });

    csv += '\n' + row(['=== 04 PERTANDINGAN ===']);
    csv += row(['Match ID', 'Session ID', 'No', 'Pemain 1', 'Pemain 2', 'Pemain 3', 'Pemain 4', 'Waktu Main', 'Catatan']);
    calc.seasonMatches.forEach(m => {
      csv += row([m.match_id, m.session_id, m.match_number, ...[0, 1, 2, 3].map(i => nameOf(m.players[i])), m.played_at, m.notes]);
    });

    csv += '\n' + row(['=== 05 DETAIL KEKALAHAN ===']);
    csv += row(['Loss ID', 'Match ID', 'Pemain', 'Jumlah Kalah']);
    this.state.loss_events.filter(l => matchIds.has(l.match_id)).forEach(l => {
      csv += row([l.loss_id, l.match_id, nameOf(l.player_id), l.loss_count]);
    });

    csv += '\n' + row(['=== 06 DETAIL KEJADIAN (Ratus / Ribu) ===']);
    csv += row(['Event ID', 'Match ID', 'Pemain', 'Jenis', 'Jumlah']);
    this.state.special_events.filter(e => matchIds.has(e.match_id)).forEach(e => {
      csv += row([e.event_id, e.match_id, nameOf(e.player_id), this.eventLabel(e.event_type), e.quantity]);
    });

    csv += '\n' + row(['=== 07 PENGHARGAAN SEASON ===']);
    csv += row(['Penghargaan', 'Pemenang', 'Nilai']);
    calc.awards.forEach(a => {
      csv += row([a.title, a.winners.map(w => w.name).join(', ') || '-', a.winners[0]?.value || '-']);
    });

    // BOM agar Excel membaca UTF-8 dengan benar
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Domino_League_${seasonId}_Export.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  showModal(html) {
    const modalHost = document.getElementById('modal-host');
    if (modalHost) modalHost.innerHTML = html;
  }

  closeModal() {
    const modalHost = document.getElementById('modal-host');
    if (modalHost) modalHost.innerHTML = '';
    const r = this._finalResolve;
    this._finalResolve = null;
    if (r) r(false);
    if (this._renderPending) { this._renderPending = false; this.render(); }
  }
}

window.app = new DominoLeagueApp();
