import {useAppTheme} from '@/theme/theme';
import type { PropsWithChildren } from 'react';
import { StyleSheet } from '@/theme/StyleSheet';
import { SafeAreaView } from 'react-native-safe-area-context';

export function Screen({ children, testID }: PropsWithChildren<{ testID?: string }>) {
  const {colors} = useAppTheme();
  return <SafeAreaView edges={['top', 'right', 'bottom', 'left']} testID={testID ?? "app-screen"} style={[styles.screen, {backgroundColor:colors.background}]}>{children}</SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f8fafc' }
});
