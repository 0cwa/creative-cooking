import { PowerSyncDatabase } from '@powersync/react-native';
import type { CommonPowerSyncDatabase } from '@powersync/common';
import { AppSchema } from './powerSyncSchema';

const databases = new Map<string, Promise<CommonPowerSyncDatabase>>();

function databaseName(profileId: string): string {
  const safe = profileId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48) || 'profile';
  let hash = 2166136261;
  for (let index = 0; index < profileId.length; index += 1) {
    hash ^= profileId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `creative-cooking-${safe}-${(hash >>> 0).toString(36)}.db`;
}

export function getContentDatabase(profileId: string): Promise<CommonPowerSyncDatabase> {
  let database = databases.get(profileId);
  if (!database) {
    const instance = new PowerSyncDatabase({
      schema: AppSchema,
      database: { dbFilename: databaseName(profileId) }
    });
    database = instance.waitForReady().then(() => instance);
    databases.set(profileId, database);
    void database.catch(() => databases.delete(profileId));
  }
  return database;
}
