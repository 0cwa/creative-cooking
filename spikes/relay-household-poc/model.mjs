// Signatures, encrypted epochs and authorized confirmations are assumed inputs.
export function recovery({codePresent, copies, unavailable = [], withholding = [], lostDomains = [], threshold, confirmed}) {
  const eligible = [...new Set(copies.filter(c => !unavailable.includes(c.holder) && !withholding.includes(c.holder) && !lostDomains.includes(c.domain)).map(c => c.holder))].sort();
  return {codePresent, eligible, threshold, codeCanUnwrap:codePresent, sharesCanUnwrap:eligible.length >= threshold, codeConfirmed:codePresent && confirmed, sharesConfirmed:eligible.length >= threshold && confirmed};
}

// Each delivery is applied locally; arrival order cannot select a trust head.
export function trust(events, threshold) {
  const proposals = new Map(), devices = new Map();
  const device = id => { if (!devices.has(id)) devices.set(id,{known:{base:{id:'base',parent:null,members:['Ana','Ben','Chi','Dee']}}, inbox:[], outbox:[], copies:[]}); return devices.get(id); };
  let repeated = 0;
  for (const e of events) {
    if (e.type === 'proposal') {
      const parent = e.parentState.id === 'base' ? {id:'base',members:['Ana','Ben','Chi','Dee']} : [...proposals.values()].find(p=>p.id===e.parentState.id && p.approvals.length >= threshold);
      if (!parent || !parent.members.includes(e.actor)) continue;
      const key = `${parent.id}:${e.remove}`;
      if (proposals.has(key)) { repeated++; continue; }
      proposals.set(key,{id:e.id,parent:parent.id,remove:e.remove,members:parent.members.filter(x=>x!==e.remove),electorate:parent.members,approvals:[e.actor]});
    } else if (e.type === 'approval') {
      const p = [...proposals.values()].find(p=>p.id===e.id);
      if (p && p.electorate.includes(e.actor) && !p.approvals.includes(e.actor)) p.approvals.push(e.actor);
    } else if (e.type === 'deliver') {
      const p = [...proposals.values()].find(p=>p.id===e.id);
      if (p && p.approvals.length >= threshold && device(e.device).known[p.parent]) device(e.device).known[p.id] = structuredClone(p);
    } else if (e.type === 'edit') {
      device(e.device).outbox.push({id:e.id,epoch:e.epoch,content:e.content});
    } else if (e.type === 'receiveEdit') {
      device(e.device).inbox.push({id:e.id,epoch:e.epoch,content:e.content});
    } else if (e.type === 'copyRejoin') {
      const d = device(e.device), source = d.inbox.find(x=>x.id===e.id);
      if (source && e.copyConsent && e.invitationAccepted && e.newEpoch && d.known[e.parent] && d.known[e.parent].members.includes(e.actor)) {
        d.known[e.newEpoch] = {id:e.newEpoch,parent:e.parent,members:[...new Set([...d.known[e.parent].members,e.joiner])]};
        d.copies.push({content:source.content,provenance:source.id,epoch:e.newEpoch});
      }
    }
  }
  const views = {};
  for (const [id,d] of devices) {
    const parents = new Set(Object.values(d.known).map(x=>x.parent));
    const heads = Object.keys(d.known).filter(x=>!parents.has(x)).sort();
    const quarantine = d.inbox.filter(x=>heads.length !== 1 || x.epoch !== heads[0]);
    views[id] = {...d,heads,quarantine};
  }
  return {proposals:[...proposals.values()],repeated,devices:views};
}

// Social checkpoint selection and operation labels are explicit scenario inputs.
export function reconstruction({devices, operations, checkpoint, selected, deviceApprovals, adultApprovals, personalConsent}) {
  const deviceVotes = [...new Set(deviceApprovals)].filter(id=>devices.some(d=>d.id===id));
  const adults = [...new Set(devices.map(d=>d.adult))];
  const adultVotes = [...new Set(adultApprovals)].filter(id=>adults.includes(id));
  const chosen = operations.filter(op=>selected.includes(op.id));
  if (!checkpoint.trustedBy || !checkpoint.newBranch) throw new Error('explicit checkpoint and new branch required');
  return {editPermission:'any authorized device',checkpointChoiceBy:checkpoint.trustedBy, newBranch:checkpoint.newBranch, deviceVote:{votes:deviceVotes.length,threshold:2,approved:deviceVotes.length>=2},adultVote:{votes:adultVotes.length,electorate:adults.length,threshold:2,approved:adultVotes.length>=2},checkpoint,selected:chosen,quarantined:operations.filter(op=>!selected.includes(op.id)),rejectedHistoryExport:operations,personalRecovery:{codeOnly:{guardianAccess:false},guardians:{enabled:personalConsent,thresholdCanRead:personalConsent}}};
}
