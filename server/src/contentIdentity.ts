const STORAGE_ID_PREFIX = 'cc1';

export function contentStorageId(
  table: string,
  spaceId: string,
  parentEntityId: string | null,
  entityId: string,
): string {
  const parentToken = parentEntityId === null ? 'n' : `s${encodeURIComponent(parentEntityId)}`;
  return `${STORAGE_ID_PREFIX}:${table}:${spaceId.toLowerCase()}:${parentToken}:s${encodeURIComponent(entityId)}`;
}
