import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import { recordedMockedShards, mockedShards } from './mocked-shards.mjs';

test('discovers every mocked spec once, including a new unrecorded spec', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-mocked-shards-'));
  try {
    for (const name of [
      'slow.spec.ts',
      'fast.spec.ts',
      'new.spec.ts',
      'support.ts',
    ])
      writeFileSync(join(directory, name), '');
    const shards = mockedShards(
      directory,
      { 'e2e/slow.spec.ts': 30, 'e2e/fast.spec.ts': 10 },
      2,
    );
    assert.deepEqual(shards.flatMap(({ files }) => files).sort(), [
      'e2e/fast.spec.ts',
      'e2e/new.spec.ts',
      'e2e/slow.spec.ts',
    ]);
    assert.deepEqual(
      shards.map(({ milliseconds }) => milliseconds),
      [30, 30],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('recorded mocked shards cover the disk inventory once with balanced cost', () => {
  const shards = recordedMockedShards();
  const files = readdirSync('apps/web/e2e', { recursive: true })
    .filter((file) => file.endsWith('.spec.ts'))
    .map((file) => `e2e/${file}`);
  assert.deepEqual(shards.flatMap(({ files }) => files).sort(), files.sort());
  const totals = shards.map(({ milliseconds }) => milliseconds);
  assert.ok(Math.abs(totals[0] - totals[1]) < 1000, totals.join(', '));
});
