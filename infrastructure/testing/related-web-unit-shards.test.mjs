import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relatedWebUnitShardCount } from './related-web-unit-shards.mjs';

test('a small changed test keeps one job and broad app imports split in two', () => {
  assert.equal(relatedWebUnitShardCount(['test/lib/clock.test.ts']), 1);
  assert.equal(
    relatedWebUnitShardCount(['src/features/usage/model/usage-search.ts']),
    2,
  );
  assert.equal(relatedWebUnitShardCount(['src/lib/class-names.ts']), 2);
});
