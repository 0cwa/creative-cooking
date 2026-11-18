import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pruneExchangeShares } from './exchange-share-cache.mjs';

const now = 100_000;
const share = (id, modificationTime) => directory(
  `cooking-share-01234567-0123-0123-0123-${String(id).padStart(12, '0')}`, modificationTime
);
function directory(name, modificationTime) {
  return {
    name, deleted: false,
    info: () => ({ modificationTime }),
    delete() { this.deleted = true; }
  };
}

test('expired exchange copies are pruned while fresh shares and other cache entries survive', () => {
  const expired = share(0, now - 60_000);
  const fresh = share(1, now - 59_999);
  const unrelated = directory('cooking-share-manual-backup', 0);
  pruneExchangeShares([expired, fresh, unrelated], now);
  assert.equal(expired.deleted, true);
  assert.equal(fresh.deleted, false);
  assert.equal(unrelated.deleted, false);
});

test('a full cache defers a new share instead of deleting a recent copy', () => {
  const fresh = Array.from({ length: 8 }, (_, id) => share(id, now));
  assert.throws(() => pruneExchangeShares(fresh, now), /Try again in a minute/);
  assert.ok(fresh.every(entry => !entry.deleted));
  assert.doesNotThrow(() => pruneExchangeShares(fresh, now + 60_000));
  assert.ok(fresh.every(entry => entry.deleted));
});
