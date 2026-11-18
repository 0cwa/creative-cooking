import {CHUNK, MAX_FRAME, MAX_OBJECT, MAX_QUEUED_FRAMES, Reassembler, digest, inboxAdapter, objectFrames, sendFrames} from './adapter.mjs';
import {comparisonCode, directDomain, exact, hex, objectId, readSignal, requireNegotiated, signalHash, signSignal, signature, transcriptHash, verifySignal} from './direct-signal.mjs';

const BATCH_SIZE = 8;
const MAX_OBJECTS = 64;
const MAX_MESSAGES = MAX_OBJECTS * (Math.ceil(MAX_OBJECT / CHUNK) + 4);
const IDLE_MS = 5 * 60_000;
const GATHER_MS = 15_000;
const CONNECT_MS = 30_000;
const RESULT_MS = 30_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});
const must = result => { if (!result.ok) throw Error(result.error); return result.value; };
const sameDevice = (a, b) => a.deviceId === b.deviceId && a.signingKey === b.signingKey;
const transferId = () => hex(crypto.getRandomValues(new Uint8Array(16)));

async function gather(connection, description) {
  await connection.setLocalDescription(description);
  if (connection.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timeout);
      connection.removeEventListener('icegatheringstatechange', check);
      connection.removeEventListener('signalingstatechange', check);
      error ? reject(error) : resolve();
    };
    const check = () => {
      if (connection.signalingState === 'closed') finish(Error('CLOSED'));
      else if (connection.iceGatheringState === 'complete') finish();
    };
    const timeout = setTimeout(() => finish(Error('ICE_GATHERING_TIMEOUT')), GATHER_MS);
    connection.addEventListener('icegatheringstatechange', check);
    connection.addEventListener('signalingstatechange', check);
    check();
  });
  return connection.localDescription.sdp;
}

/** Manual signaling for a current, admitted household. Content and receipt
 * traffic stays gated until both signed confirmations cross the final channel. */
export function browserDirect({runtime, provider, cooking, assertSelected, withSelected}) {
  const {scopeId, branchHead: head, authorDevice: localId, acceptedRecipients} = runtime.scope;
  const peers = acceptedRecipients.filter(id => id !== localId);
  async function devicePair(otherId) {
    await assertSelected();
    if (!peers.includes(otherId) || await runtime.storage.compromise.isQuarantined(scopeId, otherId)) throw Error('UNAUTHORIZED_PEER');
    const {signingKeyRefs} = await runtime.authorization();
    const local = {deviceId:localId, signingKey:signingKeyRefs[localId]};
    const peer = {deviceId:otherId, signingKey:signingKeyRefs[otherId]};
    if (![local.signingKey, peer.signingKey].every(objectId) || local.signingKey === peer.signingKey) throw Error('UNAUTHORIZED_PEER');
    return {local, peer};
  }

  function connect({notify, importUpdate}) {
    const connection = new RTCPeerConnection({iceServers:[]});
    const channel = connection.createDataChannel('creative-cooking-v1', {negotiated:true, id:0, ordered:true});
    channel.binaryType = 'arraybuffer';
    let offer, answer, transcript, initiator, local, peer, reassembler, ready = false;
    let confirmed = false, peerConfirmed = false, confirmationSent = false, confirmationSending = false, closed = false;
    let idle, connectionTimeout, waiting, sending = false, queued = 0, queue = Promise.resolve();
    let receivedMessages = 0, receivedObjects = 0, sentObjects = 0;
    const attempts = new Map();
    const appliedHere = new Set(), retainedHere = new Set(), storedByPeer = new Set(), appliedByPeer = new Set();
    const state = {ready:false, closed:false, error:null, receivedApplied:0, receivedRetained:0, peerStored:0, peerApplied:0};
    const publish = () => notify({...state});
    function close(error = null) {
      if (closed) return;
      closed = true;
      ready = false;
      clearTimeout(idle);
      clearTimeout(connectionTimeout);
      waiting?.settle(Error('CLOSED'));
      channel.close();
      connection.close();
      Object.assign(state, {ready:false, closed:true, error});
      publish();
    }
    function touch() {
      clearTimeout(idle);
      idle = setTimeout(() => close('DIRECT_TIMEOUT'), IDLE_MS);
    }
    async function authorize() {
      if (closed) throw Error('CLOSED');
      const current = await devicePair(peer.deviceId);
      if (closed || !sameDevice(current.local, local) || !sameDevice(current.peer, peer)) throw Error('UNAUTHORIZED_PEER');
      requireNegotiated(connection, offer, answer, initiator);
    }
    function checkReady() {
      if (!closed && !ready && confirmed && confirmationSent && peerConfirmed) {
        ready = state.ready = true;
        publish();
      }
    }
    const maximum = () => Math.min(MAX_FRAME, connection.sctp?.maxMessageSize || MAX_FRAME);
    async function control(kind, fields) {
      await sendFrames(channel, [encoder.encode(JSON.stringify({version:1, sessionId:offer.sessionId, kind, ...fields}))], maximum());
    }
    const confirmation = deviceId => ({transcript, deviceId});
    async function sendConfirmation() {
      if (!confirmed || confirmationSent || confirmationSending || channel.readyState !== 'open') return;
      confirmationSending = true;
      try {
        await authorize();
        const signed = await provider.sign(local.signingKey, directDomain('confirm', confirmation(localId)));
        await control('confirm', {signature:hex(signed)});
        confirmationSent = true;
        checkReady();
      } finally { confirmationSending = false; }
    }
    async function completeDescriptions() {
      requireNegotiated(connection, offer, answer, initiator);
      transcript = await transcriptHash(offer, answer);
      reassembler = new Reassembler(offer.sessionId, maximum());
      return comparisonCode(transcript);
    }
    const receiptProvider = {
      sign: claims => provider.sign(local.signingKey, directDomain('receipt', claims)),
      verify: (claims, bytes) => provider.verify(peer.signingKey, directDomain('receipt', claims), bytes)
    };
    const inbox = id => inboxAdapter({storage:runtime.storage, reader:runtime.storage, verifyObject:bytes => cooking.verify(bytes, id, peer.deviceId), receiptProvider, scopeId, source:`direct:${id}`, recipientId:localId, trustHead:head});
    const sendReceipt = ({claims, bytes}) => control('receipt', {claims, signature:hex(bytes)});

    async function receiveObject(object) {
      if (++receivedObjects > MAX_OBJECTS || !objectId(object.streamId)) throw Error('DIRECT_LIMIT');
      await authorize();
      const id = object.streamId, adapter = inbox(id);
      const cursor = must(await runtime.storage.listCursors(scopeId)).find(row => row.source === `direct:${id}`)?.cursor ?? null;
      try {
        const stored = await adapter.stage({transferId:id, bytes:object.bytes, expectedCursor:cursor, cursor:id});
        await authorize();
        await sendReceipt(stored);
      } catch (error) {
        if (!['IO', 'CONFLICT', 'QUOTA'].includes(error.message)) throw error;
        await control('retry', {objectId:id});
        return;
      }
      try { await importUpdate({itemId:id, bytes:object.bytes}, authorize); }
      catch { /* Authenticated ciphertext is retained for a retry. */ }
      await authorize();
      const applied = must(await runtime.storage.getInboxApplication(scopeId, id));
      if (applied) {
        await sendReceipt(await adapter.applied(id, id));
        retainedHere.delete(id);
        appliedHere.add(id);
      } else {
        retainedHere.add(id);
        await control('retained', {objectId:id});
      }
      state.receivedApplied = appliedHere.size;
      state.receivedRetained = retainedHere.size;
      publish();
    }

    async function receive(data) {
      if (closed) return;
      if (++receivedMessages > MAX_MESSAGES || !(data instanceof ArrayBuffer) || data.byteLength > maximum()) throw Error('DIRECT_LIMIT');
      const raw = new Uint8Array(data), message = JSON.parse(decoder.decode(raw));
      if (message?.version !== 1 || message.sessionId !== offer?.sessionId) throw Error('INVALID_DIRECT_FRAME');
      if (message.kind === 'confirm') {
        const bytes = signature(message.signature);
        if (!transcript || !exact(message, ['version','sessionId','kind','signature']) || !bytes) throw Error('INVALID_CONFIRMATION');
        await authorize();
        if (!await provider.verify(peer.signingKey, directDomain('confirm', confirmation(peer.deviceId)), bytes)) throw Error('INVALID_CONFIRMATION');
        peerConfirmed = true;
        checkReady();
        return;
      }
      if (!ready) throw Error('DIRECT_CONFIRMATION_REQUIRED');
      if (message.kind === 'objectChunk') {
        const object = await reassembler.accept(raw);
        if (object) await withSelected(() => receiveObject(object));
        return;
      }
      if (['retry', 'retained'].includes(message.kind)) {
        if (!exact(message, ['version','sessionId','kind','objectId']) || !waiting || message.objectId !== waiting.id ||
          (message.kind === 'retained') !== waiting.stored) throw Error('INVALID_DIRECT_FRAME');
        waiting.settle(null, message.kind);
        return;
      }
      const {claims} = message, bytes = signature(message.signature);
      if (message.kind !== 'receipt' || !exact(message, ['version','sessionId','kind','claims','signature']) || !bytes || !waiting ||
        claims?.objectId !== waiting.id || claims.transferId !== waiting.id || (claims.state === 'applied') !== waiting.stored) throw Error('INVALID_RECEIPT');
      await authorize();
      const receiptId = await digest(directDomain('receipt-id', claims));
      await inbox(waiting.id).acceptReceipt({claims, bytes, receiptId, expectedRecipient:peer.deviceId});
      if (claims.state === 'stored') {
        waiting.stored = true;
        storedByPeer.add(claims.objectId);
        state.peerStored = storedByPeer.size;
      } else {
        appliedByPeer.add(claims.objectId);
        state.peerApplied = appliedByPeer.size;
        waiting.settle(null, 'applied');
      }
      publish();
    }
    function waitResult(id) {
      let timeout;
      const promise = new Promise((resolve, reject) => {
        waiting = {id, stored:false, settle(error, result) {
          clearTimeout(timeout);
          waiting = null;
          error ? reject(error) : resolve(result);
        }};
        timeout = setTimeout(() => waiting?.settle(Error('DIRECT_RESULT_TIMEOUT')), RESULT_MS);
      });
      void promise.catch(() => {});
      return promise;
    }
    channel.addEventListener('message', event => {
      if (closed) return;
      if (queued >= MAX_QUEUED_FRAMES) { close('DIRECT_LIMIT'); return; }
      touch();
      queued++;
      queue = queue.then(() => receive(event.data)).catch(error => close(error.message)).finally(() => { queued--; });
    });
    channel.addEventListener('open', () => {
      clearTimeout(connectionTimeout);
      void sendConfirmation().catch(error => close(error.message));
    });
    channel.addEventListener('close', () => close('DIRECT_CLOSED'));
    channel.addEventListener('error', () => close('DIRECT_CONNECTION_FAILED'));
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed') close('DIRECT_CONNECTION_FAILED');
    });
    touch();

    return {
      close,
      async createOffer(otherId) {
        ({local, peer} = await devicePair(otherId));
        initiator = true;
        const sdp = await gather(connection, await connection.createOffer());
        offer = await signSignal(provider, {version:1, kind:'offer', scopeId, head, sessionId:transferId(), initiator:local, responder:peer, sdp}, local.signingKey);
        return JSON.stringify(offer);
      },
      async createAnswer(text) {
        const incoming = readSignal(text, 'offer');
        if (incoming.scopeId !== scopeId || incoming.head !== head || incoming.responder.deviceId !== localId) throw Error('DIRECT_HOUSEHOLD_MISMATCH');
        ({local, peer} = await devicePair(incoming.initiator.deviceId));
        if (!sameDevice(incoming.initiator, peer) || !sameDevice(incoming.responder, local)) throw Error('UNAUTHORIZED_PEER');
        await verifySignal(provider, incoming, peer.signingKey);
        offer = incoming;
        initiator = false;
        await connection.setRemoteDescription({type:'offer', sdp:offer.sdp});
        const sdp = await gather(connection, await connection.createAnswer());
        const {signature: _offerSignature, ...fields} = offer;
        answer = await signSignal(provider, {...fields, kind:'answer', sdp, offerHash:await signalHash(offer)}, local.signingKey);
        return {text:JSON.stringify(answer), code:await completeDescriptions()};
      },
      async acceptAnswer(text) {
        if (!offer || !initiator || answer) throw Error('INVALID_DIRECT_STEP');
        const incoming = readSignal(text, 'answer');
        if (incoming.scopeId !== scopeId || incoming.head !== head || incoming.sessionId !== offer.sessionId ||
          incoming.offerHash !== await signalHash(offer) || !sameDevice(incoming.initiator, local) || !sameDevice(incoming.responder, peer)) throw Error('DIRECT_HOUSEHOLD_MISMATCH');
        await devicePair(peer.deviceId);
        await verifySignal(provider, incoming, peer.signingKey);
        await connection.setRemoteDescription({type:'answer', sdp:incoming.sdp});
        answer = incoming;
        return completeDescriptions();
      },
      async confirm(value) {
        if (!transcript || value.trim().toUpperCase() !== comparisonCode(transcript)) throw Error('DIRECT_CODE_MISMATCH');
        await authorize();
        confirmed = true;
        touch();
        if (channel.readyState !== 'open') connectionTimeout = setTimeout(() => close('DIRECT_CONNECTION_FAILED'), CONNECT_MS);
        await sendConfirmation();
      },
      async send() {
        if (!ready || sending) throw Error('DIRECT_CONFIRMATION_REQUIRED');
        sending = true;
        try {
          await authorize();
          if (sentObjects >= MAX_OBJECTS) throw Error('DIRECT_LIMIT');
          const {objects, more} = await cooking.directBatch(peer.deviceId, Math.min(BATCH_SIZE, MAX_OBJECTS - sentObjects), attempts);
          let retry = 0;
          for (const {objectId:id, bytes} of objects) {
            touch();
            sentObjects++;
            attempts.set(id, (attempts.get(id) ?? 0) + 1);
            const {result} = await withSelected(async () => {
              await authorize();
              const frames = await objectFrames({sessionId:offer.sessionId, streamId:id, transferId:transferId(), bytes});
              const result = waitResult(id);
              await sendFrames(channel, frames, maximum());
              return {result};
            });
            if (await result !== 'applied') retry++;
          }
          return {sent:objects.length, retry, more};
        } catch (error) {
          close(error.message);
          throw error;
        } finally { sending = false; }
      }
    };
  }
  return {peers, connect};
}
