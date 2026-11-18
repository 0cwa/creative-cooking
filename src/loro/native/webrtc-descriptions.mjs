/** React Native WebRTC exposes the live local and remote descriptions. Once
 * signaling is stable, neither field contains a pending description. */
export const nativeCurrentDescriptions = connection => [connection.localDescription, connection.remoteDescription];
