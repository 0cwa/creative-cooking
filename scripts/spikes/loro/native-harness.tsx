import React, { useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LoroDoc } from 'loro-react-native';
import { baseSnapshot, scenario, webPackage, webUpdate } from '../scripts/spikes/loro/native-fixture';

type HarnessResult = {
  ok: boolean;
  platformApi: string;
  webPackage: string;
  scenario: string;
  importedWebSnapshot?: boolean;
  nativeBeforeWeb?: unknown;
  afterMerge?: unknown;
  afterRestart?: unknown;
  duplicateImportIdempotent?: boolean;
  movableList?: unknown;
  text?: unknown;
  mergeableMap?: unknown;
  nativeUpdateBytes?: number[];
  snapshotBytes?: number;
  updateBytes?: number;
  error?: string;
};

function runHarness(): HarnessResult {
  const replica = new LoroDoc();
  replica.import_(baseSnapshot);

  const imported = replica.toJSON() as Record<string, any>;
  if (imported['recipe:recipe-1']?.portions !== 2) {
    throw new Error(`web snapshot import mismatch: ${JSON.stringify(imported['recipe:recipe-1'])}`);
  }

  const commonVersion = replica.oplogVersion();
  replica.setPeerId(303n);
  replica.getMap('recipe:recipe-1').set('portions', 6);
  replica.setNextCommitMessage('device:ipad; interop native portions=6');
  replica.commit();

  const nativeBeforeWeb = replica.toJSON() as Record<string, any>;
  const nativeUpdate = replica.export({ mode: 'updates', from: commonVersion });

  replica.import_(webUpdate);
  const afterMerge = replica.toJSON() as Record<string, any>;

  const snapshot = replica.export({ mode: 'snapshot' });
  const restarted = new LoroDoc();
  restarted.import_(snapshot);
  const afterRestart = restarted.toJSON() as Record<string, any>;

  const beforeDuplicate = JSON.stringify(afterRestart);
  restarted.import_(webUpdate);
  const duplicateImportIdempotent = JSON.stringify(restarted.toJSON()) === beforeDuplicate;

  const structures = new LoroDoc();
  structures.setPeerId(404n);
  const movable = structures.getMovableList('steps');
  movable.push('step-a');
  movable.push('step-b');
  movable.move(1, 0);
  const text = structures.getText('method');
  text.insert(0, 'Heat oil.');
  text.insert(text.length(), ' Add tomatoes.');
  const mergeable = structures.getMap('root').ensureMergeableMap('child') as any;
  mergeable.set('nativeField', 'preserved');
  structures.commit();

  const structureJson = structures.toJSON() as Record<string, any>;

  return {
    ok: true,
    platformApi: 'loro-react-native@source-8fad8d61 / loro-ffi 1.13.7',
    webPackage,
    scenario,
    importedWebSnapshot: true,
    nativeBeforeWeb: nativeBeforeWeb['recipe:recipe-1'],
    afterMerge: afterMerge['recipe:recipe-1'],
    afterRestart: afterRestart['recipe:recipe-1'],
    duplicateImportIdempotent,
    movableList: structureJson.steps,
    text: structureJson.method,
    mergeableMap: structureJson.root,
    nativeUpdateBytes: Array.from(new Uint8Array(nativeUpdate)),
    snapshotBytes: snapshot.byteLength,
    updateBytes: nativeUpdate.byteLength
  };
}

export default function LoroNativeHarness() {
  const [result, setResult] = useState<HarnessResult | null>(null);

  useEffect(() => {
    let value: HarnessResult;
    try {
      value = runHarness();
    } catch (error) {
      value = {
        ok: false,
        platformApi: 'loro-react-native@source-8fad8d61 / loro-ffi 1.13.7',
        webPackage,
        scenario,
        error: error instanceof Error ? error.stack ?? error.message : String(error)
      };
    }
    setResult(value);
    console.log(`LORO_NATIVE_RESULT:${JSON.stringify(value)}`);
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Loro native feasibility</Text>
        <Text style={result?.ok ? styles.pass : styles.pending}>
          {result === null ? 'RUNNING' : result.ok ? 'PASS' : 'FAIL'}
        </Text>
        <View style={styles.card}>
          <Text selectable style={styles.mono}>
            {result ? JSON.stringify(result, null, 2) : 'Starting native Loro runtime…'}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f4ef' },
  content: { padding: 24, gap: 16 },
  title: { fontSize: 28, fontWeight: '700' },
  pass: { fontSize: 22, fontWeight: '700' },
  pending: { fontSize: 22, fontWeight: '700' },
  card: { backgroundColor: '#ffffff', borderRadius: 16, padding: 16 },
  mono: { fontFamily: 'Courier', fontSize: 12, lineHeight: 18 }
});
