import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {NATIVE_GATHERING_STABLE_MS, nativeCurrentDescriptions, nativeGatheredLocalSdp} from '../native/webrtc-descriptions.mjs';
import {cookingDirect} from './cooking-direct.mjs';
import {comparisonCode, directDomain, hex, readSignal, requireNegotiated, signalHash, signSignal, transcriptHash, verifySignal} from './direct-signal.mjs';

const dataSdp = ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', `a=fingerprint:sha-256 ${Array(32).fill('AA').join(':')}`, 'a=ice-ufrag:fixture', 'a=ice-pwd:fixture', ''].join('\r\n');
const offerBody = {version:1, kind:'offer', scopeId:'household', head:'a'.repeat(64), sessionId:'b'.repeat(32), initiator:{deviceId:'a',signingKey:'c'.repeat(64)}, responder:{deviceId:'b',signingKey:'d'.repeat(64)}, sdp:dataSdp};

test('direct signaling signs both endpoints and the original SDP; both current descriptions must match', async () => {
  const signer = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const provider = {
    sign: async (_ref, bytes) => new Uint8Array(await crypto.subtle.sign('Ed25519', signer.privateKey, bytes)),
    verify: (_ref, bytes, signed) => crypto.subtle.verify('Ed25519', signer.publicKey, signed, bytes)
  };
  const offer = await signSignal(provider, offerBody, offerBody.initiator.signingKey);
  const answer = await signSignal(provider, {...offerBody, kind:'answer', sdp:dataSdp.replace('ufrag:fixture', 'ufrag:answer'), offerHash:await signalHash(offer)}, offerBody.responder.signingKey);
  await verifySignal(provider, readSignal(JSON.stringify(offer), 'offer'), offerBody.initiator.signingKey);
  const changed = {...offer, sdp:offer.sdp.replace('ufrag:fixture', 'ufrag:tampered')};
  await assert.rejects(verifySignal(provider, changed, offerBody.initiator.signingKey), /INVALID_SIGNAL_SIGNATURE/);
  assert.notEqual(await signalHash(changed), answer.offerHash);
  assert.notEqual(comparisonCode(await transcriptHash(changed, answer)), comparisonCode(await transcriptHash(offer, answer)));
  assert.throws(() => readSignal(JSON.stringify({...offer, sdp:`${dataSdp}m=audio 9 RTP/AVP 0\r\n`}), 'offer'), /INVALID_SIGNAL/);
  const state = {signalingState:'stable', currentLocalDescription:{type:'offer',sdp:offer.sdp}, currentRemoteDescription:{type:'answer',sdp:answer.sdp}};
  requireNegotiated(state, offer, answer, true);
  assert.throws(() => requireNegotiated({...state,currentLocalDescription:{type:'offer',sdp:changed.sdp}}, offer, answer, true), /NEGOTIATED_SIGNAL_MISMATCH/);
  assert.equal(hex(await provider.sign('sender', directDomain('confirm', offer))).length, 128);
});

test('Android stable descriptions and injected SHA-256 preserve the browser transcript', async () => {
  const offer = offerBody;
  const answer = {...offerBody, kind:'answer', sdp:dataSdp.replace('ufrag:fixture', 'ufrag:native'), offerHash:await signalHash(offer)};
  const nativeSha256 = async bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(await signalHash(offer, nativeSha256), answer.offerHash);
  assert.equal(await transcriptHash(offer, answer, nativeSha256), await transcriptHash(offer, answer));

  const local = {type:'answer',sdp:answer.sdp}, remote = {type:'offer',sdp:offer.sdp};
  const native = {signalingState:'stable',localDescription:local,remoteDescription:remote};
  requireNegotiated(native, offer, answer, false, nativeCurrentDescriptions);
  assert.throws(() => requireNegotiated({...native,signalingState:'have-remote-offer'}, offer, answer, false, nativeCurrentDescriptions), /NEGOTIATED_SIGNAL_MISMATCH/);
  const changed = {...remote, sdp:remote.sdp.replaceAll('\r\n','\n')};
  assert.throws(() => requireNegotiated({...native,remoteDescription:changed}, offer, answer, false, nativeCurrentDescriptions), /NEGOTIATED_SIGNAL_MISMATCH/);
});

test('Android answers wait for progressive late candidates and reject overlapping signaling', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const {scopeId, head, initiator, responder} = offerBody;
  const {promise: gatheringReported, resolve: reportGathering} = Promise.withResolvers();
  const initialAnswer = dataSdp.replace('ufrag:fixture', 'ufrag:native');
  const partialAnswer = initialAnswer.replace('m=application 9', 'm=application 46723') +
    'a=candidate:1 1 udp 2122260223 10.0.2.16 46723 typ host\r\n';
  const finalAnswer = partialAnswer + 'a=candidate:2 1 udp 2122260222 10.0.2.17 46724 typ host\r\n';
  let signed = 0;
  const provider = {verify: async () => true, sign: async () => { signed++; return new Uint8Array(64); }};
  const connection = Object.assign(new EventTarget(), {
    signalingState:'stable', iceGatheringState:'new',
    createDataChannel: () => Object.assign(new EventTarget(), {close() {}}),
    async setRemoteDescription(description) { this.remoteDescription = description; },
    async createOffer() { return {type:'offer',sdp:dataSdp}; },
    async createAnswer() { return {type:'answer',sdp:initialAnswer}; },
    async setLocalDescription(description) {
      this.localDescription = description;
      this.iceGatheringState = 'complete';
      this.dispatchEvent(new Event('icegatheringstatechange'));
      reportGathering();
    },
    close() { this.signalingState = 'closed'; this.dispatchEvent(new Event('signalingstatechange')); }
  });
  const session = cookingDirect({
    runtime: {
      scope:{scopeId,branchHead:head,authorDevice:responder.deviceId,acceptedRecipients:[initiator.deviceId]},
      authorization:async () => ({signingKeyRefs:{[initiator.deviceId]:initiator.signingKey,[responder.deviceId]:responder.signingKey}}),
      storage:{compromise:{isQuarantined:async () => false}}
    },
    provider, assertSelected:async () => {}, withSelected:use => use(),
    createPeerConnection:() => connection,
    readCurrentDescriptions:nativeCurrentDescriptions, readGatheredLocalSdp:nativeGatheredLocalSdp,
    gatheringStableMs:NATIVE_GATHERING_STABLE_MS
  }).connect({notify() {}});
  t.after(() => session.close());

  const response = session.createAnswer(JSON.stringify({...offerBody,signature:'0'.repeat(128)}));
  void response.catch(() => {});
  await gatheringReported;
  await new Promise(setImmediate);
  assert.equal(signed, 0);
  await assert.rejects(session.createOffer(initiator.deviceId), /INVALID_DIRECT_STEP/);
  connection.localDescription = {type:'answer',sdp:partialAnswer};
  connection.dispatchEvent(new Event('icecandidate'));
  t.mock.timers.tick(NATIVE_GATHERING_STABLE_MS - 1);
  await new Promise(setImmediate);
  assert.equal(signed, 0);
  connection.localDescription = {type:'answer',sdp:finalAnswer};
  connection.dispatchEvent(new Event('icecandidate'));
  t.mock.timers.tick(NATIVE_GATHERING_STABLE_MS - 1);
  await new Promise(setImmediate);
  assert.equal(signed, 0);
  t.mock.timers.tick(1);
  const {text,code} = await response;
  assert.equal(readSignal(text, 'answer').sdp, finalAnswer);
  assert.ok(code);
  assert.equal(signed, 1);
  await assert.rejects(session.createOffer(initiator.deviceId), /INVALID_DIRECT_STEP/);
});
