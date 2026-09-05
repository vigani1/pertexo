import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { JOB_NAME, parseQueueJob } from '../src/index.js';

describe('queue contract compatibility', () => {
  it('accepts every canonical V1 wire fixture', async () => {
    const serialized = await readFile(
      new URL('./fixtures/queue-jobs-v1.json', import.meta.url),
      'utf8',
    );
    const fixtures: unknown = JSON.parse(serialized);
    expect(Array.isArray(fixtures)).toBe(true);
    if (!Array.isArray(fixtures))
      throw new TypeError('Fixture must be an array');

    const parsed = fixtures.map((fixture) => parseQueueJob(fixture));
    expect(parsed.map(({ name }) => name).sort()).toEqual(
      Object.values(JOB_NAME).sort(),
    );
  });
});
