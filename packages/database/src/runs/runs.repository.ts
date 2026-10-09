import type { InitialCheckpointFactory } from './initial-checkpoint.js';
import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import { readWorkflowRunAcceptanceReplay } from './commands/acceptance.js';
import {
  lockManualStartCommand,
  readManualStartRejection,
  recordManualStartRejection,
  type ManualStartRejection,
} from './commands/manual-start.js';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../outbox/events.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import {
  classifyPublishedWorkflowVersionRow,
  type PublishedWorkflowV2Projection,
} from './published-workflow.js';
import { sha256HexSchema as digestSchema } from '../platform/persisted-primitives.js';
import { withWorkspaceTransaction } from '../tenant-access/transactions.js';
import type { WorkspaceTransaction } from '../tenant-access/transactions.js';
import { requestWorkflowRunCancellation } from './commands/cancel.js';
import {
  WorkflowRunNotExecutableError,
  WorkflowRunNotFoundError,
  WorkflowPublishedVersionConflictError,
} from './errors.js';
import {
  acceptWorkflowRunWithAudit,
  insertWorkflowRunAudit,
  readWorkflowRunRecord,
} from './commands/records.js';
import type { WorkflowRunRecord } from './commands/records.js';
import { replayWorkflowRunInTransaction } from './commands/replay.js';
import {
  readWorkflowRunListPage,
  type ListWorkflowRunsDatabaseInput,
  type WorkflowRunListPage,
} from './queries/list.js';
import {
  readWorkflowStepHealth,
  readWorkflowStepRuns,
  type ReadWorkflowStepHealthInput,
  type ReadWorkflowStepRunsInput,
  type WorkflowStepHealthPage,
  type WorkflowStepRunRecord,
} from './queries/step-history.js';
import {
  readWorkflowRun,
  type GetWorkflowRunInput,
  type WorkflowRunReadModel,
} from './queries/read.js';
import {
  readWorkflowNodeRunInput,
  readWorkflowNodeRunOutput,
  readWorkflowRunInput,
  type ReadWorkflowNodeRunOutputInput,
  type ReadWorkflowRunInputInput,
  type WorkflowRunData,
} from './queries/run-data.js';
import {
  readWorkflowRunStatistics,
  type WorkflowRunStatisticsDatabaseInput,
  type WorkflowRunStatisticsRecord,
} from './queries/statistics.js';
import {
  readWorkspaceUsageCapacity,
  type WorkspaceUsageCapacityInput,
  type WorkspaceUsageCapacityRecord,
} from './queries/usage-capacity.js';

export {
  WorkflowRunNotExecutableError,
  WorkflowRunNotFoundError,
  WorkflowRunReadCapacityError,
  WorkflowPublishedVersionConflictError,
} from './errors.js';
export type { WorkflowRunRecord } from './commands/records.js';
export type {
  GetWorkflowRunInput,
  WorkflowNodeRunRecord,
  WorkflowRunReadModel,
} from './queries/read.js';

const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16));
const actorSchema = z.uuid();
const requestIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const startInputSchema = z
  .object({
    actorId: actorSchema,
    workspaceId: z.uuid(),
    workflowId: z.uuid(),
    idempotencyKeyHash: digestSchema,
    requestHash: digestSchema,
    scope: z.string().regex(/^workflow:[0-9a-f-]{36}:manual$/u),
    input: z.unknown().optional(),
    expectedPublishedVersionId: z.uuid().optional(),
    deadlineAt: z.date().optional(),
    requestId: requestIdentifierSchema.optional(),
    traceId: requestIdentifierSchema.optional(),
    traceparent: traceparentSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
    checkpointFactory: z.custom<InitialCheckpointFactory>(
      (value) => typeof value === 'function',
    ),
  })
  .strict();
const replayInputSchema = z
  .object({
    actorId: actorSchema,
    workspaceId: z.uuid(),
    sourceRunId: z.uuid(),
    workflowVersionId: z.uuid(),
    idempotencyKeyHash: digestSchema,
    requestHash: digestSchema,
    scope: z.string().regex(/^workflow:[0-9a-f-]{36}:replay$/u),
    input: z
      .unknown()
      .refine((value) => value !== undefined, 'Replay input is required'),
    deadlineAt: z.date().optional(),
    requestId: requestIdentifierSchema.optional(),
    traceId: requestIdentifierSchema.optional(),
    traceparent: traceparentSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
    checkpointFactory: z.custom<InitialCheckpointFactory>(
      (value) => typeof value === 'function',
    ),
  })
  .strict();
const cancelInputSchema = z
  .object({
    actorId: actorSchema,
    workspaceId: z.uuid(),
    runId: z.uuid(),
    reason: z.string().trim().min(1).max(500).optional(),
    requestId: requestIdentifierSchema.optional(),
    traceId: requestIdentifierSchema.optional(),
    traceparent: traceparentSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();

export type StartPublishedWorkflowRunInput = Readonly<
  z.input<typeof startInputSchema>
>;
export type ReplayPublishedWorkflowRunInput = Readonly<
  z.input<typeof replayInputSchema>
>;
export type CancelWorkflowRunInput = Readonly<
  z.input<typeof cancelInputSchema>
>;
export interface WorkflowRunDatabase {
  usageCapacity(
    input: WorkspaceUsageCapacityInput,
  ): Promise<WorkspaceUsageCapacityRecord>;
  start(input: StartPublishedWorkflowRunInput): Promise<
    Readonly<{
      run: WorkflowRunRecord;
      replayed: boolean;
    }>
  >;
  replay(input: ReplayPublishedWorkflowRunInput): Promise<
    Readonly<{
      run: WorkflowRunRecord;
      replayed: boolean;
    }>
  >;
  get(input: GetWorkflowRunInput): Promise<WorkflowRunReadModel | undefined>;
  list(input: ListWorkflowRunsDatabaseInput): Promise<WorkflowRunListPage>;
  readInput(
    input: ReadWorkflowRunInputInput,
  ): Promise<WorkflowRunData | undefined>;
  readNodeRunOutput(
    input: ReadWorkflowNodeRunOutputInput,
  ): Promise<WorkflowRunData | undefined>;
  readNodeRunInput(
    input: ReadWorkflowNodeRunOutputInput,
  ): Promise<WorkflowRunData | undefined>;
  stepHealth(
    input: ReadWorkflowStepHealthInput,
  ): Promise<WorkflowStepHealthPage | undefined>;
  stepRuns(
    input: ReadWorkflowStepRunsInput,
  ): Promise<readonly WorkflowStepRunRecord[] | undefined>;
  statistics(
    input: WorkflowRunStatisticsDatabaseInput,
  ): Promise<WorkflowRunStatisticsRecord>;
  cancel(input: CancelWorkflowRunInput): Promise<
    Readonly<{
      run: WorkflowRunRecord;
      alreadyRequested: boolean;
      eventSequence: number | null;
    }>
  >;
  close(): Promise<void>;
}

export function createWorkflowRunDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkflowRunDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    start: async (input: StartPublishedWorkflowRunInput) => {
      const parsed = startInputSchema.parse(input);
      const result = await withWorkspaceTransaction(
        pool,
        parsed.workspaceId,
        async (transaction) => startInTransaction(transaction, parsed),
        parsed.signal === undefined ? {} : { signal: parsed.signal },
      );
      if ('kind' in result)
        throw new WorkflowPublishedVersionConflictError(
          result.expectedPublishedVersionId,
          result.observedPublishedVersionId,
        );
      return result;
    },
    replay: async (input: ReplayPublishedWorkflowRunInput) => {
      const parsed = replayInputSchema.parse(input);
      return withWorkspaceTransaction(
        pool,
        parsed.workspaceId,
        async (transaction) =>
          replayWorkflowRunInTransaction(transaction, parsed),
        parsed.signal === undefined ? {} : { signal: parsed.signal },
      );
    },
    get: (input: GetWorkflowRunInput) => readWorkflowRun(pool, input),
    list: (input: ListWorkflowRunsDatabaseInput) =>
      readWorkflowRunListPage(pool, input),
    readInput: (input: ReadWorkflowRunInputInput) =>
      readWorkflowRunInput(pool, input),
    readNodeRunOutput: (input: ReadWorkflowNodeRunOutputInput) =>
      readWorkflowNodeRunOutput(pool, input),
    readNodeRunInput: (input: ReadWorkflowNodeRunOutputInput) =>
      readWorkflowNodeRunInput(pool, input),
    stepHealth: (input: ReadWorkflowStepHealthInput) =>
      readWorkflowStepHealth(pool, input),
    stepRuns: (input: ReadWorkflowStepRunsInput) =>
      readWorkflowStepRuns(pool, input),
    statistics: (input: WorkflowRunStatisticsDatabaseInput) =>
      readWorkflowRunStatistics(pool, input),
    usageCapacity: (input: WorkspaceUsageCapacityInput) =>
      readWorkspaceUsageCapacity(pool, input),
    cancel: async (input: CancelWorkflowRunInput) => {
      const parsed = cancelInputSchema.parse(input);
      return withWorkspaceTransaction(
        pool,
        parsed.workspaceId,
        async (transaction) => cancelInTransaction(transaction, parsed),
        parsed.signal === undefined ? {} : { signal: parsed.signal },
      );
    },
    close: () => lease.close(),
  });
}

async function startInTransaction(
  transaction: WorkspaceTransaction,
  input: z.output<typeof startInputSchema>,
): Promise<
  Readonly<{ run: WorkflowRunRecord; replayed: boolean }> | ManualStartRejection
> {
  await lockManualStartCommand(transaction, input);
  const identity = {
    keyHash: input.idempotencyKeyHash,
    operation: 'workflow.run.accept' as const,
    requestHash: input.requestHash,
    scope: input.scope,
  };
  const replay = await readWorkflowRunAcceptanceReplay(transaction, identity);
  if (replay !== null) {
    const run = await readWorkflowRunRecord(transaction, replay.runId);
    if (run === undefined) throw new WorkflowRunNotFoundError();
    return Object.freeze({ run, replayed: true });
  }
  const rejection = await readManualStartRejection(transaction, input);
  if (rejection !== null) return rejection;

  const projection = await lockPublishedExecution(
    transaction,
    input.workflowId,
  );
  if (
    input.expectedPublishedVersionId !== undefined &&
    input.expectedPublishedVersionId !== projection.id
  ) {
    return recordManualStartRejection(
      transaction,
      input,
      input.expectedPublishedVersionId,
      projection.id,
    );
  }
  const initial = input.checkpointFactory(projection);
  return acceptWorkflowRunWithAudit(transaction, {
    acceptance: {
      engineVersion: initial.engineVersion,
      initialCheckpoint: initial.checkpoint,
      keyHash: input.idempotencyKeyHash,
      operation: 'workflow.run.accept',
      requestHash: input.requestHash,
      scope: input.scope,
      triggerType: 'manual',
      workflowId: input.workflowId,
      workflowVersionId: projection.id,
      ...(input.input === undefined ? {} : { runInput: input.input }),
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
    },
    actorId: input.actorId,
    auditAction: 'workflow.run.started',
    auditMetadata: sql`jsonb_build_object('schemaVersion', 1, 'workflowId', ${input.workflowId}::text, 'workflowVersionId', ${projection.id}::text)`,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  });
}

async function lockPublishedExecution(
  transaction: WorkspaceTransaction,
  workflowId: string,
): Promise<PublishedWorkflowV2Projection> {
  const result = await transaction.db.execute(sql<Record<string, unknown>>`
    select
      v.id,
      v.workspace_id,
      v.workflow_id,
      v.version_number,
      v.schema_version,
      v.checksum,
      v.executable_schema_version,
      v.executable_json
    from app.workflows w
    join app.workflow_versions v
      on v.workspace_id = w.workspace_id
     and v.workflow_id = w.id
     and v.id = w.published_version_id
    where w.workspace_id = ${transaction.workspaceId}
      and w.id = ${workflowId}
      and w.lifecycle_status = 'active'
    for share of w
  `);
  const classified = classifyPublishedWorkflowVersionRow(result.rows[0]);
  if (classified.kind !== 'v2_projection')
    throw new WorkflowRunNotExecutableError();
  if (
    classified.workflowVersion.workflowId !== workflowId ||
    classified.workflowVersion.workspaceId !== transaction.workspaceId
  )
    throw new WorkflowRunNotExecutableError();
  return classified.workflowVersion;
}

/**
 * Requests cancellation of every run in the workspace that has not finished
 * and is not already being canceled, as one actor with one reason.
 */
export async function requestActiveRunCancellations(
  transaction: WorkspaceTransaction,
  input: Readonly<{ actorId: string; reason: string }>,
): Promise<number> {
  const active = await transaction.db.execute<{ id: string }>(sql`
    select id from app.workflow_runs
    where workspace_id = ${transaction.workspaceId}
      and status in ('queued', 'running', 'waiting')
      and cancel_requested_at is null
    order by id
    for update
  `);
  for (const { id } of active.rows)
    await cancelInTransaction(transaction, {
      actorId: input.actorId,
      workspaceId: transaction.workspaceId,
      runId: id,
      reason: input.reason,
    });
  return active.rows.length;
}

async function cancelInTransaction(
  transaction: WorkspaceTransaction,
  input: z.output<typeof cancelInputSchema>,
): Promise<
  Readonly<{
    run: WorkflowRunRecord;
    alreadyRequested: boolean;
    eventSequence: number | null;
  }>
> {
  // The cancellation audit references workspace. Lifecycle/purge owns that
  // row before runs, so take its shared lock before the exclusive run lock.
  await transaction.db.execute(
    sql`select app.lock_workspace_run_admission(${transaction.workspaceId})`,
  );
  const cancellation = await requestWorkflowRunCancellation(transaction, {
    actor: input.actorId,
    runId: input.runId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
  if (!cancellation.duplicate) {
    const outboxEventId = generatePersistedId();
    const payload = {
      schemaVersion: 1,
      workspaceId: transaction.workspaceId,
      runId: input.runId,
      outboxEventId,
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
    } as const;
    await insertOutboxEvent(transaction, {
      id: outboxEventId,
      jobName: 'advance-workflow-run',
      schemaVersion: 1,
      aggregateType: 'workflow-run',
      aggregateId: input.runId,
      payload,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    });
    await insertWorkflowRunAudit(transaction, {
      action: 'workflow.run.cancel_requested',
      actorId: input.actorId,
      runId: input.runId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      metadata: sql`jsonb_build_object('schemaVersion', 1, 'reasonProvided', ${input.reason !== undefined}::boolean)`,
    });
  }
  const run = await readWorkflowRunRecord(transaction, input.runId);
  if (run === undefined) throw new WorkflowRunNotFoundError();
  return Object.freeze({
    run,
    alreadyRequested: cancellation.duplicate,
    eventSequence: cancellation.eventSequence,
  });
}
