// Disposable loopback TLS proxy for transport/behavior measurements only.
// Origin filtering is not authentication. Never deploy this toy as a public service.
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';

const port = Number(process.env.CC_OPS_PROXY_PORT);
const backendPort = Number(process.env.CC_OPS_TARGET_PORT);
const allowed = process.env.CC_OPS_ALLOWED_ORIGIN || 'http://127.0.0.1:9891';
const keyPath = process.env.CC_OPS_PROXY_KEY, certPath = process.env.CC_OPS_PROXY_CERT;
if (!(port > 0 && backendPort > 0 && keyPath && certPath)) throw new Error('Missing loopback TLS proxy config');
const stats = {
  httpRequests:0, httpBytesUp:0, httpBytesDown:0, httpRejected:0, preflight:0,
  upgrades:0, upgradeRejected:0, wsBytesUp:0, wsBytesDown:0,
  activeWebSockets:0, peakWebSockets:0
};
const originPermitted = origin => !origin || origin === allowed;
const headersForOrigin = origin => origin === allowed
  ? { 'access-control-allow-origin':allowed, 'access-control-allow-methods':'GET, POST, OPTIONS',
      'access-control-allow-headers':'Content-Type, X-Session-Id',
      'access-control-expose-headers':'X-Session-Id', 'vary':'Origin' }
  : { 'vary':'Origin' };
const MAX_HTTP_BYTES = 256 * 1024;
const MAX_SESSIONS = 16;
const server = https.createServer({
  key:readFileSync(keyPath), cert:readFileSync(certPath)
}, (req,res) => {
  if (req.url === '/__ops_stats' && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(stats));
    return;
  }
  stats.httpRequests++;
  const origin = req.headers.origin;
  if (!originPermitted(origin)) {
    stats.httpRejected++;res.writeHead(403);res.end('origin denied');return;
  }
  if (req.method === 'OPTIONS') {
    stats.preflight++;
    res.writeHead(204, headersForOrigin(origin));res.end();return;
  }
  if (Number(req.headers['content-length'] || 0) > MAX_HTTP_BYTES) {
    stats.httpRejected++;req.resume();res.writeHead(413);res.end('HTTP request quota exceeded');return;
  }
  const proxied = http.request({
    hostname:'127.0.0.1',port:backendPort,method:req.method,path:req.url,
    headers:{...req.headers,host:'127.0.0.1:' + backendPort},timeout:90000
  }, upstream => {
    const hdr = {...upstream.headers, ...headersForOrigin(origin)};
    res.writeHead(upstream.statusCode || 502, hdr);
    upstream.on('data', buf => {stats.httpBytesDown+=buf.length;});
    upstream.pipe(res);
  });
  // If the upstream crashes/disconnects, return a bounded gateway error.
  // Keep errors handled to avoid bringing down the TLS proxy.
  res.on('error', () => {});
  proxied.on('error', () => {
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) res.writeHead(502);
    res.end('upstream unavailable');
  });
  proxied.on('timeout', () => proxied.destroy(new Error('upstream timeout')));
  let count = 0;
  req.on('data', chunk => {
    count += chunk.length;stats.httpBytesUp += chunk.length;
    if (count > MAX_HTTP_BYTES) {
      stats.httpRejected++;proxied.destroy();req.destroy();
    }
  });
  req.pipe(proxied);
});
server.on('upgrade', (req, downstream, head) => {
  if (!originPermitted(req.headers.origin) || stats.activeWebSockets >= MAX_SESSIONS) {
    stats.upgradeRejected++;
    downstream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  stats.upgrades++;stats.activeWebSockets++;
  stats.peakWebSockets=Math.max(stats.peakWebSockets,stats.activeWebSockets);
  const upstream=net.connect(backendPort,'127.0.0.1');
  let closed=false;
  const close=()=>{if(!closed){closed=true;stats.activeWebSockets--; }downstream.destroy();upstream.destroy();};
  downstream.on('close',close);upstream.on('close',close);
  downstream.on('error',close);upstream.on('error',close);
  upstream.once('connect', () => {
    const headers = Object.entries(req.headers).map(([k,v]) =>
      k + ': ' + (Array.isArray(v) ? v.join(', ') : v)).join('\r\n');
    upstream.write(req.method + ' ' + req.url + ' HTTP/1.1\r\n' + headers + '\r\n\r\n');
    if (head.length) upstream.write(head);
    downstream.on('data', buf => {stats.wsBytesUp += buf.length;});
    upstream.on('data', buf => {stats.wsBytesDown += buf.length;});
    downstream.pipe(upstream);upstream.pipe(downstream);
  });
});
server.listen(port,'127.0.0.1',()=>console.log('CC_OPS_PROXY_READY=' + port));
const exit=()=>server.close(()=>process.exit(0));
process.on('SIGTERM',exit);process.on('SIGINT',exit);
