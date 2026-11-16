import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { recordedWebUnitShards } from './web-unit-shards.mjs';

test('full unit shards run every discovered test exactly once and balance recorded work', () => {
  const shards = recordedWebUnitShards();
  const expected = readdirSync('apps/web/test', { recursive: true })
    .filter((file) => /\.test\.tsx?$/u.test(file))
    .map((file) => `test/${file}`);
  assert.deepEqual(
    shards.flatMap(({ files }) => files).sort(),
    expected.sort(),
  );
  assert.ok(Math.abs(shards[0].milliseconds - shards[1].milliseconds) < 1000);
});
