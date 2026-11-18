import {useContext, useState} from 'react';
import {Pressable, Text, TextInput, View} from 'react-native';
import {admissionThreshold, validAdmissionPolicy} from '../authority/validator.mjs';
import {AdmissionRulePicker, admissionPolicyFromDraft, admissionRuleLabel, type AdmissionRuleDraft} from './AdmissionRulePicker';
import {copyText} from './clipboard';
import type {householdAdmissionRule, reviewHouseholdAdmissionRule} from './household-admission-rule.mjs';
import {LoroWorkspaceValue} from './WorkspaceStatus';

const limit = 128 * 1024;
type Status = Awaited<ReturnType<typeof householdAdmissionRule>>;
type Review = Awaited<ReturnType<typeof reviewHouseholdAdmissionRule>>;

export function HouseholdAdmissionRule() {
  const {householdPairing} = useContext(LoroWorkspaceValue);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<Status | null>(null);
  const [draft, setDraft] = useState<AdmissionRuleDraft>({kind:'unanimous', count:'1'});
  const [message, setMessage] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const rule = householdPairing.admissionRule;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice('');
    try { await action(); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not process the admission rule.'); }
    finally { setBusy(false); }
  }

  async function refresh() { setCurrent(await rule.status()); }

  function showMessage(value: string) {
    setMessage(value);
    setReview(null);
  }

  async function inspect() {
    setReview(null);
    if (new TextEncoder().encode(message).length > limit) throw Error('The proposal message is too large.');
    setReview(await rule.review(JSON.parse(message)));
  }

  if (!open) return <Pressable accessibilityRole="button" onPress={() => {setOpen(true); void run(refresh);}}>
    <Text>Manage adult admission rules</Text>
  </Pressable>;

  const proposed = admissionPolicyFromDraft(draft);
  const canPropose = current && validAdmissionPolicy(proposed, current.electorate.length) &&
    (current.policy.kind !== proposed.kind || current.policy.fixedCount !== proposed.fixedCount);

  return <View style={{gap:8}}>
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => setOpen(false)}>
      <Text>Close adult admission rules</Text>
    </Pressable>
    {current && <>
      <Text accessibilityLabel="Active adult admission rule">{admissionRuleLabel(current.policy)}. Requires {current.required} of {current.electorate.length} existing adults.</Text>
      <Text selectable>Adults eligible to vote: {current.electorate.join(', ')}</Text>
      <Text selectable>Current household head: {current.head}</Text>
      <AdmissionRulePicker adults={current.electorate.length} draft={draft} onChange={setDraft} />
      <Pressable accessibilityRole="button" disabled={busy || !canPropose} onPress={() => void run(async () => {
        const item = await rule.propose({policy:proposed, expectedHead:current.head, explicit:true});
        showMessage(JSON.stringify(item));
        setReview(await rule.review(item));
      })}><Text>Create admission rule proposal</Text></Pressable>
    </>}
    <Text>Share the proposal message with eligible adults. Each adult reviews the same proposal, then passes on the message with their signed approval. The current rule determines how many approvals the proposed change needs.</Text>
    <TextInput accessibilityLabel="Admission rule proposal message" multiline maxLength={limit}
      value={message} editable={!busy} onChangeText={showMessage} style={{borderWidth:1, padding:8, minHeight:72}} />
    <Pressable accessibilityRole="button" disabled={busy || !message} onPress={() => void run(inspect)}>
      <Text>Review admission rule proposal</Text>
    </Pressable>
    {review && <>
      <Text selectable>Proposal fingerprint: {review.eventHash}</Text>
      <Text selectable>Frozen household head: {review.parent.head}</Text>
      <Text selectable>Eligible adults for this proposal: {review.parent.roster.join(', ')}</Text>
      <Text>{review.approvals} of {review.required} required approvals under the current rule.</Text>
      <Text>The proposed {admissionRuleLabel(review.item.event.nextPolicy)} requires {admissionThreshold(review.item.event.nextPolicy, review.parent.roster.length)} of {review.parent.roster.length} existing adults for future invitations.</Text>
      <Pressable accessibilityRole="button" disabled={busy || !review.canApprove || review.complete} onPress={() => void run(async () => {
        const next = await rule.approve({item:review.item, confirmedEventHash:review.eventHash, explicit:true});
        setMessage(JSON.stringify(next.item));
        setReview(next);
      })}><Text>Sign approval for reviewed rule</Text></Pressable>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run(async () => {
        if (!await copyText(message)) throw Error('Copy the displayed message manually.');
        setNotice('Proposal message copied.');
      })}><Text>Copy admission rule proposal message</Text></Pressable>
      <Pressable accessibilityRole="button" disabled={busy || !review.complete} onPress={() => void run(async () => {
        const result = await rule.retain({item:review.item, confirmedEventHash:review.eventHash, explicit:true});
        await refresh();
        setNotice(result.replayed ? 'This approved rule is already retained.' : 'Approved rule retained. Opening its branch requires checkout of the cooking workspace.');
      })}><Text>Retain approved admission rule</Text></Pressable>
    </>}
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run(async () => {
      setReview(null);
      await refresh();
    })}><Text>Refresh admission rules</Text></Pressable>
    {current && current.successors.length > 0 && <>
      <Text accessibilityRole="header">Retained admission rule changes</Text>
      <Text>Each change has its own household branch. Opening a different branch requires checkout of its cooking workspace.</Text>
      {current.successors.map(successor => <View key={successor.eventHash} style={{gap:4}}>
        <Text>{admissionRuleLabel(successor.policy)} · {successor.eventHash === current.head ? 'Active' : 'Retained'}</Text>
        <Text selectable>Branch: {successor.eventHash}</Text>
        <Text selectable>Parent: {successor.parentHead}</Text>
      </View>)}
    </>}
    {notice ? <Text accessibilityRole="alert">{notice}</Text> : null}
  </View>;
}
