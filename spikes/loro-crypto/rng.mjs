// Expo's native implementation is installed before loading crypto-dependent modules.
export function installSecureRng(expoCrypto, target = globalThis) {
  if (target.__REMOTEDEV__) throw Error('remote debugging is unsupported');
  if (!expoCrypto || typeof expoCrypto.getRandomValues !== 'function') throw Error('secure RNG unavailable');
  const getRandomValues = array => {
    if (!(array instanceof Uint8Array) || array.length > 65536) throw Error('invalid RNG request');
    const result = expoCrypto.getRandomValues(array);
    if (result !== array) throw Error('invalid secure RNG result');
    return result;
  };
  Object.defineProperty(target, 'crypto', { value: { getRandomValues }, configurable: true });
  return getRandomValues;
}
