import { useMemo, useRef } from 'react';
import { Alert, Animated, Modal, PanResponder, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from '@/theme/StyleSheet';
import type { ChatConversation } from '@/domain/types';

function metaText(conversation: ChatConversation, notes: boolean): string {
  const count = conversation.messages.length;
  const date = new Date(conversation.updatedAt);
  const formatted = Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${count} ${notes ? 'note' : 'message'}${count === 1 ? '' : 's'}${formatted ? ` · ${formatted}` : ''}`;
}

function previewText(conversation: ChatConversation): string {
  const last = [...conversation.messages].reverse().find((message) => message.content.trim());
  const preview = last?.content.replace(/\s+/g, ' ').trim() ?? '';
  return preview === conversation.title ? '' : preview;
}

function ConversationRow({
  conversation,
  notes,
  onOpen,
  onDelete
}: {
  conversation: ChatConversation;
  notes: boolean;
  onOpen(): void;
  onDelete(): void;
}) {
  const x = useRef(new Animated.Value(0)).current;
  const responder = useMemo(
    () => PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderMove: (_, gesture) => x.setValue(Math.max(-120, Math.min(0, gesture.dx))),
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx < -90) onDelete();
        Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
      }
    }),
    [onDelete, x]
  );

  return (
    <View
      style={styles.rowShell}
      testID={`conversation-row-${conversation.id}`}
    >
      <View style={styles.deleteBackdrop}>
        <Text style={styles.deleteBackdropText}>Delete</Text>
      </View>
      <Animated.View style={[styles.row, { transform: [{ translateX: x }] }]} {...responder.panHandlers}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${notes ? 'Open notes' : 'Open conversation'} ${conversation.title}`}
          onPress={onOpen}
          style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}
        >
          <Text numberOfLines={1} style={styles.rowTitle}>{conversation.title}</Text>
          <Text style={styles.rowMeta}>{metaText(conversation, notes)}</Text>
          {previewText(conversation) ? (
            <Text numberOfLines={2} style={styles.rowPreview}>{previewText(conversation)}</Text>
          ) : null}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${notes ? 'Delete notes' : 'Delete conversation'} ${conversation.title}`}
          onPress={onDelete}
          style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}
        >
          <Text style={styles.deleteButtonText}>×</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

export function ConversationHistoryModal({
  visible,
  mode = 'chats',
  conversations,
  onClose,
  onOpen,
  onDelete
}: {
  visible: boolean;
  mode?: 'chats' | 'notes';
  conversations: ChatConversation[];
  onClose(): void;
  onOpen(id: string): void;
  onDelete(id: string): void;
}) {
  const notes = mode === 'notes';
  const closeLabel = notes ? 'Close previous notes' : 'Close previous conversations';
  const requestDelete = (conversation: ChatConversation) => {
    const message = `Delete “${conversation.title}”? ${notes ? 'These notes' : 'This conversation'} cannot be recovered.`;

    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(message)) onDelete(conversation.id);
      return;
    }

    Alert.alert(notes ? 'Delete notes?' : 'Delete conversation?', message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => onDelete(conversation.id)
      }
    ]);
  };

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          onPress={onClose}
          style={styles.dismissArea}
        />
        <View accessibilityViewIsModal style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.eyebrow}>{notes ? 'COOKING NOTES' : 'CHEF HISTORY'}</Text>
              <Text accessibilityRole="header" style={styles.title}>{notes ? 'Previous notes' : 'Previous chats'}</Text>
              <Text style={styles.subtitle}>{notes
                ? 'Open saved notes to keep writing. Swipe left or use × to delete.'
                : 'Tap a chat to continue it. Swipe left or use × to delete.'}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={closeLabel}
              onPress={onClose}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>

          {conversations.length ? (
            <ScrollView contentContainerStyle={styles.list}>
              {conversations.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  notes={notes}
                  onOpen={() => onOpen(conversation.id)}
                  onDelete={() => requestDelete(conversation)}
                />
              ))}
            </ScrollView>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{notes ? 'No previous notes yet' : 'No previous chats yet'}</Text>
              <Text style={styles.emptyText}>{notes
                ? 'Starting new notes will keep your current notes here automatically.'
                : 'Starting a new chat will keep the current conversation here automatically.'}</Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.35)', justifyContent: 'flex-end', alignItems: 'center' },
  dismissArea: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  card: {
    width: '100%',
    maxWidth: 620,
    maxHeight: '82%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingTop: 18,
    paddingBottom: 14
  },
  header: { paddingHorizontal: 18, paddingBottom: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  headerCopy: { flex: 1 },
  eyebrow: { color: '#94a3b8', fontSize: 10, fontWeight: '800', letterSpacing: 1.35 },
  title: { color: '#172033', fontSize: 23, lineHeight: 29, fontWeight: '800', marginTop: 2 },
  subtitle: { color: '#64748b', fontSize: 13.5, lineHeight: 19, marginTop: 3 },
  closeButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  closeText: { color: '#475569', fontSize: 26, lineHeight: 28 },
  list: { paddingHorizontal: 14, paddingBottom: 8 },
  rowShell: { marginVertical: 5, borderRadius: 16, overflow: 'hidden' },
  deleteBackdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#b91c1c', alignItems: 'flex-end', justifyContent: 'center', paddingRight: 22 },
  deleteBackdropText: { color: 'white', fontWeight: '800' },
  row: { minHeight: 92, flexDirection: 'row', alignItems: 'center', backgroundColor: 'white', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 16 },
  rowMain: { flex: 1, paddingLeft: 15, paddingVertical: 12, paddingRight: 8 },
  rowTitle: { color: '#172033', fontSize: 16.5, fontWeight: '700' },
  rowMeta: { color: '#94a3b8', fontSize: 11.5, fontWeight: '600', marginTop: 2 },
  rowPreview: { color: '#64748b', fontSize: 13, lineHeight: 18, marginTop: 5 },
  deleteButton: { width: 52, minHeight: 72, alignItems: 'center', justifyContent: 'center' },
  deleteButtonText: { color: '#94a3b8', fontSize: 28, lineHeight: 30 },
  empty: { marginHorizontal: 18, marginTop: 8, marginBottom: 18, borderRadius: 18, backgroundColor: 'white', borderWidth: 1, borderColor: '#e2e8f0', padding: 22, alignItems: 'center' },
  emptyTitle: { color: '#172033', fontSize: 17, fontWeight: '800' },
  emptyText: { color: '#64748b', fontSize: 13.5, lineHeight: 20, textAlign: 'center', marginTop: 5, maxWidth: 360 },
  pressed: { opacity: 0.7 }
});
