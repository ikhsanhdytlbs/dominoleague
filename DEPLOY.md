# Deploy: agar bisa dibuka dari HP/komputer mana pun

> **Tidak mau menyewa/merawat server?** Pakai **GitHub Pages + Supabase**: lihat `SUPABASE-GITHUB.md`.
> Dokumen ini untuk menjalankan **server Node** (`server.cjs`) di internet.

Aplikasi ini server Node.js yang menyimpan data ke file, jadi perlu hosting yang **menjalankan Node** dan
punya **penyimpanan permanen**. Hosting statis (Netlify, GitHub Pages) tidak cocok.

## A. Coba cepat dari laptop (gratis, sementara)

Laptop harus menyala selama dipakai.

```bash
npm start
cloudflared tunnel --url http://localhost:3000   # atau: ngrok http 3000
```
Anda mendapat alamat `https://....` yang bisa dibuka siapa saja. Alamat gratis biasanya berubah tiap dijalankan.

## B. VPS (disarankan untuk liga yang jalan terus)

Contoh Ubuntu 22.04/24.04. Ganti `domino.contoh.com` dengan domain Anda (arahkan DNS A-record ke IP VPS).

```bash
# 1. Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Salin folder aplikasi ke /opt/domino-league (scp/rsync), lalu siapkan folder data
sudo mkdir -p /var/lib/domino-league
sudo useradd -r -s /usr/sbin/nologin domino
sudo chown -R domino /var/lib/domino-league
```

`/etc/systemd/system/domino.service`:
```ini
[Unit]
Description=Domino League
After=network.target

[Service]
User=domino
WorkingDirectory=/opt/domino-league
Environment=PORT=3000
Environment=DATA_DIR=/var/lib/domino-league
Environment=TRUST_PROXY=1
Environment=FORCE_PASSWORD=ISI-KATA-SANDI-ANDA
ExecStart=/usr/bin/node server.cjs
Restart=always

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now domino
```

HTTPS otomatis dengan Caddy (`sudo apt install caddy`), isi `/etc/caddy/Caddyfile`:
```
domino.contoh.com {
    reverse_proxy localhost:3000
}
```
```bash
sudo systemctl reload caddy
```
Buka `https://domino.contoh.com`. Pastikan `TRUST_PROXY=1` diatur supaya pembatasan percobaan kata sandi/PIN
membaca alamat pengunjung yang sebenarnya.

## C. Platform PaaS (Render, Railway, Fly.io, dll.)

Lebih mudah, tetapi **wajib memakai persistent disk/volume**. Tanpa itu `database.json` bisa hilang setiap restart
atau deploy. Langkah umum:
1. Unggah proyek (Git), start command: `node server.cjs`.
2. Pasang volume, misalnya di `/data`, lalu set `DATA_DIR=/data`.
3. Set environment: `FORCE_PASSWORD`, `TRUST_PROXY=1`.
Syarat, harga, dan ketersediaan disk gratis tiap penyedia berubah-ubah, jadi cek dulu sebelum memilih.

## Backup

* Server menyimpan 40 backup terbaru di `DATA_DIR/backups/`.
* Tetap salin `database.json` ke tempat lain secara berkala (misalnya `cron` + `rclone`, atau unduh manual).
* Untuk memulihkan: hentikan server, salin salah satu file `backups/database-...json` menjadi `database.json`, jalankan lagi.

## Sebelum dibuka ke banyak orang

* Setel `FORCE_PASSWORD` dengan kata sandi yang hanya diketahui orang yang Anda percaya. Siapa pun yang tahu
  kata sandi ini bisa mengubah game tanpa pengesahan dan mereset PIN (tercatat di Riwayat).
* Semua halaman data dilindungi login PIN. **PIN bawaan mudah ditebak** (`0001`, `0002`, ...), jadi minta tiap pemain
  mengganti PIN-nya dengan PIN sendiri (menu akun di sidebar) sebelum dipakai serius.
* Pasang HTTPS (Caddy di atas, atau fitur bawaan PaaS) supaya PIN tidak terkirim sebagai teks biasa lewat internet.
* Server mengingat sesi login di memori: setiap server di-restart, semua orang diminta memasukkan PIN lagi.
