import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

try {
  const recorded = JSON.parse(readFileSync(0, 'utf8'));
  if (
    !Array.isArray(recorded) ||
    !recorded.every((name) => typeof name === 'string')
  )
    throw new Error('Recorded migration history must be an array of names');
  const applied = new Set(recorded);
  // This file is mounted into the selected image; its migration directory stays image-owned.
  const names = await readdir(
    new URL('../../packages/database/migrations/', import.meta.url),
  );
  const pending = names
    .filter((name) => name.endsWith('.sql') && !applied.has(name))
    .sort();
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
