import { readFile } from 'node:fs/promises';

const fixtureUrl = new URL(
  '../fixtures/migration-history-v1.json',
  import.meta.url,
);

export async function expectedMigrationHistoryFrom(
  firstMigration: string,
): Promise<readonly string[]> {
  const candidate: unknown = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  if (
    !Array.isArray(candidate) ||
    !candidate.every((entry): entry is string => typeof entry === 'string')
  )
    throw new TypeError('Migration history fixture must be a string array');
  const firstIndex = candidate.indexOf(firstMigration);
  if (firstIndex < 0)
    throw new Error(`Migration history fixture is missing ${firstMigration}`);
  return candidate.slice(firstIndex);
}
