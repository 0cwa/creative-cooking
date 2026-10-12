import { requireNativeModule } from 'expo-modules-core';

// Never import this research-only module from production AppState/UI.
export const nativeAutomerge = requireNativeModule('CreativeCookingAutomergeSpike');
