// Test-only in-memory key store. Not a durable or secure production key store.
export function testProvider(sodium, { signing, recipient, publicSigning, publicRecipient, initialKey } ) {
 const data = new Map(initialKey ? [['data', initialKey.slice()]] : []);
 const key = () => { const k=data.get('data'); if (!k) throw Error('MISSING_KEY'); return k; };
 return {
  hash:async b=>sodium.crypto_generichash(32,b),
  sign:async (who,b)=> { if (who !== 'sender' || !signing) throw Error('MISSING_KEY'); return sodium.crypto_sign_detached(b,signing.privateKey); },
  verify:async (who,b,s)=>who === 'sender' && sodium.crypto_sign_verify_detached(s,b,publicSigning),
  encrypt:async (_,v,a)=>{const n=sodium.randombytes_buf(24); const c=sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(v,a,null,n,key()); return new Uint8Array([...n,...c]);},
  decrypt:async (_,v,a)=>sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,v.slice(24),a,v.slice(0,24),key()),
  wrap:async (who,ref)=>{if (who !== 'recipient' || ref !== 'data') throw Error('MISSING_KEY'); return sodium.crypto_box_seal(key(),publicRecipient);},
  unwrap:async (h,v)=>{if (h.recipientDevice !== 'recipient' || !recipient) throw Error('MISSING_KEY'); const material=sodium.crypto_box_seal_open(v,recipient.publicKey,recipient.privateKey); if (material.length !== 32) throw Error('INVALID_KEY'); data.set('data',material); return 'data';},
 };
}
