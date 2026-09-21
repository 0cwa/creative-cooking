export async function shareNativeBackup(_json: string): Promise<void> {
  throw new Error('Native backup sharing is unavailable on web.');
}

export async function pickNativeBackup(): Promise<string | null> {
  throw new Error('Native backup picking is unavailable on web.');
}
