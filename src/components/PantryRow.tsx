import { useMemo, useRef } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import type { IngredientPreference, PantryItem } from '@/domain/types';
import { StarRating } from './StarRating';

export function PantryRow({
  item,
  onDelete,
  onPreference
}: {
  item: PantryItem;
  onDelete(): void;
  onPreference(value: IngredientPreference): void;
}) {
  const x = useRef(new Animated.Value(0)).current;
  const responder = useMemo(
    () => PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderMove: (_, gesture) => x.setValue(Math.min(0, gesture.dx)),
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx < -90) {
          Animated.timing(x, { toValue: -320, duration: 160, useNativeDriver: true }).start(onDelete);
        } else {
          Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
        }
      }
    }),
    [onDelete, x]
  );

  return (
    <View style={styles.shell}>
      <View style={styles.deleteBackdrop}><Text style={styles.deleteBackdropText}>Remove</Text></View>
      <Animated.View style={[styles.row, { transform: [{ translateX: x }] }]} {...responder.panHandlers}>
        <View style={styles.textWrap}>
          <Text style={styles.name}>{item.name}</Text>
          <StarRating value={item.preference} onChange={onPreference} />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${item.name}`} onPress={onDelete} style={styles.removeButton}>
          <Text style={styles.removeText}>×</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { marginHorizontal: 16, marginVertical: 5, borderRadius: 16, overflow: 'hidden' },
  deleteBackdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#b91c1c', alignItems: 'flex-end', justifyContent: 'center', paddingRight: 22 },
  deleteBackdropText: { color: 'white', fontWeight: '700' },
  row: { minHeight: 72, backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 16, paddingLeft: 16, flexDirection: 'row', alignItems: 'center' },
  textWrap: { flex: 1, gap: 3 },
  name: { color: '#172033', fontSize: 17, fontWeight: '600' },
  removeButton: { width: 52, height: 52, marginRight: 4, alignItems: 'center', justifyContent: 'center' },
  removeText: { fontSize: 28, color: '#94a3b8', lineHeight: 30 }
});
