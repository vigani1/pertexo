import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Receipt = Readonly<{ name: string; checksum: string }>;

export class PartialMigrationHistoryError extends Error {
  public override readonly name = 'PartialMigrationHistoryError';
  public constructor() {
    super(
      'Partial pre-baseline migration history: upgrade to the last pre-baseline release v0.2.0 first, then upgrade again',
    );
  }
}

/** The migrator and operator gate use the same decision without rewriting receipts. */
export async function inspectMigrationHistory(
  rows: readonly Receipt[],
  directory: string,
  historyDirectory = fileURLToPath(new URL('../migrations/', import.meta.url)),
): Promise<{
  applied: Map<string, string>;
  pending: readonly string[];
  adoption: Receipt | undefined;
}> {
  const names = await migrationNames(directory);
  const manifest = new Map(
    await Promise.all(
      names.map(
        async (name) =>
          [
            name,
            createHash('sha256')
              .update(await readFile(path.join(directory, name), 'utf8'))
              .digest('hex'),
          ] as const,
      ),
    ),
  );
  // Older pre-baseline images have no adoption manifest and cannot adopt a newer baseline.
  let history: Receipt[] = [];
  try {
    history = JSON.parse(
      await readFile(
        path.join(historyDirectory, 'pre-baseline-history.json'),
        'utf8',
      ),
    ) as Receipt[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const historical = new Map(history.map((row) => [row.name, row.checksum]));
  const baseline = '0000_baseline.sql';
  const checksum = manifest.get(baseline);
  const legacyBaseline = rows.some(
    (row) =>
      row.name === baseline &&
      row.checksum === historical.get(baseline) &&
      row.checksum !== checksum,
  );
  let adoption: Receipt | undefined;
  let applied = new Map(rows.map((row) => [row.name, row.checksum]));
  if (legacyBaseline || rows.some((row) => !manifest.has(row.name))) {
    for (const row of rows) {
      const expected = historical.get(row.name);
      if (expected === undefined)
        throw new Error(`Unknown applied migration: ${row.name}`);
      if (expected !== row.checksum)
        throw new Error(`Applied migration checksum changed: ${row.name}`);
    }
    if (
      rows.length !== history.length ||
      new Set(rows.map((row) => row.name)).size !== history.length
    )
      throw new PartialMigrationHistoryError();
    if (checksum === undefined)
      throw new Error('Baseline migration is missing');
    adoption = { name: baseline, checksum };
    applied = new Map([[baseline, checksum]]);
  }
  for (const [name, value] of applied) {
    if (value !== manifest.get(name))
      throw new Error(`Applied migration checksum changed: ${name}`);
  }
  return {
    applied,
    adoption,
    pending: names.filter(
      (name) =>
        !applied.has(name) || (adoption !== undefined && name === baseline),
    ),
  };
}

export async function migrationNames(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
}
