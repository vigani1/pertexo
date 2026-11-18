import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fileStatus, parseShard, pickShard } from './lane-run.mjs';

test('shards split the files so each lands in exactly one', () => {
  const files = ['e', 'a', 'd', 'c', 'b'];
  const shards = [1, 2, 3].map((index) =>
    pickShard(files, { index, total: 3 }),
  );
  assert.deepEqual(shards, [['a', 'd'], ['b', 'e'], ['c']]);
});

test('reads a shard as i/n and refuses one outside 1..n', () => {
  assert.deepEqual(parseShard('2/3'), { index: 2, total: 3 });
  for (const text of ['0/3', '4/3', '3', 'a/b'])
    assert.throws(() => parseShard(text), /--shard/);
});

test('a file passes only with a passing test and no failure', () => {
  const counts = (passed, failed, skipped) => ({ passed, failed, skipped });
  assert.equal(fileStatus(0, counts(2, 0, 1)), 'passed');
  assert.equal(fileStatus(0, counts(0, 0, 3)), 'skipped');
  assert.equal(fileStatus(1, counts(2, 0, 0)), 'failed');
  assert.equal(fileStatus(0, counts(2, 1, 0)), 'failed');
});
