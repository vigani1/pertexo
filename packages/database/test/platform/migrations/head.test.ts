import { readdir } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../../../src/platform/readiness.js';

it('expects the newest migration as the database head', async () => {
  const migrations = (
    await readdir(new URL('../../../migrations/', import.meta.url))
  ).filter((name) => name.endsWith('.sql'));
  expect(EXPECTED_MIGRATION_HEAD).toBe(migrations.sort().at(-1));
});
