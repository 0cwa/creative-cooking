/** The server accepts bounded immutable ID snapshots for purchase history. */
export function validateHistorySnapshotIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 200) {
    throw new Error(`A shopping purchase has invalid ${field}; the workspace accepts at most 200 snapshot IDs.`);
  }
  if (value.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)) {
    throw new Error(`A shopping purchase has invalid ${field}; each snapshot ID must contain 1 to 200 characters.`);
  }
  // Keep duplicates and order. These arrays record what the purchase referred
  // to at that time; current rows can be missing or removed.
  return [...value];
}
