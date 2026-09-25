import type { PropsWithChildren } from 'react';
import { SafeAreaView } from 'react-native';
import { StyleSheet } from '@/theme/StyleSheet';

export function Screen({ children }: PropsWithChildren) {
  return <SafeAreaView testID="app-screen" style={styles.screen}>{children}</SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f8fafc' }
});
