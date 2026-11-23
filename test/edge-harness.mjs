// Menjalankan Edge Function (supabase/functions/api/index.ts) sebagai server HTTP biasa di Node,
// supaya bisa diuji dengan suite yang sama. Datanya ada di tiruan PostgREST (MOCK_URL).
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const { handler } = await import(pathToFileURL(path.join(root, 'supabase', 'functions', 'api', 'index.ts')).href);
const PORT = Number(process.env.PORT || 4000);

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(',') : v);
  headers.set('x-forwarded-for', req.socket.remoteAddress || 'unknown');
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, '127.0.0.1');
