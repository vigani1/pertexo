import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { expectedMigrationsAfter } from '../../../src/testing/expected-migrations.js';

it('includes a newly journaled migration in the remaining upgrade inventory', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'pertexo-migration-inventory-'),
  );
  try {
    await mkdir(join(directory, 'meta'));
    const entries = [
      { tag: '0041_existing_upgrade' },
      { tag: '0039_previous_release' },
      { tag: '0040_first_upgrade' },
    ];
    const save = () =>
      writeFile(
        join(directory, 'meta', '_journal.json'),
        JSON.stringify({ entries }),
      );
    await save();
    expect(await expectedMigrationsAfter(39, directory)).toEqual([
      '0040_first_upgrade.sql',
      '0041_existing_upgrade.sql',
    ]);
    entries.push({ tag: '0042_next_release' });
    await save();
    expect(await expectedMigrationsAfter(39, directory)).toEqual([
      '0040_first_upgrade.sql',
      '0041_existing_upgrade.sql',
      '0042_next_release.sql',
    ]);
    expect(await expectedMigrationsAfter(41, directory)).toEqual([
      '0042_next_release.sql',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
