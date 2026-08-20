import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { canonicalOutboxPayloadChecksum, insertOutboxEvent } from './outbox.js';
import type { WorkspaceTransaction } from './workspace.js';

const boundedJson = (maximumBytes: number) =>
  z
    .json()
    .refine(
      (value) =>
        Buffer.byteLength(JSON.stringify(value), 'utf8') <= maximumBytes,
      `JSON value must not exceed ${String(maximumBytes)} UTF-8 bytes`,
    );
const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/u);
const actorSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u);

export const NODE_STATUS = {
  pending: 'pending',
  ready: 'ready',
  running: 'running',
  waiting: 'waiting',
  succeeded: 'succeeded',
  failed: 'failed',
  skipped: 'skipped',
  canceled: 'canceled',
  timedOut: 'timed_out',
  outcomeUnknown: 'outcome_unknown',
} as const;
export type NodeStatus = (typeof NODE_STATUS)[keyof typeof NODE_STATUS];

export const SIDE_EFFECT_CLASS = {
  safe: 'safe',
  idempotentWithKey: 'idempotent_with_key',
  unsafe: 'unsafe',
} as const;
export type SideEffectClass =
  (typeof SIDE_EFFECT_CLASS)[keyof typeof SIDE_EFFECT_CLASS];

export const RUN_EVENT_TYPE = {
  queued: 'run.queued',
  started: 'run.started',
  waiting: 'run.waiting',
  cancelRequested: 'run.cancel_requested',
  succeeded: 'run.succeeded',
  failed: 'run.failed',
  canceled: 'run.canceled',
  timedOut: 'run.timed_out',
  outcomeUnknown: 'run.outcome_unknown',
  nodeReady: 'node.ready',
  nodeStarted: 'node.started',
  nodeProgress: 'node.progress',
  nodeWaiting: 'node.waiting',
  nodeRetryScheduled: 'node.retry_scheduled',
  nodeSucceeded: 'node.succeeded',
  nodeFailed: 'node.failed',
  nodeSkipped: 'node.skipped',
  nodeCanceled: 'node.canceled',
  nodeTimedOut: 'node.timed_out',
  nodeOutcomeUnknown: 'node.outcome_unknown',
} as const;
export type RunEventType = (typeof RUN_EVENT_TYPE)[keyof typeof RUN_EVENT_TYPE];

const runEventSchema = z
  .object({
    type: z.enum(Object.values(RUN_EVENT_TYPE)),
    payload: boundedJson(4096),
  })
  .strict();

const admissionSchema = z
  .object({
    attemptId: z.uuid(),
    attemptNumber: z.number().int().positive(),
    branchContext: boundedJson(4096),
    inputRef: boundedJson(4096).nullable().optional(),
    invocationKey: identifierSchema,
    nodeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    nodeRunId: z.uuid(),
    providerIdempotencyKey: z.string().min(1).max(256).nullable().optional(),
    sideEffectClass: z.enum(Object.values(SIDE_EFFECT_CLASS)),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.sideEffectClass === SIDE_EFFECT_CLASS.idempotentWithKey &&
      value.providerIdempotencyKey == null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'idempotent_with_key admissions require a stable provider key',
        path: ['providerIdempotencyKey'],
      });
    }
  });

const coordinatorTransitionSchema = z
  .object({
    admissions: z.array(admissionSchema).max(64),
    engineVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    event: runEventSchema,
    expectedRevision: z.number().int().nonnegative(),
    nextRunStatus: z.enum([
      'running',
      'waiting',
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
    ]),
    resumeAt: z.date().nullable(),
    runId: z.uuid(),
    schedulerState: boundedJson(16_384),
    traceparent: z.string().max(256).optional(),
  })
  .strict();

export class ExecutionStateConflictError extends Error {
  public override readonly name: string = 'ExecutionStateConflictError';
}

export class CheckpointRevisionConflictError extends ExecutionStateConflictError {
  public override readonly name = 'CheckpointRevisionConflictError';

  public constructor() {
    super('execution.checkpoint_revision_conflict');
  }
}

export class AttemptFenceConflictError extends ExecutionStateConflictError {
  public override readonly name = 'AttemptFenceConflictError';

  public constructor() {
    super('execution.attempt_fence_conflict');
  }
}

export class AttemptReconciliationRequiredError extends ExecutionStateConflictError {
  public override readonly name = 'AttemptReconciliationRequiredError';

  public constructor() {
    super('execution.attempt_reconciliation_required');
  }
}

export class RunEventGapError extends ExecutionStateConflictError {
  public override readonly name = 'RunEventGapError';

  public constructor() {
    super('execution.run_event_gap');
  }
}

async function lockRun(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<{
  cancelRequestedAt: Date | null;
  deadlineAt: Date | null;
  status: string;
}> {
  const result = await transaction.db.execute<{
    cancel_requested_at: Date | null;
    deadline_at: Date | null;
    status: string;
  }>(sql`
    select status, cancel_requested_at, deadline_at
    from app.workflow_runs
    where workspace_id = ${transaction.workspaceId} and id = ${runId}
    for update
  `);
  const row = result.rows[0];
  if (row === undefined)
    throw new ExecutionStateConflictError('execution.run_not_found');
  return {
    cancelRequestedAt: row.cancel_requested_at,
    deadlineAt: row.deadline_at === null ? null : new Date(row.deadline_at),
    status: row.status,
  };
}

async function findAttemptRunId(
  transaction: WorkspaceTransaction,
  attemptId: string,
): Promise<string> {
  const result = await transaction.db.execute<{ run_id: string }>(sql`
    select n.workflow_run_id as run_id
    from app.node_attempts a
    join app.node_runs n on n.workspace_id = a.workspace_id and n.id = a.node_run_id
    where a.workspace_id = ${transaction.workspaceId} and a.id = ${attemptId}
  `);
  const runId = result.rows[0]?.run_id;
  if (runId === undefined) {
    throw new ExecutionStateConflictError('execution.attempt_not_found');
  }
  return runId;
}

async function appendLockedRunEvent(
  transaction: WorkspaceTransaction,
  runId: string,
  event: z.input<typeof runEventSchema>,
): Promise<number> {
  const parsed = runEventSchema.parse(event);
  const result = await transaction.db.execute<{ sequence: number }>(sql`
    insert into app.run_events (workspace_id, workflow_run_id, sequence, type, payload)
    select
      ${transaction.workspaceId},
      ${runId},
      coalesce(max(sequence), 0) + 1,
      ${parsed.type},
      ${JSON.stringify(parsed.payload)}::jsonb
    from app.run_events
    where workspace_id = ${transaction.workspaceId}
      and workflow_run_id = ${runId}
    returning sequence
  `);
  const sequence = result.rows[0]?.sequence;
  if (sequence === undefined)
    throw new Error('Run event insert returned no sequence');
  return sequence;
}

export async function appendRunEvent(
  transaction: WorkspaceTransaction,
  input: Readonly<{ runId: string; event: z.input<typeof runEventSchema> }>,
): Promise<number> {
  const runId = z.uuid().parse(input.runId);
  await lockRun(transaction, runId);
  return appendLockedRunEvent(transaction, runId, input.event);
}

const readRunEventsSchema = z
  .object({
    afterSequence: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(500),
    runId: z.uuid(),
  })
  .strict();

export type PersistedRunEvent = Readonly<{
  createdAt: Date;
  payload: unknown;
  sequence: number;
  type: RunEventType;
}>;

export type RunEventPage = Readonly<{
  events: readonly PersistedRunEvent[];
  hasMore: boolean;
  highWaterSequence: number;
}>;

export async function readRunEventsAfter(
  transaction: WorkspaceTransaction,
  input: Readonly<z.input<typeof readRunEventsSchema>>,
): Promise<RunEventPage> {
  const parsed = readRunEventsSchema.parse(input);
  const run = await transaction.db.execute<{ high_water: number }>(sql`
    select coalesce(max(e.sequence), 0)::integer as high_water
    from app.workflow_runs r
    left join app.run_events e
      on e.workspace_id = r.workspace_id and e.workflow_run_id = r.id
    where r.workspace_id = ${transaction.workspaceId} and r.id = ${parsed.runId}
    group by r.id
  `);
  const highWaterSequence = run.rows[0]?.high_water;
  if (highWaterSequence === undefined) {
    throw new ExecutionStateConflictError('execution.run_not_found');
  }
  const result = await transaction.db.execute<{
    created_at: Date;
    payload: unknown;
    sequence: number;
    type: RunEventType;
  }>(sql`
    select sequence, type, payload, created_at
    from app.run_events
    where workspace_id = ${transaction.workspaceId}
      and workflow_run_id = ${parsed.runId}
      and sequence > ${parsed.afterSequence}
    order by sequence
    limit ${parsed.limit + 1}
  `);
  const pageRows = result.rows.slice(0, parsed.limit);
  for (const [index, row] of pageRows.entries()) {
    if (row.sequence !== parsed.afterSequence + index + 1) {
      throw new RunEventGapError();
    }
  }
  const events = pageRows.map((row) =>
    Object.freeze({
      createdAt: new Date(row.created_at),
      payload: row.payload,
      sequence: row.sequence,
      type: row.type,
    }),
  );
  return Object.freeze({
    events: Object.freeze(events),
    hasMore: result.rows.length > parsed.limit,
    highWaterSequence,
  });
}

const terminalRunStatuses = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);

const allowedRunTransitions: Readonly<Record<string, ReadonlySet<string>>> = {
  queued: new Set(['running', 'canceled', 'timed_out']),
  running: new Set([
    'waiting',
    'succeeded',
    'failed',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ]),
  waiting: new Set([
    'running',
    'succeeded',
    'failed',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ]),
};

export type CoordinatorTransitionInput = Readonly<
  z.input<typeof coordinatorTransitionSchema>
>;

export async function commitCoordinatorTransition(
  transaction: WorkspaceTransaction,
  input: CoordinatorTransitionInput,
): Promise<
  Readonly<{ revision: number; admittedAttemptIds: readonly string[] }>
> {
  const parsed = coordinatorTransitionSchema.parse(input);
  const checkpoint = await transaction.db.execute<{ revision: number }>(sql`
    select revision
    from app.run_checkpoints
    where workspace_id = ${transaction.workspaceId}
      and workflow_run_id = ${parsed.runId}
    for update
  `);
  if (checkpoint.rows[0]?.revision !== parsed.expectedRevision) {
    throw new CheckpointRevisionConflictError();
  }
  const run = await lockRun(transaction, parsed.runId);
  if (!allowedRunTransitions[run.status]?.has(parsed.nextRunStatus)) {
    throw new ExecutionStateConflictError('execution.invalid_run_transition');
  }
  if (
    run.deadlineAt !== null &&
    run.deadlineAt <= new Date() &&
    parsed.nextRunStatus !== 'timed_out'
  ) {
    throw new ExecutionStateConflictError('execution.run_deadline_expired');
  }
  if (run.cancelRequestedAt !== null && parsed.admissions.length > 0) {
    throw new ExecutionStateConflictError('execution.cancel_stops_admission');
  }

  const nextRevision = parsed.expectedRevision + 1;
  const checkpointUpdate = await transaction.db.execute(sql`
    update app.run_checkpoints
    set revision = ${nextRevision},
        engine_version = ${parsed.engineVersion},
        scheduler_state = ${JSON.stringify(parsed.schedulerState)}::jsonb,
        resume_at = ${parsed.resumeAt},
        resume_lease_owner = null,
        resume_lease_token = null,
        resume_lease_expires_at = null,
        updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId}
      and workflow_run_id = ${parsed.runId}
      and revision = ${parsed.expectedRevision}
  `);
  if (checkpointUpdate.rowCount !== 1)
    throw new CheckpointRevisionConflictError();

  await transaction.db.execute(sql`
    update app.workflow_runs
    set status = ${parsed.nextRunStatus},
        started_at = case when ${parsed.nextRunStatus} = 'running' then coalesce(started_at, clock_timestamp()) else started_at end,
        completed_at = case when ${terminalRunStatuses.has(parsed.nextRunStatus)} then clock_timestamp() else null end,
        updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId} and id = ${parsed.runId}
  `);
  await appendLockedRunEvent(transaction, parsed.runId, parsed.event);

  const admittedAttemptIds: string[] = [];
  for (const admission of parsed.admissions) {
    await transaction.db.execute(sql`
      insert into app.node_runs (
        id, workspace_id, workflow_run_id, node_id, invocation_key,
        branch_context, status, side_effect_class, provider_idempotency_key,
        input_ref, current_attempt_id, current_attempt_number
      ) values (
        ${admission.nodeRunId}, ${transaction.workspaceId}, ${parsed.runId},
        ${admission.nodeId}, ${admission.invocationKey},
        ${JSON.stringify(admission.branchContext)}::jsonb, 'ready',
        ${admission.sideEffectClass}, ${admission.providerIdempotencyKey ?? null},
        ${admission.inputRef == null ? null : JSON.stringify(admission.inputRef)}::jsonb,
        ${admission.attemptId}, ${admission.attemptNumber}
      )
    `);
    await transaction.db.execute(sql`
      insert into app.node_attempts (
        id, workspace_id, node_run_id, attempt_number, status,
        side_effect_class, provider_idempotency_key
      ) values (
        ${admission.attemptId}, ${transaction.workspaceId}, ${admission.nodeRunId},
        ${admission.attemptNumber}, 'ready', ${admission.sideEffectClass},
        ${admission.providerIdempotencyKey ?? null}
      )
    `);
    const eventPayload = {
      attemptId: admission.attemptId,
      attemptNumber: admission.attemptNumber,
      invocationKey: admission.invocationKey,
      nodeRunId: admission.nodeRunId,
    };
    await appendLockedRunEvent(transaction, parsed.runId, {
      type: RUN_EVENT_TYPE.nodeReady,
      payload: eventPayload,
    });
    const outboxEventId = randomUUID();
    const payload = {
      attemptId: admission.attemptId,
      nodeRunId: admission.nodeRunId,
      outboxEventId,
      runId: parsed.runId,
      schemaVersion: 1,
      workspaceId: transaction.workspaceId,
      ...(parsed.traceparent === undefined
        ? {}
        : { traceparent: parsed.traceparent }),
    };
    await insertOutboxEvent(transaction, {
      id: outboxEventId,
      aggregateId: admission.attemptId,
      aggregateType: 'node-attempt',
      jobName: 'execute-node-attempt',
      payload,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
      schemaVersion: 1,
    });
    admittedAttemptIds.push(admission.attemptId);
  }
  return Object.freeze({
    admittedAttemptIds: Object.freeze(admittedAttemptIds),
    revision: nextRevision,
  });
}

const claimAttemptSchema = z
  .object({
    attemptId: z.uuid(),
    leaseDurationSeconds: z.number().int().min(1).max(300),
    workerId: actorSchema,
  })
  .strict();

export type AttemptLease = Readonly<{
  attemptId: string;
  fenceToken: number;
  leaseExpiresAt: Date;
  nodeRunId: string;
}>;

export async function claimNodeAttempt(
  transaction: WorkspaceTransaction,
  input: Readonly<z.input<typeof claimAttemptSchema>>,
): Promise<AttemptLease | null> {
  const parsed = claimAttemptSchema.parse(input);
  const candidateRunId = await findAttemptRunId(transaction, parsed.attemptId);
  await lockRun(transaction, candidateRunId);
  const locked = await transaction.db.execute<{
    cancel_requested_at: Date | null;
    deadline_at: Date | null;
    dispatch_marked_at: Date | null;
    fence_token: string;
    lease_expires_at: Date | null;
    node_run_id: string;
    run_id: string;
    status: string;
  }>(sql`
    select a.status, a.node_run_id, a.fence_token, a.lease_expires_at,
           a.dispatch_marked_at, r.id as run_id, r.cancel_requested_at,
           r.deadline_at
    from app.node_attempts a
    join app.node_runs n on n.workspace_id = a.workspace_id and n.id = a.node_run_id
    join app.workflow_runs r on r.workspace_id = n.workspace_id and r.id = n.workflow_run_id
    where a.workspace_id = ${transaction.workspaceId} and a.id = ${parsed.attemptId}
    for update of a, n
  `);
  const row = locked.rows[0];
  if (row === undefined)
    throw new ExecutionStateConflictError('execution.attempt_not_found');
  if (
    row.status === 'running' &&
    row.lease_expires_at !== null &&
    row.lease_expires_at > new Date()
  )
    return null;
  if (row.status === 'running' && row.dispatch_marked_at !== null) {
    throw new AttemptReconciliationRequiredError();
  }
  if (row.status !== 'ready' && row.status !== 'running') return null;
  if (row.cancel_requested_at !== null) return null;
  if (row.deadline_at !== null && new Date(row.deadline_at) <= new Date()) {
    return null;
  }

  const result = await transaction.db.execute<{
    fence_token: string;
    lease_expires_at: Date;
  }>(sql`
    update app.node_attempts
    set status = 'running', lease_owner = ${parsed.workerId},
        lease_expires_at = clock_timestamp() + make_interval(secs => ${parsed.leaseDurationSeconds}),
        fence_token = fence_token + 1,
        started_at = coalesce(started_at, clock_timestamp()),
        updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId} and id = ${parsed.attemptId}
    returning fence_token, lease_expires_at
  `);
  await transaction.db.execute(sql`
    update app.node_runs
    set status = 'running', started_at = coalesce(started_at, clock_timestamp()), updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId} and id = ${row.node_run_id}
  `);
  await appendLockedRunEvent(transaction, row.run_id, {
    type: RUN_EVENT_TYPE.nodeStarted,
    payload: { attemptId: parsed.attemptId, nodeRunId: row.node_run_id },
  });
  const claimed = result.rows[0];
  if (claimed === undefined)
    throw new ExecutionStateConflictError('execution.attempt_claim_lost');
  return Object.freeze({
    attemptId: parsed.attemptId,
    fenceToken: Number(claimed.fence_token),
    leaseExpiresAt: new Date(claimed.lease_expires_at),
    nodeRunId: row.node_run_id,
  });
}

const ownedAttemptSchema = z
  .object({
    attemptId: z.uuid(),
    fenceToken: z.number().int().positive(),
    workerId: actorSchema,
  })
  .strict();

export async function markNodeAttemptDispatched(
  transaction: WorkspaceTransaction,
  input: Readonly<z.input<typeof ownedAttemptSchema>>,
): Promise<Date> {
  const parsed = ownedAttemptSchema.parse(input);
  const result = await transaction.db.execute<{ dispatch_marked_at: Date }>(sql`
    update app.node_attempts
    set dispatch_marked_at = coalesce(dispatch_marked_at, clock_timestamp()),
        updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId} and id = ${parsed.attemptId}
      and status = 'running' and lease_owner = ${parsed.workerId}
      and fence_token = ${parsed.fenceToken}
      and lease_expires_at > clock_timestamp()
    returning dispatch_marked_at
  `);
  const dispatchedAt = result.rows[0]?.dispatch_marked_at;
  if (dispatchedAt === undefined) throw new AttemptFenceConflictError();
  return new Date(dispatchedAt);
}

export async function heartbeatNodeAttempt(
  transaction: WorkspaceTransaction,
  input: Readonly<
    z.input<typeof ownedAttemptSchema> & { leaseDurationSeconds: number }
  >,
): Promise<Date> {
  const parsed = ownedAttemptSchema
    .extend({
      leaseDurationSeconds: z.number().int().min(1).max(300),
    })
    .parse(input);
  const result = await transaction.db.execute<{ lease_expires_at: Date }>(sql`
    update app.node_attempts
    set lease_expires_at = clock_timestamp() + make_interval(secs => ${parsed.leaseDurationSeconds}),
        updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId} and id = ${parsed.attemptId}
      and status = 'running' and lease_owner = ${parsed.workerId}
      and fence_token = ${parsed.fenceToken}
      and lease_expires_at > clock_timestamp()
    returning lease_expires_at
  `);
  const expiresAt = result.rows[0]?.lease_expires_at;
  if (expiresAt === undefined) throw new AttemptFenceConflictError();
  return new Date(expiresAt);
}

const terminalAttemptSchema = ownedAttemptSchema
  .extend({
    errorSummary: z.string().max(2048).nullable().optional(),
    outputRef: boundedJson(4096).nullable().optional(),
    safeErrorCode: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
      .nullable()
      .optional(),
    status: z.enum([
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
    ]),
    traceparent: z.string().max(256).optional(),
  })
  .strict();

const delayedAttemptSchema = ownedAttemptSchema
  .extend({
    dueAt: z.date(),
    safeErrorCode: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
      .nullable()
      .optional(),
  })
  .strict();

const nodeTerminalEvent: Readonly<Record<string, RunEventType>> = {
  succeeded: RUN_EVENT_TYPE.nodeSucceeded,
  failed: RUN_EVENT_TYPE.nodeFailed,
  canceled: RUN_EVENT_TYPE.nodeCanceled,
  timed_out: RUN_EVENT_TYPE.nodeTimedOut,
  outcome_unknown: RUN_EVENT_TYPE.nodeOutcomeUnknown,
};

export async function completeNodeAttempt(
  transaction: WorkspaceTransaction,
  input: Readonly<z.input<typeof terminalAttemptSchema>>,
): Promise<Readonly<{ duplicate: boolean; outboxEventId: string | null }>> {
  const parsed = terminalAttemptSchema.parse(input);
  const candidateRunId = await findAttemptRunId(transaction, parsed.attemptId);
  await lockRun(transaction, candidateRunId);
  const locked = await transaction.db.execute<{
    fence_token: string;
    lease_owner: string | null;
    node_run_id: string;
    run_id: string;
    status: string;
  }>(sql`
    select a.status, a.fence_token, a.lease_owner, a.node_run_id,
           n.workflow_run_id as run_id
    from app.node_attempts a
    join app.node_runs n on n.workspace_id = a.workspace_id and n.id = a.node_run_id
    where a.workspace_id = ${transaction.workspaceId} and a.id = ${parsed.attemptId}
    for update of a, n
  `);
  const row = locked.rows[0];
  if (row === undefined)
    throw new ExecutionStateConflictError('execution.attempt_not_found');
  if (terminalRunStatuses.has(row.status)) {
    if (row.status !== parsed.status)
      throw new ExecutionStateConflictError(
        'execution.attempt_terminal_conflict',
      );
    return Object.freeze({ duplicate: true, outboxEventId: null });
  }
  if (
    row.status !== 'running' ||
    row.lease_owner !== parsed.workerId ||
    Number(row.fence_token) !== parsed.fenceToken
  )
    throw new AttemptFenceConflictError();

  await transaction.db.execute(sql`
    update app.node_attempts
    set status = ${parsed.status}, lease_owner = null, lease_expires_at = null,
        output_ref = ${parsed.outputRef == null ? null : JSON.stringify(parsed.outputRef)}::jsonb,
        safe_error_code = ${parsed.safeErrorCode ?? null},
        error_summary = ${parsed.errorSummary ?? null},
        completed_at = clock_timestamp(), updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId} and id = ${parsed.attemptId}
  `);
  await transaction.db.execute(sql`
    update app.node_runs
    set status = ${parsed.status},
        output_ref = ${parsed.outputRef == null ? null : JSON.stringify(parsed.outputRef)}::jsonb,
        safe_error_code = ${parsed.safeErrorCode ?? null},
        completed_at = clock_timestamp(), updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId} and id = ${row.node_run_id}
      and current_attempt_id = ${parsed.attemptId}
  `);
  const terminalEventType = nodeTerminalEvent[parsed.status];
  if (terminalEventType === undefined) {
    throw new ExecutionStateConflictError('execution.terminal_event_missing');
  }
  await appendLockedRunEvent(transaction, row.run_id, {
    type: terminalEventType,
    payload: {
      attemptId: parsed.attemptId,
      nodeRunId: row.node_run_id,
      ...(parsed.safeErrorCode == null
        ? {}
        : { safeErrorCode: parsed.safeErrorCode }),
      ...(parsed.outputRef == null ? {} : { outputRef: parsed.outputRef }),
    },
  });
  const outboxEventId = randomUUID();
  const payload = {
    outboxEventId,
    runId: row.run_id,
    schemaVersion: 1,
    workspaceId: transaction.workspaceId,
    ...(parsed.traceparent === undefined
      ? {}
      : { traceparent: parsed.traceparent }),
  };
  await insertOutboxEvent(transaction, {
    aggregateId: row.run_id,
    aggregateType: 'workflow-run',
    id: outboxEventId,
    jobName: 'advance-workflow-run',
    payload,
    payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    schemaVersion: 1,
  });
  return Object.freeze({ duplicate: false, outboxEventId });
}

async function delayOwnedAttempt(
  transaction: WorkspaceTransaction,
  input: Readonly<z.input<typeof delayedAttemptSchema>>,
  kind: 'retry' | 'wait',
): Promise<void> {
  const parsed = delayedAttemptSchema.parse(input);
  const candidateRunId = await findAttemptRunId(transaction, parsed.attemptId);
  await lockRun(transaction, candidateRunId);
  const locked = await transaction.db.execute<{
    fence_token: string;
    lease_owner: string | null;
    node_run_id: string;
    run_id: string;
    status: string;
  }>(sql`
    select a.status, a.fence_token, a.lease_owner, a.node_run_id,
           n.workflow_run_id as run_id
    from app.node_attempts a
    join app.node_runs n on n.workspace_id = a.workspace_id and n.id = a.node_run_id
    where a.workspace_id = ${transaction.workspaceId} and a.id = ${parsed.attemptId}
    for update of a, n
  `);
  const row = locked.rows[0];
  if (
    row?.status !== 'running' ||
    row.lease_owner !== parsed.workerId ||
    Number(row.fence_token) !== parsed.fenceToken
  )
    throw new AttemptFenceConflictError();
  const attemptStatus = kind === 'retry' ? 'failed' : 'succeeded';
  await transaction.db.execute(sql`
    update app.node_attempts
    set status = ${attemptStatus}, lease_owner = null, lease_expires_at = null,
        safe_error_code = ${parsed.safeErrorCode ?? null},
        completed_at = clock_timestamp(), updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId} and id = ${parsed.attemptId}
  `);
  await transaction.db.execute(sql`
    update app.node_runs
    set status = 'waiting',
        resume_at = ${kind === 'wait' ? parsed.dueAt : null},
        retry_due_at = ${kind === 'retry' ? parsed.dueAt : null},
        safe_error_code = ${parsed.safeErrorCode ?? null},
        updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId} and id = ${row.node_run_id}
      and current_attempt_id = ${parsed.attemptId}
  `);
  await appendLockedRunEvent(transaction, row.run_id, {
    type:
      kind === 'retry'
        ? RUN_EVENT_TYPE.nodeRetryScheduled
        : RUN_EVENT_TYPE.nodeWaiting,
    payload: {
      attemptId: parsed.attemptId,
      dueAt: parsed.dueAt.toISOString(),
      nodeRunId: row.node_run_id,
      ...(parsed.safeErrorCode == null
        ? {}
        : { safeErrorCode: parsed.safeErrorCode }),
    },
  });
}

export async function scheduleNodeAttemptRetry(
  transaction: WorkspaceTransaction,
  input: Readonly<z.input<typeof delayedAttemptSchema>>,
): Promise<void> {
  await delayOwnedAttempt(transaction, input, 'retry');
}

export async function suspendNodeAttemptUntil(
  transaction: WorkspaceTransaction,
  input: Readonly<z.input<typeof delayedAttemptSchema>>,
): Promise<void> {
  await delayOwnedAttempt(transaction, input, 'wait');
}

export type DueNodeRun = Readonly<{
  attemptNumber: number;
  dueAt: Date;
  kind: 'retry' | 'wait';
  nodeRunId: string;
  runId: string;
}>;

export async function readDueNodeRuns(
  transaction: WorkspaceTransaction,
  limitInput: number,
): Promise<readonly DueNodeRun[]> {
  const limit = z.number().int().min(1).max(100).parse(limitInput);
  const result = await transaction.db.execute<{
    current_attempt_number: number;
    due_at: Date;
    kind: 'retry' | 'wait';
    node_run_id: string;
    run_id: string;
  }>(sql`
    select id as node_run_id, workflow_run_id as run_id,
           current_attempt_number,
           case when retry_due_at is not null then 'retry' else 'wait' end as kind,
           coalesce(retry_due_at, resume_at) as due_at
    from app.node_runs
    where workspace_id = ${transaction.workspaceId} and status = 'waiting'
      and coalesce(retry_due_at, resume_at) <= clock_timestamp()
    order by coalesce(retry_due_at, resume_at), id
    limit ${limit}
  `);
  return Object.freeze(
    result.rows.map((row) =>
      Object.freeze({
        attemptNumber: row.current_attempt_number,
        dueAt: new Date(row.due_at),
        kind: row.kind,
        nodeRunId: row.node_run_id,
        runId: row.run_id,
      }),
    ),
  );
}

const dueNodeAdmissionSchema = z
  .object({
    attemptId: z.uuid(),
    engineVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    expectedAttemptNumber: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    nodeRunId: z.uuid(),
    schedulerState: boundedJson(16_384),
    traceparent: z.string().max(256).optional(),
  })
  .strict();

export async function commitDueNodeAdmission(
  transaction: WorkspaceTransaction,
  input: Readonly<z.input<typeof dueNodeAdmissionSchema>>,
): Promise<Readonly<{ attemptNumber: number; revision: number }>> {
  const parsed = dueNodeAdmissionSchema.parse(input);
  const checkpoint = await transaction.db.execute<{
    revision: number;
    workflow_run_id: string;
  }>(sql`
    select c.revision, c.workflow_run_id
    from app.run_checkpoints c
    join app.node_runs n on n.workflow_run_id = c.workflow_run_id
      and n.workspace_id = c.workspace_id
    where c.workspace_id = ${transaction.workspaceId}
      and n.id = ${parsed.nodeRunId}
    for update of c
  `);
  const checkpointRow = checkpoint.rows[0];
  if (checkpointRow?.revision !== parsed.expectedRevision) {
    throw new CheckpointRevisionConflictError();
  }
  const run = await lockRun(transaction, checkpointRow.workflow_run_id);
  if (run.cancelRequestedAt !== null) {
    throw new ExecutionStateConflictError('execution.cancel_stops_admission');
  }
  const node = await transaction.db.execute<{
    current_attempt_number: number;
    provider_idempotency_key: string | null;
    side_effect_class: SideEffectClass;
    status: string;
  }>(sql`
    select status, current_attempt_number, side_effect_class,
           provider_idempotency_key
    from app.node_runs
    where workspace_id = ${transaction.workspaceId} and id = ${parsed.nodeRunId}
      and status = 'waiting'
      and coalesce(retry_due_at, resume_at) <= clock_timestamp()
    for update
  `);
  const nodeRow = node.rows[0];
  if (nodeRow?.current_attempt_number !== parsed.expectedAttemptNumber)
    throw new ExecutionStateConflictError('execution.node_due_state_conflict');
  const attemptNumber = parsed.expectedAttemptNumber + 1;
  await transaction.db.execute(sql`
    insert into app.node_attempts (
      id, workspace_id, node_run_id, attempt_number, status,
      side_effect_class, provider_idempotency_key
    ) values (
      ${parsed.attemptId}, ${transaction.workspaceId}, ${parsed.nodeRunId},
      ${attemptNumber}, 'ready', ${nodeRow.side_effect_class},
      ${nodeRow.provider_idempotency_key}
    )
  `);
  await transaction.db.execute(sql`
    update app.node_runs
    set status = 'ready', current_attempt_id = ${parsed.attemptId},
        current_attempt_number = ${attemptNumber}, resume_at = null,
        retry_due_at = null, updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId} and id = ${parsed.nodeRunId}
  `);
  const revision = parsed.expectedRevision + 1;
  await transaction.db.execute(sql`
    update app.run_checkpoints
    set revision = ${revision}, engine_version = ${parsed.engineVersion},
        scheduler_state = ${JSON.stringify(parsed.schedulerState)}::jsonb,
        updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId}
      and workflow_run_id = ${checkpointRow.workflow_run_id}
      and revision = ${parsed.expectedRevision}
  `);
  await appendLockedRunEvent(transaction, checkpointRow.workflow_run_id, {
    type: RUN_EVENT_TYPE.nodeReady,
    payload: {
      attemptId: parsed.attemptId,
      attemptNumber,
      nodeRunId: parsed.nodeRunId,
    },
  });
  const outboxEventId = randomUUID();
  const payload = {
    attemptId: parsed.attemptId,
    outboxEventId,
    schemaVersion: 1,
    workspaceId: transaction.workspaceId,
    ...(parsed.traceparent === undefined
      ? {}
      : { traceparent: parsed.traceparent }),
  };
  await insertOutboxEvent(transaction, {
    aggregateId: parsed.attemptId,
    aggregateType: 'node-attempt',
    id: outboxEventId,
    jobName: 'execute-node-attempt',
    payload,
    payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    schemaVersion: 1,
  });
  return Object.freeze({ attemptNumber, revision });
}

const cancellationSchema = z
  .object({
    actor: actorSchema,
    reason: z.string().min(1).max(512).nullable().optional(),
    runId: z.uuid(),
  })
  .strict();

export async function requestWorkflowRunCancellation(
  transaction: WorkspaceTransaction,
  input: Readonly<z.input<typeof cancellationSchema>>,
): Promise<Readonly<{ duplicate: boolean; requestedAt: Date }>> {
  const parsed = cancellationSchema.parse(input);
  const result = await transaction.db.execute<{
    cancel_reason: string | null;
    cancel_requested_at: Date | null;
    cancel_requested_by: string | null;
    status: string;
  }>(sql`
    select status, cancel_requested_at, cancel_requested_by, cancel_reason
    from app.workflow_runs
    where workspace_id = ${transaction.workspaceId} and id = ${parsed.runId}
    for update
  `);
  const row = result.rows[0];
  if (row === undefined)
    throw new ExecutionStateConflictError('execution.run_not_found');
  if (terminalRunStatuses.has(row.status))
    throw new ExecutionStateConflictError('execution.run_terminal');
  if (row.cancel_requested_at !== null) {
    if (
      row.cancel_requested_by !== parsed.actor ||
      row.cancel_reason !== (parsed.reason ?? null)
    ) {
      throw new ExecutionStateConflictError(
        'execution.cancel_request_conflict',
      );
    }
    return Object.freeze({
      duplicate: true,
      requestedAt: new Date(row.cancel_requested_at),
    });
  }
  const updated = await transaction.db.execute<{
    cancel_requested_at: Date;
  }>(sql`
    update app.workflow_runs
    set cancel_requested_at = clock_timestamp(), cancel_requested_by = ${parsed.actor},
        cancel_reason = ${parsed.reason ?? null}, updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId} and id = ${parsed.runId}
    returning cancel_requested_at
  `);
  await appendLockedRunEvent(transaction, parsed.runId, {
    type: RUN_EVENT_TYPE.cancelRequested,
    payload: {
      actor: parsed.actor,
      ...(parsed.reason == null ? {} : { reason: parsed.reason }),
    },
  });
  const cancellation = updated.rows[0];
  if (cancellation === undefined) {
    throw new ExecutionStateConflictError('execution.cancel_update_lost');
  }
  return Object.freeze({
    duplicate: false,
    requestedAt: new Date(cancellation.cancel_requested_at),
  });
}

const dueWaitSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    traceparent: z.string().max(256).optional(),
  })
  .strict();

export async function dispatchDueWorkflowWaits(
  transaction: WorkspaceTransaction,
  input: Readonly<z.input<typeof dueWaitSchema>>,
): Promise<readonly Readonly<{ outboxEventId: string; runId: string }>[]> {
  const parsed = dueWaitSchema.parse(input);
  const due = await transaction.db.execute<{ workflow_run_id: string }>(sql`
    select workflow_run_id
    from app.run_checkpoints
    where workspace_id = ${transaction.workspaceId}
      and resume_at <= clock_timestamp()
      and (resume_lease_expires_at is null or resume_lease_expires_at <= clock_timestamp())
    order by resume_at, workflow_run_id
    limit ${parsed.limit}
    for update skip locked
  `);
  const dispatched: { outboxEventId: string; runId: string }[] = [];
  for (const row of due.rows) {
    await transaction.db.execute(sql`
      update app.run_checkpoints
      set resume_at = null, resume_lease_owner = null, resume_lease_token = null,
          resume_lease_expires_at = null, updated_at = clock_timestamp()
      where workspace_id = ${transaction.workspaceId} and workflow_run_id = ${row.workflow_run_id}
    `);
    const outboxEventId = randomUUID();
    const payload = {
      outboxEventId,
      runId: row.workflow_run_id,
      schemaVersion: 1,
      workspaceId: transaction.workspaceId,
      ...(parsed.traceparent === undefined
        ? {}
        : { traceparent: parsed.traceparent }),
    };
    await insertOutboxEvent(transaction, {
      aggregateId: row.workflow_run_id,
      aggregateType: 'workflow-run',
      id: outboxEventId,
      jobName: 'advance-workflow-run',
      payload,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
      schemaVersion: 1,
    });
    dispatched.push({ outboxEventId, runId: row.workflow_run_id });
  }
  return Object.freeze(dispatched.map((item) => Object.freeze(item)));
}

export type ExpiredAttempt = Readonly<{
  attemptId: string;
  dispatchMarkedAt: Date | null;
  fenceToken: number;
  nodeRunId: string;
  providerIdempotencyKey: string | null;
  sideEffectClass: SideEffectClass;
}>;

export async function readExpiredAttemptReconciliations(
  transaction: WorkspaceTransaction,
  limitInput: number,
): Promise<readonly ExpiredAttempt[]> {
  const limit = z.number().int().min(1).max(100).parse(limitInput);
  const result = await transaction.db.execute<{
    dispatch_marked_at: Date | null;
    fence_token: string;
    id: string;
    node_run_id: string;
    provider_idempotency_key: string | null;
    side_effect_class: SideEffectClass;
  }>(sql`
    select id, node_run_id, fence_token, dispatch_marked_at,
           side_effect_class, provider_idempotency_key
    from app.node_attempts
    where workspace_id = ${transaction.workspaceId} and status = 'running'
      and lease_expires_at <= clock_timestamp()
    order by lease_expires_at, id
    limit ${limit}
  `);
  return Object.freeze(
    result.rows.map((row) =>
      Object.freeze({
        attemptId: row.id,
        dispatchMarkedAt:
          row.dispatch_marked_at === null
            ? null
            : new Date(row.dispatch_marked_at),
        fenceToken: Number(row.fence_token),
        nodeRunId: row.node_run_id,
        providerIdempotencyKey: row.provider_idempotency_key,
        sideEffectClass: row.side_effect_class,
      }),
    ),
  );
}

const reconciliationSchema = z
  .object({
    action: z.enum(['reclaim', 'outcome_unknown']),
    attemptId: z.uuid(),
    expectedFenceToken: z.number().int().positive(),
    evidenceRef: boundedJson(4096).nullable().optional(),
    traceparent: z.string().max(256).optional(),
  })
  .strict();

export async function reconcileExpiredNodeAttempt(
  transaction: WorkspaceTransaction,
  input: Readonly<z.input<typeof reconciliationSchema>>,
): Promise<Readonly<{ fenceToken: number; outboxEventId: string }>> {
  const parsed = reconciliationSchema.parse(input);
  const candidateRunId = await findAttemptRunId(transaction, parsed.attemptId);
  await lockRun(transaction, candidateRunId);
  const locked = await transaction.db.execute<{
    dispatch_marked_at: Date | null;
    fence_token: string;
    node_run_id: string;
    run_id: string;
    side_effect_class: SideEffectClass;
    status: string;
  }>(sql`
    select a.status, a.fence_token, a.dispatch_marked_at, a.side_effect_class,
           a.node_run_id, n.workflow_run_id as run_id
    from app.node_attempts a
    join app.node_runs n on n.workspace_id = a.workspace_id and n.id = a.node_run_id
    where a.workspace_id = ${transaction.workspaceId} and a.id = ${parsed.attemptId}
    for update of a, n
  `);
  const row = locked.rows[0];
  if (
    row?.status !== 'running' ||
    Number(row.fence_token) !== parsed.expectedFenceToken
  )
    throw new AttemptFenceConflictError();
  const mayReclaim =
    row.dispatch_marked_at === null ||
    row.side_effect_class === SIDE_EFFECT_CLASS.safe ||
    row.side_effect_class === SIDE_EFFECT_CLASS.idempotentWithKey;
  if (parsed.action === 'reclaim' && !mayReclaim) {
    throw new AttemptReconciliationRequiredError();
  }
  const nextFence = parsed.expectedFenceToken + 1;
  const nextStatus = parsed.action === 'reclaim' ? 'ready' : 'outcome_unknown';
  await transaction.db.execute(sql`
    update app.node_attempts
    set status = ${nextStatus}, fence_token = ${nextFence}, lease_owner = null,
        lease_expires_at = null,
        reconciliation_ref = ${parsed.evidenceRef == null ? null : JSON.stringify(parsed.evidenceRef)}::jsonb,
        completed_at = case when ${nextStatus} = 'outcome_unknown' then clock_timestamp() else null end,
        updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId} and id = ${parsed.attemptId}
  `);
  if (nextStatus === 'outcome_unknown') {
    await transaction.db.execute(sql`
      update app.node_runs
      set status = 'outcome_unknown', completed_at = clock_timestamp(), updated_at = clock_timestamp()
      where workspace_id = ${transaction.workspaceId} and id = ${row.node_run_id}
        and current_attempt_id = ${parsed.attemptId}
    `);
    await appendLockedRunEvent(transaction, row.run_id, {
      type: RUN_EVENT_TYPE.nodeOutcomeUnknown,
      payload: {
        attemptId: parsed.attemptId,
        nodeRunId: row.node_run_id,
        reconciliation: true,
      },
    });
  }
  const outboxEventId = randomUUID();
  const payload =
    parsed.action === 'reclaim'
      ? {
          attemptId: parsed.attemptId,
          outboxEventId,
          schemaVersion: 1,
          workspaceId: transaction.workspaceId,
        }
      : {
          outboxEventId,
          runId: row.run_id,
          schemaVersion: 1,
          workspaceId: transaction.workspaceId,
        };
  await insertOutboxEvent(transaction, {
    aggregateId: parsed.action === 'reclaim' ? parsed.attemptId : row.run_id,
    aggregateType:
      parsed.action === 'reclaim' ? 'node-attempt' : 'workflow-run',
    id: outboxEventId,
    jobName:
      parsed.action === 'reclaim'
        ? 'execute-node-attempt'
        : 'advance-workflow-run',
    payload: {
      ...payload,
      ...(parsed.traceparent === undefined
        ? {}
        : { traceparent: parsed.traceparent }),
    },
    payloadChecksum: canonicalOutboxPayloadChecksum({
      ...payload,
      ...(parsed.traceparent === undefined
        ? {}
        : { traceparent: parsed.traceparent }),
    }),
    schemaVersion: 1,
  });
  return Object.freeze({ fenceToken: nextFence, outboxEventId });
}
