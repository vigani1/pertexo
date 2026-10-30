import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  JOB_NAME,
  QUEUE_FOR_JOB,
  QUEUE_NAME,
  parseQueueJob,
} from '../../src/index.js';

type WireFixture = Readonly<{ name: unknown; queue: unknown; data: unknown }>;

// Job and queue names are stored: in outbox rows, Redis queue keys and
// in-flight jobs. The fixture is their canonical wire form, so renaming or
// rerouting a job fails here instead of stranding work during an upgrade.
async function wireFixtures(): Promise<readonly WireFixture[]> {
  const serialized = await readFile(
    new URL('../fixtures/queue-jobs.json', import.meta.url),
    'utf8',
  );
  const fixtures: unknown = JSON.parse(serialized);
  if (!Array.isArray(fixtures)) throw new TypeError('Fixture must be an array');
  return fixtures as readonly WireFixture[];
}

describe('queue contract compatibility', () => {
  it('accepts every canonical wire fixture', async () => {
    const parsed = (await wireFixtures()).map(({ name, data }) =>
      parseQueueJob({ name, data }),
    );
    expect(parsed.map(({ name }) => name).sort()).toEqual(
      Object.values(JOB_NAME).sort(),
    );
  });

  it('routes every job to the queue its stored form names', async () => {
    const fixtures = await wireFixtures();
    for (const fixture of fixtures) {
      const { name } = parseQueueJob({
        name: fixture.name,
        data: fixture.data,
      });
      expect(QUEUE_FOR_JOB[name], name).toBe(fixture.queue);
    }
    expect([...new Set(fixtures.map(({ queue }) => queue))].sort()).toEqual(
      Object.values(QUEUE_NAME).sort(),
    );
  });
});
