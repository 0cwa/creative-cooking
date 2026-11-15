import type { PropsWithChildren } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export function Screen({ children, testID }: PropsWithChildren<{ testID?: string }>) {
  return <SafeAreaView edges={['top', 'right', 'bottom', 'left']} testID={testID} style={styles.screen}>{children}</SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f8fafc' }
});
