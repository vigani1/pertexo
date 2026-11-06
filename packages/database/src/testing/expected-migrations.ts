import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MIGRATIONS_DIRECTORY } from '../migrations.js';

const journalSchema = z.object({
  entries: z.array(z.object({ tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/u) })),
});

/** Upgrade assertions follow the journal so adding a migration cannot leave a stale inventory. */
export async function expectedMigrationsAfter(
  lastApplied: number,
  directory = MIGRATIONS_DIRECTORY,
): Promise<readonly string[]> {
  const journal = journalSchema.parse(
    JSON.parse(
      await readFile(join(directory, 'meta', '_journal.json'), 'utf8'),
    ),
  );
  return journal.entries
    .filter(({ tag }) => Number(tag.slice(0, 4)) > lastApplied)
    .map(({ tag }) => `${tag}.sql`)
    .sort();
}
