const bytes = text => new TextEncoder().encode(text);
const hex = x => Array.from(x,b=>b.toString(16).padStart(2,'0')).join('');
const unhex = x => Uint8Array.from(x.match(/../g), v=>parseInt(v,16));
const assert = (ok, message) => { if (!ok) throw Error(message); };
export async function sealedProbe(sodium) {
 await sodium.ready;
 const pair = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(7));
 const other = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(8));
 const message = bytes('K1 sealed box cross-runtime fixture');
 const box = sodium.crypto_box_seal(message,pair.publicKey);
 assert(hex(sodium.crypto_box_seal_open(box,pair.publicKey,pair.privateKey))===hex(message),'open');
 const fails = (cipher,pk,sk) => { try { const result=sodium.crypto_box_seal_open(cipher,pk,sk); return !result; } catch { return true; } };
 const corrupt=box.slice(); corrupt[corrupt.length-1]^=1;
 assert(fails(corrupt,pair.publicKey,pair.privateKey),'corruption');
 assert(fails(box,other.publicKey,other.privateKey),'wrong recipient');
 assert(fails(box.slice(0,10),pair.publicKey,pair.privateKey),'truncation');
 for (const fixture of FIXED_BOXES) assert(hex(sodium.crypto_box_seal_open(unhex(fixture),pair.publicKey,pair.privateKey))===hex(message),'fixed sealed fixture');
 return { checks:['libsodium sealed box recipient roundtrip','sealed box tamper, wrong key and truncation','open fixed Node and browser sealed boxes'], publicKey:hex(pair.publicKey), generatedBox:hex(box) };
}
const FIXED_BOXES = ['1c4aaf17f76847efe7a1be108ba01c5f9f240132729d3e254f1273a7231de71fb34c15da0f9225ff0752fe628cc57f71b9d52877cd510cd710e22046bd17faa6c188290317dc4c37bffde529744f5bf753e2e5','054da597b242755b135908eeec12d4d338d0c18128684c334876dcfaf540aa190795206bb886bd11fee0be940a18afcddae116c007f1bbfc43e899f44c437d1f28f4d8f167ebacf3e3ec2888653e8261606151'];
