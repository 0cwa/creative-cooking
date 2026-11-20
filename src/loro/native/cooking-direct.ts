import {RTCPeerConnection} from 'react-native-webrtc';
import {cookingDirect} from '../transport/cooking-direct.mjs';
import {NATIVE_GATHERING_STABLE_MS, nativeCurrentDescriptions, nativeGatheredLocalSdp} from './webrtc-descriptions.mjs';
import {sha256} from './sha256.native';
import sodium from './sodium';

type Options = {
  runtime: any; provider: any; cooking: any;
  assertSelected: () => Promise<void>;
  withSelected: <T>(use: () => Promise<T>) => Promise<T>;
};

export const openNativeCookingDirect = (options: Options) => cookingDirect({
  ...options,
  createPeerConnection: config => new RTCPeerConnection(config),
  readCurrentDescriptions: nativeCurrentDescriptions,
  readGatheredLocalSdp: nativeGatheredLocalSdp,
  gatheringStableMs: NATIVE_GATHERING_STABLE_MS,
  sha256,
  randomBytes: size => sodium.randombytes_buf(size),
});
