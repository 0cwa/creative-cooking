import {publishReviewedRevocation, readAuthority, resolveHistoricalAuthority, verifyAuthority, verifiedRevocationDraft} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {digest, exact, grantBody, hex, same, verifyRevocation, verifySignature, checkRecipientBinding} from '../compromise/revocation.mjs';
import {projectCurrentSeed} from '../compromise/current-seed.mjs';
import {canonicalReportBytes, evidenceSha256, manifestDigest, validateReport, verifyReport} from '../compromise/report.mjs';
import {sealHouseholdFile, installHouseholdFile} from '../pairing/household-file.mjs';
import {authenticateEvidence} from '../compromise/authenticated-evidence.mjs';
import {projectCooking} from '../domain/app-projection.mjs';
import {REVIEW_LIMITS} from '../compromise/review.mjs';

const must=result=>{if(!result.ok)throw Error(result.error?.code??result.error);return result.value;};
const utf8=new TextDecoder('utf-8',{fatal:true});
const suiteId='candidate-ed25519-xchacha20-sealedbox-v1';

/** Public messages carry signatures and hashes. Only recipient files carry the
 * clean seed and the wrapped fresh key. */
export function householdRevocation({
  storage, scope, pin, provider, sodium, master, runtime, deviceId, adultId,
  signingKey, wrappingPublicKey, store, withSecrets, LoroDoc, randomUUID, sha256=evidenceSha256
}) {
  const reviews=storage.compromise;
  const slot=JSON.stringify(['household-revocation-notices',scope.id,pin]);
  const sign=async (purpose,body)=>hex(await provider.sign(signingKey,domain(purpose,body)));
  const notices=()=>store.transaction(tx=>tx.get(slot)??[],{readOnly:true});
  async function authority() {
    const current=await readAuthority(storage,scope,pin,provider);
    const {nodes}=await verifyAuthority(current.state,pin,provider);
    return {...current,nodes,parent:nodes.get(current.activeHead)};
  }
  async function review(proposal, historical=false, requireQuorum=false) {
    if(!exact(proposal,'item,grant,manifest,recipientBindings'))throw Error('INVALID_REVOCATION');
    const current=await authority(), parent=historical?current.nodes.get(proposal.item?.event?.parentHead):current.parent;
    if(!parent || parent.head!==proposal.item?.event?.parentHead)throw Error('STALE_AUTHORITY');
    const verified=await verifyRevocation({provider,parent,...proposal,requireQuorum});
    const local=parent.devices.find(d=>d.active&&d.deviceId===deviceId&&d.adultId===adultId);
    const canApprove=!!local && !proposal.item.approvals.some(v=>v.adultId===adultId);
    const confirmation=await digest(provider,'reviewed-device-revocation',{eventHash:verified.eventHash,grantHash:verified.grantHash});
    return {...verified,confirmation,canApprove,parentHead:parent.head,selected:current.activeHead===verified.eventHash};
  }
  const freshPeer=(peers)=>{
    for(let i=0;i<32;i++){
      const n=BigInt('0x'+hex(sodium.randombytes_buf(8))).toString();
      if(n!=='0'&&!peers.has(n)){peers.add(n);return n;}
    }
    throw Error('PEER_GENERATION_FAILED');
  };
  async function binding(){
    const a=await runtime.authorize();
    const body={version:1,scopeId:scope.id,parentHead:a.record.acceptedParent,deviceId,wrappingKey:wrappingPublicKey};
    return {...body,signature:await sign('revocation-recipient',body)};
  }
  async function authenticateLate(bytes){
    const {header}=JSON.parse(utf8.decode(bytes)), a=await runtime.authorize(), current=await authority();
    if(a.record.revision!==current.revision||a.record.acceptedParent!==current.activeHead)throw Error('STALE_AUTHORITY');
    const edges=new Map(await Promise.all(current.state.events.map(async entry=>[await digest(provider,'event',entry.event),entry.event])));
    let head=current.activeHead, revoked=false;
    while(head!==header?.branchHead&&edges.has(head)){
      const event=edges.get(head);
      revoked ||= event.kind==='revokeDevice'&&event.subject.deviceId===header?.authorDevice;
      head=event.parentHead;
    }
    if(!revoked||head!==header?.branchHead||current.parent.devices.find(d=>d.deviceId===header.authorDevice)?.active!==false)throw Error('INVALID_LATE_EVIDENCE');
    const historical=await resolveHistoricalAuthority(storage,scope,pin,provider,head);
    if(!same(historical.expectedAuthority,a))throw Error('STALE_AUTHORITY');
    const opened=await runtime.codec.openContent(bytes,historical.signingKeyRefs);
    const evidence=await authenticateEvidence(runtime,'household',historical,{sourceId:'inbox',objectId:opened.object.id,bytes});
    return {a,evidence};
  }
  return {
    async status(){
      const current=await authority();
      const {parent,state,activeHead}=current;
      const published=state.events.find(e=>e.rotation?.grant?.version===2&&e.rotation.grant.eventHash===activeHead&&e.rotation.localDeviceId===deviceId);
      const retained=await notices(), branches=[];
      for(const proposal of retained){
        const verified=await review(proposal,true,true);
        branches.push({...verified,proposal});
      }
      const drafts=[], archivedReports=[];
      for(const {reviewId,report} of await reviews.listReports(scope.id)){
        if(report.payload.head!==activeHead)archivedReports.push({reviewId,head:report.payload.head});
        const saved=await reviews.get(scope.id,reviewId);
        if(saved?.status==='local-draft'&&saved.context.authorityHead===activeHead&&!saved.draft.held.length){
          drafts.push({reviewId,documentId:saved.draft.documentId,deviceId:saved.report.payload.suspectDeviceIds[0]});
        }
      }
      const archivedHeads=[...new Set([pin,...state.selections.map(entry=>entry.to)])].filter(head=>head!==activeHead);
      return {head:activeHead,drafts,archivedHeads,archivedReports,devices:parent.devices.map(d=>({deviceId:d.deviceId,active:d.active})),branches,
        reopen:activeHead!==runtime.scope.branchHead?activeHead:null,
        published:published&&{operationId:published.rotation.operationId,generation:parent.generation,
          proposal:{item:{event:published.event,approvals:published.approvals,authorSignature:published.authorSignature},
            grant:published.rotation.grant,manifest:published.rotation.manifest,recipientBindings:published.rotation.recipientBindings},
          recipients:parent.runtime.acceptedRecipients.filter(id=>id!==deviceId)}};
    },
    binding,
    async prepare({reviewId,bindings,explicit}){
      if(explicit!==true||!Array.isArray(bindings)||bindings.length>127)throw Error('CONFIRMATION_REQUIRED');
      const a=await runtime.authorize();
      const {parent,revision}=await authority();
      if(a.record.revision!==revision||a.record.acceptedParent!==parent.head)throw Error('STALE_AUTHORITY');
      const saved=await reviews.get(scope.id,reviewId);
      const draft=saved?.draft, target=saved?.report?.payload?.suspectDeviceIds?.[0];
      if(!saved?.isolated||saved.status!=='local-draft'||!saved.selection||!draft||draft.held.length||target===deviceId||
         saved.report.payload.suspectDeviceIds.length!==1||!parent.devices.some(d=>d.active&&d.deviceId===target))throw Error('INVALID_DRAFT');
      const source=must(await storage.reopenBranchDocument(a,parent.runtime.documentId));
      if(draft.publicationBaseRevision!==(source?.revision??null))throw Error('SOURCE_CHANGED');
      const original=await reviews.inspectOriginal(scope.id,reviewId,sha256);
      if(await verifyReport({runtime,report:saved.report,context:saved.context,reviewId,manifest:saved.manifest,sha256})!==saved.reportHash)throw Error('INVALID_REPORT');
      const old=new LoroDoc(), clean=new LoroDoc();
      if(source)old.import(source.bytes);
      clean.import(draft.snapshot);
      const peers=new Set([...old.oplogVersion().toJSON().keys(),...clean.oplogVersion().toJSON().keys(),...Object.values(parent.runtime.authorPeers)]);
      const supplied=[...bindings,await binding()], byDevice=new Map();
      for(const binding of supplied){
        const d=await checkRecipientBinding(parent,binding,provider);
        if(d.deviceId===target||byDevice.has(d.deviceId))throw Error('INVALID_RECIPIENT');
        byDevice.set(d.deviceId,binding);
      }
      const remaining=parent.devices.filter(d=>d.active&&d.deviceId!==target).sort((a,b)=>a.deviceId.localeCompare(b.deviceId));
      if(remaining.some(d=>!byDevice.has(d.deviceId)))throw Error('RECIPIENT_BINDINGS_REQUIRED');
      const recipientBindings=remaining.map(d=>byDevice.get(d.deviceId));
      const devices=remaining.map(({deviceId,signingKeyRef})=>({deviceId,signingKeyRef,wrappingKeyRef:byDevice.get(deviceId).wrappingKey,peerId:freshPeer(peers)}));
      const subject={deviceId:target,documentId:draft.documentId,newGeneration:parent.generation+1,newEpochId:randomUUID(),devices};
      const event={version:2,suiteId,householdId:scope.id,parentHead:parent.head,policyHash:parent.policyHash,
        generation:parent.generation,epochId:parent.epochId,proposalId:randomUUID(),kind:'revokeDevice',authorDeviceId:deviceId,
        frozenAdultRoster:parent.roster,subject,nextPolicy:null};
      const item={event,authorSignature:await sign('event-signature',event),approvals:[]};
      const seedId=randomUUID(),seedPeerId=freshPeer(peers);
      const seed=projectCurrentSeed({LoroDoc,source:draft.snapshot,seedId,peerId:seedPeerId,schemaVersion:4});
      const manifest={version:1,scopeId:scope.id,authorizationSnapshot:a.record.authorizationSnapshot,sourceDocumentId:parent.runtime.documentId,sourceRevision:source?.revision??null,
        sourceHash:await digest(provider,'rotation-source-snapshot',hex(source?.bytes??new Uint8Array())),reviewId,
        evidenceDocumentId:draft.sourceDocumentId,evidenceGeneration:draft.sourceGeneration,reportHash:saved.reportHash,
        selectionHash:await digest(provider,'rotation-selection',saved.selection),newDocumentId:subject.documentId,newGeneration:subject.newGeneration,
        newEpochId:subject.newEpochId,draftHash:await digest(provider,'rotation-draft-snapshot',hex(seed.snapshot)),seedId,seedPeerId,seedSchemaVersion:4,
        seedIdentitiesHash:await digest(provider,'projection-seed-identities',seed.identities),
        archiveHash:await digest(provider,'rotation-archive-snapshot',hex(draft.snapshot))};
      const grant={version:2,householdId:scope.id,parentHead:parent.head,eventHash:await digest(provider,'event',event),
        newEpochId:subject.newEpochId,newGeneration:subject.newGeneration,documentId:subject.documentId,
        manifestHash:await digest(provider,'rotation-manifest',manifest),recipients:devices.map(d=>d.deviceId),
        packageRefs:devices.filter(d=>d.deviceId!==deviceId).map(()=>randomUUID()),contentClasses:['pantry','recipe','shopping'],
        disclosure:'current-state-only',signatures:[]};
      await verifiedRevocationDraft({runtime,provider,item,manifest,review:saved,original,source,sha256});
      const proposal={item,grant,manifest,recipientBindings};
      return {proposal,...await review(proposal)};
    },
    review,
    async approve({proposal,confirmed,explicit}){
      if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');
      const checked=await review(proposal);
      if(checked.confirmation!==confirmed||!checked.canApprove)throw Error('APPROVAL_UNAVAILABLE');
      await runtime.authorize();
      const {event}=proposal.item;
      const approval={version:1,householdId:scope.id,eventHash:checked.eventHash,parentHead:event.parentHead,
        policyHash:event.policyHash,generation:event.generation,epochId:event.epochId,adultId,deviceId};
      const signature=await sign('approval-signature',approval);
      const grantSignature=await sign('rotation-grant-signature',{grant:grantBody(proposal.grant),adultId,deviceId});
      proposal.item.approvals.push({...approval,signature});
      proposal.grant.signatures.push({adultId,deviceId,signature:grantSignature});
      return {proposal,...await review(proposal)};
    },
    async retain({proposal,confirmed,explicit}){
      if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');
      const verified=await review(proposal,true,true);
      if(verified.confirmation!==confirmed)throw Error('REVIEW_CHANGED');
      return store.transaction(tx=>{
        const records=tx.get(slot)??[];
        const existing=records.find(p=>p.grant.eventHash===verified.eventHash);
        if(existing){if(!same(existing,proposal))throw Error('CONFLICT');return {replayed:true};}
        if(records.length>=16)throw Error('NOTICE_CAPACITY');
        tx.put(slot,[...records,proposal]);
        return {replayed:false};
      });
    },
    async publish({proposal,confirmed,explicit}){
      if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');
      const checked=await review(proposal,true,true);
      if(checked.confirmation!==confirmed)throw Error('REVIEW_CHANGED');
      return withSecrets(({signingSecret})=>publishReviewedRevocation({
        ...proposal,storage,scope,pin,provider,master,deviceId,signingSecret,runtime,sha256
      }));
    },
    seal:({operationId,recipientDevice})=>withSecrets(keys=>sealHouseholdFile({
      sodium,storage,scope,pin,provider,keys,operationId,recipientDevice,LoroDoc,kind:'revocation'
    })),
    async install({bytes,proposal,confirmed,explicit}){
      if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');
      const checked=await review(proposal,true,true);
      if(checked.confirmation!==confirmed)throw Error('REVIEW_CHANGED');
      const ids=eventHash=>({
        operationId:`receive-revocation:${eventHash}`,keyOperationId:`received-revocation-key:${eventHash}`
      });
      return withSecrets(async keys=>{
        const install=()=>installHouseholdFile({sodium,bytes,keys,storage,scope,pin,provider,recipientDevice:deviceId,LoroDoc,master,
          recipientKind:'revocation',confirmedEventHash:checked.eventHash,confirmedGrantHash:checked.grantHash,identify:ids});
        try{return await install();}
        catch(error){
          if(error.message==='CONFLICT'&&must(await storage.householdRecipient.find(scope.id,ids(checked.eventHash).operationId)))return install();
          throw error;
        }
      });
    },
    async holdLateEvidence(raw){
      if(!(raw instanceof Uint8Array)||raw.length>REVIEW_LIMITS.objectBytes)throw Error('TOO_LARGE');
      const bytes=new Uint8Array(raw), {a,evidence}=await authenticateLate(bytes);
      return {objectId:evidence.objectId,...must(await storage.holdRevokedEvidence(a,{id:evidence.objectId,bytes}))};
    },
    async inspectBranch(head){
      const historical=await resolveHistoricalAuthority(storage,scope,pin,provider,head);
      const original=must(await storage.readRetainedBranch(historical.expectedAuthority,{head,documentId:historical.scope.documentId}));
      if(!original)return {head,available:false};
      const doc=new LoroDoc();
      doc.import(original.bytes);
      const cooking=projectCooking(doc);
      return {head,available:true,pantry:cooking.pantry.map(item=>item.name),recipes:cooking.recipes.map(recipe=>recipe.title),
        shopping:cooking.shopping.lists.map(list=>list.name)};
    },
    async inspectArchivedReport(reviewId){
      const saved=await reviews.get(scope.id,reviewId);
      if(!saved?.isolated)throw Error('NOT_FOUND');
      const original=await reviews.inspectOriginal(scope.id,reviewId,sha256);
      const payload=validateReport(saved.report,saved.manifest);
      const historical=await resolveHistoricalAuthority(storage,scope,pin,provider,payload.head);
      const signer=historical.signingKeyRefs[payload.reporterDevice];
      if(!signer||payload.reviewId!==reviewId||payload.scopeKind!=='household'||payload.scopeId!==scope.id||
         payload.manifestHash!==await manifestDigest(saved.manifest,sha256)||
         saved.reportHash!==await sha256(canonicalReportBytes(saved.report))||
         !await verifySignature(provider,signer,'compromise-report',payload,saved.report.signature))throw Error('INVALID_REPORT');
      return {reviewId,head:payload.head,deviceIds:payload.suspectDeviceIds,objects:saved.manifest.map(row=>row.objectId),
        missing:original.missing.map(row=>row.objectId),checkpointAvailable:original.checkpointBytes!==null};
    },
    async inspectLate(objectId){
      const cursors=must(await storage.listCursors(scope.id));
      if(!cursors.some(c=>c.source===`revoked:${objectId}`&&c.cursor===objectId))throw Error('NOT_FOUND');
      const original=must(await storage.listStagedInbox(scope.id)).find(row=>row.itemId===objectId);
      if(!original)throw Error('ORIGINAL_EVIDENCE_UNAVAILABLE');
      const {evidence}=await authenticateLate(original.bytes);
      return {objectId,authorDevice:evidence.authorDevice,sourceHead:evidence.sourceHead,command:evidence.command};
    },
    async lateEvidence(){
      await runtime.authorize();
      const cursors=must(await storage.listCursors(scope.id));
      return cursors.filter(c=>c.source===`revoked:${c.cursor}`).map(c=>c.cursor);
    }
  };
}
