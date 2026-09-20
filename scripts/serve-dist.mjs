import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.PORT || 4173);
const dist = new URL('../dist/', import.meta.url).pathname;
const base = '/creative-cooking';

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

function exportedPath(pathname) {
  if (!pathname.startsWith(base)) return null;
  let relative = pathname.slice(base.length).replace(/^\/+/, '');
  if (!relative) relative = 'index.html';

  const safe = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
  const direct = join(dist, safe);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;

  if (!extname(safe)) {
    const html = join(dist, `${safe}.html`);
    if (existsSync(html)) return html;
    const nested = join(dist, safe, 'index.html');
    if (existsSync(nested)) return nested;
  }

  return join(dist, 'index.html');
}

createServer((request, response) => {
  const pathname = new URL(request.url || '/', `http://127.0.0.1:${port}`).pathname;
  const file = exportedPath(pathname);

  if (!file || !existsSync(file)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const type = types[extname(file)] || 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  });
  response.end(readFileSync(file));
}).listen(port, '127.0.0.1', () => {
  console.log(`Serving exported PWA at http://127.0.0.1:${port}${base}/`);
});
