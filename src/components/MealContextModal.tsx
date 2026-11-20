import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from '@/theme/StyleSheet';
import type { CookEnergy, MealContext } from '@/domain/types';

const energyOptions: CookEnergy[] = ['low', 'medium', 'high'];

export function MealContextModal({
  visible,
  value,
  onClose,
  onChange
}: {
  visible: boolean;
  value: MealContext;
  onClose(): void;
  onChange(value: MealContext): void;
}) {
  const setCount = (count: number) => {
    const clamped = Math.max(1, Math.min(8, count));
    const cooks = Array.from({ length: clamped }, (_, index) => value.cooks[index] ?? 'medium');
    onChange({ ...value, cooks });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessible={false} style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.header}>
            <View><Text accessibilityRole="header" style={styles.title}>Meal context</Text><Text style={styles.subtitle}>Chef will use this for the next suggestion.</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close meal context" onPress={onClose} style={styles.done}><Text style={styles.doneText}>Done</Text></Pressable>
          </View>

          <Counter label="Portions" value={value.portions} onChange={(portions) => onChange({ ...value, portions: Math.max(1, portions) })} />
          <Counter label="People cooking" value={value.cooks.length} onChange={setCount} />

          {value.cooks.map((energy, index) => (
            <View key={index} style={styles.energyRow}>
              <Text style={styles.label}>Cook {index + 1} energy</Text>
              <View style={styles.pills}>
                {energyOptions.map((option) => (
                  <Pressable
                    key={option}
                    accessibilityRole="radio"
                    accessibilityLabel={`Cook ${index + 1} energy: ${option === 'medium' ? 'Okay' : option}`}
                    accessibilityState={{ checked: energy === option }}
                    onPress={() => {
                      const cooks = [...value.cooks];
                      cooks[index] = option;
                      onChange({ ...value, cooks });
                    }}
                    style={[styles.pill, energy === option && styles.pillActive]}
                  >
                    <Text style={[styles.pillText, energy === option && styles.pillTextActive]}>{option === 'medium' ? 'Okay' : option[0].toUpperCase() + option.slice(1)}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

function Counter({ label, value, onChange }: { label: string; value: number; onChange(value: number): void }) {
  return (
    <View style={styles.counterRow}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.counter}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Decrease ${label}`} onPress={() => onChange(value - 1)} style={styles.counterButton}><Text style={styles.counterButtonText}>−</Text></Pressable>
        <Text accessibilityLabel={`${label}: ${value}`} style={styles.counterValue}>{value}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Increase ${label}`} onPress={() => onChange(value + 1)} style={styles.counterButton}><Text style={styles.counterButtonText}>+</Text></Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.35)' },
  sheet: { maxHeight: '76%', backgroundColor: 'white', borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  content: { padding: 20, paddingBottom: 40, gap: 22 },
  header: { flexDirection: 'row', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' },
  title: { fontSize: 24, fontWeight: '700', color: '#172033' },
  subtitle: { color: '#64748b', marginTop: 4 },
  done: { minHeight: 40, backgroundColor: '#172033', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
  doneText: { color: 'white', fontWeight: '700', textAlign: 'center' },
  counterRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: '#334155', fontSize: 16, fontWeight: '600' },
  counter: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  counterButton: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' },
  counterButtonText: { fontSize: 23, color: '#172033' },
  counterValue: { minWidth: 24, textAlign: 'center', fontSize: 18, fontWeight: '700' },
  energyRow: { gap: 10 },
  pills: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  pill: { minHeight: 38, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' },
  pillActive: { backgroundColor: '#172033' },
  pillText: { color: '#475569', fontWeight: '600', textAlign: 'center' },
  pillTextActive: { color: 'white' }
});
