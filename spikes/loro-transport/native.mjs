// Inject react-native-webrtc's RTCPeerConnection; no native runtime is bundled here.
export function createNativePeer(RTCPeerConnection, onChannel) {
  const peer = new RTCPeerConnection({iceServers: []});
  peer.ondatachannel = event => onChannel(event.channel);
  return peer;
}
// Native bindings differ in binary DataChannel support: verify before using send().
