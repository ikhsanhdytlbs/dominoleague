// Menyalin file bersama ke supabase/functions/_shared (Edge Function hanya bisa mengimpor dari folder functions).
// Jalankan: node scripts/sync-supabase.mjs          -> menyalin
//           node scripts/sync-supabase.mjs --check  -> hanya memeriksa (gagal bila ada yang berbeda)
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const target = path.join(root, 'supabase', 'functions', '_shared');
const files = ['engine/engine.js', 'engine/store-supabase.js', 'dominoLogic.js', 'demoData.js'];
const check = process.argv.includes('--check');
fs.mkdirSync(target, { recursive: true });
let diff = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(root, f));
  const dst = path.join(target, path.basename(f));
  const same = fs.existsSync(dst) && fs.readFileSync(dst).equals(src);
  if (check) { if (!same) { console.error('BERBEDA:', path.basename(f)); diff++; } }
  else if (!same) { fs.writeFileSync(dst, src); console.log('disalin:', path.basename(f)); }
}
if (check) { if (diff) { console.error('Jalankan: node scripts/sync-supabase.mjs'); process.exit(1); } console.log('supabase/functions/_shared sudah sinkron.'); }
