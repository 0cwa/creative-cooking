import {assertCommandScope} from '../domain/personal-codec.mjs';
import {resolveActivatedPolicyAuthority,resolveInstalledSetAuthority,resolveRuntimeAuthority} from '../authority/chain.mjs';
import {resolvePersonalAuthority} from '../authority/personal.mjs';
import * as registry from '../domain/registry.mjs';
import {commandRecipeId,recipeCatalogBinding,recipeDocumentId} from '../domain/recipe-document.mjs';
// Minimal offline engine. The caller supplies a LoroDoc constructor and an explicitly
// preaccepted scope; product pairing and authority management are not implemented here.
const FIXTURE=Symbol('fixture authority');
const encoder = new TextEncoder();
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v==='object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])) : v;
const same = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const required = result => { if (!result.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error.code); return result.value; };
const commandBytes = registry.bytes;
const checkCommand = registry.validate;
const apply = registry.apply;
/**
 * `scope` is an already accepted, immutable test/deployment configuration, not a
 * pairing implementation. Only the listed authors and exact policy context are
 * accepted. Callers must establish this configuration through their authority layer.
 * The candidate codec is the actual K2 throwing API, not C0's Result API.
 */
export class OfflineRuntime {
  #recipeId;
  constructor({storage, codec, LoroDoc, decodeImportBlobMeta, scope, keyRef, authority, recipeId = null, recipeCreation = /** @type {(() => Promise<any>)|null} */(null)}, fixtureToken) {
    const fixtureAuthority=fixtureToken===FIXTURE;
    if ((!authority || typeof authority.rootPin!=='string' || !authority.provider) && fixtureAuthority!==true) throw new Error('INVALID_AUTHORITY_CONFIG');
    if (authority && fixtureAuthority) throw new Error('INVALID_AUTHORITY_CONFIG');
    if (recipeId !== null && (!authority || (authority.kind ?? 'household') !== 'household')) throw Error('INVALID_AUTHORITY_CONFIG');
    this.#recipeId=recipeId;
    this.recipeCreation=recipeCreation;
    this.authority=authority; this.fixtureAuthority=fixtureAuthority;
    this.storage=storage; this.codec=codec; this.LoroDoc=LoroDoc; this.decodeImportBlobMeta=decodeImportBlobMeta; this.scope=structuredClone(scope); this.keyRef=keyRef;
    const peers=scope.authorPeers && Object.values(scope.authorPeers);
    const validPeer=p=>typeof p==='string' && p.length <= 20 && /^(0|[1-9][0-9]*)$/.test(p) && BigInt(p) <= 18446744073709551615n;
    if (!peers || !peers.every(validPeer) || new Set(peers).size !== peers.length || Object.keys(scope.authorPeers).length !== scope.acceptedAuthors?.length || !scope.acceptedAuthors.every(a=>Object.hasOwn(scope.authorPeers,a))) throw new Error('MALFORMED_SCOPE');
    if (!scope.scopeId || !scope.documentId || !scope.branchHead || !scope.epochId || !scope.authorDevice || !scope.suiteId || !Array.isArray(scope.policyHashes) || !Array.isArray(scope.acceptedAuthors) || !scope.acceptedAuthors.includes(scope.authorDevice)) throw new Error('MALFORMED_SCOPE');
  }
  get recipeId() { return this.#recipeId; }
  async forRecipe(recipeId, creation = /** @type {{codec:any;prepareKey:()=>Promise<any>}|null} */(null)) {
    if (this.#recipeId !== null || !this.authority || (this.authority.kind ?? 'household') !== 'household') throw Error('INVALID_RECIPE_DOCUMENT');
    if(creation&&this.authority?.activatedPolicy)throw Error('SOURCE_PROVENANCE_REQUIRED');
    const auth=await this.authorization(),{members}=auth;
    const documentId=await recipeDocumentId(this.scope,this.authority.rootPin,this.authority.provider,recipeId);
    if(creation&&(!members||!this.authority.installedSet?.recipeCatalog||
       members.some(entry=>entry.recipeId===recipeId||entry.documentId===documentId)))throw Error('INVALID_RECIPE_DOCUMENT');
    if(members&&!creation)await this.requireRecipeMember(auth,recipeId,documentId);
    return new OfflineRuntime({
      storage:this.storage,codec:creation?.codec??this.codec,LoroDoc:this.LoroDoc,decodeImportBlobMeta:this.decodeImportBlobMeta,
      scope:{...this.scope,documentId},keyRef:this.keyRef,authority:this.authority,recipeId,recipeCreation:creation?.prepareKey
    });
  }
  async requireRecipeMember(auth,recipeId,documentId) {
    if(auth.members.some(entry=>entry.recipeId===recipeId&&entry.documentId===documentId))return;
    const catalog=this.authority.installedSet?.recipeCatalog;
    if(recipeId===null||!catalog||!(await catalog(this,auth,recipeId)).children.has(recipeId))throw Error('INVALID_RECIPE_DOCUMENT');
  }
  assertRecipeCommand(command,{replay=false}={}) {
    if(this.authority?.installedSet&&
      (!replay&&(command.kind==='recipe-create')!==!!this.recipeCreation))throw Error('UNSUPPORTED_VERSION');
    if (this.#recipeId !== null && commandRecipeId(command) !== this.#recipeId) throw Error('INVALID_RECIPE_DOCUMENT');
  }
  async authorization() {
    const s=this.scope;
    if (!this.fixtureAuthority) {
      const kind=this.authority.kind ?? 'household';
      if (!['household','personal'].includes(kind)) throw new Error('INVALID_AUTHORITY_CONFIG');
      const scope={kind,id:s.scopeId},{rootPin:pin,provider,installedSet}=this.authority;
      if(installedSet&&kind!=='household')throw Error('INVALID_AUTHORITY_CONFIG');
      const resolver=kind==='personal' ? resolvePersonalAuthority : resolveRuntimeAuthority;
      const activated=this.authority.activatedPolicy;
      if(activated&&(installedSet||kind!=='household'))throw Error('INVALID_AUTHORITY_CONFIG');
      const resolved=activated ? await resolveActivatedPolicyAuthority({storage:this.storage,scope,pin,provider,authorDevice:s.authorDevice,LoroDoc:this.LoroDoc,targetHead:activated.targetHead,keys:activated.keys}) : installedSet
        ? await resolveInstalledSetAuthority({storage:this.storage,scope,pin,provider,authorDevice:s.authorDevice,
          operationId:installedSet.operationId,sodium:installedSet.sodium,LoroDoc:this.LoroDoc,paired:installedSet.paired})
        : await resolver(this.storage,scope,pin,provider,s.authorDevice);
      if(activated&&!same(resolved,activated.resolved))throw Error('STALE_AUTHORITY');
      if (this.authority.selectionIndex!==undefined && resolved.selectionIndex!==this.authority.selectionIndex) throw new Error('INVALID_AUTHORITY');
      const expected={...resolved.scope,authorizationSnapshot:s.authorizationSnapshot};
      if (this.#recipeId !== null) expected.documentId=await recipeDocumentId(resolved.scope,this.authority.rootPin,this.authority.provider,this.#recipeId);
      if (!same(expected,s)) throw new Error('INVALID_AUTHORITY');
      if (!resolved.signingKeyRefs || !s.acceptedAuthors.every(a=>Object.hasOwn(resolved.signingKeyRefs,a) && typeof resolved.signingKeyRefs[a]==='string' && resolved.signingKeyRefs[a])) throw new Error('INVALID_AUTHORITY');
      const auth={expectedAuthority:resolved.expectedAuthority,signingKeyRefs:resolved.signingKeyRefs,
        sourceDocumentId:resolved.scope.documentId,...(resolved.members?{members:resolved.members,wrappingKeyRefs:resolved.wrappingKeyRefs}:{}),
        ...(activated?{pairedSeed:resolved.members.find(document=>document.documentId===s.documentId)?.policySeed??null}:
          resolved.pairedDocuments?{pairedSeed:resolved.pairedDocuments.find(document=>document.documentId===s.documentId)?.seed??null}:{})};
      if(resolved.members&&!this.recipeCreation)await this.requireRecipeMember(auth,this.#recipeId,s.documentId);
      return auth;
    }
    const record=required(await this.storage.readPairingAuthority({kind:'household',id:s.scopeId}));
    if (!record || record.acceptedParent !== s.branchHead || record.authorizationSnapshot !== s.authorizationSnapshot) throw new Error('INVALID_AUTHORITY');
    let state; try { state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record.authorityState)); } catch { throw new Error('INVALID_AUTHORITY'); }
    if (!same(state,{acceptedAuthors:s.acceptedAuthors,authorPeers:s.authorPeers,acceptedRecipients:s.acceptedRecipients,epochId:s.epochId,policyHashes:s.policyHashes,documentId:s.documentId,documentGeneration:s.documentGeneration})) throw new Error('INVALID_AUTHORITY');
    return {expectedAuthority:{version:2,scope:record.scope,record:{revision:record.revision,acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot}},signingKeyRefs:Object.fromEntries(s.acceptedAuthors.map(a=>[a,a]))};
  }
  async authorize() { return (await this.authorization()).expectedAuthority; }
  async recipePublication(command, expectedAuthority) {
    if (this.#recipeId === null) return undefined;
    this.assertRecipeCommand(command);
    const current = await this.authorization();
    if (!same(current.expectedAuthority, expectedAuthority)) throw Error('CONFLICT');
    if(current.members&&!this.recipeCreation)return undefined;
    const binding = recipeCatalogBinding(this.scope,this.authority.rootPin,current.sourceDocumentId);
    if (command.kind !== 'recipe-create') {
      const {entries}=required(await this.storage.readSelectedRecipeCatalog(expectedAuthority,binding,{recipeId:this.#recipeId,documentId:this.scope.documentId}));
      if (entries[0]?.documentId!==this.scope.documentId) throw Error('MISSING_DEPENDENCY');
      return undefined;
    }
    const source = required(await this.storage.reopenBranchDocument(expectedAuthority,current.sourceDocumentId));
    const doc = new this.LoroDoc();
    if (source) doc.import(source.bytes);
    if (doc.getMap('recipe-index').get(this.#recipeId)) throw Error('CONFLICT');
    return {
      binding,
      recipeId: this.#recipeId,
      sourceRevision: source?.revision ?? null,
      ...(this.recipeCreation?{installedKey:await this.recipeCreation()}:{})
    };
  }
  async document() {
    const {expectedAuthority,pairedSeed}=await this.authorization();
    const stored=required(await this.storage.reopenBranchDocument(expectedAuthority,this.scope.documentId));
    const doc=new this.LoroDoc(); if (stored) doc.import(stored.bytes);
    const markers=doc.getMap('domain-effects').toJSON(),seeded=Object.entries(markers).filter(([,m])=>m?.version===3);
    const seed=pairedSeed!==undefined?pairedSeed:typeof this.storage.readProjectionSeed==='function'?required(await this.storage.readProjectionSeed(expectedAuthority,this.scope.documentId)):null;if(seeded.length&&!seed)throw Error('UNVERIFIED_SEED');if(seed){const originalSeed=new this.LoroDoc();originalSeed.import(seed.snapshot);let retained;try{retained=doc.forkAt(originalSeed.frontiers())}catch{throw Error('UNVERIFIED_SEED')}if(!same(retained.exportJsonUpdates(undefined,undefined,false),originalSeed.exportJsonUpdates(undefined,undefined,false)))throw Error('UNVERIFIED_SEED');const expected=new Map(seed.seed.identities.map(x=>[x.effectId,x.commandId]));if(seeded.length!==expected.size||seeded.some(([id,m])=>m.seedId!==seed.seed.seedId||m.effectId!==id||m.commandId!==expected.get(id)||Object.keys(m).sort().join(',')!=='commandId,effectId,seedId,version'))throw Error('UNVERIFIED_SEED')}
    return {doc,revision:stored?.revision ?? null,storedBytes:stored?.bytes ?? null};
  }
  async read() { const {doc}=await this.document(); return {recipe:doc.getMap('recipe').toJSON(), purchases:doc.getMap('purchases').toJSON()}; }
  async prepare(input,verifyRecipeSource=undefined) { return this.#prepareOnDocument(input,null,verifyRecipeSource); }
  async prepareActivatedRecipeField(input,token,service) {
    if(!this.authority?.activatedPolicy || this.recipeId===null || input?.command?.kind!=='recipe-field')throw Error('INVALID_AUTHORITY');
    const {verifiedActivatedPolicyEdit}=await import('../app/activated-policy-source.mjs');
    await verifiedActivatedPolicyEdit(token,this,service);
    return this.#prepareOnDocument(input,null,undefined,true);
  }
  async #prepareOnDocument({operationId, command, deviceSequence}, staged, verifyRecipeSource, activatedEdit=false) {
    if(this.authority?.activatedPolicy&&!activatedEdit)throw Error('SOURCE_PROVENANCE_REQUIRED');
    command=structuredClone(command);
    command=checkCommand(command);
    this.assertRecipeCommand(command);
    assertCommandScope(command.kind,this.authority?.kind ?? 'household');
    const {expectedAuthority,signingKeyRefs}=await this.authorization();
    if (!operationId || !Number.isSafeInteger(deviceSequence) || deviceSequence < 0) throw new Error('MALFORMED');
    const {doc,revision}=staged ?? await this.document();
    if(doc.getMap('domain-effects').get(command.effectId)?.version===3)throw Error('ALREADY_RECORDED');
    const previous=required(await this.storage.getLocalOperation(this.scope.scopeId,operationId));
    if (previous) {
      const c=previous.commit.commands[0];
      const oldHeader=previous.commit.outbound.length === 1 ? JSON.parse(new TextDecoder().decode(previous.commit.outbound[0].object.bytes)).header : null;
      if (!oldHeader || oldHeader.deviceSequence !== deviceSequence || oldHeader.authorDevice !== this.scope.authorDevice || oldHeader.scopeId !== this.scope.scopeId || oldHeader.documentId !== this.scope.documentId || oldHeader.documentGeneration !== this.scope.documentGeneration || oldHeader.branchHead !== this.scope.branchHead || oldHeader.epochId !== this.scope.epochId || !same(oldHeader.policyHashes,this.scope.policyHashes) || previous.commit.commands.length !== 1 || c.commandId !== command.commandId || c.effectId !== command.effectId || c.documentId !== this.scope.documentId || c.kind !== command.kind || !same(Array.from(c.payload),Array.from(commandBytes(command)))) throw new Error('CONFLICT');
      return {previous:{outcome:previous.outcome,replayed:true}};
    }
    if (command.data.author !== undefined && command.data.author !== this.scope.authorDevice) throw new Error('INVALID_AUTHORITY');
    doc.setPeerId(this.scope.authorPeers[this.scope.authorDevice]);
    const linked=command.data.recipeSource ? await verifyRecipeSource?.(command,expectedAuthority) : undefined;
    registry.checkPreconditions(doc,command,{recipeSource:linked?.source});
    registry.checkShoppingCompatibility(doc,command);
    const before=doc.oplogVersion();
    apply(doc,command);
    registry.validateOperations(command,doc.exportJsonUpdates(before,undefined,false).changes);
    const snapshot=doc.export({mode:'snapshot'}), update=doc.export({mode:'update',from:before});
    const meta=this.inspectUpdate(update);
    const header={version:1,suiteId:this.scope.suiteId,scopeId:this.scope.scopeId,documentId:this.scope.documentId,documentGeneration:this.scope.documentGeneration,branchHead:this.scope.branchHead,policyHashes:this.scope.policyHashes,epochId:this.scope.epochId,authorDevice:this.scope.authorDevice,deviceSequence,predecessorRefs:meta.predecessors,semanticEffectIds:[command.effectId],payloadKind:'loro-update-v1'};
    const payload=encoder.encode(JSON.stringify({version:1,command,update:Array.from(update)}));
    const object=await this.codec.sealContent(header,payload,this.keyRef,signingKeyRefs[this.scope.authorDevice]);
    return {recipeSourceReceipt:linked?.receipt,commit:{scopeId:this.scope.scopeId,operationId,expectedAuthority,documents:[{documentId:this.scope.documentId,bytes:snapshot,expectedRevision:revision}],commands:[{version:1,commandId:command.commandId,effectId:command.effectId,documentId:this.scope.documentId,kind:command.kind,payload:commandBytes(command),dependencyEffectIds:command.dependencyEffectIds}],outbound:[{object,branchHead:this.scope.branchHead,epochId:this.scope.epochId}]}};
  }
  /** Atomically commit ordered commands against one authority-bound document. */
  async executeBatch({operationId,items},verifyRecipeSource=undefined) {
    if(this.authority?.activatedPolicy)throw Error('SOURCE_PROVENANCE_REQUIRED');
    if(typeof operationId!=='string'||!operationId||!Array.isArray(items)||!items.length) throw Error('MALFORMED');
    items=structuredClone(items);
    await this.authorize();
    const saved=required(await this.storage.getLocalOperation(this.scope.scopeId,operationId));
    if(saved) {
      const commit=saved.commit;
      if(commit.commands.length!==items.length||commit.outbound.length!==items.length||commit.documents.length!==1)throw Error('CONFLICT');
      for(let i=0;i<items.length;i++) {
        const item=items[i],cmd=checkCommand(item.command),c=commit.commands[i];this.assertRecipeCommand(cmd);assertCommandScope(cmd.kind,this.authority?.kind ?? 'household');
        let h;try{h=JSON.parse(new TextDecoder().decode(commit.outbound[i].object.bytes)).header}catch{throw Error('CORRUPT')}
        if(c.documentId!==this.scope.documentId||c.commandId!==cmd.commandId||c.effectId!==cmd.effectId||!same(Array.from(c.payload),Array.from(commandBytes(cmd)))||h.deviceSequence!==item.deviceSequence||h.authorDevice!==this.scope.authorDevice||h.scopeId!==this.scope.scopeId||h.documentId!==this.scope.documentId||h.documentGeneration!==this.scope.documentGeneration||h.branchHead!==this.scope.branchHead||h.epochId!==this.scope.epochId||h.suiteId!==this.scope.suiteId||!same(h.policyHashes,this.scope.policyHashes))throw Error('CONFLICT');
      }
      return {outcome:saved.outcome,replayed:true};
    }
    let staged=await this.document();const initialRevision=staged.revision,commands=[],outbound=[],recipeSourceReceipts=[];let expectedAuthority;
    for(const item of items) {
      if(['chef-accept','chef-effect'].includes(item.command?.kind))throw Error('GROUP_REQUIRED');
      const prepared=await this.#prepareOnDocument({...item,operationId},staged,verifyRecipeSource);
      if(prepared.previous)throw Error('CONFLICT');
      if(expectedAuthority && !same(expectedAuthority,prepared.commit.expectedAuthority))throw Error('CONFLICT');
      if(prepared.recipeSourceReceipt)recipeSourceReceipts.push(prepared.recipeSourceReceipt);
      expectedAuthority=prepared.commit.expectedAuthority;commands.push(...prepared.commit.commands);outbound.push(...prepared.commit.outbound);
      const next=new this.LoroDoc();next.import(prepared.commit.documents[0].bytes);staged={doc:next,revision:initialRevision};
    }
    return required(await this.storage.commitLocal({scopeId:this.scope.scopeId,operationId,expectedAuthority,documents:[{documentId:this.scope.documentId,bytes:staged.doc.export({mode:'snapshot'}),expectedRevision:initialRevision}],commands,outbound},recipeSourceReceipts));
  }
  async execute(input) {
    if(this.recipeCreation)throw Error('UNSUPPORTED_VERSION');
    if (['chef-accept','chef-effect','shopping-item-create','shopping-item-field','shopping-list-field'].includes(input?.command?.kind)) throw new Error('GROUP_REQUIRED');
    const prepared=await this.prepare(input);
    if (prepared.previous) return prepared.previous;
    return required(await this.storage.commitLocal(prepared.commit));
  }
  inspectUpdate(update) {
    const meta=this.decodeImportBlobMeta(update,true);
    const starts=meta.partialStartVersionVector.toJSON(), ends=meta.partialEndVersionVector.toJSON();
    let operations=0;
    for (const [peer,end] of ends) operations += end-(starts.get(peer) ?? 0);
    if (meta.mode !== 'update' || meta.changeNum !== 1 || operations < 1) throw new Error('MALFORMED_UPDATE');
    if (ends.size !== 1) throw new Error('MALFORMED_UPDATE');
    return {peer:[...ends.keys()][0],frontiers:meta.startFrontiers,predecessors:meta.startFrontiers.map(({peer,counter})=>`${peer}:${counter}`).sort()};
  }
  async importItem(item) {
    if(this.authority?.activatedPolicy)throw Error('SOURCE_PROVENANCE_REQUIRED');
    if(this.recipeCreation)throw Error('UNSUPPORTED_VERSION');
    item=structuredClone(item);
    if(!(item?.bytes instanceof Uint8Array))throw Error('MALFORMED_UPDATE');
    const {expectedAuthority,signingKeyRefs}=await this.authorization();
    const applied=required(await this.storage.getInboxApplication(this.scope.scopeId,item.itemId,item.bytes));
    const opened=await this.codec.openContent(item.bytes,signingKeyRefs), h=opened.header, s=this.scope;
    if(h.version!==1)throw Error('PROVENANCE_HANDLER_REQUIRED');
    if (!applied) {
      if (!this.storage.compromise) throw Error('QUARANTINE_UNAVAILABLE');
      if (await this.storage.compromise.isQuarantined(s.scopeId,h.authorDevice)) throw Error('QUARANTINED');
    }
    if (opened.object.id !== item.itemId || h.scopeId !== s.scopeId || h.documentId !== s.documentId || h.documentGeneration !== s.documentGeneration || h.branchHead !== s.branchHead || h.epochId !== s.epochId || h.suiteId !== s.suiteId || !same(h.policyHashes,s.policyHashes) || !s.acceptedAuthors.includes(h.authorDevice) || h.payloadKind !== 'loro-update-v1' || h.semanticEffectIds.length !== 1) throw new Error('INVALID_AUTHORITY');
    let payload; try { payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(opened.value)); } catch { throw new Error('MALFORMED_UPDATE'); }
    if (!payload || Object.keys(payload).sort().join(',') !== 'command,update,version' || payload.version !== 1 || !Array.isArray(payload.update) || !payload.update.every(x=>Number.isInteger(x) && x>=0 && x<=255)) throw new Error('MALFORMED_UPDATE');
    checkCommand(payload.command);
    this.assertRecipeCommand(payload.command);
    assertCommandScope(payload.command.kind,this.authority?.kind ?? 'household');
    if (payload.command.data.author !== undefined && payload.command.data.author !== h.authorDevice) throw new Error('INVALID_AUTHORITY');
    if (payload.command.effectId !== h.semanticEffectIds[0]) throw new Error('MALFORMED_UPDATE');
    const update=Uint8Array.from(payload.update);
    const meta=this.inspectUpdate(update);
    if (meta.peer !== s.authorPeers[h.authorDevice] || !same(meta.predecessors,h.predecessorRefs)) throw new Error('MALFORMED_UPDATE');
    if (applied) {
      if (applied.outcome.revisions.length!==1 || applied.outcome.revisions[0].documentId!==s.documentId) throw Error('CONFLICT');
      return {outcome:applied.outcome,replayed:true};
    }
    const {doc,revision}=await this.document();
    // Verify the entire authenticated update on its causal starting document,
    // independently of operations already present on this receiver.
    let prior;try {prior=doc.forkAt(meta.frontiers);} catch {throw new Error('MISSING_DEPENDENCY');}
    const verifier=prior.forkAt(meta.frontiers), start=verifier.oplogVersion();
    const checked=verifier.import(update);
    if (checked.pending && checked.pending.size) throw new Error('MISSING_DEPENDENCY');
    const command=payload.command;
    registry.validateOperations(command,verifier.exportJsonUpdates(start,undefined,false).changes);
    registry.checkPreconditions(prior,command,{importing:true});
    registry.checkShoppingCompatibility(doc,command);if(['shopping-item-create','shopping-item-field','shopping-list-field'].includes(command.kind)&&h.version!==4)throw Error('UNSUPPORTED_VERSION');
    const status=doc.import(update);
    if (status.pending && status.pending.size) throw new Error('MISSING_DEPENDENCY');
    return required(await this.storage.commitImport({version:2,scopeId:s.scopeId,operationId:`import:${item.itemId}`,expectedAuthority,itemId:item.itemId,documents:[{documentId:s.documentId,bytes:doc.export({mode:'snapshot'}),expectedRevision:revision}],commands:[{version:1,commandId:command.commandId,effectId:command.effectId,documentId:s.documentId,kind:command.kind,payload:commandBytes(command),dependencyEffectIds:command.dependencyEffectIds}],effectIds:h.semanticEffectIds},{authorDevice:h.authorDevice,bytes:item.bytes}));
  }
  async recoverInbox() {
    const items=required(await this.storage.listStagedInbox(this.scope.scopeId));
    const results=new Map(), remaining=new Map(items.map(item=>[item.itemId,item]));
    let progress;
    do {
      progress=false;
      for (const [id,item] of remaining) {
        try { results.set(id,{itemId:id,result:await this.importItem(item)}); remaining.delete(id); progress=true; }
        catch (error) { if (error.message !== 'MISSING_DEPENDENCY') { results.set(id,{itemId:id,error}); remaining.delete(id); } }
      }
    } while (progress && remaining.size);
    for (const id of remaining.keys()) results.set(id,{itemId:id,error:new Error('MISSING_DEPENDENCY')});
    return items.map(item=>results.get(item.itemId));
  }
  async outboundFor(recipient) {
    await this.authorize();
    if (!this.scope.acceptedRecipients?.includes(recipient)) throw new Error('INVALID_AUTHORITY');
    const objects=required(await this.storage.listOutboundObjects(this.scope.scopeId));
    const receipts=required(await this.storage.listReceiptStates(this.scope.scopeId));
    return objects.filter(o => o.branchHead === this.scope.branchHead && o.epochId === this.scope.epochId && !receipts.some(r => r.objectId === o.objectId && r.destination === 'peer' && r.recipientId === recipient && r.state === 'applied'));
  }
}

/** Explicitly test-only authority fixture; never use for product enrollment. */
export class FixtureOfflineRuntime extends OfflineRuntime { constructor(options) { super(options,FIXTURE); } }
