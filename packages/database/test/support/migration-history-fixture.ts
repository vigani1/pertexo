import { readFile } from 'node:fs/promises';

const fixtureUrl = new URL(
  '../fixtures/migration-history-v1.json',
  import.meta.url,
);
const migrationNamePattern = /^\d{4}_[a-z0-9_]+\.sql$/u;

export function parseExpectedMigrationHistory(
  candidate: unknown,
): readonly string[] {
  if (
    !Array.isArray(candidate) ||
    !candidate.every(
      (entry): entry is string =>
        typeof entry === 'string' && migrationNamePattern.test(entry),
    )
  )
    throw new TypeError(
      'Migration history fixture must contain valid migration names',
    );
  if (candidate.length === 0)
    throw new TypeError('Migration history fixture must not be empty');
  const unique = new Set(candidate);
  if (unique.size !== candidate.length)
    throw new TypeError(
      'Migration history fixture must not contain duplicates',
    );
  const sorted = [...candidate].sort();
  if (candidate.some((entry, index) => entry !== sorted[index]))
    throw new TypeError('Migration history fixture must be ordered');
  return Object.freeze([...candidate]);
}

export async function expectedMigrationHistoryFrom(
  firstMigration: string,
): Promise<readonly string[]> {
  const candidate: unknown = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const history = parseExpectedMigrationHistory(candidate);
  const firstIndex = history.indexOf(firstMigration);
  if (firstIndex < 0)
    throw new Error(`Migration history fixture is missing ${firstMigration}`);
  return history.slice(firstIndex);
}
