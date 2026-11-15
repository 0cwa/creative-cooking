export type WorkspaceRecoveryFailure = 'save' | 'archive';

/** Hide the departing account first, attempt both recovery writes, then activate the next scope. */
export async function recoverAndActivateWorkspace<T>(input: {
  hidePreviousAccount(): void;
  persistPrevious?: () => Promise<void>;
  archivePrevious?: () => Promise<void>;
  activateNext(failures: WorkspaceRecoveryFailure[]): Promise<T>;
}): Promise<{ value: T; failures: WorkspaceRecoveryFailure[] }> {
  input.hidePreviousAccount();
  const failures: WorkspaceRecoveryFailure[] = [];
  if (input.persistPrevious) {
    try {
      await input.persistPrevious();
    } catch {
      failures.push('save');
    }
  }
  if (input.archivePrevious) {
    try {
      await input.archivePrevious();
    } catch {
      failures.push('archive');
    }
  }
  return { value: await input.activateNext(failures), failures };
}
