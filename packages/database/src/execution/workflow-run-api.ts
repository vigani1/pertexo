import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import {
  lockExpectedCompatibilityReleaseSet,
  parseCompatibilityReleaseExpectation,
  parseCompatibilityReleaseExpectationSet,
  type CompatibilityReleaseExpectation,
  type CompatibilityReleaseExpectationSet,
} from '../compatibility/compatibility-release.js';
import { readWorkflowRunAcceptanceReplay } from './execution-acceptance.js';
import { canonicalOutboxPayloadChecksum, insertOutboxEvent } from './outbox.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import {
  classifyPublishedWorkflowVersionRow,
  type PublishedWorkflowV2Projection,
} from './published-workflow-reader.js';
import { sha256HexSchema as digestSchema } from '../validation/persisted-primitives.js';
import { withWorkspaceTransaction } from '../tenant-access/workspace.js';
import type { WorkspaceTransaction } from '../tenant-access/workspace.js';
import { requestWorkflowRunCancellation } from './workflow-run-cancellation.js';
import {
  WorkflowRunNotExecutableError,
  WorkflowRunNotFoundError,
  WorkflowRunReadCapacityError,
} from './workflow-run-errors.js';
import {
  acceptWorkflowRunWithAudit,
  insertWorkflowRunAudit,
  readWorkflowRunRecord,
} from './workflow-run-persistence-support.js';
import type { WorkflowRunRecord } from './workflow-run-persistence-support.js';
import { replayWorkflowRunInTransaction } from './workflow-run-replay.js';

export {
  WorkflowRunNotExecutableError,
  WorkflowRunNotFoundError,
  WorkflowRunReadCapacityError,
} from './workflow-run-errors.js';
export type { WorkflowRunRecord } from './workflow-run-persistence-support.js';

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
    deadlineAt: z.date().optional(),
    requestId: requestIdentifierSchema.optional(),
    traceId: requestIdentifierSchema.optional(),
    traceparent: traceparentSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
    checkpointFactory: z.custom<WorkflowRunCheckpointFactory>(
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
    checkpointFactory: z.custom<WorkflowRunCheckpointFactory>(
      (value) => typeof value === 'function',
    ),
  })
  .strict();
const getInputSchema = z
  .object({
    workspaceId: z.uuid(),
    runId: z.uuid(),
    signal: z.instanceof(AbortSignal).optional(),
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

const nodeStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);
const nodeRowSchema = z
  .object({
    id: z.uuid(),
    node_id: z.string().min(1).max(128),
    invocation_key: z.string().min(1).max(256),
    status: nodeStatusSchema,
    current_attempt_number: z.number().int().nonnegative(),
    started_at: z.coerce.date().nullable(),
    completed_at: z.coerce.date().nullable(),
    resume_at: z.coerce.date().nullable(),
    safe_error_code: z.string().min(1).max(128).nullable(),
  })
  .strict();

export type WorkflowNodeRunRecord = Readonly<{
  id: string;
  nodeId: string;
  invocationKey: string;
  status: z.output<typeof nodeStatusSchema>;
  currentAttemptNumber: number;
  startedAt: Date | null;
  completedAt: Date | null;
  resumeAt: Date | null;
  safeErrorCode: string | null;
}>;

export type WorkflowRunReadModel = Readonly<{
  run: WorkflowRunRecord;
  nodes: readonly WorkflowNodeRunRecord[];
}>;

export type WorkflowRunCheckpointFactory = (
  projection: PublishedWorkflowV2Projection,
  currentCompatibilityRelease: CompatibilityReleaseExpectation,
) => Readonly<{ engineVersion: string; checkpoint: unknown }>;

export type StartPublishedWorkflowRunInput = Readonly<
  z.input<typeof startInputSchema>
>;
export type ReplayPublishedWorkflowRunInput = Readonly<
  z.input<typeof replayInputSchema>
>;
export type GetWorkflowRunInput = Readonly<z.input<typeof getInputSchema>>;
export type CancelWorkflowRunInput = Readonly<
  z.input<typeof cancelInputSchema>
>;

export interface WorkflowRunDatabase {
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
  compatibilityReleaseInput:
    CompatibilityReleaseExpectation | CompatibilityReleaseExpectationSet,
  runtime?: DatabaseRuntime,
): WorkflowRunDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  const compatibilityReleases = Array.isArray(compatibilityReleaseInput)
    ? parseCompatibilityReleaseExpectationSet(compatibilityReleaseInput)
    : Object.freeze([
        parseCompatibilityReleaseExpectation(compatibilityReleaseInput),
      ]);
  return Object.freeze({
    start: async (input: StartPublishedWorkflowRunInput) => {
      const parsed = startInputSchema.parse(input);
      return withWorkspaceTransaction(
        pool,
        parsed.workspaceId,
        async (transaction) =>
          startInTransaction(transaction, parsed, compatibilityReleases),
        parsed.signal === undefined ? {} : { signal: parsed.signal },
      );
    },
    replay: async (input: ReplayPublishedWorkflowRunInput) => {
      const parsed = replayInputSchema.parse(input);
      return withWorkspaceTransaction(
        pool,
        parsed.workspaceId,
        async (transaction) =>
          replayWorkflowRunInTransaction(
            transaction,
            parsed,
            compatibilityReleases,
          ),
        parsed.signal === undefined ? {} : { signal: parsed.signal },
      );
    },
    get: async (input: GetWorkflowRunInput) => {
      const parsed = getInputSchema.parse(input);
      return withWorkspaceTransaction(
        pool,
        parsed.workspaceId,
        async (transaction) => readRunModel(transaction, parsed.runId),
        parsed.signal === undefined ? {} : { signal: parsed.signal },
      );
    },
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
  compatibilityReleases: CompatibilityReleaseExpectationSet,
): Promise<Readonly<{ run: WorkflowRunRecord; replayed: boolean }>> {
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

  const currentCompatibilityRelease = await lockExpectedCompatibilityReleaseSet(
    transaction.db,
    compatibilityReleases,
  );

  const projection = await lockPublishedExecution(
    transaction,
    input.workflowId,
  );
  const initial = input.checkpointFactory(
    projection,
    currentCompatibilityRelease,
  );
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
      v.executable_json,
      v.compatibility_release_epoch
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

async function readRunModel(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<WorkflowRunReadModel | undefined> {
  const run = await readWorkflowRunRecord(transaction, runId);
  if (run === undefined) return undefined;
  const nodes = await transaction.db.execute(sql`
    select
      id,
      node_id,
      invocation_key,
      status,
      coalesce(current_attempt_number, 0) as current_attempt_number,
      started_at,
      completed_at,
      coalesce(retry_due_at, resume_at) as resume_at,
      safe_error_code
    from app.node_runs
    where workspace_id = ${transaction.workspaceId}
      and workflow_run_id = ${runId}
    order by created_at, id
    limit 1001
  `);
  if (nodes.rows.length > 1_000) throw new WorkflowRunReadCapacityError();
  return Object.freeze({
    run,
    nodes: Object.freeze(nodes.rows.map(toNodeRecord)),
  });
}

function toNodeRecord(value: unknown): WorkflowNodeRunRecord {
  const row = nodeRowSchema.parse(value);
  return Object.freeze({
    id: row.id,
    nodeId: row.node_id,
    invocationKey: row.invocation_key,
    status: row.status,
    currentAttemptNumber: row.current_attempt_number,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    resumeAt: row.resume_at,
    safeErrorCode: row.safe_error_code,
  });
}
