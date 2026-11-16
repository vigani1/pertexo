import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignDurationShards } from './duration-shards.mjs';

test('new work runs once with the median recorded cost', () => {
  const shards = assignDurationShards(['a', 'b', 'new'], { a: 10, b: 30 }, 2);
  assert.deepEqual(shards.flatMap(({ files }) => files).sort(), [
    'a',
    'b',
    'new',
  ]);
  assert.deepEqual(
    shards.map(({ milliseconds }) => milliseconds),
    [30, 30],
  );
});
