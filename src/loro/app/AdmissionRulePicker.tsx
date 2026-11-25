import {View} from 'react-native';
import {Pressable,Text,TextInput} from '@/theme/primitives';
import {admissionThreshold, validAdmissionPolicy} from '../authority/validator.mjs';

const rules = [
  ['allMinusOne', 'All but one (default)'],
  ['unanimous', 'Every adult (unanimous)'],
  ['fixed', 'Fixed number of adults'],
] as const;

export type AdmissionRuleDraft = {kind: typeof rules[number][0]; count: string};

export function admissionPolicyFromDraft(draft: AdmissionRuleDraft) {
  return {kind: draft.kind, fixedCount: draft.kind === 'fixed' ? (/^[0-9]+$/.test(draft.count) ? Number(draft.count) : NaN) : null};
}

export function admissionRuleLabel(policy: ReturnType<typeof admissionPolicyFromDraft>) {
  return policy.kind === 'fixed' ? `Fixed quorum of ${policy.fixedCount}` : rules.find(([kind]) => kind === policy.kind)?.[1];
}

export function AdmissionRulePicker({draft, onChange, adults}: {draft: AdmissionRuleDraft; onChange: (draft: AdmissionRuleDraft) => void; adults: number}) {
  const policy = admissionPolicyFromDraft(draft);
  const valid = validAdmissionPolicy(policy, adults);
  return <View style={{gap: 8}}>
    <Text accessibilityRole="header">Adult admission rule</Text>
    <Text>Only existing adults vote, with one vote per adult. With the default, one adult can approve an invitation when the household has two adults.</Text>
    {rules.map(([kind, label]) => <Pressable
      key={kind}
      accessibilityRole="radio"
      accessibilityState={{checked: draft.kind === kind}}
      onPress={() => onChange({...draft, kind})}
      style={{padding: 6, alignSelf: 'flex-start'}}>
      <Text>{draft.kind === kind ? '◉ ' : '○ '}{label}</Text>
    </Pressable>)}
    {draft.kind === 'fixed' && <TextInput accessibilityLabel="Number of required adult approvals"
      keyboardType="number-pad" value={draft.count} maxLength={4}
      onChangeText={count => onChange({...draft, count})} style={{borderWidth: 1, padding: 8}} />}
    <Text>{valid
      ? `This rule requires approval from ${admissionThreshold(policy, adults)} of ${adults} existing ${adults === 1 ? 'adult' : 'adults'}.`
      : `Enter a whole number from 1 to ${adults}, the size of the current electorate.`}</Text>
  </View>;
}
