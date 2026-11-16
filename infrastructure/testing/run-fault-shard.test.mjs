import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { assignFaultShards } from './run-fault-shard.mjs';

test('assigns every recovery file once and balances measured work', () => {
  const durations = JSON.parse(
    readFileSync('apps/worker/test/recovery/durations.json', 'utf8'),
  );
  const files = readdirSync('apps/worker/test/recovery', { recursive: true })
    .filter((file) => file.endsWith('.resilience.integration.test.ts'))
    .map((file) => 'test/recovery/' + file);
  const shards = assignFaultShards(files, durations, 4);
  assert.deepEqual(shards.flatMap(({ files }) => files).sort(), files.sort());
  const totals = shards.map(({ milliseconds }) => milliseconds);
  assert.ok(Math.max(...totals) - Math.min(...totals) < 15_000);
  const added = assignFaultShards([...files, 'new.test.ts'], durations, 4);
  assert.equal(
    added.flatMap(({ files }) => files).filter((file) => file === 'new.test.ts')
      .length,
    1,
  );
  const sorted = Object.values(durations).sort((a, b) => a - b);
  assert.equal(
    added.reduce((sum, shard) => sum + shard.milliseconds, 0) -
      totals.reduce((a, b) => a + b, 0),
    (sorted[15] + sorted[16]) / 2,
  );
});
