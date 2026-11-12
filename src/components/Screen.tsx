import type { PropsWithChildren } from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';

export function Screen({ children, testID }: PropsWithChildren<{ testID?: string }>) {
  return <SafeAreaView testID={testID} style={styles.screen}>{children}</SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f8fafc' }
});
