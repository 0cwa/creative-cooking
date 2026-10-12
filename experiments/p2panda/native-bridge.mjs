/**
 * Dev-only HTTP↔REAL p2panda native process bridge. No durable HTTP mailbox.
 * The peer must be experiments/p2panda/rust/src/bin/peer.rs (real 0.7.1 Node).
 * Frames are opaque client-encrypted bytes; the bridge does NOT implement
 * p2panda Spaces authentication, HTTPS, accountless pairing or public relay.
 * Use only on 127.0.0.1. X-Spike-Token is a test barrier, not production auth.
 */
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { decodeFrame } from './contract.mjs';

const MAX_FRAME = 1024 * 1024 + 2048;
const json = (res, code, object) => {
  res.writeHead(code, {'content-type':'application/json','cache-control':'no-store',
    'x-content-type-options':'nosniff','access-control-allow-origin':'http://127.0.0.1'});
  res.end(JSON.stringify(object));
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function startNativeBridge(peer, topic, token, spaceId) {
  if (!/^[0-9a-f]{64}$/.test(topic) || typeof token !== 'string' || token.length < 32 || !/^space:personal:[a-z]+$/.test(spaceId))
    throw new Error('Invalid isolated bridge topic/token');
  const endpoint = '/v1/native/' + topic + '/frames';
  const permitted = Buffer.from(token);
  const forwarded = new Set();
  const server = createServer(async (req,res) => {
    const origin = req.headers.origin;
    // A static localhost page is served by this same loopback bridge.
    if (origin && origin !== 'http://' + req.headers.host) return json(res,403,{error:'origin'});
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store',
        'content-security-policy':"default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'"});
      res.end('<!doctype html><html><head><meta charset="utf-8"></head><body>Local p2panda native boundary fixture</body></html>');
      return;
    }
    if (req.url !== endpoint) return json(res,404,{error:'topic_or_route'});
    const presented = req.headers['x-spike-token'];
    if (typeof presented !== 'string' ||
        !timingSafeEqualLength(presented, permitted)) return json(res,401,{error:'test_token_required'});
    if (req.method === 'GET') {
      const seen = new Map();
      for (const raw of peer.received) {
        try {
          const frame = decodeFrame(new Uint8Array(raw));
          if (!frame.documentId.startsWith(spaceId + '/')) continue;
          const payload = Buffer.from(frame.bytes);
          const id = hash(payload);
          if (!seen.has(id)) seen.set(id,{documentId:frame.documentId,sha256:id,
            bytesBase64:payload.toString('base64'),byteLength:payload.length});
        } catch { /* old/non-envelope frames are not part of this test boundary */ }
      }
      return json(res,200,{topic,frames:[...seen.values()]});
    }
    if (req.method !== 'POST') return json(res,405,{error:'method'});
    try {
      let total=0, parts=[];
      for await (const chunk of req) {
        total+=chunk.length;
        if (total>MAX_FRAME) return json(res,413,{error:'too_large'});
        parts.push(chunk);
      }
      const frameBytes=Buffer.concat(parts);
      const parsed=decodeFrame(new Uint8Array(frameBytes));
      if (!parsed.documentId.startsWith(spaceId + '/'))
        return json(res,403,{error:'wrong_space'});
      const id=hash(parsed.bytes);
      if (forwarded.has(id)) return json(res,200,{accepted:false,replayNoop:true,sha256:id});
      peer.publish(frameBytes);
      forwarded.add(id);
      return json(res,202,{accepted:true,sha256:id,storedBy:'p2panda_peer_not_http'});
    } catch (err) {
      return json(res,422,{error:'invalid_or_peer_exited',message:String(err)});
    }
  });
  function timingSafeEqualLength(value, expected) {
    const raw=Buffer.from(value);
    return raw.length===expected.length && timingSafeEqual(raw,expected);
  }
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  const address=server.address();
  if (!address || typeof address==='string') throw new Error('Unexpected bridge address');
  return {server,url:'http://127.0.0.1:'+address.port,endpoint,
    close:()=>new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()))};
}
