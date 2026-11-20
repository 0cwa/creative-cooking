/** Web bootstrap initializes this exact web module. Node and React Native use
 * their configured bare Loro entry; no plaintext or fixture fallback exists. */
export async function loadLoroDoc(){
 const web=typeof document!=='undefined'&&!(typeof navigator!=='undefined'&&navigator.product==='ReactNative');
 return (web?await import('loro-crdt/web/loro_wasm.js'):await import('loro-crdt')).LoroDoc;
}
