import {authenticateEvidence} from '../compromise/authenticated-evidence.mjs';
import {evidenceSha256,manifestDigest,reportMessage,verifyReport} from '../compromise/report.mjs';
import {decodeReportFile,encodeReportFile} from '../compromise/report-file.mjs';
import {REVIEW_LIMITS} from '../compromise/review.mjs';

const decoder = new TextDecoder('utf-8',{fatal:true});
const hex = bytes => Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
const must = result => {if(!result.ok)throw Error(result.error?.code??result.error);return result.value;};
const sameAuthority = (a,b) => a?.revision===b.revision && a?.acceptedParent===b.acceptedParent &&
  a?.authorizationSnapshot===b.authorizationSnapshot;
const reportIdValid = id => typeof id==='string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const publicOperation = ({objectId,authorDevice,command}) => ({objectId,authorDevice,effectId:command.effectId,kind:command.kind});

function classify(entries,suspects,knownCheckpointEffects,boundary) {
  const effects = new Map(), overlaps = new Set();
  for(const entry of entries) {
    const id = entry.command.effectId;
    if(effects.has(id)) overlaps.add(id);
    effects.set(id,entry);
  }
  const suspect = new Set(entries.filter(e=>suspects.includes(e.authorDevice)).map(e=>e.command.effectId));
  const dependent = new Set();
  let changed;
  do {
    changed=false;
    for(const {command} of entries) {
      if(suspect.has(command.effectId)||dependent.has(command.effectId))continue;
      if(command.dependencyEffectIds.some(id=>!overlaps.has(id)&&(suspect.has(id)||dependent.has(id)))) {
        dependent.add(command.effectId);
        changed=true;
      }
    }
  } while(changed);
  return entries.map(entry=>{
    const {command,objectId,authorDevice} = entry;
    return {
      ...publicOperation(entry),boundary:boundary.kind==='operation' && boundary.ref===objectId,
      category:suspects.includes(authorDevice)?'suspect':overlaps.has(command.effectId)?'uncertain':dependent.has(command.effectId)?'dependent':'other',
      missingDependencies:command.dependencyEffectIds.filter(id=>overlaps.has(id)||!effects.has(id)&&!knownCheckpointEffects.has(id)).length
    };
  });
}

export function householdCompromise({runtime,withCurrent,sha256=evidenceSha256,randomUUID=()=>globalThis.crypto.randomUUID()}) {
  const scope = runtime.scope;
  const reviews = runtime.storage.compromise;
  const provider = runtime.authority.provider;
  const plans = new WeakMap();

  async function current(selectionRevision,confirmation,verifySelection=true) {
    const authority = await runtime.authorization();
    const token = {scopeId:scope.scopeId,selectionRevision,record:authority.expectedAuthority.record};
    if(verifySelection&&(confirmation?.scopeId!==token.scopeId||confirmation.selectionRevision!==selectionRevision||
      !sameAuthority(confirmation.record,token.record)))throw Error('STALE_REPORT_SELECTION');
    return {...authority,scope,token};
  }

  async function checkpoint(authority) {
    const seed = must(await runtime.storage.readProjectionSeed(authority.expectedAuthority,scope.documentId));
    if(seed) {
      if(seed.snapshot.length>REVIEW_LIMITS.bytes)throw Error('TOO_LARGE');
      await runtime.document(); // Checks the retained seed against the authorized local document frontier.
      return {bytes:seed.snapshot,label:'Verified household projection checkpoint',effects:new Set(seed.seed.identities.map(row=>row.effectId))};
    }
    if(scope.branchHead===runtime.authority.rootPin) {
      return {bytes:new Uint8Array(),label:'Pinned household starting checkpoint',effects:new Set()};
    }
    return null;
  }

  async function matchBoundary(authority,payload) {
    if(payload?.head!==scope.branchHead||payload.scopeId!==scope.scopeId||payload.scopeKind!=='household')throw Error('REPORT_BRANCH_UNAVAILABLE');
    if(!Array.isArray(payload.suspectDeviceIds)||payload.suspectDeviceIds.length!==1||
        payload.suspectDeviceIds[0]===payload.reporterDevice||
        !Object.hasOwn(authority.signingKeyRefs,payload.suspectDeviceIds[0]))throw Error('INVALID_REPORT_DEVICE');
    if(payload.boundary?.kind==='operation')return {bytes:new Uint8Array(),effects:new Set()};
    const local = await checkpoint(authority);
    if(!local)throw Error('CHECKPOINT_UNAVAILABLE');
    return local;
  }

  function context(authority,checkpointHash) {
    const {acceptedParent,revision,authorizationSnapshot} = authority.expectedAuthority.record;
    return {kind:'household',scopeId:scope.scopeId,authorityHead:acceptedParent,authorityRevision:revision,
      authoritySnapshot:authorizationSnapshot,checkpointHash};
  }

  const authenticate = (authority,object) => authenticateEvidence(runtime,'household',authority,object);

  async function inspect(authority,reviewId) {
    const saved = await reviews.get(scope.scopeId,reviewId);
    if(!saved?.isolated)throw Error('NOT_FOUND');
    if(!sameAuthority(authority.expectedAuthority.record,{revision:saved.context.authorityRevision,
      acceptedParent:saved.context.authorityHead,authorizationSnapshot:saved.context.authoritySnapshot}))throw Error('REPORT_AUTHORITY_CHANGED');
    const original = await reviews.inspectOriginal(scope.scopeId,reviewId,sha256);
    const {report,manifest,objects,missing} = original;
    let checkpoint = null;
    if(original.checkpointBytes!==null){
      try {checkpoint=await matchBoundary(authority,report.payload);}
      catch(error){if(error.message!=='CHECKPOINT_UNAVAILABLE')throw error;}
    }
    const checkpointUnavailable = !checkpoint || await sha256(checkpoint.bytes)!==saved.context.checkpointHash;
    if(await verifyReport({runtime,report,manifest,context:saved.context,reviewId,sha256})!==saved.reportHash)throw Error('INVALID_REPORT');
    const entries = [];
    for(const object of objects)entries.push(await authenticate(authority,object));
    const {boundary,suspectDeviceIds,reporterDevice} = report.payload;
    return {original,view:{reviewId,reporterDevice,suspectDeviceIds,boundary,checkpointLabel:checkpoint?.label,checkpointUnavailable,
      rows:classify(entries,suspectDeviceIds,checkpointUnavailable?new Set():checkpoint.effects,boundary),missing,count:manifest.length}};
  }

  return {
    open:()=>withCurrent(async revision=>{
      const a = await current(revision,null,false);
      return {confirmation:a.token,reports:await reviews.listReports(scope.scopeId)};
    }),
    prepare:(confirmation,suspectDevice)=>withCurrent(async revision=>{
      const reviewId = randomUUID();
      await reviews.preflightReport(scope.scopeId,reviewId);
      const {objects:candidates,truncated} = await reviews.reviewCandidates(scope.scopeId);
      const a = await current(revision,confirmation);
      if(suspectDevice===scope.authorDevice||!Object.hasOwn(a.signingKeyRefs,suspectDevice))throw Error('INVALID_REPORT_DEVICE');
      let base = null, checkpointOversized = false;
      try {base=await checkpoint(a);}
      catch(error) {if(error.message!=='TOO_LARGE')throw error;checkpointOversized=true;}
      const objects = [], operations = [];
      let excluded = 0;
      for(const object of candidates) {
        let header;
        try { header=JSON.parse(decoder.decode(object.bytes)).header; } catch { excluded++; continue; }
        if(header?.branchHead!==scope.branchHead) { excluded++; continue; }
        try { operations.push(publicOperation(await authenticate(a,object))); objects.push(object); }
        catch { excluded++; }
      }
      const checkpointFits = base && base.bytes.length+objects.reduce((sum,o)=>sum+o.bytes.length,0)<=REVIEW_LIMITS.bytes;
      const plan = {suspectDevice,operations,checkpoint:checkpointFits?base.label:null,
        checkpointOversized:checkpointOversized||!!base&&!checkpointFits,excluded,truncated};
      plans.set(plan,{reviewId,suspectDevice,objects,operations:structuredClone(operations),base:checkpointFits?base:null,confirmation:a.token});
      return plan;
    }),
    devices:confirmation=>withCurrent(async revision=>{
      const a = await current(revision,confirmation);
      return Object.keys(a.signingKeyRefs).filter(id=>id!==scope.authorDevice);
    }),
    sign:(plan,boundary)=>withCurrent(async revision=>{
      const draft = plans.get(plan);
      if(!draft)throw Error('STALE_REPORT_SELECTION');
      const {reviewId,objects,operations,base,confirmation,suspectDevice} = draft;
      const checkpointBytes = boundary.kind==='checkpoint'?base?.bytes:new Uint8Array();
      if(!checkpointBytes || (boundary.kind!=='checkpoint' &&
          (boundary.kind!=='operation'||!operations.some(o=>o.objectId===boundary.ref))))throw Error('INVALID_BOUNDARY');
      if(checkpointBytes.length+objects.reduce((sum,o)=>sum+o.bytes.length,0)>REVIEW_LIMITS.bytes)throw Error('TOO_LARGE');
      await reviews.preflightReport(scope.scopeId,reviewId);
      const a = await current(revision,confirmation);
      const checkpointHash = await sha256(checkpointBytes);
      const manifest = [];
      for(const o of objects)manifest.push({sourceId:o.sourceId,objectId:o.objectId,bytes:o.bytes.length,hash:await sha256(o.bytes)});
      const payload = {version:1,reportId:reviewId,reporterDevice:scope.authorDevice,reviewId,scopeId:scope.scopeId,scopeKind:'household',
        head:scope.branchHead,checkpointHash,manifestHash:await manifestDigest(manifest,sha256),suspectDeviceIds:[suspectDevice],
        boundary:boundary.kind==='checkpoint'?{kind:'checkpoint',ref:checkpointHash}:{kind:'operation',ref:boundary.ref}};
      const report = {payload,signature:hex(await provider.sign(a.signingKeyRefs[scope.authorDevice],reportMessage(payload)))};
      await reviews.freeze({reviewId,runtime,context:context(a,checkpointHash),report,objects,checkpointBytes,isolated:true,sha256});
      return reviewId;
    }),
    receive:(confirmation,file)=>withCurrent(async revision=>{
      let received = decodeReportFile(file);
      const {payload} = received.report;
      if(payload.scopeId!==scope.scopeId||payload.head!==scope.branchHead||payload.scopeKind!=='household')throw Error('REPORT_BRANCH_UNAVAILABLE');
      const reviewId = payload.reviewId;
      if(!reportIdValid(reviewId)||payload.reportId!==reviewId)throw Error('MALFORMED_REPORT');
      await reviews.preflightReport(scope.scopeId,reviewId);
      // The picker owns the input. Take a bounded private copy before any crypto.
      received = decodeReportFile(new Uint8Array(file));
      if(received.report.payload?.reviewId!==reviewId)throw Error('MALFORMED_REPORT');
      const a = await current(revision,confirmation);
      const local = await matchBoundary(a,received.report.payload);
      const checkpointBytes = local.bytes;
      if(checkpointBytes.length+received.measuredBytes>REVIEW_LIMITS.bytes)throw Error('TOO_LARGE');
      const checkpointHash = await sha256(checkpointBytes);
      const {replayed} = await reviews.stageEvidence({frozenReview:{reviewId,runtime,context:context(a,checkpointHash),report:received.report,
        expectedManifest:received.manifest,objects:received.objects,checkpointBytes,sha256,
        verifyEvidence:async objects=>{for(const o of objects)await authenticate(a,o);}}});
      return {reviewId,replayed};
    }),
    inspect:(confirmation,reviewId)=>withCurrent(async revision=>{
      const a = await current(revision,confirmation);
      const {view} = await inspect(a,reviewId);
      await current(revision,confirmation);
      return view;
    }),
    share:(confirmation,reviewId,handoff)=>withCurrent(async revision=>{
      const a = await current(revision,confirmation);
      const {original,view} = await inspect(a,reviewId);
      if(original.report.payload.reporterDevice!==scope.authorDevice)throw Error('INVALID_REPORT_DEVICE');
      if(view.checkpointUnavailable)throw Error('CHECKPOINT_UNAVAILABLE');
      if(original.missing.length)throw Error('ORIGINAL_EVIDENCE_UNAVAILABLE');
      const file = encodeReportFile(original.report,original.manifest,original.objects);
      await current(revision,confirmation);
      await handoff(file);
    })
  };
}
