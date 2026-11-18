/** React Native WebRTC exposes the live local and remote descriptions. Once
 * signaling is stable, neither field contains a pending description. */
export const nativeCurrentDescriptions = connection => [connection.localDescription, connection.remoteDescription];

/** The bridge can publish more candidate snapshots after reporting complete.
 * Let that event burst settle and still compare exact SDP before use. */
export const NATIVE_GATHERING_STABLE_MS = 150;
export function nativeGatheredLocalSdp(connection) {
  const sdp = connection.localDescription?.sdp;
  return sdp && /^a=candidate:/m.test(sdp) ? sdp : undefined;
}
