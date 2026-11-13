import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  apiDatabase,
  installExecutionAcceptanceFixture,
  workspaceA,
} from '../../runs/acceptance/run-acceptance.fixture.js';
import { createTestRunStore } from '../../support/run-advance-store.js';
import {
  acceptRun,
  claimRuns,
  publishClaims,
  setLimit,
  withOwner,
} from './concurrency-admission.fixtures.js';
import {
  deferredDelivery,
  publishExecutableVersion,
  startInput,
  workerUrl,
} from './concurrency-review-regressions.fixture.js';

// The ordered-start fallback defers a run 5 s while it holds its slot. A next run
// that is free to start must not wait that out: 2 s is well under it and leaves
// room for a loaded machine.
const MAX_IDLE_MS = 2_000;

const endings = [
  {
    ending: 'is canceled',
    status: 'canceled',
    event: { name: 'run.canceled' },
    cancelRequested: true,
    deadlineExpired: false,
  },
  {
    ending: 'times out',
    status: 'timed_out',
    event: { name: 'run.timed_out', reasonCode: 'execution.deadline_exceeded' },
    cancelRequested: false,
    deadlineExpired: true,
  },
  {
    ending: 'fails',
    status: 'failed',
    event: { name: 'run.failed' },
    cancelRequested: false,
    deadlineExpired: false,
  },
] as const;

installExecutionAcceptanceFixture();
describe('the run ahead leaving before it starts, under a workflow limit', () => {
  it.each(endings)(
    'starts the next granted run promptly when the run ahead $ending',
    async (ending) => {
      await setLimit(2);
      await publishExecutableVersion();
      const first = await acceptRun(
        ending.deadlineExpired
          ? { deadlineAt: new Date(Date.now() + 1_000) }
          : {},
      );
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

        if (ending.cancelRequested)
          await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
            db.execute(sql`
              update app.workflow_runs
                 set cancel_requested_at=clock_timestamp(),cancel_requested_by='ordered-release-test'
               where workspace_id=${workspaceA} and id=${first.runId}`),
          );
        if (ending.deadlineExpired) await waitForDeadline(first.runId);
        // The run ahead ends without starting, through the coordinator.
        await expect(
          store.commitAdvancePlan(
            endInput(firstEvent, first.request.initialCheckpoint, ending),
          ),
        ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
        await expect(runStatus(first.runId)).resolves.toBe(ending.status);

        // Nothing holds the next run back now, so its slot mustn't sit idle.
        const startedWaiting = Date.now();
        await expect
          .poll(
            async () => {
              const retry = await claimRuns();
              await publishClaims(retry);
              return retry.events.map(({ id }) => id);
            },
            { timeout: MAX_IDLE_MS, interval: 50 },
          )
          .toEqual([deferred.id]);
        expect(Date.now() - startedWaiting).toBeLessThan(MAX_IDLE_MS);
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
    },
  );
});

function endInput(
  event: Parameters<typeof startInput>[0],
  initial: Parameters<typeof startInput>[1],
  ending: (typeof endings)[number],
) {
  const start = startInput(event, initial);
  return {
    ...start,
    plan: {
      ...start.plan,
      checkpoint: {
        ...start.plan.checkpoint,
        runStatus: ending.status,
        cancelRequested: ending.cancelRequested,
        deadlineExpired: ending.deadlineExpired,
      },
      events: [
        {
          sequence: 2,
          occurredAt: '2026-10-01T00:00:00.000Z',
          ...ending.event,
        },
      ],
    },
  };
}

async function waitForDeadline(runId: string) {
  await withOwner((client) =>
    client.query(
      `select pg_sleep(greatest(0,extract(epoch from(deadline_at-clock_timestamp()))+0.001))
         from app.workflow_runs where id=$1`,
      [runId],
    ),
  );
}

async function runStatus(runId: string) {
  return withOwner(
    async (client) =>
      (
        await client.query<{ status: string }>(
          'select status from app.workflow_runs where id=$1',
          [runId],
        )
      ).rows[0]?.status,
  );
}
