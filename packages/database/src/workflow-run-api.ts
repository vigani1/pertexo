import { createDatabasePool } from './postgres-telemetry.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';
import {
  lockExpectedCompatibilityReleaseSet,
  parseCompatibilityReleaseExpectation,
  parseCompatibilityReleaseExpectationSet,
  type CompatibilityReleaseExpectation,
  type CompatibilityReleaseExpectationSet,
} from './compatibility-release.js';
import {
  acceptWorkflowRun,
  readWorkflowRunAcceptanceReplay,
} from './execution-acceptance.js';
import { canonicalOutboxPayloadChecksum, insertOutboxEvent } from './outbox.js';
import { generatePersistedId } from './persisted-id.js';
import {
  classifyPublishedWorkflowVersionRow,
  type PublishedWorkflowV2Projection,
} from './published-workflow-reader.js';
import { withWorkspaceTransaction } from './workspace.js';
import type { WorkspaceTransaction } from './workspace.js';
import { requestWorkflowRunCancellation } from './workflow-run-cancellation.js';

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
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

const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);
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
const triggerTypeSchema = z.enum([
  'api',
  'manual',
  'replay',
  'schedule',
  'webhook',
]);
const runRowSchema = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    workflow_id: z.uuid(),
    workflow_version_id: z.uuid(),
    status: runStatusSchema,
    trigger_type: triggerTypeSchema,
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    started_at: z.coerce.date().nullable(),
    completed_at: z.coerce.date().nullable(),
    deadline_at: z.coerce.date().nullable(),
    cancel_requested_at: z.coerce.date().nullable(),
  })
  .strict();
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

export type WorkflowRunRecord = Readonly<{
  id: string;
  workspaceId: string;
  workflowId: string;
  workflowVersionId: string;
  status: z.output<typeof runStatusSchema>;
  triggerType: z.output<typeof triggerTypeSchema>;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  deadlineAt: Date | null;
  cancelRequestedAt: Date | null;
}>;

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

export class WorkflowRunNotFoundError extends Error {
  public override readonly name = 'WorkflowRunNotFoundError';
}

export class WorkflowRunNotExecutableError extends Error {
  public override readonly name = 'WorkflowRunNotExecutableError';
}

export class WorkflowRunReadCapacityError extends Error {
  public override readonly name = 'WorkflowRunReadCapacityError';
}

export function createWorkflowRunDatabase(
  config: DatabaseConfig,
  compatibilityReleaseInput:
    CompatibilityReleaseExpectation | CompatibilityReleaseExpectationSet,
): WorkflowRunDatabase {
  const pool = createDatabasePool(config);
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
    close: async (): Promise<void> => pool.end(),
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
    const run = await readRunRecord(transaction, replay.runId);
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
  const accepted = await acceptWorkflowRun(transaction, {
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
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  });
  const run = await readRunRecord(transaction, accepted.runId);
  if (run === undefined) throw new WorkflowRunNotFoundError();
  if (!accepted.duplicate) {
    await insertAudit(transaction, {
      action: 'workflow.run.started',
      actorId: input.actorId,
      runId: run.id,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      metadata: sql`jsonb_build_object('schemaVersion', 1, 'workflowId', ${input.workflowId}::text, 'workflowVersionId', ${projection.id}::text)`,
    });
  }
  return Object.freeze({ run, replayed: accepted.duplicate });
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
    await insertAudit(transaction, {
      action: 'workflow.run.cancel_requested',
      actorId: input.actorId,
      runId: input.runId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      metadata: sql`jsonb_build_object('schemaVersion', 1, 'reasonProvided', ${input.reason !== undefined}::boolean)`,
    });
  }
  const run = await readRunRecord(transaction, input.runId);
  if (run === undefined) throw new WorkflowRunNotFoundError();
  return Object.freeze({
    run,
    alreadyRequested: cancellation.duplicate,
    eventSequence: cancellation.eventSequence,
  });
}

async function insertAudit(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    action: string;
    actorId: string;
    runId: string;
    requestId?: string;
    traceId?: string;
    metadata: ReturnType<typeof sql>;
  }>,
): Promise<void> {
  await transaction.db.execute(sql`
    insert into app.audit_events
      (id, workspace_id, actor_user_id, action, target_type, target_id,
       request_id, trace_id, metadata)
    values
      (${generatePersistedId()}, ${transaction.workspaceId}, ${input.actorId},
       ${input.action}, 'workflow_run', ${input.runId},
       ${input.requestId ?? null}, ${input.traceId ?? null}, ${input.metadata})
  `);
}

async function readRunModel(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<WorkflowRunReadModel | undefined> {
  const run = await readRunRecord(transaction, runId);
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

async function readRunRecord(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<WorkflowRunRecord | undefined> {
  const result = await transaction.db.execute(sql`
    select
      id,
      workspace_id,
      workflow_id,
      workflow_version_id,
      status,
      trigger_type,
      created_at,
      updated_at,
      started_at,
      completed_at,
      deadline_at,
      cancel_requested_at
    from app.workflow_runs
    where workspace_id = ${transaction.workspaceId} and id = ${runId}
    limit 1
  `);
  const row = result.rows[0];
  return row === undefined ? undefined : toRunRecord(row);
}

function toRunRecord(value: unknown): WorkflowRunRecord {
  const row = runRowSchema.parse(value);
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    status: row.status,
    triggerType: row.trigger_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    deadlineAt: row.deadline_at,
    cancelRequestedAt: row.cancel_requested_at,
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
