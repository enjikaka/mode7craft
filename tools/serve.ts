// Tiny static server for dist/ with precompressed brotli/gzip.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
const dist = new URL('../dist/', import.meta.url).pathname;
const types: Record<string, string> = { html: 'text/html; charset=utf-8', wasm: 'application/wasm', js: 'text/javascript' };
const port = Number(process.env.PORT ?? 8787);
createServer((req, res) => {
  let p = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.includes('..') || !existsSync(dist + p)) { res.writeHead(404).end('not found'); return; }
  const ext = p.split('.').pop()!;
  const ae = String(req.headers['accept-encoding'] ?? '');
  const enc = ae.includes('br') && existsSync(dist + p + '.br') ? 'br' : ae.includes('gzip') && existsSync(dist + p + '.gz') ? 'gzip' : '';
  const body = readFileSync(dist + p + (enc === 'br' ? '.br' : enc === 'gzip' ? '.gz' : ''));
  const h: Record<string, string> = { 'Content-Type': types[ext] ?? 'application/octet-stream', 'Cache-Control': ext === 'html' ? 'no-cache' : 'public, max-age=60', 'Vary': 'Accept-Encoding', 'Content-Length': String(body.length) };
  if (enc) h['Content-Encoding'] = enc;
  res.writeHead(200, h).end(req.method === 'HEAD' ? undefined : body);
}).listen(port, () => console.log(`serving ${dist} on :${port}`));
