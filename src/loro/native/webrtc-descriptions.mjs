/** React Native WebRTC exposes the live local and remote descriptions. Once
 * signaling is stable, neither field contains a pending description. */
export const nativeCurrentDescriptions = connection => [connection.localDescription, connection.remoteDescription];

/** The Android bridge can report completed gathering before the candidate
 * callbacks publish the updated SDP. Wait for a candidate-bearing snapshot. */
export function nativeGatheredLocalSdp(connection) {
  const sdp = connection.localDescription?.sdp;
  return sdp && /^a=candidate:/m.test(sdp) ? sdp : undefined;
}
