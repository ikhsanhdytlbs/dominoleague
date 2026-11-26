# 🀄 DOMINO LEAGUE - Web App, Statistik & Sync Google Sheets

Aplikasi web untuk mencatat skor sesi nongkrong, klasemen, arsip season, dan sertifikat penghargaan.
Bisa dibuka dari HP atau komputer mana pun. **Setiap orang masuk dengan PIN pemain**, sehingga semua perubahan
tercatat atas nama yang jelas, dan perubahan pada game yang sudah tercatat harus disahkan pemain lain.

---

## 🌐 Dua cara menjalankan

| | **A. Server Node** (`npm start`) | **B. GitHub Pages + Supabase** |
|---|---|---|
| Tampilan dilayani oleh | `server.cjs` | GitHub Pages |
| Aturan dijalankan oleh | `server.cjs` | Supabase Edge Function |
| Data disimpan di | `database.json` | Postgres Supabase |
| Perlu menyewa/merawat server | Ya (atau laptop menyala) | **Tidak** |
| Panduan | bagian di bawah + `DEPLOY.md` | **`SUPABASE-GITHUB.md`** |

Keduanya memakai **kode aturan yang sama** (`engine/engine.js`), jadi perilakunya identik.

## 🚀 Menjalankan

Butuh Node.js 18 atau lebih baru. Tidak perlu `npm install`.

1. (Opsional tapi disarankan) aktifkan **edit paksa**: salin `config.example.json` menjadi `config.local.json`,
   lalu isi `force_password` dengan kata sandi pilihan Anda. File ini tidak pernah dikirim ke browser.
   Alternatif: set variabel lingkungan `FORCE_PASSWORD` (PowerShell: `$env:FORCE_PASSWORD="kata-sandi"`).
   Tanpa kata sandi, fitur paksa nonaktif.
2. Jalankan di folder proyek:
   ```powershell
   npm start
   ```
3. Buka `http://localhost:3000` di laptop, atau alamat IP yang tampil di terminal dari HP (Wi-Fi sama).

Agar bisa dibuka dari mana saja, lihat **DEPLOY.md**.

### Muncul pesan "Server tidak terjangkau" / layar kosong?

Hampir selalu karena yang berjalan adalah **server versi lama** atau server belum dijalankan.
1. Hentikan server yang sedang berjalan (`Ctrl+C` di terminal).
2. Pastikan folder berisi `server.cjs` **terbaru** dan **hapus `server.js` lama** (README lama menyuruh `node server.js`).
3. Jalankan `npm start`. Terminal harus menampilkan baris "Edit paksa dengan kata sandi: ..." dan "Data: ...".
4. Cek di browser: buka `http://localhost:3000/api/state`. Tulisan `{"ok":false,"code":"AUTH",...}` berarti server baru
   sudah benar. Tulisan "404 Not Found" berarti masih server lama.
5. Muat ulang halaman (Ctrl+F5).

---

## 🔐 Login PIN

Setiap kali membuka aplikasi, pemain memasukkan PIN. Satu PIN = satu pemain.

* **PIN bawaan** = 4 angka dari nomor Player ID: `PL01` → `0001`, `PL02` → `0002`, `PL10` → `0010`, dst.
  Pemain baru otomatis mendapat PIN bawaan dari ID-nya (ditampilkan saat pemain ditambahkan).
* **Ubah PIN** (menu akun di sidebar): PIN sendiri terdiri dari **5 atau 6 angka** dan tidak boleh sama dengan pemain lain.
  Setelah diganti, PIN bawaan tidak berlaku lagi untuk pemain itu.
* **Lupa PIN**: ketua liga mereset PIN pemain (Master Data Pemain → ✏️ → Reset PIN, memakai kata sandi paksa).
  PIN kembali ke bawaan.
* Login berlaku di tab/browser itu saja dan berakhir saat tab ditutup (atau setelah 12 jam, atau tombol Keluar).
* Salah PIN terlalu sering mengunci percobaan login selama beberapa menit.

## 👥 Aturan Siapa Boleh Apa

| Aksi | Aturan |
|---|---|
| Lihat apa pun | Harus login dengan PIN |
| **Tambah game baru**, buat sesi, tambah/ubah nama pemain | Pemain yang login (tercatat atas namanya) |
| **Ubah nama, tanggal, catatan sesi** (✏️ di kartu sesi) | Pemain yang login (tercatat di Riwayat) |
| **Hapus sesi kosong** (🗑️) | Pemain yang login |
| **Hapus sesi yang berisi game** | Hanya kata sandi paksa + alasan. Sesi **dan semua game di dalamnya** terhapus; server membuat backup otomatis lebih dulu |
| **Koreksi game yang baru dibuat** | Pembuat game, dalam **10 menit** pertama |
| **Edit / hapus game lama** | Diajukan sebagai usulan, berlaku setelah **1 pemain lain di game itu mengesahkan** |
| Edit / hapus game **tanpa pengesahan** | Kata sandi paksa + alasan wajib. Tercatat sebagai **PAKSA** di Riwayat |
| Finalisasi season, buka kunci, reset, muat demo, ubah pengaturan | Ketik **FINAL** |

Detail pengesahan:
* Pengusul **tidak bisa mengesahkan usulannya sendiri**. Pemain lain harus melakukannya dari HP-nya,
  atau di HP yang sama setelah **Keluar** lalu masuk dengan PIN pemain itu.
* Yang boleh mengesahkan hanya pemain yang bermain di game itu.
* Satu penolakan membatalkan usulan. Usulan kedaluwarsa setelah 48 jam.
* Selama menunggu, statistik tidak berubah. Bila game berubah sebelum disahkan, usulan dibatalkan (ajukan ulang).
* Semua kejadian tercatat di tab **Riwayat** dengan nama pemain yang login, lengkap dengan tombol **Kembalikan** (undo).

Teks yang diketik pemain (nama, label, catatan, alasan) dibersihkan server dari karakter `<` `>` `"` dan `` ` ``
agar tidak ada kode yang bisa disisipkan ke layar pemain lain.

**Batasan yang jujur:** PIN bawaan mudah ditebak (siapa pun bisa mencoba `0002`), jadi aturan ini baru benar-benar
menyulitkan kecurangan bila pemain **mengganti PIN bawaan mereka dengan PIN sendiri**. Riwayat yang terbuka untuk
semua pemain adalah pengawas utamanya. Ketik "FINAL" hanyalah pengaman salah klik.

---

## 💾 Penyimpanan Data

* Semua data ada di **`database.json`** di server (folder proyek, atau `DATA_DIR` bila diatur).
* Backup bergilir otomatis di folder `backups/` (40 terbaru, tambahan khusus sebelum aksi besar).
* Server menolak menimpa `database.json` yang rusak: ia berhenti dan meminta Anda memulihkan dari `backups/`.
* Tampilan di semua perangkat diperbarui otomatis tiap beberapa detik. PIN yang diganti pemain tersimpan di server (dalam bentuk terenkripsi).
* **Data dari versi lama** (yang tersimpan di browser) akan ditawarkan untuk diimpor saat pertama dibuka.
* Aplikasi **membutuhkan server** untuk menyimpan perubahan. Tanpa koneksi, perubahan tidak bisa dicatat.
* Pada cara B, data ada di Postgres Supabase (tabel `league_state`), cadangan bergilir di `league_backups`, dan Anda bisa **Unduh/Pulihkan Cadangan** dari menu Pengaturan (JSON). Lihat `SUPABASE-GITHUB.md`.

Pengaturan opsional (variabel lingkungan): `PORT`, `DATA_DIR`, `TIMEZONE` (default `Asia/Jakarta`), `TRUST_PROXY=1`
(bila di belakang reverse proxy), `FORCE_PASSWORD`.

---

## 📊 Sinkronisasi Google Sheets

1. Buat **Google Spreadsheet** baru, lalu **Extensions > Apps Script**.
2. Salin seluruh isi `google-apps-script.js` ke editor Apps Script.
3. **Deploy > New deployment > Web app**: *Execute as* **Me**, *Who has access* **Anyone**. Salin Web App URL (berakhiran `/exec`).
4. Di aplikasi: **Pengaturan & Sync**, tempel URL, simpan (ketik FINAL), lalu aktifkan **Auto-Sync** bila mau.
   Setiap kali kode Apps Script diubah, deploy ulang lewat *Manage deployments > New version*.

URL webhook disimpan di server dan tidak ditampilkan ke pengguna lain. Server hanya mau mengirim ke `script.google.com`.

Sheet yang dibuat otomatis: `01_Dashboard_Leaderboard`, `02_Data_Pemain`, `03_Data_Sesi`, `04_Input_Pertandingan`,
`05_Detail_Kekalahan`, `06_Detail_Kejadian`, `09_Penghargaan_Season`.

---

## 🌟 Fitur

1. **Dashboard & Klasemen Performance Index** (persentil Ratus, Ribu, dan Kalah).
   * Semua kartu dashboard **murni dari data**, tanpa angka contoh. Kartu **Dominasi Klasemen** menampilkan pemuncak
     sebenarnya (Performance Index, Ratus Rate, Ribu Rate, Loss Control) dan grafik tren PI per sesi. Bila belum ada game,
     atau belum ada pemain yang memenuhi syarat juara, kartu menyatakannya dengan jelas (tanda "—"), bukan angka palsu.
   * Kartu **Aktivitas** menghitung game per **lokasi nongkrong**: dua lokasi berarti dua batang, tiga lokasi tiga batang.
     Isi kolom **Lokasi** saat membuat atau mengubah sesi; penulisan berbeda huruf besar/kecil digabung. Selama belum ada
     lokasi, batangnya per sesi.
   * **Menu samping** bisa disembunyikan: di HP menjadi laci yang dibuka dengan tombol ☰ (tutup dengan mengetuk latar gelap,
     Esc, atau memilih menu); di layar lebar tombol panah menyembunyikannya dan pilihan itu diingat.
   * Kartu **MVP Hari Ini** (dengan karakter domino yang melompat kegirangan) menampilkan pemain dengan skor terbaik
     pada hari itu. Skor memakai rumus Performance Index liga yang sama, tetapi hanya dari game pada hari itu, dan
     pemain harus main minimal 3 game (atau sebanyak game terbanyak bila hari itu lebih sedikit). Bila hari ini belum
     ada game, kartu menampilkan MVP hari terakhir yang ada game, lengkap dengan tanggalnya. Seri diputus oleh kalah
     paling sedikit, lalu Ratus + Ribu terbanyak. Animasi mati otomatis bila perangkat memilih "kurangi gerakan".
2. **Input cepat untuk HP**: wajib 4 pemain berbeda, catat kalah serta kejadian **Ratus** dan **Ribu**.
3. **Sesi nongkrong**, master data pemain (tambah, ubah nama, aktif/nonaktif).
4. **Statistik akumulatif & rasio**, **Head to Head**.
5. **8 Penghargaan Season** + sertifikat digital siap cetak/PDF.
6. **Finalisasi & Arsip**: kunci season dengan snapshot hasil, **Mulai Season Baru**, **Buka Kunci**.
7. **Ekspor CSV** (dapat dibuka di Excel).
8. **Mode DEMO / Data Asli**: dataset contoh `[DEMO]`, lalu beralih ke data kosong saat siap dipakai.

> Catatan istilah: di layar, kejadian disebut **Ratus** dan **Ribu**. Kode internal di data tetap `S100` / `S1000`.


---

## 🗂️ Struktur proyek

```
index.html, app.js, dominoLogic.js, demoData.js   tampilan + statistik (dijalankan di browser)
server.cjs                      cara A: pembungkus HTTP tipis (data di file)
engine/engine.js                SEMUA aturan (dipakai cara A dan B)
engine/store-file.js            penyimpanan file untuk cara A
engine/store-supabase.js        penyimpanan Postgres untuk cara B
supabase/functions/api/         Edge Function (cara B)  | _shared/ = salinan file bersama (npm run sync)
supabase/migrations/            SQL pembuat tabel (cara B)
.github/workflows/              Pages, jaga-aktif, deploy Supabase (opsional), uji otomatis
scripts/                        smoke-test.mjs (periksa deployment), run-tests.mjs, sync-supabase.mjs
test/                           seluruh uji (server Node + Edge Function dengan Supabase tiruan + browser)
```

Setelah mengubah `engine/*`, `dominoLogic.js`, atau `demoData.js`, jalankan `npm run sync` agar salinan untuk Edge Function ikut berubah (`npm test` memeriksanya).

## ✅ Menguji

```bash
npm test                  # semua uji, pada server Node DAN Edge Function
bash test/e2e-browser.sh  # opsional: uji di browser sungguhan (butuh python + playwright)
node scripts/smoke-test.mjs <API_URL> ...   # memeriksa deployment Supabase Anda yang sebenarnya
```
