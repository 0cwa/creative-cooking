import {DatabaseSync} from 'node:sqlite';
import {createHash, timingSafeEqual, sign, randomBytes, createPublicKey} from 'node:crypto';
import {createServer} from 'node:http';
import {candidateObjectId} from '../../src/loro/crypto/candidate.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
const tokenHash = s => createHash('sha256').update(s).digest();
const validId = s => /^[0-9a-f]{64}$/.test(s);
const json = (res,status,value) => {const b=Buffer.from(JSON.stringify(value));res.writeHead(status,{'content-type':'application/json','content-length':b.length,'cache-control':'no-store'});res.end(b);};

// Provisioning is an operator action; no HTTP endpoint grants mailbox control.
export function openMailbox({path, signingKey, hashProvider, now = Date.now, maxObject = 2425344, maxPage = 128, maxObjects = 65536, rate = 600}) {
 if (!signingKey || typeof hashProvider?.hash !== 'function' || !Number.isSafeInteger(maxObject) || maxObject<1 || !Number.isSafeInteger(maxPage) || maxPage<1 || !Number.isSafeInteger(maxObjects) || maxObjects<1 || !Number.isSafeInteger(rate) || rate<1) throw Error('CONFIG');
 const relayId=hash(createPublicKey(signingKey).export({type:'spki',format:'der'}));
 const db = new DatabaseSync(path); db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS mailboxes(id TEXT PRIMARY KEY, read_hash BLOB NOT NULL, append_hash BLOB NOT NULL, quota INTEGER NOT NULL, expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS objects(seq INTEGER PRIMARY KEY AUTOINCREMENT, mailbox TEXT NOT NULL REFERENCES mailboxes(id), id TEXT NOT NULL, bytes BLOB NOT NULL, receipt TEXT NOT NULL, UNIQUE(mailbox,id));`);
 const insertMailbox=db.prepare('INSERT INTO mailboxes VALUES(?,?,?,?,?)');
 const getMailbox=db.prepare('SELECT * FROM mailboxes WHERE id=?');
 const getObject=db.prepare('SELECT * FROM objects WHERE mailbox=? AND id=?');
 const usage=db.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS used, COUNT(*) AS count FROM objects WHERE mailbox=?');
 const insert=db.prepare('INSERT INTO objects(mailbox,id,bytes,receipt) VALUES(?,?,?,?)');
 const listing=db.prepare('SELECT seq,id,length(bytes) AS size FROM objects WHERE mailbox=? AND seq>? ORDER BY seq LIMIT ?');
 const lookupCursor=db.prepare('SELECT seq FROM objects WHERE mailbox=? AND id=?');
 const rates=new Map();
 function provision({id,readCapability,appendCapability,quota,expires}) {if(!validId(id) || typeof readCapability!=='string' || typeof appendCapability!=='string' || !/^[0-9a-f]{64}$/.test(readCapability) || !/^[0-9a-f]{64}$/.test(appendCapability) || readCapability===appendCapability || !Number.isSafeInteger(quota) || quota<1 || !Number.isSafeInteger(expires) || expires<=now()) throw Error('CONFIG');insertMailbox.run(id,tokenHash(readCapability),tokenHash(appendCapability),quota,expires);}
 const server=createServer(async(req,res)=>{try {
  const url=new URL(req.url,'http://localhost'); const m=/^\/v1\/mailboxes\/([0-9a-f]{64})\/(?:objects\/([0-9a-f]{64})|(log))$/.exec(url.pathname); if(!m) return json(res,404,{error:'NOT_FOUND'});
  const mailbox=getMailbox.get(m[1]); const auth=/^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || ''); const expected=mailbox && (req.method==='PUT' ? mailbox.append_hash : mailbox.read_hash);
  if(!auth || !expected || !timingSafeEqual(tokenHash(auth[1]),expected)) return json(res,401,{error:'UNAUTHORIZED'});
  const key=hash(auth[1]); const minute=Math.floor(now()/60000); let window=rates.get(key); if(!window || window.minute!==minute) {window={minute,count:0};rates.set(key,window); if(rates.size>4096) for(const [k,v] of rates) if(v.minute!==minute) rates.delete(k);} if(++window.count>rate) return json(res,429,{error:'RATE_LIMIT'});
  if(now()>=mailbox.expires) return json(res,410,{error:'EXPIRED',expires:mailbox.expires});
  if(m[2] && req.method==='PUT') {let size=0;const chunks=[]; for await(const chunk of req) {size+=chunk.length;if(size>maxObject) {req.resume();return json(res,413,{error:'TOO_LARGE'});} chunks.push(chunk);} const bytes=Buffer.concat(chunks);if(!size) return json(res,400,{error:'MALFORMED'});if(await candidateObjectId(hashProvider,bytes)!==m[2]) return json(res,400,{error:'HASH_MISMATCH'});
   db.exec('BEGIN IMMEDIATE');try {const old=getObject.get(m[1],m[2]);if(old) {if(!Buffer.from(old.bytes).equals(bytes)) {db.exec('ROLLBACK');return json(res,409,{error:'CONFLICT'});} db.exec('COMMIT');return json(res,200,JSON.parse(old.receipt));}
    const capacity=usage.get(m[1]);if(capacity.count>=maxObjects || capacity.used+size>mailbox.quota) {db.exec('ROLLBACK');return json(res,507,{error:'QUOTA_FULL'});}
    const claims={domain:'creative-cooking/relay-receipt/v1',version:1,kind:'relay-stored',relayId,mailbox:m[1],objectId:m[2],size,method:'PUT',path:url.pathname,expires:mailbox.expires};const signature=sign(null,Buffer.from(JSON.stringify(claims)),signingKey).toString('base64url');const receipt={claims,signature};insert.run(m[1],m[2],bytes,JSON.stringify(receipt));db.exec('COMMIT');return json(res,201,receipt);
   } catch(e) {db.exec('ROLLBACK');throw e;}
  }
  if(m[2] && req.method==='GET') {const row=getObject.get(m[1],m[2]);if(!row) return json(res,404,{error:'NOT_FOUND'});res.writeHead(200,{'content-type':'application/octet-stream','content-length':row.bytes.length,'cache-control':'no-store'});return res.end(row.bytes);}
  if(m[3] && req.method==='GET') {if([...url.searchParams.keys()].some(k=>!['after','limit'].includes(k)) || url.searchParams.getAll('after').length>1 || url.searchParams.getAll('limit').length>1) return json(res,400,{error:'MALFORMED'});const after=url.searchParams.get('after');const rawLimit=url.searchParams.get('limit') || '32';if(!/^[1-9][0-9]*$/.test(rawLimit) || Number(rawLimit)>maxPage || (after && !validId(after))) return json(res,400,{error:'MALFORMED'});let seq=0;if(after) {const cursor=lookupCursor.get(m[1],after);if(!cursor) return json(res,400,{error:'CURSOR'});seq=cursor.seq;} const rows=listing.all(m[1],seq,Number(rawLimit));return json(res,200,{objects:rows.map(r=>({id:r.id,size:r.size})),cursor:rows.length?rows.at(-1).id:after});}
  return json(res,405,{error:'METHOD'});
 } catch {if(!res.headersSent) json(res,500,{error:'INTERNAL'});else res.destroy();}});
 return {server,provision,close:()=>db.close()};
}
export function randomMailboxSecrets() {return {id:randomBytes(32).toString('hex'),readCapability:randomBytes(32).toString('hex'),appendCapability:randomBytes(32).toString('hex')};}
