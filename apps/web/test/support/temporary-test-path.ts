import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { test as base } from '@playwright/test';

const directories = new Map<string, string>();

// An auto fixture outlives afterEach diagnostics too; hook registration order
// must not let a late screenshot recreate a directory after it was removed.
export const test = base.extend<{ temporaryFiles: undefined }>({
  temporaryFiles: [
    // Playwright requires destructuring even when a fixture has no dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, runWithFiles, info) => {
      try {
        await runWithFiles(undefined);
      } finally {
        const directory = directories.get(info.testId);
        if (directory !== undefined) {
          rmSync(directory, { recursive: true, force: true });
          directories.delete(info.testId);
        }
      }
    },
    { auto: true },
  ],
});

export function temporaryTestPath(name: string): string {
  const id = test.info().testId;
  let directory = directories.get(id);
  if (directory === undefined) {
    directory = mkdtempSync(join(tmpdir(), 'pertexo-browser-'));
    directories.set(id, directory);
  }
  const file = join(directory, name);
  mkdirSync(dirname(file), { recursive: true });
  return file;
}
