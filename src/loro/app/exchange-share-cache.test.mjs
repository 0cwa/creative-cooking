import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pruneExchangeShares } from './exchange-share-cache.mjs';

const now = 100_000;
const share = (id, completedAt) => directory(
  `cooking-share-01234567-0123-0123-0123-${String(id).padStart(12, '0')}`, completedAt
);
const completionTime = entry => entry.completedAt;
function directory(name, completedAt) {
  return {
    name, completedAt, modificationTime: 0, deleted: false,
    delete() { this.deleted = true; }
  };
}

test('expired exchange copies are pruned while fresh shares and other cache entries survive', () => {
  const expired = share(0, now - 60_000);
  const fresh = share(1, now - 59_999);
  const unconfirmed = share(2, null);
  const missingTime = share(3, 0);
  const unrelated = directory('cooking-share-manual-backup', 0);
  pruneExchangeShares([expired, fresh, unconfirmed, missingTime, unrelated], now, completionTime);
  assert.equal(expired.deleted, true);
  assert.equal(fresh.deleted, false);
  assert.equal(unconfirmed.deleted, false);
  assert.equal(missingTime.deleted, false);
  assert.equal(unrelated.deleted, false);
});

test('a full cache defers a new share instead of deleting a recent copy', () => {
  const pending = share(0, null);
  const fresh = Array.from({ length: 7 }, (_, id) => share(id + 1, now));
  const entries = [pending, ...fresh];
  assert.throws(() => pruneExchangeShares(entries, now, completionTime), /share cache is full/);
  assert.ok(entries.every(entry => !entry.deleted));
  assert.doesNotThrow(() => pruneExchangeShares(entries, now + 60_000, completionTime));
  assert.ok(fresh.every(entry => entry.deleted));
  assert.equal(pending.deleted, false);
});
