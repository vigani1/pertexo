import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectMigrationHistory } from '../../packages/database/dist/migration-history.js';

try {
  const recorded = JSON.parse(readFileSync(0, 'utf8'));
  if (
    !Array.isArray(recorded) ||
    !recorded.every(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        typeof row.name === 'string' &&
        typeof row.checksum === 'string',
    )
  )
    throw new Error(
      'Recorded migration history must contain names and checksums',
    );
  // Both manifests remain target-image owned, including on pre-baseline rollbacks.
  const directory = fileURLToPath(
    new URL('../../packages/database/migrations/', import.meta.url),
  );
  const { pending } = await inspectMigrationHistory(
    recorded,
    directory,
    directory,
  );
  if (pending.length) process.stdout.write(`${pending.join('\n')}\n`);
} catch (error) {
  const reason =
    error instanceof SyntaxError
      ? 'Recorded migration history is not valid JSON'
      : error instanceof Error
        ? error.message
        : 'Unknown inspection failure';
  process.stderr.write(`Pending migration inspection failed: ${reason}\n`);
  process.exitCode = 1;
}
