import {Button,Platform} from 'react-native';
import {KitchenStartupStatus} from '@/components/KitchenStartupStatus';
import {SetupDisclosure,SetupPanel} from '@/components/SetupScreen';
import {RecoveryStart} from './RecoveryStart';
export function LockedWorkspace({error,onRetry,onOriginal}:{error:string|null;onRetry:()=>void;onOriginal?:()=>void}){
 return <KitchenStartupStatus error={error??'Could not open saved kitchen'} onRetry={onRetry}>
  {onOriginal?<Button title="Return to original local household" onPress={onOriginal}/>:null}
  {Platform.OS==='web'?<SetupDisclosure title="Recover an existing kitchen" preserveContent>
   <SetupPanel><RecoveryStart/></SetupPanel>
  </SetupDisclosure>:null}
 </KitchenStartupStatus>;
}
