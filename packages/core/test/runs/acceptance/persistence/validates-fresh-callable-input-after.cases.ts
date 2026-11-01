import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';

import { expect, it, vi } from 'vitest';
import {
  CallableInputInvalidError,
  validateCallableValue,
  type JsonValue,
} from '@pertexo/workflow-model';
import { acceptWorkflowRun } from '../../../../src/runs/commands/acceptance.repository.js';
import {
  IdempotencyRecordCorruptError,
  IdempotencyRequestConflictError,
} from '../../../../src/runs/commands/acceptance/errors.js';
import {
  idempotencyRecords,
  outboxEvents,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '@pertexo/database/schema';
import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/database/platform';
import {
  acceptanceInput,
  apiDatabase,
  expectAcceptanceRecordCounts,
  initialCheckpoint,
  requestHash,
  workspaceA,
} from '../fixtures.js';

export function registerValidatesFreshCallableInputAfter(): void {
  it('validates a fresh callable input after storage admission and before any acceptance effects', async () => {
    const validateInput = vi.fn(
      (value: JsonValue | undefined, storedBytes: number) => {
        expect(storedBytes).toBe(
          Buffer.byteLength('{"kind":"inline","value":"valid"}'),
        );
        if (
          value === undefined ||
          validateCallableValue({ type: 'number' }, value) !== undefined
        )
          throw new CallableInputInvalidError('missing');
      },
    );
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(requestHash, 'valid'),
          validateInput,
        }),
      ),
    ).rejects.toBeInstanceOf(CallableInputInvalidError);
    expect(validateInput).toHaveBeenCalledTimes(1);
    await expectAcceptanceRecordCounts(0);
  });

  it('passes immutable JSON to input validation and does not revalidate an accepted redelivery', async () => {
    const value = { name: 'hello' };
    const validateInput = vi.fn((input: JsonValue | undefined) => {
      expect(input).toEqual(value);
      expect(input).not.toBe(value);
      expect(Object.isFrozen(input)).toBe(true);
    });
    const request = { ...acceptanceInput(requestHash, value), validateInput };
    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, request),
    );
    const replay = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, request),
    );
    expect(replay).toMatchObject({ runId: first.runId, duplicate: true });
    expect(validateInput).toHaveBeenCalledTimes(1);
    await expectAcceptanceRecordCounts(1);
  });

  it('fails closed for a malformed completed idempotency record', async () => {
    const input = acceptanceInput();
    await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db
        .insert(idempotencyRecords)
        .values({
          id: randomUUID(),
          workspaceId: workspaceA,
          operation: input.operation,
          scope: input.scope,
          keyHash: input.keyHash,
          requestHash: input.requestHash,
          status: 'completed',
          resourceId: randomUUID(),
          resultRef: {},
        })
        .then(() => undefined),
    );
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, input),
      ),
    ).rejects.toBeInstanceOf(IdempotencyRecordCorruptError);
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      expect(await db.select({ count: count() }).from(workflowRuns)).toEqual([
        { count: 0 },
      ]);
    });
  });

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

  it('rejects an initial checkpoint for another version before persisting acceptance state', async () => {
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(),
          initialCheckpoint: {
            ...initialCheckpoint(),
            workflowVersionId: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow('Initial checkpoint does not belong to this run');
    await expectAcceptanceRecordCounts(0);
  });

  it('atomically stores a tagged inline run input at the exact application byte limit', async () => {
    const runInput = 'x'.repeat(STORED_EXECUTION_VALUE_LIMITS.inlineBytes - 2);
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
          inputRef: { kind: 'inline', value: runInput },
          inputRefExpiresAt: new Date(
            accepted.acceptedAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
          ),
        },
      ]);
    });
  });
}
