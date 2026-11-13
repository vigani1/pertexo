import { describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { installExecutionAcceptanceFixture } from '../../runs/acceptance/run-acceptance.fixture.js';
import { createTestRunStore } from '../../support/run-advance-store.js';
import {
  acceptRun,
  claimRuns,
  publishClaims,
  setLimit,
} from './concurrency-admission.fixtures.js';
import {
  deferredDelivery,
  publishExecutableVersion,
  startInput,
  workerUrl,
} from './concurrency-review-regressions.fixture.js';

installExecutionAcceptanceFixture();
describe('ordered starts under a workflow limit', () => {
  it('starts the next granted run as soon as the run ahead of it starts, not after the deferral', async () => {
    await setLimit(2);
    await publishExecutableVersion();
    const first = await acceptRun();
    const second = await acceptRun();
    const firstGrant = await claimRuns();
    await publishClaims(firstGrant);
    const secondGrant = await claimRuns();
    await publishClaims(secondGrant);
    const firstEvent = firstGrant.events[0];
    const secondEvent = secondGrant.events[0];
    if (firstEvent === undefined || secondEvent === undefined)
      throw new Error('Expected both runs granted');
    expect([firstEvent.aggregateId, secondEvent.aggregateId]).toEqual([
      first.runId,
      second.runId,
    ]);

    const store = createTestRunStore(
      parseDatabaseConfig({ connectionString: workerUrl(), max: 1 }),
    );
    try {
      // The later run's start lands first, so ticket order defers it.
      await expect(
        store.commitAdvancePlan(
          startInput(secondEvent, second.request.initialCheckpoint),
        ),
      ).resolves.toEqual({ kind: 'deferred', revision: 0 });
      const deferred = await deferredDelivery(second.runId, secondEvent.id);
      await expect(claimRuns()).resolves.toMatchObject({ events: [] });

      await expect(
        store.commitAdvancePlan(
          startInput(firstEvent, first.request.initialCheckpoint),
        ),
      ).resolves.toMatchObject({ kind: 'committed', revision: 1 });

      // Its slot isn't left idle: the deferred start is deliverable right away.
      const retry = await claimRuns();
      expect(retry.events.map(({ id }) => id)).toEqual([deferred.id]);
      await publishClaims(retry);
      await expect(
        store.commitAdvancePlan({
          ...startInput(secondEvent, second.request.initialCheckpoint),
          delivery: {
            outboxEventId: deferred.id,
            payloadChecksum: deferred.payload_checksum,
          },
        }),
      ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
    } finally {
      await store.close();
    }
  });
});
