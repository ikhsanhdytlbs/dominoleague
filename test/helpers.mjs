// Pembantu uji: menjalankan target yang sama dengan dua cara.
//   TARGET=node (bawaan): server.cjs  -> data di file
//   TARGET=edge         : Edge Function + tiruan PostgREST -> data di "Supabase"
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const TARGET = process.env.TARGET === 'edge' ? 'edge' : 'node';
const children = [];
process.on('exit', () => children.forEach(c => { try { c.kill(); } catch (_) { /* abaikan */ } }));

let mock = null;
async function ensureMock(port) {
  if (mock) return;
  mock = spawn('node', [path.join(ROOT, 'test', 'mock-postgrest.mjs')], { env: { ...process.env, MOCK_PORT: String(port) }, stdio: 'ignore' });
  children.push(mock);
  await new Promise(r => setTimeout(r, 500));
}
export const mockUrl = port => `http://127.0.0.1:${port}`;

export function target({ port, dataDir, forcePassword = 'CURANGDOSA', extraEnv = {} }) {
  const mockPort = port + 1000;
  let child = null;
  const api = {
    kind: TARGET,
    base: `http://127.0.0.1:${port}`,
    mock: mockUrl(mockPort),
    async start() {
      const env = { ...process.env, PORT: String(port), FORCE_PASSWORD: forcePassword, ...extraEnv };
      if (TARGET === 'edge') {
        await ensureMock(mockPort);
        Object.assign(env, { SUPABASE_URL: mockUrl(mockPort), SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' });
        child = spawn('node', [path.join(ROOT, 'test', 'edge-harness.mjs')], { env, stdio: 'ignore', cwd: ROOT });
      } else {
        env.DATA_DIR = dataDir;
        child = spawn('node', [path.join(ROOT, 'server.cjs')], { env, stdio: 'ignore', cwd: ROOT });
      }
      children.push(child);
      await new Promise(r => setTimeout(r, 1300));
    },
    async stop() { if (child) { child.kill(); await new Promise(r => setTimeout(r, 300)); child = null; } },
    kill() { if (child) child.kill(); if (mock) mock.kill(); }
  };
  return api;
}
