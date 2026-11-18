import { readFileSync, readdirSync } from 'node:fs';
import { assignDurationShards } from './duration-shards.mjs';

export function mockedShards(directory, durations, count) {
  return assignDurationShards(mockedSpecFiles(directory), durations, count);
}

/** The mocked suite's spec files, as `e2e/<path>` below the web app. */
export function mockedSpecFiles(directory) {
  return readdirSync(directory, { recursive: true })
    .filter((file) => file.endsWith('.spec.ts'))
    .map((file) => `e2e/${file}`);
}

export function recordedMockedShards() {
  const durations = JSON.parse(
    readFileSync(new URL('./mocked-durations.json', import.meta.url), 'utf8'),
  );
  return mockedShards(
    new URL('../../apps/web/e2e', import.meta.url),
    durations,
    2,
  );
}

// Playwright treats file arguments as regular expressions; anchor complete paths.
export function mockedFilePatterns(files) {
  return files.map(
    (file) => `${file.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`,
  );
}
