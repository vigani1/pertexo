import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLifecycleCommandReadinessMarker } from '../src/readiness-marker.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('lifecycle command readiness marker', () => {
  it('creates a private marker and clears it idempotently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pertexo-readiness-'));
    temporaryDirectories.push(directory);
    const markerPath = join(directory, 'ready');
    const marker = createLifecycleCommandReadinessMarker(markerPath);

    await marker.clear();
    await marker.mark();
    expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
    await marker.clear();
    await expect(access(markerPath)).rejects.toThrow();
    await marker.clear();
  });
});
