# Online tanpa server: GitHub Pages + Supabase

Dengan cara ini tidak ada server yang perlu Anda sewa atau rawat.

```
HP / komputer pemain
      │  membuka halaman                      │  memanggil API (HTTPS)
      ▼                                       ▼
 GitHub Pages                         Supabase Edge Function "api"
 (tampilan statis)                    (semua aturan: PIN, pengesahan, paksa, FINAL, riwayat)
                                              │
                                              ▼
                                      Supabase Postgres (data, sesi login, cadangan)
```

* **GitHub Pages** hanya menayangkan file tampilan (`index.html`, `app.js`, ...).
* **Edge Function `api`** menjalankan aturan yang **sama persis** dengan `server.cjs` (kode bersama: `engine/engine.js`).
* **Postgres** hanya menyimpan data. Tabelnya dikunci total: kunci "anon" yang terlihat di browser tidak bisa membaca atau menulis apa pun.

Waktu yang dibutuhkan: sekitar 30 sampai 45 menit untuk kali pertama.

---

## 0. Yang perlu disiapkan

* Akun **GitHub** dan akun **Supabase** (keduanya gratis).
* Folder proyek ini di komputer Anda. Untuk Cara A di Langkah 3 juga butuh **Node.js 20+** terpasang.
* Sebuah **kata sandi paksa** pilihan Anda (hanya untuk ketua liga).

---

## 1. Buat proyek Supabase

1. Di supabase.com buat **New project**. Pilih region terdekat (mis. Singapore), catat **Database password**.
2. Setelah jadi, catat **Project ref**: potongan acak di alamat `https://<PROJECT_REF>.supabase.co`.
3. Alamat API Anda nantinya: `https://<PROJECT_REF>.supabase.co/functions/v1/api`

> ⚠️ **Jangan tertukar:** dashboard Supabase juga menampilkan "API URL" berakhiran `/rest/v1/`. Itu alamat database langsung dan **bukan** yang kita pakai.
> Alamat API aplikasi ini **selalu** berakhiran `/functions/v1/api`.

## 2. Buat tabel

1. Di Supabase buka **SQL Editor** > **New query**.
2. Tempel seluruh isi `supabase/migrations/20260101000000_init.sql`, lalu **Run**.
3. Buka **Table Editor**: harus ada 4 tabel (`league_state`, `league_backups`, `app_sessions`, `app_limits`) dan tiap tabel menunjukkan **RLS enabled**.

File itu hanya membuat tabel dan menguncinya. Tidak ada logika di SQL.

## 3. Deploy Edge Function

Pilih salah satu.

### Cara A: dari komputer Anda (Supabase CLI)

```bash
npm run sync                                        # menyalin file bersama ke supabase/functions/_shared
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npx supabase functions deploy api --no-verify-jwt
```

### Cara B: otomatis dari GitHub (tanpa terminal)

Cara ini butuh **repositori GitHub yang sudah berisi file proyek** (Langkah 4 poin 1 sampai 2), jadi kerjakan itu dulu.
Anda hanya perlu mengisi **satu rahasia** dan **satu variabel**:

1. **Buat token di Supabase.** Buka <https://supabase.com/dashboard/account/tokens> (atau: klik foto/ikon akun Anda di dashboard Supabase > **Account preferences** > **Access Tokens**), klik **Generate new token**, beri nama bebas (mis. `github-deploy`), lalu **salin tokennya** (awalan `sbp_`). Token hanya tampil sekali.
   Bila Anda diminta memilih izin, batasi ke proyek ini saja dan izinkan **Edge Functions (Read-write)**.
2. **Buka pengaturan repositori GitHub** (bukan pengaturan akun): masuk ke halaman repositori Anda, lalu klik tab **Settings** pada deretan menu paling atas (Code, Issues, Pull requests, Actions, ..., **Settings**).
3. Di menu kiri klik **Secrets and variables** > **Actions**. Halaman itu punya dua tab: **Secrets** dan **Variables**.
4. Tab **Secrets** > **New repository secret** > Name: `SUPABASE_ACCESS_TOKEN`, Secret: tempel token tadi > **Add secret**.
5. Tab **Variables** > **New repository variable** > Name: `SUPABASE_PROJECT_REF`, Value: Project ref Anda (potongan acak di alamat proyek, mis. `abcdefghijklmnop` dari `https://abcdefghijklmnop.supabase.co`) > **Add variable**.
6. Jalankan workflow: klik tab **Actions** di repositori > di daftar kiri pilih **Deploy fungsi ke Supabase (opsional)** > tombol **Run workflow** (kanan) > **Run workflow** (hijau). Tunggu 1 sampai 2 menit sampai ada tanda centang hijau ✓.

Selanjutnya fungsi otomatis ter-deploy ulang tiap Anda mengubah file di folder `supabase/` atau `engine/`.

> Editor fungsi di dashboard Supabase tidak cocok di sini karena fungsi kita memakai beberapa file. Pakai Cara A atau B.

### Atur rahasia fungsi (wajib)

```bash
npx supabase secrets set FORCE_PASSWORD="kata-sandi-ketua-liga"
npx supabase secrets set ALLOWED_ORIGIN="https://USERNAME.github.io"
npx supabase secrets set INITIAL_DATA=real
```

Tanpa terminal: di dashboard Supabase buka menu **Edge Functions**, lalu **Secrets** (tampilan bisa sedikit berbeda), dan tambahkan pasangan nama dan nilai satu per satu.

| Rahasia | Fungsi |
|---|---|
| `FORCE_PASSWORD` | Kata sandi untuk edit paksa, hapus sesi berisi game, reset PIN, unduh cadangan. Tanpa ini fitur-fitur itu mati. |
| `ALLOWED_ORIGIN` | Alamat situs tampilan Anda **tanpa garis miring dan tanpa folder**, mis. `https://budi.github.io`. Browser dari situs lain akan diblokir. Pisahkan dengan koma bila lebih dari satu. |
| `INITIAL_DATA` | `real` = mulai kosong (disarankan). Tanpa ini, instalasi baru dimulai dengan data contoh [DEMO]. |
| `TIMEZONE` | Opsional, bawaan `Asia/Jakarta`. |

Nama rahasia tidak boleh diawali `SUPABASE_` (dicadangkan Supabase). `SUPABASE_URL` dan kunci rahasia (`SUPABASE_SECRET_KEYS` untuk kunci format baru, atau `SUPABASE_SERVICE_ROLE_KEY` untuk format lama) sudah tersedia otomatis di dalam fungsi; kode kita membaca keduanya, jadi Anda tidak perlu mengatur apa pun untuk itu. **Jangan pernah** menaruh kunci `service_role` di GitHub atau di `config.js`.

## 4. Siapkan GitHub dan GitHub Pages

1. Buat repositori baru di GitHub. Untuk akun gratis, GitHub Pages membutuhkan repositori **publik**. Itu aman karena tidak ada rahasia di dalam kodenya (rahasia ada di Supabase).
2. Unggah seluruh folder proyek ke repositori itu (cabang `main`).
3. **Settings > Pages > Build and deployment > Source: GitHub Actions**.
4. **Settings > Secrets and variables > Actions > Variables > New repository variable**:
   * `API_URL` = `https://<PROJECT_REF>.supabase.co/functions/v1/api`
5. **Jalankan pembuatan situs** (lihat "Cara menjalankan sebuah workflow" di bawah) untuk workflow **Tayangkan tampilan ke GitHub Pages**. Ini perlu karena workflow pertama yang berjalan saat Anda mengunggah file kemungkinan gagal (Pages dan `API_URL` belum diatur saat itu), jadi ulangi setelah poin 3 dan 4.
6. Alamat situs (muncul juga di **Settings > Pages** sebagai "Your site is live at ..."): `https://USERNAME.github.io/NAMA-REPO/`. Pastikan `ALLOWED_ORIGIN` di Langkah 3 sama dengan `https://USERNAME.github.io`.

### Cara menjalankan sebuah workflow

"Workflow" adalah tugas otomatis di GitHub (mis. membuat situs). Cara menjalankannya dengan tangan:

1. Buka halaman repositori Anda di GitHub > klik tab **Actions** (di deretan menu atas).
2. Di daftar sebelah kiri, klik nama workflow, mis. **Tayangkan tampilan ke GitHub Pages**.
3. Di sisi kanan ada tombol **Run workflow**. Klik, lalu klik tombol hijau **Run workflow** di kotak yang muncul.
4. Muncul baris baru dengan ikon kuning (berjalan). Tunggu sampai menjadi **centang hijau ✓** (sekitar 1 sampai 2 menit). Tanda **✗ merah** berarti gagal: klik barisnya untuk melihat pesannya.
5. Untuk situs: setelah ✓, alamatnya ada di **Settings > Pages**.

Kalau daftar workflow di kiri **kosong**, folder tersembunyi `.github` belum ikut terunggah. Periksa di tab **Code**: harus ada folder `.github` berisi `workflows`. Bila belum ada, unggah folder itu (di Windows pastikan "Hidden items" ditampilkan di File Explorer).

"Atau cukup push lagi" artinya: setiap kali Anda mengunggah/mengubah file di cabang `main`, situs otomatis dibuat ulang tanpa menekan tombol apa pun.

## 5. Periksa semuanya dengan smoke test

Ini memeriksa deployment yang sebenarnya, termasuk bahwa database benar-benar terkunci. Kerjakan **setelah** fungsi ter-deploy (Langkah 3) dan `.../functions/v1/api/ping` menjawab `{"ok":true,...}`.

**Buka terminal yang benar.** Di Windows: tekan tombol Windows, ketik `cmd` (atau `PowerShell`), Enter. Ini jendela hitam/biru dengan alamat folder seperti `C:\Users\Nama>`. **Bukan** program "Node.js" (yang berawalan `>` dan menampilkan "Welcome to Node.js"): perintah di bawah akan error di sana.

Masuk ke folder proyek yang sudah diekstrak, mis.:

```
cd C:\Users\NAMA\Downloads\domino-league
```

Lalu jalankan **satu baris** ini (ganti nilainya; jangan pecah menjadi beberapa baris dan jangan pakai tanda `\`):

```
node scripts/smoke-test.mjs https://<PROJECT_REF>.supabase.co/functions/v1/api --origin https://USERNAME.github.io --supabase-url https://<PROJECT_REF>.supabase.co --anon-key <KUNCI_PUBLISHABLE> --write
```

`<KUNCI_PUBLISHABLE>` ada di Supabase: **Project Settings > API Keys**, kunci berawalan `sb_publishable_` (kunci lama bernama *anon* juga bisa). Kunci ini memang publik dan aman dipakai di sini. **Jangan pernah** memakai atau membagikan kunci `sb_secret_` / `service_role`.

Semua baris harus **PASS**. Perhatikan khususnya baris `RLS: kunci publik TIDAK bisa membaca/menulis`. Kalau ada yang **FAIL**, jangan dibuka ke pemain dulu. Untuk keluar dari jendela Node.js yang terlanjur terbuka, ketik `.exit` lalu Enter.

## 6. Pertama kali dipakai

1. Buka situs, masuk dengan **PIN bawaan**: `0001` = pemain `PL01`, `0002` = `PL02`, dan seterusnya.
2. **Segera** ubah PIN tiap pemain menjadi PIN sendiri (chip nama di kanan atas > Ubah PIN). Ingat: alamat situs publik, dan PIN bawaan mudah ditebak.
3. Ubah nama pemain bawaan menjadi nama sebenarnya (Data Pemain > ✏️).
4. Bila tadi tidak memakai `INITIAL_DATA=real` dan layar menampilkan data [DEMO]: **Pengaturan > Beralih ke Data Asli**.

### Memindahkan data lama

* Dari server Node lama: pakai **Pengaturan > Pulihkan dari File Cadangan** dan pilih file `database.json` (atau file cadangan hasil **Unduh Cadangan**). PIN semua pemain kembali ke PIN bawaan.
* Dari browser versi sangat lama: aplikasi menawarkan impor otomatis saat pertama masuk.

---

## Cadangan (penting)

Paket gratis Supabase tidak bisa diandalkan untuk cadangan otomatis (cek ketentuan terbaru di halaman resmi Supabase). Karena itu:

1. **Cadangan dalam database:** tiap aksi penting (hapus paksa, finalisasi, reset, dst.) menyimpan salinan keadaan sebelumnya di tabel `league_backups` (40 terbaru).
2. **Cadangan di luar Supabase (disarankan seminggu sekali):** **Pengaturan > Unduh Cadangan** (butuh kata sandi paksa), simpan file JSON-nya di Google Drive atau tempat lain.

Memulihkan dari tabel `league_backups` (SQL Editor). Cari dulu nomornya, lalu pulihkan:

```sql
select id, taken_at, reason from public.league_backups order by id desc;

update public.league_state s
   set doc = b.doc, rev = s.rev + 1
  from public.league_backups b
 where b.id = 12 and s.id = 1;   -- ganti 12 dengan nomor cadangan pilihan Anda
```

Memulihkan dari file JSON: **Pengaturan > Pulihkan dari File Cadangan** (ketik FINAL).

## Menjaga proyek tetap aktif

Proyek gratis Supabase dijeda bila aktivitas database sangat sedikit selama seminggu. Workflow **Jaga proyek Supabase tetap aktif** memanggil `/ping` sekali sehari, dan itu menyentuh database. Itu membantu tetapi bukan jaminan mutlak. GitHub juga dapat menonaktifkan workflow terjadwal pada repositori yang lama tanpa aktivitas, jadi sesekali lihat tab Actions. Bila proyek terlanjur dijeda, buka dashboard Supabase dan **Restore**.

## Batas paket gratis

(Angka dari dokumentasi Supabase saat panduan ini ditulis; cek halaman resmi untuk yang terbaru.)

* Edge Function: **500.000 pemanggilan per bulan**, batas CPU 2 detik per permintaan. Permintaan preflight CORS tidak dihitung.
* Aplikasi memeriksa pembaruan tiap **15 detik** hanya saat tab terlihat. Lima HP terbuka empat jam seminggu kira-kira 20.000 pemanggilan per bulan. Tutup tab yang tidak dipakai.
* Database gratis 500 MB, sangat lebih dari cukup untuk liga ini.

## Keamanan: ringkasan

* Database dikunci (RLS tanpa kebijakan + hak anon/authenticated dicabut). Hanya fungsi `api` yang bisa mengaksesnya. **Verifikasi dengan smoke test.**
* Kata sandi paksa dan kunci `service_role` hanya ada di rahasia Supabase.
* Semua halaman data butuh login PIN. PIN bawaan mudah ditebak, jadi minta semua pemain menggantinya.
* Percobaan PIN salah dan kata sandi salah dibatasi per alamat IP. Bila Supabase tidak meneruskan IP asli pengunjung, semua orang berbagi satu batas: banyak PIN salah dari satu orang bisa menahan login semua orang selama beberapa menit. Bila ini terjadi, beri tahu saya.
* Teks yang diketik pemain dibersihkan dari karakter `<` `>` `"` `` ` `` agar tidak ada kode yang bisa disisipkan.

## Pemecahan masalah

| Gejala | Penyebab umum |
|---|---|
| "Alamat API tidak ditemukan..." | `API_URL` salah, atau fungsi `api` belum di-deploy. Periksa variabel `API_URL` lalu jalankan ulang workflow Pages. |
| "Tidak bisa menghubungi layanan API..." atau layar PIN tak bereaksi | `ALLOWED_ORIGIN` tidak sama dengan alamat situs (browser memblokir), atau tak ada internet. |
| Galat 500 "Konfigurasi server belum lengkap" | Fungsi tidak menemukan `SUPABASE_URL` atau kunci rahasia Supabase (`SUPABASE_SECRET_KEYS` / `SUPABASE_SERVICE_ROLE_KEY`). Biasanya tersedia otomatis; deploy ulang fungsinya, dan pastikan proyek punya kunci rahasia (Project Settings > API Keys). |
| "Penyimpanan data tidak tersedia" / galat "Supabase: ..." | Tabel belum dibuat (Langkah 2), atau proyek sedang dijeda. |
| Fitur paksa mati | `FORCE_PASSWORD` belum diatur sebagai rahasia fungsi. |
| Workflow deploy ✗ dengan pesan "Confirmation required ... Re-run with --yes" | Versi CLI terbaru meminta konfirmasi. Pakai file `deploy-supabase.yml` terbaru (baris terakhirnya memakai `--yes`). |
| `npm run sync` error di Windows karena jalur aneh (`C:\C:\...`, `%20`) | Bug skrip versi lama pada folder yang namanya mengandung spasi. Sudah diperbaiki di versi terbaru. Selain itu `npm run sync` hanya perlu dijalankan **setelah Anda mengubah** file di `engine/`, `dominoLogic.js`, atau `demoData.js`; ZIP yang dibagikan sudah sinkron. |
| Semua orang diminta login ulang | Sesi 12 jam berakhir, atau data dipulihkan dari impor/reset. Normal. |

## Menjalankan di komputer sendiri (tanpa Supabase)

Cara lama tetap bisa: `npm start` (server Node, data di `database.json`). Aturannya identik karena memakai kode yang sama.

## Menguji

```bash
npm test                 # seluruh uji: server Node DAN Edge Function (dengan database Supabase tiruan)
bash test/e2e-browser.sh # uji di browser sungguhan, tampilan dan API di alamat berbeda (opsional: butuh playwright)
```

### Yang sudah dan belum diuji

Sudah diuji otomatis: semua aturan (login PIN, pengesahan, paksa, FINAL, sesi, riwayat, cadangan) pada **kedua** target; penyimpanan Supabase terhadap tiruan PostgREST yang ketat; CORS dan alur lintas-alamat di Chromium; skrip smoke test.

**Belum bisa diuji dari lingkungan pengembangan** (tidak ada Postgres, Deno, atau akses ke proyek Supabase Anda): menjalankan SQL di Postgres asli, perilaku runtime Edge Function asli, dan workflow GitHub Actions. Bagian ini sengaja dibuat sekecil mungkin dan sederhana, dan **smoke test di Langkah 5 adalah cara memverifikasinya di deployment Anda**. Kalau ada yang FAIL atau galat, kirimkan keluarannya kepada saya.
