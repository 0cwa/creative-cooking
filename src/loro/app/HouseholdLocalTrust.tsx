import {useContext,useState} from 'react';
import {View} from 'react-native';
import {Pressable,Text} from '@/theme/primitives';
import {LoroWorkspaceValue} from './WorkspaceStatus';
import type {householdLocalTrust} from './household-local-trust.mjs';

type Device = Awaited<ReturnType<ReturnType<typeof householdLocalTrust>['list']>>[number];

export function HouseholdLocalTrust({onQuarantine}:{onQuarantine:()=>void}) {
  const workspace = useContext(LoroWorkspaceValue);
  const [open,setOpen] = useState(false), [busy,setBusy] = useState(false);
  const [devices,setDevices] = useState<Device[]>([]);
  const [target,setTarget] = useState<Device|null>(null);
  const [status,setStatus] = useState('');

  function run(use:()=>Promise<void>) {
    setBusy(true);
    setStatus('');
    void use().catch(() => {
      setDevices([]);
      setTarget(null);
      setStatus('Could not verify the current household devices. Refresh the list and review the device again.');
    }).finally(() => setBusy(false));
  }
  function refresh() {
    setTarget(null);
    run(async () => setDevices(await workspace.householdLocalTrust.list()));
  }
  function confirm(device:Device) {
    run(async () => {
      await workspace.householdLocalTrust.quarantine({deviceId:device.deviceId,confirmation:device.confirmation,explicit:true});
      setTarget(null);
      onQuarantine();
      setDevices(previous => previous.map(row => row.deviceId === device.deviceId ? {...row,quarantined:true} : row));
      setStatus('Device quarantined on this device.');
    });
  }
  return <View style={{gap:6}}>
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => {
      setOpen(!open);
      if (!open) refresh();
      else setTarget(null);
    }}>
      <Text>{open ? 'Close household devices' : 'Review household devices'}</Text>
    </Pressable>
    {open && <>
      <Text>Quarantine blocks incoming cooking updates from a device on this installation. You can keep editing and previously saved work stays. Household revocation and sharing permissions are separate decisions.</Text>
      <Pressable accessibilityRole="button" disabled={busy} onPress={refresh}><Text>Refresh household devices</Text></Pressable>
      {devices.map(device => <View key={device.deviceId} accessibilityLabel={`Household device ${device.deviceId}`}>
        <Text selectable>{device.deviceId}</Text>
        <Text>{device.local ? 'This device' : device.quarantined ? 'Quarantined on this device' : 'Verified household device'}</Text>
        {!device.local && !device.quarantined && <Pressable accessibilityRole="button" disabled={busy} onPress={() => {
          setStatus('');
          setTarget(device);
        }}>
          <Text>Review local quarantine for {device.deviceId}</Text>
        </Pressable>}
      </View>)}
      {target && <View style={{gap:6}}>
        <Text selectable>Block incoming cooking updates from {target.deviceId} on this device?</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => confirm(target)}><Text>Quarantine on this device</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => setTarget(null)}><Text>Cancel local quarantine</Text></Pressable>
      </View>}
      {!!status && <Text accessibilityRole="alert">{status}</Text>}
    </>}
  </View>;
}
