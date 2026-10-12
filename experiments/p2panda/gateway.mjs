// Experimental, loopback-only durable ciphertext mailbox. NOT a p2panda relay,
// production server or trustworthy authorization service. Stores opaque bytes.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATH = /^\/v1\/spaces\/([a-f0-9]{32,64})\/frames(?:\/([a-f0-9]{64}))?$/;
const MAX_BYTES = 1024 * 1024 + 64;
const cors = {
  'Access-Control-Allow-Origin': '*', // local demonstration only
  'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
function reply(res, status, body = '', type = 'text/plain') {
  res.writeHead(status, { ...cors, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

export function createGateway(directory) {
  return createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return reply(res, 204);
    const match = PATH.exec(new URL(req.url, 'http://localhost').pathname);
    if (!match) return reply(res, 404, 'Not found');
    const [, space, id] = match;
    const root = join(directory, space);
    try {
      if (req.method === 'PUT' && id) {
        const chunks = [];
        let total = 0;
        for await (const chunk of req) {
          total += chunk.length;
          if (total > MAX_BYTES) return reply(res, 413, 'Frame too large');
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        if (createHash('sha256').update(bytes).digest('hex') !== id) {
          return reply(res, 422, 'Content hash mismatch');
        }
        await mkdir(root, { recursive: true });
        try {
          await writeFile(join(root, id + '.bin'), bytes, { flag: 'wx', mode: 0o600 });
          return reply(res, 201);
        } catch (e) {
          if (e.code === 'EEXIST') return reply(res, 200);
          throw e;
        }
      }
      if (req.method === 'GET' && !id) {
        const files = await readdir(root).catch(e => {
          if (e.code === 'ENOENT') return [];
          throw e;
        });
        return reply(res, 200, JSON.stringify(files.filter(x => /^[a-f0-9]{64}\.bin$/.test(x))
          .map(x => x.slice(0, -4)).sort()), 'application/json');
      }
      if (req.method === 'GET' && id) {
        const bytes = await readFile(join(root, id + '.bin')).catch(e => {
          if (e.code === 'ENOENT') return null;
          throw e;
        });
        return bytes ? reply(res, 200, bytes, 'application/octet-stream') : reply(res, 404);
      }
      return reply(res, 405);
    } catch (e) {
      console.error('gateway failed:', e);
      return reply(res, 500, 'Internal gateway error');
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const directory = process.argv[2] || './.p2panda-mailbox';
  const port = Number(process.argv[3] || 8765);
  createGateway(directory).listen(port, '127.0.0.1', () =>
    console.log('EXPERIMENTAL localhost ciphertext mailbox at http://127.0.0.1:' + port));
}
