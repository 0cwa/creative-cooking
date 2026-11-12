/** Serialize outbox drains while ensuring later callers get a fresh pass. */
export function createContentOutboxDrain(drain: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | null = null;
  const flush = (): Promise<void> => {
    if (active) return active.then(flush);
    const run = drain().finally(() => {
      if (active === run) active = null;
    });
    active = run;
    return run;
  };
  return flush;
}
