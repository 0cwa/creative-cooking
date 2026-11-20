import {domain} from './validator.mjs';

const byPeer = (a, b) => a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0;

export function policyBranchAncestors({nodes,policyParents},head) {
  const ancestors=[];
  while (head && nodes.has(head)) {
    ancestors.push(nodes.get(head));
    head=policyParents?.get(head)?.head;
  }
  return ancestors;
}

export function normalizedFrontiers(doc) {
  return doc.frontiers().map(({counter, peer}) => ({counter, peer})).sort(byPeer);
}

export async function policyBaseline(doc, provider) {
  const operations = doc.exportJsonUpdates(undefined, undefined, false).changes
    .map(change => ({...change, deps:[...change.deps].sort()}))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const hash = await provider.hash(domain('policy-cooking-baseline', operations));
  if (!(hash instanceof Uint8Array) || hash.length !== 32) throw Error('INVALID_PROOF');
  return {frontiers:normalizedFrontiers(doc), historyHash:Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')};
}

export async function verifyPolicyBaseline(parent, LoroDoc, baseline, provider) {
  let fork;
  try { fork = baseline.frontiers.length ? parent.forkAt(baseline.frontiers) : new LoroDoc(); }
  catch { throw Error('POLICY_BASELINE_UNAVAILABLE'); }
  await requireExactBaseline(fork, baseline, provider);
  return fork;
}

async function requireExactBaseline(doc, baseline, provider) {
  const derived = await policyBaseline(doc, provider);
  if (derived.historyHash !== baseline.historyHash || derived.frontiers.length !== baseline.frontiers.length ||
      derived.frontiers.some((point, i) => point.peer !== baseline.frontiers[i].peer || point.counter !== baseline.frontiers[i].counter)) {
    throw Error('POLICY_BASELINE_UNAVAILABLE');
  }
}

export async function verifyRetainedPolicyBaseline(LoroDoc, stored, baseline, provider) {
  const doc = new LoroDoc();
  if (doc.import(stored.bytes).pending?.size) throw Error('POLICY_BASELINE_UNAVAILABLE');
  if (stored.revision === 0) await requireExactBaseline(doc, baseline, provider);
  else await verifyPolicyBaseline(doc, LoroDoc, baseline, provider);
}

export async function recoverPolicyBaseline(LoroDoc, stored, baseline, provider) {
  const parent = new LoroDoc();
  if (stored) parent.import(stored.bytes);
  return (await verifyPolicyBaseline(parent,LoroDoc,baseline,provider)).export({mode:'snapshot'});
}
