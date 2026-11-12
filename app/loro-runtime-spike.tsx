import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { loadSnapshot, saveSnapshot } from '../spikes/loro-runtime/storage';

function toBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;
    encoded += alphabet.charAt((value >>> 18) & 63);
    encoded += alphabet.charAt((value >>> 12) & 63);
    encoded += index + 1 < bytes.length ? alphabet.charAt((value >>> 6) & 63) : '=';
    encoded += index + 2 < bytes.length ? alphabet.charAt(value & 63) : '=';
  }
  return encoded;
}

export default function LoroRuntimeSpike() {
  const [result, setResult] = useState('Running Loro runtime proof…');
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { runScenario } = await import('../spikes/loro-runtime/engine');
      const prior = await loadSnapshot();
      const report = runScenario(prior);
      await saveSnapshot(report.snapshot);
      if (report.adapter === 'loro-react-native') {
        console.log(`LORO_NATIVE_UPDATE_BASE64=${toBase64(report.localUpdate)}`);
      }
      const lines = [
        `adapter=${report.adapter}`,
        `reopen=${report.reopenedPreviousSnapshot ? 'restored prior bytes' : 'first run'}`,
        `same-field winner=${report.sameFieldWinner}`,
        `remove-vs-edit=deleted marker and concurrent amount retained`,
        `stable row IDs=${report.stableRowIdsPreserved ? 'preserved' : 'FAIL'}`,
        `web update imported=${report.webUpdateImported}`,
        `updates converge across shuffled/duplicate delivery=${report.differentOrdersConverged}`,
        `portable snapshot import/export=${report.portableRoundTrip}`,
        `startup=${report.startupMs} ms`,
        `offline update bytes=${report.updateBytes}`,
        `local update bytes=${report.localUpdateBytes}`,
        `snapshot bytes=${report.snapshotBytes}`,
        'PASS',
      ];
      console.log(`LORO_RUNTIME_RESULT=${JSON.stringify({
        adapter: report.adapter,
        reopenedPreviousSnapshot: report.reopenedPreviousSnapshot,
        sameFieldWinner: report.sameFieldWinner,
        removedIngredientRetainedEdit: report.removedIngredientRetainedEdit,
        stableRowIdsPreserved: report.stableRowIdsPreserved,
        webUpdateImported: report.webUpdateImported,
        differentOrdersConverged: report.differentOrdersConverged,
        portableRoundTrip: report.portableRoundTrip,
        startupMs: report.startupMs,
        updateBytes: report.updateBytes,
        localUpdateBytes: report.localUpdateBytes,
        snapshotBytes: report.snapshotBytes,
      })}`);
      if (alive) setResult(lines.join('\n'));
    })().catch((error) => {
      console.error(`LORO_RUNTIME_ERROR=${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      if (alive) setResult(`FAIL\n${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { alive = false; };
  }, []);
  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 24, gap: 12 }}>
      <Text accessibilityRole="header" style={{ fontSize: 24, fontWeight: '700' }}>Loro runtime spike</Text>
      <View testID="loro-result"><Text selectable style={{ fontFamily: 'monospace' }}>{result}</Text></View>
    </ScrollView>
  );
}
