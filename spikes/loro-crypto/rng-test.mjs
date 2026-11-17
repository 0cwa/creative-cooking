import {installSecureRng} from './rng.mjs';
export function rngProbe() {
 const fails=fn=>{try{fn();}catch{return;}throw Error('RNG accepted invalid source');};
 fails(()=>installSecureRng(null,{})); fails(()=>installSecureRng({getRandomValues:x=>x},{__REMOTEDEV__:true}));
 const target={}; const get=installSecureRng({getRandomValues:x=>x.fill(42)},target);
 if(get(new Uint8Array(2))[0]!==42)throw Error('RNG adapter');
 fails(()=>get(new Uint8Array(65537))); fails(()=>installSecureRng({getRandomValues:()=>null},{}) (new Uint8Array(2)));
 return 'adapter rejects missing source, remote debugging and invalid output';
}
