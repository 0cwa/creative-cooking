// Minimal offline engine. The caller supplies a LoroDoc constructor and an explicitly
// preaccepted scope; product pairing and authority management are not implemented here.
const encoder = new TextEncoder();
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const required = result => { if (!result.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error.code); return result.value; };
function commandBytes(command) { return encoder.encode(JSON.stringify(command)); }
function checkCommand(c) {
  if (!c || typeof c !== 'object' || !['recipe-title','purchase'].includes(c.kind) || typeof c.commandId !== 'string' || !c.commandId || typeof c.effectId !== 'string' || !c.effectId || typeof c.value !== 'string' || !c.value || Object.keys(c).sort().join(',') !== 'commandId,effectId,kind,value') throw new Error('MALFORMED');
}
function apply(doc, command) {
  if (command.kind === 'recipe-title') doc.getMap('recipe').set('title',command.value);
  else doc.getMap('purchases').set(command.effectId,command.value);
}
/**
 * `scope` is an already accepted, immutable test/deployment configuration, not a
 * pairing implementation. Only the listed authors and exact policy context are
 * accepted. Callers must establish this configuration through their authority layer.
 * The candidate codec is the actual K2 throwing API, not C0's Result API.
 */
export class OfflineRuntime {
  constructor({storage, codec, LoroDoc, decodeImportBlobMeta, scope, keyRef}) {
    this.storage=storage; this.codec=codec; this.LoroDoc=LoroDoc; this.decodeImportBlobMeta=decodeImportBlobMeta; this.scope=structuredClone(scope); this.keyRef=keyRef;
    const peers=scope.authorPeers && Object.values(scope.authorPeers);
    const validPeer=p=>typeof p==='string' && /^(0|[1-9][0-9]*)$/.test(p) && BigInt(p) <= 18446744073709551615n;
    if (!peers || !peers.every(validPeer) || new Set(peers).size !== peers.length || Object.keys(scope.authorPeers).length !== scope.acceptedAuthors?.length || !scope.acceptedAuthors.every(a=>Object.hasOwn(scope.authorPeers,a))) throw new Error('MALFORMED_SCOPE');
    if (!scope.scopeId || !scope.documentId || !scope.branchHead || !scope.epochId || !scope.authorDevice || !scope.suiteId || !Array.isArray(scope.policyHashes) || !Array.isArray(scope.acceptedAuthors) || !scope.acceptedAuthors.includes(scope.authorDevice)) throw new Error('MALFORMED_SCOPE');
  }
  async authorize() {
    const s=this.scope;
    const record=required(await this.storage.readPairingAuthority({kind:'household',id:s.scopeId}));
    if (!record || record.acceptedParent !== s.branchHead || record.authorizationSnapshot !== s.authorizationSnapshot) throw new Error('INVALID_AUTHORITY');
    let state; try { state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record.authorityState)); } catch { throw new Error('INVALID_AUTHORITY'); }
    if (!same(state,{acceptedAuthors:s.acceptedAuthors,authorPeers:s.authorPeers,acceptedRecipients:s.acceptedRecipients,epochId:s.epochId,policyHashes:s.policyHashes,documentId:s.documentId,documentGeneration:s.documentGeneration})) throw new Error('INVALID_AUTHORITY');
    return {version:2,scope:record.scope,record:{revision:record.revision,acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot}};
  }
  async document() {
    const stored=required(await this.storage.reopenDocument(this.scope.scopeId,this.scope.documentId));
    const doc=new this.LoroDoc(); if (stored) doc.import(stored.bytes);
    return {doc,revision:stored?.revision ?? null};
  }
  async read() { const {doc}=await this.document(); return {recipe:doc.getMap('recipe').toJSON(), purchases:doc.getMap('purchases').toJSON()}; }
  async execute({operationId, command, deviceSequence}) {
    command=structuredClone(command);
    checkCommand(command);
    const expectedAuthority=await this.authorize();
    if (!operationId || !Number.isSafeInteger(deviceSequence) || deviceSequence < 0) throw new Error('MALFORMED');
    const previous=required(await this.storage.getLocalOperation(this.scope.scopeId,operationId));
    if (previous) {
      const c=previous.commit.commands[0];
      const oldHeader=previous.commit.outbound.length === 1 ? JSON.parse(new TextDecoder().decode(previous.commit.outbound[0].object.bytes)).header : null;
      if (!oldHeader || oldHeader.deviceSequence !== deviceSequence || oldHeader.authorDevice !== this.scope.authorDevice || oldHeader.scopeId !== this.scope.scopeId || oldHeader.documentId !== this.scope.documentId || oldHeader.documentGeneration !== this.scope.documentGeneration || oldHeader.branchHead !== this.scope.branchHead || oldHeader.epochId !== this.scope.epochId || !same(oldHeader.policyHashes,this.scope.policyHashes) || previous.commit.commands.length !== 1 || c.commandId !== command.commandId || c.effectId !== command.effectId || c.documentId !== this.scope.documentId || c.kind !== command.kind || !same(Array.from(c.payload),Array.from(commandBytes(command)))) throw new Error('CONFLICT');
      return {outcome:previous.outcome,replayed:true};
    }
    const {doc,revision}=await this.document();
    doc.setPeerId(this.scope.authorPeers[this.scope.authorDevice]);
    const before=doc.oplogVersion();
    apply(doc,command);
    const snapshot=doc.export({mode:'snapshot'}), update=doc.export({mode:'update',from:before});
    const meta=this.inspectUpdate(update);
    const header={version:1,suiteId:this.scope.suiteId,scopeId:this.scope.scopeId,documentId:this.scope.documentId,documentGeneration:this.scope.documentGeneration,branchHead:this.scope.branchHead,policyHashes:this.scope.policyHashes,epochId:this.scope.epochId,authorDevice:this.scope.authorDevice,deviceSequence,predecessorRefs:meta.predecessors,semanticEffectIds:[command.effectId],payloadKind:'loro-update-v1'};
    const payload=encoder.encode(JSON.stringify({version:1,command,update:Array.from(update)}));
    const object=await this.codec.sealContent(header,payload,this.keyRef);
    const result=await this.storage.commitLocal({scopeId:this.scope.scopeId,operationId,expectedAuthority,documents:[{documentId:this.scope.documentId,bytes:snapshot,expectedRevision:revision}],commands:[{version:1,commandId:command.commandId,effectId:command.effectId,documentId:this.scope.documentId,kind:command.kind,payload:commandBytes(command),dependencyEffectIds:[]}],outbound:[{object,branchHead:this.scope.branchHead,epochId:this.scope.epochId}]});
    // doc is disposable on both paths; every subsequent read reloads durable state.
    return required(result);
  }
  inspectUpdate(update) {
    const meta=this.decodeImportBlobMeta(update,true);
    const starts=meta.partialStartVersionVector.toJSON(), ends=meta.partialEndVersionVector.toJSON();
    let operations=0;
    for (const [peer,end] of ends) operations += end-(starts.get(peer) ?? 0);
    if (meta.mode !== 'update' || meta.changeNum !== 1 || operations !== 1) throw new Error('MALFORMED_UPDATE');
    if (ends.size !== 1) throw new Error('MALFORMED_UPDATE');
    return {peer:[...ends.keys()][0],predecessors:meta.startFrontiers.map(({peer,counter})=>`${peer}:${counter}`).sort()};
  }
  async importItem(item) {
    const expectedAuthority=await this.authorize();
    const applied=required(await this.storage.getInboxApplication(this.scope.scopeId,item.itemId));
    if (applied) return {replayed:true};
    const opened=await this.codec.openContent(item.bytes), h=opened.header, s=this.scope;
    if (opened.object.id !== item.itemId || h.scopeId !== s.scopeId || h.documentId !== s.documentId || h.documentGeneration !== s.documentGeneration || h.branchHead !== s.branchHead || h.epochId !== s.epochId || h.suiteId !== s.suiteId || !same(h.policyHashes,s.policyHashes) || !s.acceptedAuthors.includes(h.authorDevice) || h.payloadKind !== 'loro-update-v1' || h.semanticEffectIds.length !== 1) throw new Error('INVALID_AUTHORITY');
    let payload; try { payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(opened.value)); } catch { throw new Error('MALFORMED_UPDATE'); }
    if (!payload || Object.keys(payload).sort().join(',') !== 'command,update,version' || payload.version !== 1 || !Array.isArray(payload.update) || !payload.update.every(x=>Number.isInteger(x) && x>=0 && x<=255)) throw new Error('MALFORMED_UPDATE');
    checkCommand(payload.command);
    if (payload.command.effectId !== h.semanticEffectIds[0]) throw new Error('MALFORMED_UPDATE');
    const update=Uint8Array.from(payload.update);
    const meta=this.inspectUpdate(update);
    if (meta.peer !== s.authorPeers[h.authorDevice] || !same(meta.predecessors,h.predecessorRefs)) throw new Error('MALFORMED_UPDATE');
    const {doc,revision}=await this.document();
    const before=doc.oplogVersion();
    const status=doc.import(update);
    if (status.pending && status.pending.size) throw new Error('MISSING_DEPENDENCY');
    const changes=doc.exportJsonUpdates(before,undefined,false).changes;
    const op=changes.length === 1 && changes[0].ops.length === 1 ? changes[0].ops[0] : null;
    const command=payload.command, container=command.kind === 'recipe-title' ? 'cid:root-recipe:Map' : 'cid:root-purchases:Map';
    const key=command.kind === 'recipe-title' ? 'title' : command.effectId;
    if (!op || op.container !== container || op.content.type !== 'insert' || op.content.key !== key || op.content.value !== command.value) throw new Error('MALFORMED_UPDATE');
    return required(await this.storage.commitImport({scopeId:s.scopeId,operationId:`import:${item.itemId}`,expectedAuthority,itemId:item.itemId,documents:[{documentId:s.documentId,bytes:doc.export({mode:'snapshot'}),expectedRevision:revision}],effectIds:h.semanticEffectIds}));
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
