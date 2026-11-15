import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContentOutboxDrain } from './outboxDrain.ts';

test('a content flush arriving during the prior drain runs after that drain completes', async () => {
  let releaseFirstRead;
  let announceFirstRead;
  const firstReadStarted = new Promise((resolve) => { announceFirstRead = resolve; });
  let pendingReads = 0;
  const drain = createContentOutboxDrain(async () => {
    pendingReads += 1;
    if (pendingReads === 1) {
      announceFirstRead();
      await new Promise((resolve) => { releaseFirstRead = resolve; });
    }
  });

  const first = drain();
  await firstReadStarted;
  const second = drain();
  releaseFirstRead();
  await Promise.all([first, second]);

  assert.equal(pendingReads, 2, 'the later flush performs a fresh outbox read after the active drain');
});
