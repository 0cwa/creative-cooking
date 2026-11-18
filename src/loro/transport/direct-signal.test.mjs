import test from 'node:test';
import assert from 'node:assert/strict';
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
