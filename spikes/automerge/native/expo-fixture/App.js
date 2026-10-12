import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { nativeAutomerge } from '@creative-cooking/automerge-spike';

export default function App() {
  const [message, setMessage] = useState('Testing native Automerge…');
  useEffect(() => {
    async function run() {
      let doc = null, reopened = null, session = null;
      const timing = { sdk: 'Expo 57', rn: '0.86.3', backend: 'Rust 0.12 JNI' };
      try {
        let start = performance.now();
        doc = await nativeAutomerge.create(102, 'expo-hermes');
        timing.createMs = +(performance.now() - start).toFixed(2);
        const path = ['recipesById', 'recipe-1', 'portions'];
        start = performance.now();
        await nativeAutomerge.putInt(doc, path, 6);
        timing.updateMs = +(performance.now() - start).toFixed(2);
        await nativeAutomerge.putString(doc, ['pantryById','item-1','name'], 'tomatoes');
        const bytes = await nativeAutomerge.save(doc);
        const savedHeads = JSON.parse(await nativeAutomerge.heads(doc));
        await nativeAutomerge.dispose(doc); doc = null;
        start = performance.now();
        reopened = await nativeAutomerge.open(bytes, 103, 'expo-restart');
        timing.coldLoadMs = +(performance.now() - start).toFixed(2);
        const portions = JSON.parse(await nativeAutomerge.get(reopened, path));
        const pantry = JSON.parse(await nativeAutomerge.get(reopened,
          ['pantryById','item-1','name']));
        const heads = JSON.parse(await nativeAutomerge.heads(reopened));
        if (portions !== 6 || pantry !== 'tomatoes' ||
            JSON.stringify(heads) !== JSON.stringify(savedHeads)) {
          throw new Error('Native save/restart mismatch');
        }
        session = await nativeAutomerge.newSession();
        const syncMessage = await nativeAutomerge.generate(reopened, session);
        if (!syncMessage || typeof syncMessage !== 'string') {
          throw new Error('Missing real SyncState handshake');
        }
        console.log('AUTOMERGE_EXPO_SPIKE_PASS ' + JSON.stringify({...timing,
          savedBase64Chars:bytes.length, syncBase64Chars:syncMessage.length}));
        setMessage('PASS — native Automerge / Hermes / Expo');
      } catch (e) {
        console.error('AUTOMERGE_EXPO_SPIKE_FAIL ' + String(e));
        setMessage('FAIL — ' + String(e));
      } finally {
        if (session !== null) await nativeAutomerge.endSession(session);
        if (doc !== null) await nativeAutomerge.dispose(doc);
        if (reopened !== null) await nativeAutomerge.dispose(reopened);
      }
    }
    run();
  }, []);
  return <View style={{padding: 30, paddingTop: 90, flex: 1}}>
    <Text style={{fontSize: 22}}>Automerge native feasibility</Text>
    <Text>{message}</Text>
  </View>;
}
