// Supabase Edge Function "api": pintu masuk API Domino League (login, state, command, ping).
// Seluruh aturan ada di ../_shared/engine.js (sama dengan server Node). Data disimpan di Postgres lewat store-supabase.js.
// Dibuat tanpa verifikasi JWT Supabase (verify_jwt = false): keamanan memakai PIN + sesi sendiri, dan tabel
// database dikunci total (RLS tanpa kebijakan) sehingga hanya fungsi ini (kunci service_role) yang bisa mengaksesnya.
import { makeEngine } from '../_shared/engine.js';
import { createSupabaseStore } from '../_shared/store-supabase.js';
import * as L from '../_shared/dominoLogic.js';
import * as D from '../_shared/demoData.js';

const MAX_BODY = 10 * 1024 * 1024;

function getEnv(name: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const g: any = globalThis;
  if (g.Deno && g.Deno.env) return g.Deno.env.get(name);
  return g.process && g.process.env ? g.process.env[name] : undefined;
}

// Kunci rahasia server: format baru (SUPABASE_SECRET_KEYS, kamus JSON) lebih dulu, lalu format lama.
function getServiceKey(): string | undefined {
  const raw = getEnv('SUPABASE_SECRET_KEYS');
  if (raw) {
    if (raw.startsWith('sb_secret_')) return raw;
    try {
      const keys = JSON.parse(raw);
      if (keys && typeof keys === 'object') {
        if (keys.default) return String(keys.default);
        const first = Object.values(keys)[0];
        if (first) return String(first);
      }
    } catch (_) { /* format tidak dikenal: coba cara lama */ }
  }
  return getEnv('SUPABASE_SERVICE_ROLE_KEY');
}

function corsHeaders(req: Request): Record<string, string> {
  const list = (getEnv('ALLOWED_ORIGIN') || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') || '';
  const allow = list.includes('*') ? '*' : (list.includes(origin) ? origin : list[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Session, Authorization, apikey',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function reply(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function handler(req: Request): Promise<Response> {
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const url = new URL(req.url);
  const route = url.pathname.replace(/\/+$/, '').split('/').pop() || '';

  const supabaseUrl = getEnv('SUPABASE_URL');
  const serviceKey = getServiceKey();
  if (!supabaseUrl || !serviceKey) {
    return reply(500, { ok: false, code: 'CONFIG', error: 'Konfigurasi server belum lengkap: SUPABASE_URL atau kunci rahasia Supabase (SUPABASE_SECRET_KEYS / SUPABASE_SERVICE_ROLE_KEY) tidak ditemukan di fungsi.' }, cors);
  }

  let body: unknown = null;
  if (req.method === 'POST') {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return reply(413, { ok: false, code: 'TOO_BIG', error: 'Payload terlalu besar.' }, cors);
    try { body = raw ? JSON.parse(raw) : {}; } catch (_) {
      return reply(400, { ok: false, code: 'BAD_JSON', error: 'Body bukan JSON valid.' }, cors);
    }
  }

  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'unknown';
  const store = createSupabaseStore({ url: supabaseUrl, serviceKey });
  const api = makeEngine({
    store, L, D,
    config: {
      forcePassword: getEnv('FORCE_PASSWORD') || '', timezone: getEnv('TIMEZONE') || 'Asia/Jakarta',
      initialData: getEnv('INITIAL_DATA') || 'demo',
    },
    // Pekerjaan latar (sinkron Google Sheets) dilanjutkan setelah balasan dikirim
    background: (p: Promise<unknown>) => {
      // deno-lint-ignore no-explicit-any
      const g: any = globalThis;
      p.catch(() => {});
      if (g.EdgeRuntime && typeof g.EdgeRuntime.waitUntil === 'function') g.EdgeRuntime.waitUntil(p);
    },
  });

  try {
    const out = await api.handle({
      method: req.method, route, query: url.searchParams, token: req.headers.get('x-session') || (req.headers.get('authorization') || '').replace(/^Bearer /, ''), body, ip,
    });
    return reply(out.status, out.body, cors);
  } catch (e) {
    console.error(e);
    return reply(500, { ok: false, code: 'SERVER', error: 'Terjadi kesalahan di server.' }, cors);
  }
}

// deno-lint-ignore no-explicit-any
const g: any = globalThis;
if (g.Deno && typeof g.Deno.serve === 'function') g.Deno.serve(handler);
