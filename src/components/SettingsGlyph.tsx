import { View } from 'react-native';
import { StyleSheet } from '@/theme/StyleSheet';

export function SettingsGlyph() {
  return (
    <View accessible={false} style={styles.glyph}>
      <View style={[styles.spoke, styles.horizontal]} />
      <View style={[styles.spoke, styles.vertical]} />
      <View style={[styles.spoke, styles.diagonalForward]} />
      <View style={[styles.spoke, styles.diagonalBack]} />
      <View style={styles.hub} />
      <View style={styles.center} />
    </View>
  );
}

const styles = StyleSheet.create({
  glyph: { width: 18, height: 18, position: 'relative' },
  spoke: {
    position: 'absolute',
    left: 1,
    top: 7.5,
    width: 16,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: '#334155'
  },
  horizontal: {},
  vertical: { transform: [{ rotate: '90deg' }] },
  diagonalForward: { transform: [{ rotate: '45deg' }] },
  diagonalBack: { transform: [{ rotate: '-45deg' }] },
  hub: {
    position: 'absolute',
    left: 4,
    top: 4,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: '#334155',
    backgroundColor: '#e2e8f0'
  },
  center: {
    position: 'absolute',
    left: 7,
    top: 7,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#334155'
  }
});
