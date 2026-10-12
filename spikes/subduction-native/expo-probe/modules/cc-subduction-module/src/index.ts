import { requireNativeModule } from 'expo-modules-core';
type Probe = { runRequest(): Promise<string> };
export default requireNativeModule<Probe>('CcSubductionModule');
