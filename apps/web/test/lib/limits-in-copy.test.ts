import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

// Limits and retention periods the browser states come from their owners
// (DATA_RETENTION_DAYS, WEBHOOK_TEST_CAPTURE_SECONDS, WAIT_MAXIMUM_SECONDS,
// STORED_EXECUTION_VALUE_LIMITS, WORKFLOW_PORTABILITY_LIMITS,
// FOLDER_GRANT_LIMIT, PUBLICATION_REVIEW_TEXT_MAX_LENGTH), so copy can't
// drift from what the server does. These phrases were each written by hand
// once and drifted; this keeps them from coming back.
const WRITTEN_LIMITS = [
  /keeps? (?:run|test) data for \d+ days/u,
  /(?:expires?|stays?) (?:after|for) (?:\d+|seven|thirty) days/u,
  /keeps a run’s input for/u,
  /for two minutes/u,
  /over 256 KB/u,
  /up to 2 MB/u,
  /larger than 2 MB/u,
  /up to 30 days/iu,
  /1,000 characters/u,
  /MAX_ENTRIES = 100/u,
];

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/u.test(name) ? [path] : [];
  });
}

it('states limits through their owners, not as written numbers', () => {
  const root = join(import.meta.dirname, '../../src');
  const found = sources(root).flatMap((path) => {
    const text = readFileSync(path, 'utf8');
    return WRITTEN_LIMITS.filter((phrase) => phrase.test(text)).map(
      (phrase) => `${relative(root, path)}: ${String(phrase)}`,
    );
  });
  expect(found).toEqual([]);
});
