-- Domino League: tabel penyimpanan untuk Supabase Edge Function "api".
-- Tidak ada logika di sini; seluruh aturan ada di kode (engine/engine.js).
--
-- KEAMANAN: semua tabel DIKUNCI total. RLS aktif tanpa kebijakan apa pun dan hak akses untuk anon /
-- authenticated dicabut, sehingga kunci "anon" yang terlihat di browser tidak bisa membaca atau menulis apa pun.
-- Hanya Edge Function (memakai kunci service_role yang rahasia) yang dapat mengakses tabel-tabel ini.

-- Seluruh data liga disimpan sebagai satu dokumen JSON (satu baris, id = 1).
-- "rev" naik tiap perubahan dan dipakai sebagai kunci optimistik: dua perubahan bersamaan tidak saling menimpa.
create table if not exists public.league_state (
  id         integer primary key check (id = 1),
  doc        jsonb not null,
  rev        bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- Salinan cadangan bergilir (40 terbaru dipertahankan oleh kode).
create table if not exists public.league_backups (
  id       bigint generated always as identity primary key,
  taken_at timestamptz not null default now(),
  rev      bigint,
  reason   text,
  doc      jsonb not null
);

-- Sesi login (yang disimpan hanya hash token, bukan token-nya).
create table if not exists public.app_sessions (
  token_hash text primary key,
  player_id  text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists app_sessions_expires_idx on public.app_sessions (expires_at);
create index if not exists app_sessions_player_idx  on public.app_sessions (player_id);

-- Pembatas percobaan login/kata sandi dan laju permintaan.
create table if not exists public.app_limits (
  key          text primary key,
  fails        integer not null default 0,
  locked_until timestamptz,
  hits         integer not null default 0,
  window_reset timestamptz
);

-- ---- Kunci akses ----
alter table public.league_state   enable row level security;
alter table public.league_backups enable row level security;
alter table public.app_sessions   enable row level security;
alter table public.app_limits     enable row level security;
-- (sengaja TIDAK ada "create policy": tanpa kebijakan, anon/authenticated tidak bisa mengakses baris apa pun)

revoke all on table public.league_state, public.league_backups, public.app_sessions, public.app_limits from anon, authenticated;
grant  all on table public.league_state, public.league_backups, public.app_sessions, public.app_limits to service_role;
