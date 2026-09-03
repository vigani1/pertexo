import { count, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  acceptWorkflowRun,
  IdempotencyRequestConflictError,
} from '../src/execution-acceptance.js';
import {
  idempotencyRecords,
  outboxEvents,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '../src/schema.js';
import {
  STORED_EXECUTION_VALUE_LIMITS_V1,
  StoredExecutionValueInvalidError,
} from '../src/stored-execution-value.js';
import {
  acceptanceInput,
  apiDatabase,
  expectAcceptanceRecordCounts,
  initialCheckpoint,
  installExecutionAcceptanceFixture,
  migrationUrl,
  otherRequestHash,
  requestHash,
  workspaceA,
  workspaceCreatorId,
} from './execution-acceptance.fixtures.js';

installExecutionAcceptanceFixture();

describe('workflow run acceptance persistence and idempotency', () => {
  it('commits one queued run, accepted event, revision-0 checkpoint, idempotency claim, and coordinator outbox', async () => {
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptWorkflowRun(transaction, acceptanceInput()),
    );

    expect(accepted).toMatchObject({ duplicate: false, status: 'queued' });
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      expect(
        await db
          .select({ status: idempotencyRecords.status })
          .from(idempotencyRecords)
          .where(eq(idempotencyRecords.resourceId, accepted.runId)),
      ).toEqual([{ status: 'completed' }]);
      expect(
        await db
          .select({ status: workflowRuns.status })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, accepted.runId)),
      ).toEqual([{ status: 'queued' }]);
      expect(
        await db
          .select({ sequence: runEvents.sequence, type: runEvents.type })
          .from(runEvents)
          .where(eq(runEvents.workflowRunId, accepted.runId)),
      ).toEqual([{ sequence: 1, type: 'run.queued' }]);
      expect(
        await db
          .select({ revision: runCheckpoints.revision })
          .from(runCheckpoints)
          .where(eq(runCheckpoints.workflowRunId, accepted.runId)),
      ).toEqual([{ revision: 0 }]);
      expect(
        await db
          .select({
            aggregateId: outboxEvents.aggregateId,
            jobName: outboxEvents.jobName,
            payload: outboxEvents.payload,
          })
          .from(outboxEvents)
          .where(eq(outboxEvents.aggregateId, accepted.runId)),
      ).toEqual([
        {
          aggregateId: accepted.runId,
          jobName: 'advance-workflow-run',
          payload: {
            outboxEventId: accepted.outboxEventId,
            runId: accepted.runId,
            schemaVersion: 1,
            workspaceId: workspaceA,
          },
        },
      ]);
    });
  });

  it('persists the caller-supplied initial checkpoint with the acceptance event cursor', async () => {
    const checkpoint = initialCheckpoint();
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(),
          initialCheckpoint: checkpoint,
        }),
    );

    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      expect(
        await db
          .select({ schedulerState: runCheckpoints.schedulerState })
          .from(runCheckpoints)
          .where(eq(runCheckpoints.workflowRunId, accepted.runId)),
      ).toEqual([{ schedulerState: checkpoint }]);
    });

    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(),
          initialCheckpoint: checkpoint,
        }),
      ),
    ).resolves.toMatchObject({ duplicate: true, runId: accepted.runId });
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(),
          initialCheckpoint: {
            ...checkpoint,
            remainingIterationBudget: 1,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
  });

  it('rejects an invalid initial checkpoint before persisting acceptance state', async () => {
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(),
          initialCheckpoint: {
            ...initialCheckpoint(),
            nextEventSequence: 1,
          },
        }),
      ),
    ).rejects.toMatchObject({ name: 'PersistedWorkflowCheckpointInvalidError' });
    await expectAcceptanceRecordCounts(0);
  });

  it('atomically stores a tagged inline run input at the exact application byte limit', async () => {
    const runInput = 'x'.repeat(
      STORED_EXECUTION_VALUE_LIMITS_V1.inlineBytes - 2,
    );
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput(requestHash, runInput)),
    );

    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      await expect(
        db
          .select({
            inputRef: workflowRuns.inputRef,
            inputRefExpiresAt: workflowRuns.inputRefExpiresAt,
          })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, accepted.runId)),
      ).resolves.toEqual([
        {
          inputRef: { schemaVersion: 1, kind: 'inline', value: runInput },
          inputRefExpiresAt: new Date(
            accepted.acceptedAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
          ),
        },
      ]);
    });
  });

  it('persists canonical input without inherited toJSON hooks', async () => {
    const objectDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'toJSON',
    );
    const arrayDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      'toJSON',
    );
    let inputHookCalls = 0;
    try {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        value: function (this: unknown): unknown {
          if (
            typeof this === 'object' &&
            this !== null &&
            Object.hasOwn(this, 'kind') &&
            Object.hasOwn(this, 'schemaVersion')
          )
            inputHookCalls += 1;
          return this;
        },
      });
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value: function (this: unknown): unknown {
          inputHookCalls += 1;
          return this;
        },
      });
      const accepted = await apiDatabase.withWorkspace(
        workspaceA,
        (transaction) =>
          acceptWorkflowRun(
            transaction,
            acceptanceInput(requestHash, { nested: [1, 2, 3] }),
          ),
      );
      await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
        await expect(
          db
            .select({ inputRef: workflowRuns.inputRef })
            .from(workflowRuns)
            .where(eq(workflowRuns.id, accepted.runId)),
        ).resolves.toEqual([
          {
            inputRef: {
              schemaVersion: 1,
              kind: 'inline',
              value: { nested: [1, 2, 3] },
            },
          },
        ]);
      });
      expect(inputHookCalls).toBe(0);
    } finally {
      if (objectDescriptor === undefined)
        Reflect.deleteProperty(Object.prototype, 'toJSON');
      else Object.defineProperty(Object.prototype, 'toJSON', objectDescriptor);
      if (arrayDescriptor === undefined)
        Reflect.deleteProperty(Array.prototype, 'toJSON');
      else Object.defineProperty(Array.prototype, 'toJSON', arrayDescriptor);
    }
  });

  it('rejects oversized or hostile run input before writing acceptance state', async () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return true;
      },
    });
    for (const runInput of [
      'x'.repeat(STORED_EXECUTION_VALUE_LIMITS_V1.inlineBytes - 1),
      hostile,
    ]) {
      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(
            transaction,
            acceptanceInput(requestHash, runInput),
          ),
        ),
      ).rejects.toBeInstanceOf(StoredExecutionValueInvalidError);
      await expectAcceptanceRecordCounts(0);
    }
    expect(getterCalls).toBe(0);
  });

  it('keeps the first durable run input on an exact idempotent replay', async () => {
    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(
        transaction,
        acceptanceInput(requestHash, { retained: true }),
      ),
    );
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(
          transaction,
          acceptanceInput(requestHash, { retained: false }),
        ),
      ),
    ).resolves.toEqual({ ...first, duplicate: true });
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      await expect(
        db
          .select({ inputRef: workflowRuns.inputRef })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, first.runId)),
      ).resolves.toEqual([
        {
          inputRef: {
            schemaVersion: 1,
            kind: 'inline',
            value: { retained: true },
          },
        },
      ]);
    });
  });

  it('returns the existing run for an exact retry and rejects a changed request hash', async () => {
    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, acceptanceInput()),
    );
    const retry = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, acceptanceInput()),
    );

    expect(retry).toEqual({ ...first, duplicate: true });
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput(otherRequestHash)),
      ),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
    await expectAcceptanceRecordCounts(1);
  });

  it.each(['suspended', 'pending_deletion', 'deleted'] as const)(
    'returns durable accepted truth for an exact retry after the workspace becomes %s',
    async (status) => {
      const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );
      const owner = new Pool({ connectionString: migrationUrl, max: 1 });
      try {
        await owner.query('set role pertexo_owner');
        if (status === 'deleted') {
          await owner.query(
            `with job as (
               insert into app.workspace_purge_jobs
                 (id,workspace_id,command_id,actor_ref,reason,occurred_at,status,
                  control_sequence,control_record_hash,completed_at)
               values (gen_random_uuid(),$1,gen_random_uuid(),'fixture:purge',
                 'Completed purge fixture',now(),'completed',1,$2,now())
               returning id
             ) insert into app.workspace_purge_steps
                 (job_id,step_name,status,completed_at)
               select id,step_name,'completed',now() from job
               cross join unnest(array['object_versions','tenant_rows']) step_name`,
            [workspaceA, 'f'.repeat(64)],
          );
        }
        await owner.query(
          `update app.workspaces
           set status = $2::varchar,
               deletion_requested_at = case when $2::text = 'suspended' then null else now() end,
               deletion_requested_by = case when $2::text = 'suspended' then null::uuid else $3::uuid end,
               deletion_reason = case when $2::text = 'suspended' then null::varchar else 'fixture deletion'::varchar end,
               purge_after = case when $2::text = 'suspended' then null else now() + interval '30 days' end
           where id = $1`,
          [workspaceA, status, workspaceCreatorId],
        );
      } finally {
        await owner.end();
      }

      const replay = await apiDatabase.withWorkspace(
        workspaceA,
        (transaction) => acceptWorkflowRun(transaction, acceptanceInput()),
      );
      expect(replay).toEqual(
        status === 'pending_deletion'
          ? { ...first, duplicate: true, status: 'canceled' }
          : { ...first, duplicate: true },
      );
      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, acceptanceInput(otherRequestHash)),
        ),
      ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
      if (status !== 'pending_deletion') await expectAcceptanceRecordCounts(1);
    },
  );

  it('rolls the entire acceptance back when its surrounding transaction fails', async () => {
    await expect(
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        await acceptWorkflowRun(transaction, acceptanceInput());
        throw new Error('injected post-acceptance failure');
      }),
    ).rejects.toThrow('injected post-acceptance failure');

    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      const tables = [
        idempotencyRecords,
        workflowRuns,
        runEvents,
        runCheckpoints,
        outboxEvents,
      ] as const;
      for (const table of tables) {
        expect(await db.select({ count: count() }).from(table)).toEqual([
          { count: 0 },
        ]);
      }
    });
  });

  it('serializes concurrent exact retries to one accepted run', async () => {
    const [left, right] = await Promise.all([
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
    ]);

    expect(left.runId).toBe(right.runId);
    expect([left.duplicate, right.duplicate].sort()).toEqual([false, true]);
    await expectAcceptanceRecordCounts(1);
  });
});
