import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { proposalPresentation } from '@/chef/proposals';
import { formatRecipeIngredientLine } from '@/domain/recipeEditing';
import type { ChefToolProposal } from '@/domain/types';

type Props = {
  proposal: ChefToolProposal;
  onApply(): boolean;
};

export function ToolProposalCard({ proposal, onApply }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [applying, setApplying] = useState(false);
  const presentation = useMemo(() => proposalPresentation(proposal), [proposal]);
  const applied = proposal.status === 'applied';
  const recipe = presentation.recipe;

  const actionStyle = presentation.actionTone === 'destructive'
    ? styles.destructiveButton
    : presentation.actionTone === 'positive'
      ? styles.positiveButton
      : styles.neutralButton;

  return (
    <View style={[styles.card, applied && styles.cardApplied]}>
      <View style={styles.heading}>
        <View style={styles.headingCopy}>
          <Text style={styles.eyebrow}>{applied ? 'APPLIED' : presentation.eyebrow}</Text>
          <Text style={styles.title}>{presentation.title}</Text>
          {presentation.summary ? <Text style={styles.summary}>{presentation.summary}</Text> : null}
        </View>
        {applied ? (
          <View accessibilityLabel="Change applied" style={styles.appliedBadge}>
            <Text style={styles.appliedBadgeText}>✓</Text>
          </View>
        ) : null}
      </View>

      {recipe && expanded ? (
        <View style={styles.preview}>
          {recipe.description ? <Text style={styles.description}>{recipe.description}</Text> : null}
          <Text style={styles.recipeMeta}>{recipe.portions} portions · {recipe.ingredients.length} ingredients</Text>
          <Text style={styles.sectionTitle}>Ingredients</Text>
          <View style={styles.list}>
            {recipe.ingredients.map((ingredient, index) => (
              <Text key={`${ingredient.name}-${index}`} style={styles.listText}>• {formatRecipeIngredientLine(ingredient)}</Text>
            ))}
          </View>
          <Text style={styles.sectionTitle}>Method</Text>
          <View style={styles.list}>
            {recipe.steps.map((step, index) => (
              <Text key={`${index}-${step}`} style={styles.listText}>{index + 1}. {step}</Text>
            ))}
          </View>
          {recipe.notes?.length ? (
            <>
              <Text style={styles.sectionTitle}>Notes</Text>
              <View style={styles.list}>
                {recipe.notes.map((note, index) => (
                  <Text key={`${index}-${note}`} style={styles.listText}>• {note}</Text>
                ))}
              </View>
            </>
          ) : null}
        </View>
      ) : null}

      <View style={styles.actions}>
        {recipe ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? `Hide preview for ${presentation.title}` : `Preview ${presentation.title}`}
            onPress={() => setExpanded((value) => !value)}
            style={styles.previewButton}
          >
            <Text style={styles.previewButtonText}>{expanded ? 'Hide preview' : 'Preview recipe'}</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={applied ? `${presentation.actionLabel} applied` : presentation.actionLabel}
          accessibilityState={{ disabled: applied || applying }}
          disabled={applied || applying}
          onPress={() => {
            if (applying || applied) return;
            setApplying(true);
            if (!onApply()) setApplying(false);
          }}
          style={[styles.actionButton, actionStyle, (applied || applying) && styles.actionDisabled]}
        >
          <Text style={styles.actionButtonText}>
            {applied ? '✓ Applied' : applying ? 'Applying…' : presentation.actionTone === 'positive' ? `＋ ${presentation.actionLabel}` : presentation.actionLabel}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'flex-start',
    width: '94%',
    maxWidth: 620,
    borderWidth: 1,
    borderColor: '#dbe4dc',
    borderRadius: 18,
    backgroundColor: '#fbfefb',
    padding: 14,
    gap: 12
  },
  cardApplied: { backgroundColor: '#f8fafc', borderColor: '#e2e8f0' },
  heading: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  headingCopy: { flex: 1, gap: 3 },
  eyebrow: { color: '#15803d', fontSize: 10.5, fontWeight: '900', letterSpacing: 1.2 },
  title: { color: '#172033', fontSize: 16.5, lineHeight: 21, fontWeight: '800' },
  summary: { color: '#64748b', fontSize: 13.5, lineHeight: 19 },
  appliedBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#dcfce7',
    alignItems: 'center',
    justifyContent: 'center'
  },
  appliedBadgeText: { color: '#166534', fontWeight: '900' },
  preview: {
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingTop: 12,
    gap: 8
  },
  description: { color: '#475569', fontSize: 14, lineHeight: 20 },
  recipeMeta: { color: '#94a3b8', fontSize: 12.5, fontWeight: '700' },
  sectionTitle: { color: '#334155', fontSize: 12, fontWeight: '900', letterSpacing: 0.7, textTransform: 'uppercase', marginTop: 2 },
  list: { gap: 4 },
  listText: { color: '#475569', fontSize: 13.5, lineHeight: 19 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' },
  previewButton: {
    minHeight: 40,
    borderRadius: 12,
    paddingHorizontal: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'white',
    borderWidth: 1,
    borderColor: '#cbd5e1'
  },
  previewButtonText: { color: '#475569', fontSize: 13, fontWeight: '800' },
  actionButton: {
    minHeight: 40,
    borderRadius: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center'
  },
  positiveButton: { backgroundColor: '#15803d' },
  neutralButton: { backgroundColor: '#334155' },
  destructiveButton: { backgroundColor: '#b91c1c' },
  actionDisabled: { backgroundColor: '#94a3b8' },
  actionButtonText: { color: 'white', fontSize: 13, fontWeight: '900' }
});
