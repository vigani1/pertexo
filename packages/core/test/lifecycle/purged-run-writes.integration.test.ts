import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  parseWorkspaceId,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import { databaseSchema } from '@pertexo/database/schema';
import { createRetentionStore } from '../../src/lifecycle/retention/store.js';
import { failUnadvanceableRun } from '../../src/runs/advance/fail-unadvanceable.repository.js';
import { requestWorkflowRunCancellation } from '../../src/runs/commands/cancel.repository.js';
import { createNodeAttemptRunStore } from '../../src/attempts/repository.js';
import { settleExpiredAttempt } from '../../src/operator/handlers/attempts.repository.js';
import { readRecoveryEvidence } from '../../src/runs/recovery/records.queries.js';
import {
  actorId,
  asAdmin,
  asOwner,
  asRuntime,
  databaseUrl,
  nodeAttemptStore,
  ownedDeliveryStore,
  workerBaseUrl,
  workspaceA,
} from '../runs/run-store/fixtures.js';
import { claimDispatchAttempt } from '../runs/run-store/node-attempts/fixture.js';

const maintenanceBaseUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

const signal = new AbortController().signal;
const THIRTY_ONE_DAYS = `interval '31 days'`;

let retention!: ReturnType<typeof createRetentionStore>;
let worker!: Pool;

beforeAll(() => {
  retention = createRetentionStore(
    parseDatabaseConfig({
      connectionString: databaseUrl(maintenanceBaseUrl),
      max: 2,
    }),
    { pageSize: 500 },
  );
  worker = new Pool({ connectionString: databaseUrl(workerBaseUrl), max: 2 });
});

afterAll(async () => {
  await retention.close();
  await worker.end();
});

async function detailRows(runId: string) {
  return asAdmin(async (client) => {
    const result = await client.query<{
      nodes: number;
      events: number;
      checkpoints: number;
    }>(
      `select
         (select count(*)::int from app.node_runs where workflow_run_id=$1) nodes,
         (select count(*)::int from app.run_events where workflow_run_id=$1) events,
         (select count(*)::int from app.run_checkpoints where workflow_run_id=$1) checkpoints`,
      [runId],
    );
    return result.rows[0];
  });
}

const NOTHING = { nodes: 0, events: 0, checkpoints: 0 };

/**
 * A run canceled with its worker still holding a lease, then left past its
 * window and purged. The lease is the late work the rest of the file replays.
 */
async function purgedRunWithLiveLease() {
  const lease = await claimDispatchAttempt(`purged-${randomUUID()}`, {
    sideEffectClass: 'safe',
  });
  await asOwner(workspaceA, (client) =>
    client.query(
      `update app.workflow_runs
          set status='canceled',
              completed_at=clock_timestamp()-${THIRTY_ONE_DAYS},
              started_at=coalesce(started_at,clock_timestamp()-${THIRTY_ONE_DAYS})
        where id=$1`,
      [lease.runId],
    ),
  );
  for (let pass = 0; pass < 20; pass += 1)
    if (!(await retention.enforce()).more) break;
  const purged = await asAdmin((client) =>
    client.query<{ details_purged_at: Date | null }>(
      'select details_purged_at from app.workflow_runs where id=$1',
      [lease.runId],
    ),
  );
  expect(purged.rows[0]?.details_purged_at).toBeInstanceOf(Date);
  expect(await detailRows(lease.runId)).toEqual(NOTHING);
  return lease;
}

const transaction = (client: PoolClient) =>
  ({
    db: drizzle(client, { schema: databaseSchema }),
    workspaceId: parseWorkspaceId(workspaceA),
  }) as unknown as WorkspaceTransaction;

const refused = (work: Promise<unknown>) =>
  work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

describe('writing to a run after its details were purged', () => {
  it('a late attempt completion writes nothing', async () => {
    const lease = await purgedRunWithLiveLease();

    await refused(
      nodeAttemptStore.complete({
        lease,
        outcome: { status: 'succeeded', output: { late: true } },
        signal,
      }),
    );

    expect(await detailRows(lease.runId)).toEqual(NOTHING);
  });

  it('a late dispatch mark, heartbeat or recorded input writes nothing', async () => {
    const lease = await purgedRunWithLiveLease();

    await refused(nodeAttemptStore.heartbeat({ lease, signal } as never));
    await refused(nodeAttemptStore.markDispatched({ lease, signal } as never));
    await refused(
      nodeAttemptStore.recordInput({ lease, input: {}, signal } as never),
    );

    expect(await detailRows(lease.runId)).toEqual(NOTHING);
  });

  it('a duplicate attempt job writes nothing', async () => {
    const lease = await purgedRunWithLiveLease();
    const store = createNodeAttemptRunStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 1,
      }),
    );
    try {
      await refused(
        store.claimDelivery({
          workspaceId: workspaceA,
          runId: lease.runId,
          nodeRunId: lease.nodeRunId,
          attemptId: lease.attemptId,
          delivery: {
            eventId: randomUUID(),
            consumerName: 'node-attempt',
            payloadChecksum: 'a'.repeat(64),
          },
          leaseDurationSeconds: 30,
          workerId: 'late-worker',
          signal,
        } as never),
      );
    } finally {
      await store.close();
    }

    expect(await detailRows(lease.runId)).toEqual(NOTHING);
  });

  it('cancelling refuses a finished run and writes nothing', async () => {
    const lease = await purgedRunWithLiveLease();

    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        requestWorkflowRunCancellation(transaction(client), {
          actor: actorId,
          runId: lease.runId,
          reason: 'late',
        }),
      ),
    ).rejects.toMatchObject({ message: 'execution.run_terminal' });

    expect(await detailRows(lease.runId)).toEqual(NOTHING);
  });

  it('a duplicate advance job finds no run to advance and writes nothing', async () => {
    const lease = await purgedRunWithLiveLease();

    const loaded = await ownedDeliveryStore.loadAdvanceState({
      workspaceId: workspaceA,
      runId: lease.runId,
    });
    await refused(
      ownedDeliveryStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: lease.runId,
        signal,
        plan: {
          expectedRevision: 1,
          expectedNextEventSequence: 4,
          consumedThroughEventSequence: 3,
          checkpoint: {},
          events: [
            {
              sequence: 4,
              name: 'run.succeeded',
              occurredAt: new Date().toISOString(),
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    );

    expect(loaded).toEqual({ kind: 'not_found' });
    expect(await detailRows(lease.runId)).toEqual(NOTHING);
  });

  it('ending an unadvanceable run leaves a finished one alone', async () => {
    const lease = await purgedRunWithLiveLease();

    await expect(
      failUnadvanceableRun(worker, {
        workspaceId: workspaceA,
        runId: lease.runId,
        safeErrorCode: 'coordinator.checkpoint_invalid',
        signal,
      }),
    ).resolves.toBe('not_active');

    expect(await detailRows(lease.runId)).toEqual(NOTHING);
  });

  it('settling a lease stalled-work found has no attempt left and writes nothing', async () => {
    const lease = await purgedRunWithLiveLease();

    const settled = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      settleExpiredAttempt(transaction(client), undefined, {
        attemptId: lease.attemptId,
        expectedFenceToken: 1,
        action: 'outcome_unknown',
        dryRun: false,
        source: { stalledWorkRecovery: true },
      }),
    );

    expect(settled.outboxEventId).toBeUndefined();
    expect(await detailRows(lease.runId)).toEqual(NOTHING);
  });

  it('recovering from the purged run is refused and writes nothing', async () => {
    const lease = await purgedRunWithLiveLease();

    const evidence = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      readRecoveryEvidence(transaction(client), {
        runId: lease.runId,
        mode: 'locked',
        prepareRecovery: () => {
          throw new Error('A purged run has nothing to prepare from');
        },
        workflowVersionId: lease.workflowVersionId,
      } as never),
    );

    expect(evidence.kind).toBe('refused');
    expect(await detailRows(lease.runId)).toEqual(NOTHING);
  });
});
