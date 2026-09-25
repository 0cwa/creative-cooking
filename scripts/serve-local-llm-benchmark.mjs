import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const root = join(repoRoot, 'benchmarks', 'local-llm');
const port = Number(process.env.PORT || 4179);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const safePath = normalize(requested).replace(/^([.][.][/\\])+/, '');
    const path = join(root, safePath);
    if (!path.startsWith(root)) throw new Error('Invalid path');
    const data = await readFile(path);
    res.writeHead(200, {
      'content-type': contentTypes[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Local LLM benchmark: http://127.0.0.1:${port}`);
});
