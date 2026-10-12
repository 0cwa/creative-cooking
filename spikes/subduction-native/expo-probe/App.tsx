// This app has no production state, backup, secrets or screens.
import React, { useEffect, useState } from 'react';
import { SafeAreaView, Text } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';
const bridge = requireNativeModule('CcSubductionModule');
export default function App() {
  const [status, setStatus] = useState('Native Subduction probe starting');
  useEffect(() => {
    // The actual Rust handshake and networking execute in the mobile app process.
    // Request/result JSON in this app's Documents directory is injected only by CI.
    bridge.runRequest().then((result: string) => {
      const message = JSON.parse(result);
      setStatus(message.status + ': ' + (message.phase || message.error || 'no phase'));
      console.log('CC_SUBDUCTION_MOBILE_RESULT=' + result);
    }).catch((error: Error) => {
      console.error('CC_SUBDUCTION_MOBILE_BRIDGE_FAILURE=' + String(error));
      setStatus('Bridge failure: ' + String(error));
    });
  }, []);
  return <SafeAreaView><Text accessibilityLabel="native-subduction-status">{status}</Text></SafeAreaView>;
}
