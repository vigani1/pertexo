import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import { acceptWorkflowRun } from '../src/execution-acceptance.js';
import {
  appendRunEvent,
  AttemptFenceConflictError,
  AttemptReconciliationRequiredError,
  CheckpointRevisionConflictError,
  claimNodeAttempt,
  commitDueNodeAdmission,
  commitCoordinatorTransition,
  completeNodeAttempt,
  dispatchDueWorkflowWaits,
  heartbeatNodeAttempt,
  markNodeAttemptDispatched,
  readDueNodeRuns,
  readRunEventsAfter,
  readExpiredAttemptReconciliations,
  reconcileExpiredNodeAttempt,
  requestWorkflowRunCancellation,
  scheduleNodeAttemptRetry,
  suspendNodeAttemptUntil,
} from '../src/execution-runtime.js';
import { migrateDatabase } from '../src/migrations.js';

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';

const api = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
);
const worker = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: workerUrl, max: 4 }),
);
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const workspaceCreatorId = randomUUID();
const traceparent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

async function resetFixture(): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  await pool.query('begin');
  try {
    await pool.query('set local role pertexo_owner');
    await pool.query(`
      truncate table app.node_attempts, app.node_runs,
        app.idempotency_records, app.run_events, app.run_checkpoints,
        app.workflow_runs, app.outbox_events cascade
    `);
    await pool.query(
      `insert into app.users (id, email, display_name, status)
       values ($1, $2, 'Runtime fixture owner', 'active')
       on conflict (id) do update set status = 'active'`,
      [workspaceCreatorId, `runtime-${workspaceCreatorId}@example.test`],
    );
    await pool.query(
      `insert into app.workspaces (id, name, slug, status, created_by)
       values
         ($1, 'Runtime A', $3, 'active', $5),
         ($2, 'Runtime B', $4, 'active', $5)
       on conflict (id) do update set
         status = 'active',
         deletion_requested_at = null,
         deletion_requested_by = null,
         deletion_reason = null,
         purge_after = null`,
      [
        workspaceA,
        workspaceB,
        `runtime-a-${workspaceA}`,
        `runtime-b-${workspaceB}`,
        workspaceCreatorId,
      ],
    );
    await pool.query('commit');
  } catch (error: unknown) {
    await pool.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}

function hasPostgresCode(expectedCode: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current = error;
    while (current instanceof Error) {
      if ('code' in current && current.code === expectedCode) return true;
      current = current.cause;
    }
    return false;
  };
}

async function acceptRun(
  workspaceId = workspaceA,
  deadlineAt?: Date,
): Promise<string> {
  return api.withWorkspace(workspaceId, async (transaction) => {
    const accepted = await acceptWorkflowRun(transaction, {
      engineVersion: 'phase0e-v1',
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      operation: 'workflow.run.accept',
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      scope: `manual:${randomUUID()}`,
      triggerType: 'manual',
      workflowId: randomUUID(),
      workflowVersionId: randomUUID(),
    });
    return accepted.runId;
  });
}

function admission(
  sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe' = 'safe',
) {
  return {
    attemptId: randomUUID(),
    attemptNumber: 1,
    branchContext: { branch: 'root' },
    inputRef: { inline: { value: 7 } },
    invocationKey: `node:set:${randomUUID()}`,
    nodeId: 'set-1',
    nodeRunId: randomUUID(),
    providerIdempotencyKey:
      sideEffectClass === 'idempotent_with_key'
        ? `provider-${randomUUID()}`
        : null,
    sideEffectClass,
  } as const;
}

async function startRun(runId: string, admitted = admission()) {
  await worker.withWorkspace(workspaceA, (transaction) =>
    commitCoordinatorTransition(transaction, {
      admissions: [admitted],
      engineVersion: 'phase0e-v1',
      event: { payload: {}, type: 'run.started' },
      expectedRevision: 0,
      nextRunStatus: 'running',
      resumeAt: null,
      runId,
      schedulerState: { admitted: [admitted.invocationKey] },
    }),
  );
  return admitted;
}

beforeAll(() => migrateDatabase(migrationConfig));
beforeEach(resetFixture);
afterAll(() => Promise.all([api.close(), worker.close()]));

describe('durable execution persistence', () => {
  it('stops admission after the durable run deadline and permits only timed_out finalization', async () => {
    const runId = await acceptRun(workspaceA, new Date(Date.now() + 500));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 600);
    });
    await expect(startRun(runId)).rejects.toThrow(
      'execution.run_deadline_expired',
    );
    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        commitCoordinatorTransition(transaction, {
          admissions: [],
          engineVersion: 'phase0e-v1',
          event: { payload: {}, type: 'run.timed_out' },
          expectedRevision: 0,
          nextRunStatus: 'timed_out',
          resumeAt: null,
          runId,
          schedulerState: {},
        }),
      ),
    ).resolves.toMatchObject({ revision: 1 });
  });

  it('appends canonical bounded events with gapless sequences', async () => {
    const runId = await acceptRun();
    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        appendRunEvent(transaction, {
          event: { payload: { progress: 25 }, type: 'node.progress' },
          runId,
        }),
      ),
    ).resolves.toBe(2);
    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        appendRunEvent(transaction, {
          event: {
            payload: { value: 'x'.repeat(5_000) },
            type: 'node.progress',
          },
          runId,
        }),
      ),
    ).rejects.toThrow('JSON value must not exceed 4096');

    const firstPage = await worker.withWorkspace(workspaceA, (transaction) =>
      readRunEventsAfter(transaction, {
        afterSequence: 0,
        limit: 1,
        runId,
      }),
    );
    expect(firstPage).toMatchObject({
      hasMore: true,
      highWaterSequence: 2,
    });
    expect(firstPage.events.map((event) => event.sequence)).toEqual([1]);
    const secondPage = await worker.withWorkspace(workspaceA, (transaction) =>
      readRunEventsAfter(transaction, {
        afterSequence: 1,
        limit: 10,
        runId,
      }),
    );
    expect(secondPage.events.map((event) => event.sequence)).toEqual([2]);
    await expect(
      worker.withWorkspace(workspaceB, (transaction) =>
        readRunEventsAfter(transaction, {
          afterSequence: 0,
          limit: 10,
          runId,
        }),
      ),
    ).rejects.toThrow('execution.run_not_found');
  });

  it('fails closed when persisted run event history contains a sequence gap', async () => {
    const runId = await acceptRun();
    await worker.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
        insert into app.run_events
          (workspace_id, workflow_run_id, sequence, type, payload)
        values (${workspaceA}, ${runId}, 3, 'node.progress', '{"progress": 50}'::jsonb)
      `),
    );
    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        readRunEventsAfter(transaction, {
          afterSequence: 1,
          limit: 10,
          runId,
        }),
      ),
    ).rejects.toThrow('execution.run_event_gap');
  });

  it('atomically advances a checkpoint and admits one identifier-only attempt', async () => {
    const runId = await acceptRun();
    const admitted = await startRun(runId);

    await worker.withWorkspace(workspaceA, async ({ db }) => {
      const persisted = await db.execute<{
        attempt_number: number;
        attempt_status: string;
        job_name: string;
        node_status: string;
        payload: unknown;
        revision: number;
        run_status: string;
      }>(sql`
        select r.status as run_status, c.revision, n.status as node_status,
               a.status as attempt_status, a.attempt_number,
               o.job_name, o.payload
        from app.workflow_runs r
        join app.run_checkpoints c on c.workflow_run_id = r.id
        join app.node_runs n on n.workflow_run_id = r.id
        join app.node_attempts a on a.node_run_id = n.id
        join app.outbox_events o on o.aggregate_id = a.id
        where r.id = ${runId}
      `);
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0]).toMatchObject({
        attempt_number: 1,
        attempt_status: 'ready',
        job_name: 'execute-node-attempt',
        node_status: 'ready',
        revision: 1,
        run_status: 'running',
      });
      const payload = persisted.rows[0]?.payload;
      expect(payload).toMatchObject({
        attemptId: admitted.attemptId,
        nodeRunId: admitted.nodeRunId,
        runId,
        schemaVersion: 1,
        workspaceId: workspaceA,
      });
      const events = await db.execute(sql`
        select sequence, type from app.run_events
        where workflow_run_id = ${runId} order by sequence
      `);
      expect(events.rows).toEqual([
        { sequence: 1, type: 'run.queued' },
        { sequence: 2, type: 'run.started' },
        { sequence: 3, type: 'node.ready' },
      ]);
    });

    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        commitCoordinatorTransition(transaction, {
          admissions: [],
          engineVersion: 'phase0e-v1',
          event: { payload: {}, type: 'run.waiting' },
          expectedRevision: 0,
          nextRunStatus: 'waiting',
          resumeAt: new Date(Date.now() + 1_000),
          runId,
          schedulerState: {},
        }),
      ),
    ).rejects.toBeInstanceOf(CheckpointRevisionConflictError);
  });

  it('serializes concurrent coordinators so exactly one checkpoint revision wins', async () => {
    const runId = await acceptRun();
    await worker.withWorkspace(workspaceA, (transaction) =>
      commitCoordinatorTransition(transaction, {
        admissions: [],
        engineVersion: 'phase0e-v1',
        event: { payload: {}, type: 'run.started' },
        expectedRevision: 0,
        nextRunStatus: 'running',
        resumeAt: null,
        runId,
        schedulerState: {},
      }),
    );
    const transition = () =>
      worker.withWorkspace(workspaceA, (transaction) =>
        commitCoordinatorTransition(transaction, {
          admissions: [],
          engineVersion: 'phase0e-v1',
          event: { payload: {}, type: 'run.waiting' },
          expectedRevision: 1,
          nextRunStatus: 'waiting',
          resumeAt: new Date(Date.now() + 10_000),
          runId,
          schedulerState: { waiting: true },
        }),
      );
    const outcomes = await Promise.allSettled([transition(), transition()]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(CheckpointRevisionConflictError);
    }
  });

  it('commits a pure checkpoint without inventing an event and fences its redelivery', async () => {
    const runId = await acceptRun();
    await worker.withWorkspace(workspaceA, (transaction) =>
      commitCoordinatorTransition(transaction, {
        admissions: [],
        engineVersion: 'phase0e-v1',
        event: { payload: {}, type: 'run.started' },
        expectedRevision: 0,
        nextRunStatus: 'running',
        resumeAt: null,
        runId,
        schedulerState: { cursor: 0 },
      }),
    );

    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        commitCoordinatorTransition(transaction, {
          admissions: [],
          engineVersion: 'phase0e-v1',
          expectedRevision: 1,
          nextRunStatus: 'running',
          resumeAt: null,
          runId,
          schedulerState: { cursor: 1 },
        }),
      ),
    ).resolves.toEqual({ admittedAttemptIds: [], revision: 2 });

    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        commitCoordinatorTransition(transaction, {
          admissions: [],
          engineVersion: 'phase0e-v1',
          expectedRevision: 1,
          nextRunStatus: 'running',
          resumeAt: null,
          runId,
          schedulerState: { cursor: 1 },
        }),
      ),
    ).rejects.toBeInstanceOf(CheckpointRevisionConflictError);

    await worker.withWorkspace(workspaceA, (transaction) =>
      commitCoordinatorTransition(transaction, {
        admissions: [],
        engineVersion: 'phase0e-v1',
        event: { payload: { resumeAt: 'later' }, type: 'run.waiting' },
        expectedRevision: 2,
        nextRunStatus: 'waiting',
        resumeAt: new Date(Date.now() + 10_000),
        runId,
        schedulerState: { cursor: 1, waiting: true },
      }),
    );

    await worker.withWorkspace(workspaceA, async ({ db }) => {
      const state = await db.execute(sql`
        select c.revision, c.scheduler_state, r.status
        from app.run_checkpoints c
        join app.workflow_runs r
          on r.workspace_id = c.workspace_id
         and r.id = c.workflow_run_id
        where c.workspace_id = ${workspaceA}
          and c.workflow_run_id = ${runId}
      `);
      expect(state.rows[0]).toMatchObject({
        revision: 3,
        scheduler_state: { cursor: 1, waiting: true },
        status: 'waiting',
      });
      const events = await db.execute(sql`
        select sequence, type
        from app.run_events
        where workspace_id = ${workspaceA}
          and workflow_run_id = ${runId}
        order by sequence
      `);
      expect(events.rows).toEqual([
        { sequence: 1, type: 'run.queued' },
        { sequence: 2, type: 'run.started' },
        { sequence: 3, type: 'run.waiting' },
      ]);
    });
  });

  it('requires an event when a checkpoint changes the durable run status', async () => {
    const runId = await acceptRun();
    await worker.withWorkspace(workspaceA, (transaction) =>
      commitCoordinatorTransition(transaction, {
        admissions: [],
        engineVersion: 'phase0e-v1',
        event: { payload: {}, type: 'run.started' },
        expectedRevision: 0,
        nextRunStatus: 'running',
        resumeAt: null,
        runId,
        schedulerState: {},
      }),
    );

    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        commitCoordinatorTransition(transaction, {
          admissions: [],
          engineVersion: 'phase0e-v1',
          expectedRevision: 1,
          nextRunStatus: 'waiting',
          resumeAt: new Date(Date.now() + 10_000),
          runId,
          schedulerState: { waiting: true },
        }),
      ),
    ).rejects.toThrow('execution.run_transition_event_required');

    await worker.withWorkspace(workspaceA, async ({ db }) => {
      const state = await db.execute(sql`
        select c.revision, r.status,
          (select count(*)::integer
             from app.run_events e
            where e.workspace_id = ${workspaceA}
              and e.workflow_run_id = ${runId}) as event_count
        from app.run_checkpoints c
        join app.workflow_runs r
          on r.workspace_id = c.workspace_id
         and r.id = c.workflow_run_id
        where c.workspace_id = ${workspaceA}
          and c.workflow_run_id = ${runId}
      `);
      expect(state.rows[0]).toEqual({
        event_count: 2,
        revision: 1,
        status: 'running',
      });
    });

    await worker.withWorkspace(workspaceA, (transaction) =>
      commitCoordinatorTransition(transaction, {
        admissions: [],
        engineVersion: 'phase0e-v1',
        event: { payload: {}, type: 'run.succeeded' },
        expectedRevision: 1,
        nextRunStatus: 'succeeded',
        resumeAt: null,
        runId,
        schedulerState: { completed: true },
      }),
    );
    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        commitCoordinatorTransition(transaction, {
          admissions: [],
          engineVersion: 'phase0e-v1',
          expectedRevision: 2,
          nextRunStatus: 'succeeded',
          resumeAt: null,
          runId,
          schedulerState: { completed: true },
        }),
      ),
    ).rejects.toThrow('execution.invalid_run_transition');
  });

  it('rolls back checkpoint, events, attempt, and outbox together on duplicate invocation', async () => {
    const runId = await acceptRun();
    const first = await startRun(runId);

    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        commitCoordinatorTransition(transaction, {
          admissions: [{ ...admission(), invocationKey: first.invocationKey }],
          engineVersion: 'phase0e-v1',
          event: { payload: {}, type: 'run.waiting' },
          expectedRevision: 1,
          nextRunStatus: 'waiting',
          resumeAt: new Date(Date.now() + 1_000),
          runId,
          schedulerState: {},
        }),
      ),
    ).rejects.toBeTruthy();

    await worker.withWorkspace(workspaceA, async ({ db }) => {
      const state = await db.execute(sql`
        select c.revision, r.status,
          (select count(*)::integer from app.run_events where workflow_run_id = r.id) event_count,
          (select count(*)::integer from app.node_attempts) attempt_count
        from app.workflow_runs r join app.run_checkpoints c on c.workflow_run_id = r.id
        where r.id = ${runId}
      `);
      expect(state.rows[0]).toEqual({
        attempt_count: 1,
        event_count: 3,
        revision: 1,
        status: 'running',
      });
    });
  });

  it('claims with a monotonic fence, records dispatch before outcome, and makes completion redelivery a no-op', async () => {
    const runId = await acceptRun();
    const admitted = await startRun(runId, admission('idempotent_with_key'));
    const lease = await worker.withWorkspace(workspaceA, (transaction) =>
      claimNodeAttempt(transaction, {
        attemptId: admitted.attemptId,
        leaseDurationSeconds: 30,
        workerId: 'worker-a',
      }),
    );
    expect(lease).toMatchObject({ fenceToken: 1 });
    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        heartbeatNodeAttempt(transaction, {
          attemptId: admitted.attemptId,
          fenceToken: 1,
          leaseDurationSeconds: 30,
          workerId: 'worker-a',
        }),
      ),
    ).resolves.toBeInstanceOf(Date);
    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        heartbeatNodeAttempt(transaction, {
          attemptId: admitted.attemptId,
          fenceToken: 2,
          leaseDurationSeconds: 30,
          workerId: 'worker-a',
        }),
      ),
    ).rejects.toBeInstanceOf(AttemptFenceConflictError);

    await worker.withWorkspace(workspaceA, (transaction) =>
      markNodeAttemptDispatched(transaction, {
        attemptId: admitted.attemptId,
        fenceToken: 1,
        workerId: 'worker-a',
      }),
    );
    const completed = await worker.withWorkspace(workspaceA, (transaction) =>
      completeNodeAttempt(transaction, {
        attemptId: admitted.attemptId,
        fenceToken: 1,
        outputRef: { inline: { mapped: 7 } },
        status: 'succeeded',
        workerId: 'worker-a',
      }),
    );
    expect(completed.duplicate).toBe(false);
    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        completeNodeAttempt(transaction, {
          attemptId: admitted.attemptId,
          fenceToken: 1,
          outputRef: { inline: { mapped: 7 } },
          status: 'succeeded',
          workerId: 'worker-a',
        }),
      ),
    ).resolves.toMatchObject({ duplicate: true });
  });

  it('persists an idempotent cancellation request and prevents later admission', async () => {
    const runId = await acceptRun();
    const first = await api.withWorkspace(workspaceA, (transaction) =>
      requestWorkflowRunCancellation(transaction, {
        actor: 'user:42',
        reason: 'stopped by owner',
        runId,
      }),
    );
    const retry = await api.withWorkspace(workspaceA, (transaction) =>
      requestWorkflowRunCancellation(transaction, {
        actor: 'user:42',
        reason: 'stopped by owner',
        runId,
      }),
    );
    expect(retry).toEqual({ ...first, duplicate: true });
    await expect(startRun(runId)).rejects.toThrow(
      'execution.cancel_stops_admission',
    );
  });

  it('reconstructs due waits from PostgreSQL and emits one durable coordinator outbox event', async () => {
    const runId = await acceptRun();
    await worker.withWorkspace(workspaceA, (transaction) =>
      commitCoordinatorTransition(transaction, {
        admissions: [],
        engineVersion: 'phase0e-v1',
        event: { payload: {}, type: 'run.started' },
        expectedRevision: 0,
        nextRunStatus: 'running',
        resumeAt: null,
        runId,
        schedulerState: {},
      }),
    );
    await worker.withWorkspace(workspaceA, (transaction) =>
      commitCoordinatorTransition(transaction, {
        admissions: [],
        engineVersion: 'phase0e-v1',
        event: { payload: { resumeAt: 'due' }, type: 'run.waiting' },
        expectedRevision: 1,
        nextRunStatus: 'waiting',
        resumeAt: new Date(0),
        runId,
        schedulerState: { waiting: true },
      }),
    );
    const dispatched = await worker.withWorkspace(workspaceA, (transaction) =>
      dispatchDueWorkflowWaits(transaction, { limit: 10 }),
    );
    expect(dispatched).toHaveLength(1);
    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        dispatchDueWorkflowWaits(transaction, { limit: 10 }),
      ),
    ).resolves.toEqual([]);
  });

  it('persists retry due time and atomically admits the next immutable attempt with the stable provider key', async () => {
    const runId = await acceptRun();
    const admitted = await startRun(runId, admission('idempotent_with_key'));
    await worker.withWorkspace(workspaceA, async (transaction) => {
      await claimNodeAttempt(transaction, {
        attemptId: admitted.attemptId,
        leaseDurationSeconds: 30,
        workerId: 'retry-worker',
      });
      await scheduleNodeAttemptRetry(transaction, {
        attemptId: admitted.attemptId,
        dueAt: new Date(0),
        fenceToken: 1,
        safeErrorCode: 'provider.busy',
        workerId: 'retry-worker',
      });
    });
    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        readDueNodeRuns(transaction, 10),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        kind: 'retry',
        nodeRunId: admitted.nodeRunId,
      }),
    ]);
    const nextAttemptId = randomUUID();
    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        commitDueNodeAdmission(transaction, {
          attemptId: nextAttemptId,
          engineVersion: 'phase0e-v1',
          expectedAttemptNumber: 1,
          expectedRevision: 1,
          nodeRunId: admitted.nodeRunId,
          schedulerState: { retry: 2 },
        }),
      ),
    ).resolves.toEqual({ attemptNumber: 2, revision: 2 });
    await worker.withWorkspace(workspaceA, async ({ db }) => {
      const attempts = await db.execute(sql`
        select attempt_number, status, provider_idempotency_key
        from app.node_attempts where node_run_id = ${admitted.nodeRunId}
        order by attempt_number
      `);
      expect(attempts.rows).toEqual([
        {
          attempt_number: 1,
          provider_idempotency_key: admitted.providerIdempotencyKey,
          status: 'failed',
        },
        {
          attempt_number: 2,
          provider_idempotency_key: admitted.providerIdempotencyKey,
          status: 'ready',
        },
      ]);
      const outbox = await db.execute<{ payload: unknown }>(sql`
        select payload from app.outbox_events
        where aggregate_id = ${nextAttemptId}
      `);
      expect(outbox.rows[0]?.payload).toMatchObject({
        attemptId: nextAttemptId,
        nodeRunId: admitted.nodeRunId,
        runId,
        schemaVersion: 1,
        workspaceId: workspaceA,
      });
    });
  });

  it('releases a waiting attempt and reconstructs its due admission without an occupied lease', async () => {
    const runId = await acceptRun();
    const admitted = await startRun(runId);
    await worker.withWorkspace(workspaceA, async (transaction) => {
      await claimNodeAttempt(transaction, {
        attemptId: admitted.attemptId,
        leaseDurationSeconds: 30,
        workerId: 'wait-worker',
      });
      await suspendNodeAttemptUntil(transaction, {
        attemptId: admitted.attemptId,
        dueAt: new Date(0),
        fenceToken: 1,
        workerId: 'wait-worker',
      });
      const due = await readDueNodeRuns(transaction, 10);
      expect(due).toEqual([
        expect.objectContaining({
          kind: 'wait',
          nodeRunId: admitted.nodeRunId,
        }),
      ]);
      const state = await transaction.db.execute(sql`
        select status, lease_owner, lease_expires_at
        from app.node_attempts where id = ${admitted.attemptId}
      `);
      expect(state.rows).toEqual([
        { lease_expires_at: null, lease_owner: null, status: 'succeeded' },
      ]);
    });
  });

  it('reconciles an expired unsafe dispatched attempt to outcome_unknown and fences its stale worker', async () => {
    const runId = await acceptRun();
    const admitted = await startRun(runId, admission('unsafe'));
    await worker.withWorkspace(workspaceA, async (transaction) => {
      await claimNodeAttempt(transaction, {
        attemptId: admitted.attemptId,
        leaseDurationSeconds: 30,
        workerId: 'worker-stale',
      });
      await markNodeAttemptDispatched(transaction, {
        attemptId: admitted.attemptId,
        fenceToken: 1,
        workerId: 'worker-stale',
      });
      await transaction.db.execute(sql`
        update app.node_attempts set lease_expires_at = clock_timestamp() - interval '1 second'
        where id = ${admitted.attemptId}
      `);
    });
    const expired = await worker.withWorkspace(workspaceA, (transaction) =>
      readExpiredAttemptReconciliations(transaction, 10),
    );
    expect(expired).toEqual([
      expect.objectContaining({
        attemptId: admitted.attemptId,
        sideEffectClass: 'unsafe',
      }),
    ]);
    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        reconcileExpiredNodeAttempt(transaction, {
          action: 'reclaim',
          attemptId: admitted.attemptId,
          expectedFenceToken: 1,
        }),
      ),
    ).rejects.toBeInstanceOf(AttemptReconciliationRequiredError);
    const reconciled = await worker.withWorkspace(workspaceA, (transaction) =>
      reconcileExpiredNodeAttempt(transaction, {
        action: 'outcome_unknown',
        attemptId: admitted.attemptId,
        evidenceRef: { reason: 'expired after dispatch marker' },
        expectedFenceToken: 1,
      }),
    );
    expect(reconciled.fenceToken).toBe(2);
    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        completeNodeAttempt(transaction, {
          attemptId: admitted.attemptId,
          fenceToken: 1,
          status: 'succeeded',
          workerId: 'worker-stale',
        }),
      ),
    ).rejects.toThrow('execution.attempt_terminal_conflict');
  });

  it('denies reconciliation during a live lease and emits the complete execute payload after expiry', async () => {
    const runId = await acceptRun();
    const admitted = await startRun(runId, admission('safe'));
    await worker.withWorkspace(workspaceA, (transaction) =>
      claimNodeAttempt(transaction, {
        attemptId: admitted.attemptId,
        leaseDurationSeconds: 30,
        workerId: 'reconcile-worker',
      }),
    );

    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        reconcileExpiredNodeAttempt(transaction, {
          action: 'reclaim',
          attemptId: admitted.attemptId,
          expectedFenceToken: 1,
        }),
      ),
    ).rejects.toBeInstanceOf(AttemptReconciliationRequiredError);
    await expect(
      worker.withWorkspace(workspaceA, (transaction) =>
        reconcileExpiredNodeAttempt(transaction, {
          action: 'outcome_unknown',
          attemptId: admitted.attemptId,
          expectedFenceToken: 1,
        }),
      ),
    ).rejects.toBeInstanceOf(AttemptReconciliationRequiredError);

    await worker.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
        update app.node_attempts
        set lease_expires_at = clock_timestamp() - interval '1 second'
        where id = ${admitted.attemptId}
      `),
    );
    const reconciled = await worker.withWorkspace(workspaceA, (transaction) =>
      reconcileExpiredNodeAttempt(transaction, {
        action: 'reclaim',
        attemptId: admitted.attemptId,
        expectedFenceToken: 1,
        traceparent,
      }),
    );
    expect(reconciled.fenceToken).toBe(2);

    await worker.withWorkspace(workspaceA, async ({ db }) => {
      const outbox = await db.execute<{
        aggregate_id: string;
        job_name: string;
        payload: unknown;
      }>(sql`
        select aggregate_id, job_name, payload
        from app.outbox_events
        where id = ${reconciled.outboxEventId}
      `);
      expect(outbox.rows).toEqual([
        {
          aggregate_id: admitted.attemptId,
          job_name: 'execute-node-attempt',
          payload: {
            attemptId: admitted.attemptId,
            nodeRunId: admitted.nodeRunId,
            outboxEventId: reconciled.outboxEventId,
            runId,
            schemaVersion: 1,
            traceparent,
            workspaceId: workspaceA,
          },
        },
      ]);
    });
  });

  it('serializes concurrent expired reconciliation and fences the loser', async () => {
    const runId = await acceptRun();
    const admitted = await startRun(runId, admission('safe'));
    await worker.withWorkspace(workspaceA, async (transaction) => {
      await claimNodeAttempt(transaction, {
        attemptId: admitted.attemptId,
        leaseDurationSeconds: 30,
        workerId: 'reconcile-worker',
      });
      await transaction.db.execute(sql`
        update app.node_attempts
        set lease_expires_at = clock_timestamp() - interval '1 second'
        where id = ${admitted.attemptId}
      `);
    });

    const outcomes = await Promise.allSettled([
      worker.withWorkspace(workspaceA, (transaction) =>
        reconcileExpiredNodeAttempt(transaction, {
          action: 'reclaim',
          attemptId: admitted.attemptId,
          expectedFenceToken: 1,
        }),
      ),
      worker.withWorkspace(workspaceA, (transaction) =>
        reconcileExpiredNodeAttempt(transaction, {
          action: 'reclaim',
          attemptId: admitted.attemptId,
          expectedFenceToken: 1,
        }),
      ),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(
      rejected?.status === 'rejected' ? rejected.reason : undefined,
    ).toBeInstanceOf(AttemptFenceConflictError);
    await worker.withWorkspace(workspaceA, async ({ db }) => {
      const state = await db.execute<{
        fence_token: string;
        status: string;
      }>(sql`
        select fence_token, status
        from app.node_attempts
        where id = ${admitted.attemptId}
      `);
      expect(state.rows).toEqual([{ fence_token: '2', status: 'ready' }]);
      const events = await db.execute<{ count: number }>(sql`
        select count(*)::integer as count
        from app.outbox_events
        where aggregate_id = ${admitted.attemptId}
          and job_name = 'execute-node-attempt'
      `);
      expect(events.rows).toEqual([{ count: 2 }]);
    });
  });

  it('forces workspace isolation and exposes no mutation path to the API for attempt history', async () => {
    const runId = await acceptRun();
    const admitted = await startRun(runId);
    await worker.withWorkspace(workspaceB, async ({ db }) => {
      expect((await db.execute(sql`select * from app.node_runs`)).rows).toEqual(
        [],
      );
      expect(
        (await db.execute(sql`select * from app.node_attempts`)).rows,
      ).toEqual([]);
    });
    await expect(
      api.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
          update app.node_attempts set status = 'succeeded'
          where id = ${admitted.attemptId}
        `),
      ),
    ).rejects.toSatisfy(hasPostgresCode('42501'));
  });

  it('forces RLS and grants only column-scoped execution mutations', async () => {
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      const rls = await owner.query<{
        relforcerowsecurity: boolean;
        relrowsecurity: boolean;
      }>(`
        select relrowsecurity, relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = any(array['node_runs', 'node_attempts'])
      `);
      expect(rls.rows).toHaveLength(2);
      expect(
        rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
      ).toBe(true);

      const privileges = await owner.query<{
        canDelete: boolean;
        canInsert: boolean;
        canSelect: boolean;
        canTruncate: boolean;
        canUpdate: boolean;
        roleName: string;
        tableName: string;
      }>(`
        with roles(role_name) as (
          values ('pertexo_api'), ('pertexo_worker'), ('pertexo_dispatcher')
        ), tables(table_oid, table_name) as (
          select c.oid, c.relname from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app' and c.relname = any(array['node_runs', 'node_attempts'])
        )
        select role_name as "roleName", table_name as "tableName",
          has_table_privilege(role_name, table_oid, 'SELECT') as "canSelect",
          has_table_privilege(role_name, table_oid, 'INSERT') as "canInsert",
          has_table_privilege(role_name, table_oid, 'UPDATE') as "canUpdate",
          has_table_privilege(role_name, table_oid, 'DELETE') as "canDelete",
          has_table_privilege(role_name, table_oid, 'TRUNCATE') as "canTruncate"
        from roles cross join tables order by role_name, table_name
      `);
      for (const row of privileges.rows) {
        expect(row.canSelect).toBe(row.roleName !== 'pertexo_dispatcher');
        expect(row.canInsert).toBe(row.roleName === 'pertexo_worker');
        expect(row.canUpdate).toBe(false);
        expect(row.canDelete).toBe(false);
        expect(row.canTruncate).toBe(false);
      }

      const immutable = await owner.query<{
        canUpdate: boolean;
        columnName: string;
      }>(`
        with columns(column_name) as (
          values ('workspace_id'), ('node_run_id'), ('attempt_number'),
                 ('side_effect_class'), ('provider_idempotency_key')
        ), relation(oid) as (
          select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app' and c.relname = 'node_attempts'
        )
        select column_name as "columnName",
          has_column_privilege('pertexo_worker', relation.oid, column_name, 'UPDATE') as "canUpdate"
        from columns cross join relation
      `);
      expect(immutable.rows.every((row) => !row.canUpdate)).toBe(true);
    } finally {
      await owner.end();
    }
  });
});
