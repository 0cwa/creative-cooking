import 'fast-text-encoding';
import React, { useEffect, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import * as Crypto from 'expo-crypto';
import { installSecureRng } from '../rng.mjs';

export default function ProbeScreen() {
  const [result, setResult] = useState('Running crypto probes');
  useEffect(() => { (async () => {
    try {
      const before = { crypto: typeof globalThis.crypto, wasm: typeof globalThis.WebAssembly };
      installSecureRng(Crypto);
      const { run } = await import('../native-probe.mjs');
      const output = { before, result: await run() };
      console.log('K1_RESULT ' + JSON.stringify(output));
      setResult(JSON.stringify(output, null, 2));
    } catch (error) { console.error('K1_FAILURE', error); setResult('FAILED: ' + (error.stack || error)); }
  })(); }, []);
  return <ScrollView><Text selectable>{result}</Text></ScrollView>;
}
