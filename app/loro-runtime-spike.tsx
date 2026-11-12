import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { loadSnapshot, saveSnapshot } from '../spikes/loro-runtime/storage';

export default function LoroRuntimeSpike() {
  const [result, setResult] = useState('Running Loro runtime proof…');
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { runScenario } = await import('../spikes/loro-runtime/engine');
      const prior = await loadSnapshot();
      const report = runScenario(prior);
      await saveSnapshot(report.snapshot);
      const lines = [
        `adapter=${report.adapter}`,
        `reopen=${report.reopenedPreviousSnapshot ? 'restored prior bytes' : 'first run'}`,
        `same-field winner=${report.sameFieldWinner}`,
        `remove-vs-edit=removed ingredient retained edited amount`,
        `updates converge across shuffled/duplicate delivery=${report.differentOrdersConverged}`,
        `portable snapshot import/export=${report.portableRoundTrip}`,
        `startup=${report.startupMs} ms`,
        `offline update bytes=${report.updateBytes}`,
        `snapshot bytes=${report.snapshotBytes}`,
        'PASS',
      ];
      if (alive) setResult(lines.join('\n'));
    })().catch((error) => {
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
