import { useRef, type PropsWithChildren } from 'react';
import { useAppState } from '@/state/AppState';
import { KitchenStartupStatus } from './KitchenStartupStatus';

/** Keep navigation and boot tasks unmounted until real saved content is ready. */
export function KitchenContentGate({ children }: PropsWithChildren) {
  const { hydrated, storageError, retryStorage } = useAppState();
  const retrying = useRef(false);

  if (hydrated) return children;

  const retry = async () => {
    if (retrying.current) return;
    retrying.current = true;
    try {
      await retryStorage();
    } finally {
      retrying.current = false;
    }
  };

  return <KitchenStartupStatus
    error={storageError}
    errorTitle="Your kitchen could not finish opening"
    loadingDetail="Loading your pantry, recipes, and preferences from this device."
    onRetry={storageError ? () => void retry() : undefined}
  />;
}
