import {useContext, useState, useSyncExternalStore} from 'react';
import {Pressable, Text, TextInput, View} from 'react-native';
import {useAppState} from '@/state/AppState';
import {admissionThreshold, validAdmissionPolicy} from '../authority/validator.mjs';
import {AdmissionRulePicker, admissionPolicyFromDraft, admissionRuleLabel, type AdmissionRuleDraft} from './AdmissionRulePicker';
import {copyText} from './clipboard';
import type {householdAdmissionRule, reviewHouseholdAdmissionRule} from './household-admission-rule.mjs';
import {LoroWorkspaceValue} from './WorkspaceStatus';

const limit = 128 * 1024;
type Status = Awaited<ReturnType<typeof householdAdmissionRule>>;
type Review = Awaited<ReturnType<typeof reviewHouseholdAdmissionRule>>;
type Checkout = {expectedHead:string;expectedRevision:number;targetHead:string};

type BranchReview = {sourceHead:string; sourceRevision:number; targetHead:string};
type ReturnReview = {sourceHead:string; targetHead:string; targetRevision:number};
type ReopenTarget = {scopeId:string; head:string};
const reopenTargets = new WeakMap<object, ReopenTarget>();
const reopenListeners = new Set<() => void>();
const subscribeReopen = (listener:()=>void) => { reopenListeners.add(listener); return () => {reopenListeners.delete(listener);}; };
const noReopen = () => null;
function saveReopen(workspace:object, target:ReopenTarget) {
  reopenTargets.set(workspace, target);
  for (const listener of reopenListeners) listener();
}

export function HouseholdAdmissionRule() {
  const workspace = useContext(LoroWorkspaceValue);
  const app = useAppState();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<Status | null>(null);
  const [draft, setDraft] = useState<AdmissionRuleDraft>({kind:'unanimous', count:'1'});
  const [message, setMessage] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const rule = workspace.householdPairing.admissionRule;
  const branches = workspace.policyBranches;
  const pendingReopen = useSyncExternalStore(subscribeReopen, () => reopenTargets.get(workspace) ?? null, noReopen);
  const [retainedHead, setRetainedHead] = useState('');
  const [branchReview, setBranchReview] = useState<BranchReview | null>(null);
  const [returnReview, setReturnReview] = useState<ReturnReview | null>(null);
  const canActivate = !!branches?.reviewStaged && !workspace.readOnly;
  const canReturn = !!branches?.reviewReturn && workspace.readOnly;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice('');
    try { await action(); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      setNotice(code === 'POLICY_BASELINE_UNAVAILABLE' ? 'This device needs the cooking updates for the signed starting point. Open the parent branch and exchange updates before trying again.' :
        code === 'CHECKOUT_REQUIRED' ? 'Open the parent cooking branch before opening this branch.' :
        code === 'CONFLICT' || code === 'INVALID_AUTHORITY' ? 'The household changed. Reopen the workspace and review the branch again.' :
        code === 'IO' ? 'Could not save the branch switch. Check device storage and try again.' :
        code || 'Could not process the admission rule.');
    }
    finally { setBusy(false); }
  }

  async function refresh() { setCurrent(await rule.status()); setCheckout(null); }

  function showMessage(value: string) {
    setMessage(value);
    setReview(null);
  }

  async function inspect() {
    setReview(null);
    if (new TextEncoder().encode(message).length > limit) throw Error('The proposal message is too large.');
    setReview(await rule.review(JSON.parse(message)));
  }

  async function openBranch(choice: Checkout) {
    await switchPolicy(async () => {
      const {head} = await rule.checkout({...choice, explicit:true});
      return head;
    });
  }

  async function switchPolicy(commit: () => Promise<string>) {
    const release = app.beginWorkspaceTransition();
    let committed = false;
    try {
      await app.flushCurrentWorkspace();
      const head = await commit();
      committed = true;
      const target = {scopeId:workspace.household.scope.scopeId, head};
      saveReopen(workspace, target);
      await workspace.reopen(target);
    } finally { if (!committed) release(); }
  }

  if (workspace.readOnly && !canReturn && !pendingReopen) return null;
  if (!open && !pendingReopen) return <Pressable accessibilityRole="button" onPress={() => {setOpen(true); if (!workspace.readOnly) void run(refresh);}}>
    <Text>Manage adult admission rules</Text>
  </Pressable>;

  const proposed = admissionPolicyFromDraft(draft);
  const canPropose = current && validAdmissionPolicy(proposed, current.electorate.length) &&
    (current.policy.kind !== proposed.kind || current.policy.fixedCount !== proposed.fixedCount);

  return <View style={{gap:8}}>
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => {setOpen(false); setCheckout(null);}}>
      <Text>Close adult admission rules</Text>
    </Pressable>
    {pendingReopen ? <>
      <Text selectable>Workspace switch saved. Editing remains paused until reopening branch {pendingReopen.head}.</Text>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run(async () => { await workspace.reopen(pendingReopen); })}><Text>Retry reopening workspace</Text></Pressable>
    </> : <>
    {(canActivate || canReturn) && <Text>The copied branch and the returned original are read-only.</Text>}
    {canReturn && <>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run(async () => {setReturnReview(await branches.reviewReturn());})}><Text>Review return to original</Text></Pressable>
      {returnReview && <>
        <Text selectable>Original branch: {returnReview.sourceHead}</Text>
        <Text selectable>Copied branch: {returnReview.targetHead} · revision {returnReview.targetRevision}</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run(() => switchPolicy(async () => {
          const result = await branches.returnToSource({expectedSourceHead:returnReview.sourceHead, expectedTargetHead:returnReview.targetHead, expectedTargetRevision:returnReview.targetRevision, explicit:true});
          return result.sourceHead;
        }))}><Text>Confirm return to original</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => setReturnReview(null)}><Text>Cancel return</Text></Pressable>
      </>}
    </>}
    {!workspace.readOnly && <>
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
      {review.item.event.version === 3 && <Text selectable>Signed cooking starting point: {review.item.event.subject.historyHash}</Text>}
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
        if ('targetHead' in result && result.targetHead) setRetainedHead(result.targetHead);
        await refresh();
        setNotice(result.replayed ? 'This approved rule is already retained.' : 'Approved rule retained. You can open its cooking branch separately.');
      })}><Text>Retain approved admission rule</Text></Pressable>
    </>}
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run(async () => {
      setReview(null);
      await refresh();
    })}><Text>Refresh admission rules</Text></Pressable>
    {current && current.successors.length > 0 && <>
      <Text accessibilityRole="header">Retained admission rule changes</Text>
      {current.successors.map(successor => <View key={successor.eventHash} style={{gap:4}}>
        <Text>{admissionRuleLabel(successor.policy)} · {successor.eventHash === current.head ? 'Active' : 'Retained'}</Text>
        <Text selectable>Branch: {successor.eventHash}</Text>
        <Text selectable>Parent: {successor.parentHead}</Text>
        {successor.legacy && <Text>This proposal predates signed cooking starting points.</Text>}
      </View>)}
    </>}
    {current && current.checkout.length > 0 && <>
      <Text accessibilityRole="header">Cooking branches</Text>
      <Text>Opening a branch keeps your current cooking edits and pending transfers with that branch.</Text>
      {current.checkout.map(branch => <View key={branch.head} style={{gap:4}}>
        <Text selectable>{admissionRuleLabel(branch.policy)} · {branch.head}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Review cooking branch ${branch.head}`} disabled={busy}
          onPress={() => setCheckout({expectedHead:current.head, expectedRevision:current.revision, targetHead:branch.head})}>
          <Text>Review branch</Text>
        </Pressable>
      </View>)}
      {checkout && <>
        <Text selectable>Open cooking branch {checkout.targetHead} on this device?</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run(() => openBranch(checkout))}>
          <Text>Open this cooking branch</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => setCheckout(null)}><Text>Cancel branch switch</Text></Pressable>
      </>}
    </>}
    {canActivate && <>
      <Text accessibilityRole="header">Open a retained policy branch</Text>
      <Text>Enter the retained head to resume review after reopening Settings or reloading.</Text>
      <TextInput accessibilityLabel="Retained policy branch head" value={retainedHead} editable={!busy} autoCapitalize="none" autoCorrect={false} onChangeText={value => {setRetainedHead(value); setBranchReview(null);}} />
      <Pressable accessibilityRole="button" disabled={busy || !retainedHead.trim()} onPress={() => void run(async () => {setBranchReview(null); setBranchReview(await branches.reviewStaged(retainedHead.trim()));})}><Text>Review staged policy branch</Text></Pressable>
      {branchReview && <>
        <Text selectable>Source branch: {branchReview.sourceHead} · revision {branchReview.sourceRevision}</Text>
        <Text selectable>Copied branch: {branchReview.targetHead}</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run(() => switchPolicy(async () => {
          const result = await branches.activate({expectedSourceHead:branchReview.sourceHead, expectedSourceRevision:branchReview.sourceRevision, targetHead:branchReview.targetHead, explicit:true});
          return result.targetHead;
        }))}><Text>Confirm open copied branch</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => setBranchReview(null)}><Text>Cancel policy branch switch</Text></Pressable>
      </>}
    </>}
    </>}
    </>}
    {notice ? <Text accessibilityRole="alert">{notice}</Text> : null}
  </View>;
}
