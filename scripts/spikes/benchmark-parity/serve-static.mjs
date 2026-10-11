import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';
const directory = path.resolve(process.argv[2] ?? 'dist-automerge');
const port = Number(process.env.PORT ?? 4173);
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json', '.wasm':'application/wasm',
  '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.webp':'image/webp', '.woff2':'font/woff2', '.map':'application/json' };
createServer((req, res) => {
  const raw = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (!raw.startsWith('/creative-cooking/')) {
    res.writeHead(404); res.end('wrong base path'); return;
  }
  const relative = raw.slice('/creative-cooking/'.length) || 'index.html';
  const candidates = [relative, relative + '.html', path.join(relative,'index.html')];
  let file;
  for (const name of candidates) {
    const full = path.resolve(directory, name);
    if (full.startsWith(directory + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      file = full; break;
    }
  }
  if (!file) { res.writeHead(404); res.end('missing ' + relative); return; }
  const body = fs.readFileSync(file);
  const accept = req.headers['accept-encoding'] || '';
  const shouldCompress = /\.(?:html|js|css|json|wasm)$/u.test(file);
  let data = body, encoding;
  if (shouldCompress && accept.includes('br')) { data = brotliCompressSync(body); encoding = 'br'; }
  else if (shouldCompress && accept.includes('gzip')) { data = gzipSync(body); encoding = 'gzip'; }
  const headers = { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': data.byteLength, 'Cache-Control': 'no-store', 'Vary': 'Accept-Encoding' };
  if (encoding) headers['Content-Encoding'] = encoding;
  res.writeHead(200, headers);
  res.end(data);
}).listen(port, '127.0.0.1', () => console.log('static export from ' + directory + ' at http://127.0.0.1:' + port + '/creative-cooking/'));
