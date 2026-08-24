import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';
import { canonicalOutboxPayloadChecksum } from './outbox.js';
import {
  parsePersistedPhase3Checkpoint,
  serializePersistedPhase3Checkpoint,
  type PersistedPhase3Checkpoint,
} from './phase3-checkpoint.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
} from './stored-execution-value.js';

const identitySchema = z.uuid();
const checksumSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const coordinatorDeliverySchema = z
  .object({
    outboxEventId: z.uuid(),
    payloadChecksum: checksumSchema,
  })
  .strict();
const coordinatorConsumerName = 'workflow-coordinator';
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumCanonicalEventPayloadBytes = 4096;
const maximumPersistedFacts = 10_000;
const maximumCanonicalPersistedFactBytes =
  maximumCanonicalEventPayloadBytes * maximumPersistedFacts;
// The SQL backstop is 512 KiB per row, so 64 rows bound each driver fetch to
// roughly 32 MiB even when PostgreSQL expands otherwise-valid numbers.
const maximumPersistedFactRowsPerFetch = 64;
const sideEffectClassSchema = z.enum(['safe', 'idempotent_with_key', 'unsafe']);
const branchScopePartSchema = z
  .object({
    nodeId: z.string().min(1).max(128),
    outputPort: z.string().min(1).max(128),
  })
  .strict();
const iterationScopePartSchema = z
  .object({
    loopNodeId: z.string().min(1).max(128),
    ordinal: z.number().int().nonnegative(),
  })
  .strict();
const nodeRunAdmissionSchema = z
  .object({
    invocationKey: z.string().min(1).max(256),
    nodeId: z.string().min(1).max(128),
    providerIdempotencyKey: z.string().min(1).max(256).optional(),
    sideEffectClass: sideEffectClassSchema,
    branchPath: z.array(branchScopePartSchema).max(1_000).optional(),
    iterationPath: z.array(iterationScopePartSchema).max(1_000).optional(),
  })
  .strict();
const attemptAdmissionSchema = nodeRunAdmissionSchema
  .extend({
    attemptNumber: z.number().int().positive(),
  })
  .strict();
const engineEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    name: z.enum([
      'run.started',
      'run.cancel_requested',
      'run.waiting',
      'run.succeeded',
      'run.failed',
      'run.canceled',
      'run.timed_out',
      'run.outcome_unknown',
      'node.ready',
      'node.waiting',
      'node.retry_scheduled',
      'node.succeeded',
      'node.failed',
      'node.skipped',
      'node.canceled',
      'node.timed_out',
      'node.outcome_unknown',
    ]),
    occurredAt: z.iso.datetime(),
    invocationKey: z.string().min(1).max(256).optional(),
    nodeId: z.string().min(1).max(128).optional(),
    attemptNumber: z.number().int().nonnegative().optional(),
    reasonCode: z.string().min(1).max(128).optional(),
    dueAt: z.iso.datetime().optional(),
  })
  .strict();
const transitionPlanSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    expectedNextEventSequence: z.number().int().positive(),
    consumedThroughEventSequence: z.number().int().nonnegative(),
    checkpoint: z.unknown(),
    events: z.array(engineEventSchema).max(512),
    nodeRunAdmissions: z.array(nodeRunAdmissionSchema).max(10_000),
    attempts: z.array(attemptAdmissionSchema).max(64),
  })
  .strict();
const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .optional();

export type LoadAdvanceStateResult =
  | Readonly<{
      kind:
        | 'not_found'
        | 'not_executable'
        | 'unsupported_checkpoint'
        | 'capacity_exceeded';
    }>
  | Readonly<{
      kind: 'ready';
      state: Readonly<{
        runId: string;
        workflowVersionId: string;
        checkpoint: unknown;
        observations: readonly unknown[];
        completedOutputs?: readonly unknown[];
      }>;
    }>;

export type CommitAdvancePlanResult =
  | Readonly<{
      kind: 'committed';
      revision: number;
      admittedAttempts: readonly Readonly<{
        invocationKey: string;
        nodeRunId: string;
        attemptId: string;
      }>[];
    }>
  | Readonly<{ kind: 'already_committed' | 'stale'; revision: number }>
  | Readonly<{ kind: 'not_found' }>;

export type CoordinatorAdvanceDelivery = Readonly<
  z.input<typeof coordinatorDeliverySchema>
>;

export type AcknowledgeAdvanceDeliveryResult = Readonly<{
  kind: 'acknowledged' | 'duplicate';
}>;

export interface CoordinatorRunStore {
  loadAdvanceState(
    input: Readonly<{
      workspaceId: string;
      runId: string;
      signal: AbortSignal;
    }>,
  ): Promise<LoadAdvanceStateResult>;
  commitAdvancePlan(
    input: Readonly<{
      delivery: CoordinatorAdvanceDelivery;
      workspaceId: string;
      runId: string;
      workflowVersionId: string;
      plan: unknown;
      traceparent?: string;
      signal: AbortSignal;
    }>,
  ): Promise<CommitAdvancePlanResult>;
  acknowledgeAdvanceDelivery(
    input: Readonly<{
      delivery: CoordinatorAdvanceDelivery;
      workspaceId: string;
      runId: string;
      signal: AbortSignal;
    }>,
  ): Promise<AcknowledgeAdvanceDeliveryResult>;
  close(): Promise<void>;
}

type LoadAdvanceStateInput = Parameters<
  CoordinatorRunStore['loadAdvanceState']
>[0];
type CommitAdvancePlanInput = Parameters<
  CoordinatorRunStore['commitAdvancePlan']
>[0];
type AcknowledgeAdvanceDeliveryInput = Parameters<
  CoordinatorRunStore['acknowledgeAdvanceDelivery']
>[0];

export class CoordinatorPlanInvalidError extends Error {
  public override readonly name = 'CoordinatorPlanInvalidError';
  public constructor() {
    super('Coordinator advance plan is invalid');
  }
}

export class CoordinatorRunStateCorruptError extends Error {
  public override readonly name = 'CoordinatorRunStateCorruptError';
  public constructor() {
    super('Persisted coordinator run state is invalid');
  }
}

export class CoordinatorDeliveryMismatchError extends Error {
  public override readonly name = 'CoordinatorDeliveryMismatchError';
  public constructor() {
    super('Coordinator delivery does not match its durable outbox identity');
  }
}

class DeliveryMismatch extends Error {}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
}

async function acquirePoolClient(
  pool: Pool,
  signal: AbortSignal,
  abortFailure: Error,
): Promise<PoolClient> {
  const connection = pool.connect();
  let rejectAbort: ((reason: Error) => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort?.(abortFailure);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) throw abortFailure;
    const client = await Promise.race([connection, abort]);
    return client;
  } catch (error: unknown) {
    if (signal.aborted)
      void connection.then(
        (client) => {
          client.release(abortFailure);
        },
        () => undefined,
      );
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function withWorkspaceClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertNotAborted(signal);
  const abortFailure = new Error('Coordinator transaction aborted');
  abortFailure.name = 'AbortError';
  const client = await acquirePoolClient(pool, signal, abortFailure);
  const connectionState = { released: false };
  const releaseForAbort = (): void => {
    if (connectionState.released) return;
    connectionState.released = true;
    client.release(abortFailure);
  };
  signal.addEventListener('abort', releaseForAbort, { once: true });
  try {
    assertNotAborted(signal);
    await client.query('begin isolation level repeatable read read only');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await operation(client);
    assertNotAborted(signal);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    if (signal.aborted) throw abortFailure;
    if (!connectionState.released)
      await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', releaseForAbort);
    if (!connectionState.released) {
      connectionState.released = true;
      client.release();
    }
  }
}

async function withWorkspaceWriteClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertNotAborted(signal);
  const abortFailure = new Error('Coordinator transaction aborted');
  abortFailure.name = 'AbortError';
  const client = await acquirePoolClient(pool, signal, abortFailure);
  const connectionState = { released: false };
  const releaseForAbort = (): void => {
    if (connectionState.released) return;
    connectionState.released = true;
    client.release(abortFailure);
  };
  signal.addEventListener('abort', releaseForAbort, { once: true });
  try {
    assertNotAborted(signal);
    await client.query('begin');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await operation(client);
    assertNotAborted(signal);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    if (signal.aborted) throw abortFailure;
    if (!connectionState.released)
      await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', releaseForAbort);
    if (!connectionState.released) {
      connectionState.released = true;
      client.release();
    }
  }
}

async function validateAuthoritativeAdvanceDelivery(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  delivery: CoordinatorAdvanceDelivery,
): Promise<void> {
  const result = await client.query<{
    aggregate_id: string;
    aggregate_type: string;
    job_name: string;
    payload: unknown;
    payload_checksum: string;
    schema_version: number;
  }>(
    `select aggregate_id, aggregate_type, job_name, payload,
            payload_checksum, schema_version
     from app.outbox_events
     where workspace_id=$1 and id=$2`,
    [workspaceId, delivery.outboxEventId],
  );
  const row = result.rows[0];
  let storedChecksum: string | undefined;
  try {
    storedChecksum =
      row === undefined
        ? undefined
        : createHash('sha256')
            .update(serializeStoredExecutionJsonValue(row.payload))
            .digest('hex');
  } catch {
    throw new DeliveryMismatch();
  }
  if (
    row?.aggregate_id !== runId ||
    row.aggregate_type !== 'workflow-run' ||
    row.job_name !== 'advance-workflow-run' ||
    row.schema_version !== 1 ||
    row.payload_checksum !== delivery.payloadChecksum ||
    storedChecksum !== row.payload_checksum
  )
    throw new DeliveryMismatch();
}

async function claimCoordinatorReceipt(
  client: PoolClient,
  workspaceId: string,
  delivery: CoordinatorAdvanceDelivery,
): Promise<'new' | 'duplicate'> {
  const inserted = await client.query(
    `insert into app.inbox_receipts (
       consumer_name, message_id, workspace_id, payload_checksum
     ) values ($1,$2,$3,$4)
     on conflict (consumer_name,message_id) do nothing
     returning message_id`,
    [
      coordinatorConsumerName,
      delivery.outboxEventId,
      workspaceId,
      delivery.payloadChecksum,
    ],
  );
  if (inserted.rowCount === 1) return 'new';
  const existing = await client.query<{
    completed_at: Date | null;
    payload_checksum: string;
  }>(
    `select completed_at, payload_checksum
     from app.inbox_receipts
     where consumer_name=$1 and message_id=$2 and workspace_id=$3
     for update`,
    [coordinatorConsumerName, delivery.outboxEventId, workspaceId],
  );
  const receipt = existing.rows[0];
  if (receipt?.completed_at == null)
    throw new CoordinatorRunStateCorruptError();
  if (receipt.payload_checksum !== delivery.payloadChecksum)
    throw new DeliveryMismatch();
  return 'duplicate';
}

async function completeCoordinatorReceipt(
  client: PoolClient,
  workspaceId: string,
  delivery: CoordinatorAdvanceDelivery,
): Promise<void> {
  const completed = await client.query(
    `update app.inbox_receipts
     set completed_at=clock_timestamp()
     where consumer_name=$1 and message_id=$2 and workspace_id=$3
       and payload_checksum=$4 and completed_at is null`,
    [
      coordinatorConsumerName,
      delivery.outboxEventId,
      workspaceId,
      delivery.payloadChecksum,
    ],
  );
  if (completed.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
}

async function auditCoordinatorDeliveryMismatch(
  pool: Pool,
  workspaceId: string,
  delivery: CoordinatorAdvanceDelivery,
  signal: AbortSignal,
): Promise<never> {
  await withWorkspaceWriteClient(pool, workspaceId, signal, async (client) => {
    await client.query(
      `insert into app.transport_security_audit_facts (
           id,workspace_id,fact_type,consumer_name,message_id
         ) values ($1,$2,'inbox_checksum_mismatch',$3,$4)`,
      [
        randomUUID(),
        workspaceId,
        coordinatorConsumerName,
        delivery.outboxEventId,
      ],
    );
  });
  throw new CoordinatorDeliveryMismatchError();
}

function normalizedJson(value: unknown): unknown {
  try {
    return JSON.parse(serializeStoredExecutionJsonValue(value)) as unknown;
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  const normalized = normalizedJson(value);
  if (
    normalized === null ||
    typeof normalized !== 'object' ||
    Array.isArray(normalized)
  )
    throw new CoordinatorRunStateCorruptError();
  return normalized as Readonly<Record<string, unknown>>;
}

function canonicalEventPayload(value: unknown): Readonly<{
  bytes: number;
  payload: Readonly<Record<string, unknown>>;
}> {
  let serialized: string;
  try {
    serialized = serializeStoredExecutionJsonValue(value);
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maximumCanonicalEventPayloadBytes)
    throw new CoordinatorRunStateCorruptError();
  const normalized = JSON.parse(serialized) as unknown;
  if (
    normalized === null ||
    typeof normalized !== 'object' ||
    Array.isArray(normalized)
  )
    throw new CoordinatorRunStateCorruptError();
  return Object.freeze({
    bytes,
    payload: normalized as Readonly<Record<string, unknown>>,
  });
}

function eventPayloadRecord(value: unknown): Readonly<Record<string, unknown>> {
  return canonicalEventPayload(value).payload;
}

async function persistedFactCapacity(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  firstSequence: number,
  lastSequence?: number,
): Promise<Readonly<{ count: number; storageBytes: number }>> {
  const result = await client.query<{
    fact_count: number;
    storage_bytes: string;
  }>(
    `select count(*)::int as fact_count,
            coalesce(sum(octet_length(payload::text)),0)::bigint as storage_bytes
     from app.run_events
     where workspace_id=$1 and workflow_run_id=$2 and sequence >= $3
       and ($4::int is null or sequence <= $4::int)`,
    [workspaceId, runId, firstSequence, lastSequence ?? null],
  );
  const row = result.rows[0];
  const count = row?.fact_count;
  const storageBytes = Number(row?.storage_bytes);
  if (
    count === undefined ||
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(storageBytes) ||
    count < 0 ||
    storageBytes < 0
  )
    throw new CoordinatorRunStateCorruptError();
  return Object.freeze({ count, storageBytes });
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new CoordinatorRunStateCorruptError();
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  )
    throw new CoordinatorRunStateCorruptError();
  return value;
}

function eventIdentity(payload: Readonly<Record<string, unknown>>): Readonly<{
  attemptId: string;
  nodeRunId: string;
}> {
  if (
    typeof payload.attemptId !== 'string' ||
    !uuidPattern.test(payload.attemptId) ||
    typeof payload.nodeRunId !== 'string' ||
    !uuidPattern.test(payload.nodeRunId)
  )
    throw new CoordinatorRunStateCorruptError();
  return { attemptId: payload.attemptId, nodeRunId: payload.nodeRunId };
}

type EventRow = Readonly<{
  sequence: number;
  type: string;
  payload: unknown;
  created_at: Date;
  attempt_id: string | null;
  attempt_number: number | null;
  attempt_status: string | null;
  attempt_output_ref: unknown;
  node_output_ref: unknown;
  invocation_key: string | null;
  node_run_id: string | null;
  current_attempt_id: string | null;
  node_status: string | null;
  resume_at: Date | null;
  retry_due_at: Date | null;
}>;

type PhysicalInvocationRow = Readonly<{
  attempt_id: string | null;
  attempt_number: number | null;
  attempt_output_ref: unknown;
  attempt_status: string | null;
  current_attempt_id: string | null;
  current_attempt_number: number | null;
  invocation_key: string;
  branch_context: unknown;
  control_kind: string | null;
  node_id: string;
  node_output_ref: unknown;
  node_status: string;
  resume_at: Date | null;
  retry_due_at: Date | null;
}>;

async function readPersistedFacts(
  client: PoolClient,
  input: Readonly<{
    count: number;
    firstSequence: number;
    lastSequence?: number;
    runId: string;
    workspaceId: string;
  }>,
): Promise<readonly EventRow[]> {
  const facts: EventRow[] = [];
  let canonicalBytes = 0;
  let nextSequence = input.firstSequence;
  while (facts.length < input.count) {
    const result = await client.query<EventRow>(
      `select event.sequence, event.type, event.payload, event.created_at,
              attempt.id as attempt_id, attempt.attempt_number,
              attempt.status as attempt_status,
              attempt.output_ref as attempt_output_ref,
              node.id as node_run_id, node.invocation_key,
              node.current_attempt_id, node.status as node_status,
              node.output_ref as node_output_ref,
              node.resume_at, node.retry_due_at
       from app.run_events event
       left join app.node_attempts attempt
         on attempt.workspace_id=event.workspace_id
        and attempt.id::text=event.payload->>'attemptId'
       left join app.node_runs node
         on node.workspace_id=event.workspace_id
        and node.id::text=event.payload->>'nodeRunId'
        and attempt.node_run_id=node.id
        and node.workflow_run_id=event.workflow_run_id
       where event.workspace_id=$1 and event.workflow_run_id=$2
         and event.sequence >= $3
         and ($4::int is null or event.sequence <= $4::int)
       order by event.sequence
       limit $5`,
      [
        input.workspaceId,
        input.runId,
        nextSequence,
        input.lastSequence ?? null,
        maximumPersistedFactRowsPerFetch,
      ],
    );
    if (result.rows.length === 0) break;
    for (const row of result.rows) {
      const canonical = canonicalEventPayload(row.payload);
      canonicalBytes += canonical.bytes;
      if (canonicalBytes > maximumCanonicalPersistedFactBytes)
        throw new CoordinatorRunStateCorruptError();
      facts.push(Object.freeze({ ...row, payload: canonical.payload }));
      nextSequence = row.sequence + 1;
    }
  }
  return Object.freeze(facts);
}

function terminalStatus(type: string): string | undefined {
  return (
    {
      'node.succeeded': 'succeeded',
      'node.failed': 'failed',
      'node.canceled': 'canceled',
      'node.timed_out': 'timed_out',
      'node.outcome_unknown': 'outcome_unknown',
    } as Readonly<Record<string, string>>
  )[type];
}

function attemptFact(
  row: EventRow,
  eventPayload?: Readonly<Record<string, unknown>>,
): Readonly<{
  attemptId: string;
  attemptNumber: number;
  invocationKey: string;
}> {
  const payload = eventIdentity(
    eventPayload ?? eventPayloadRecord(row.payload),
  );
  if (
    row.attempt_id !== payload.attemptId ||
    row.node_run_id !== payload.nodeRunId ||
    row.current_attempt_id !== payload.attemptId ||
    row.attempt_number === null ||
    row.attempt_number <= 0 ||
    row.invocation_key === null
  )
    throw new CoordinatorRunStateCorruptError();
  return {
    attemptId: payload.attemptId,
    attemptNumber: row.attempt_number,
    invocationKey: row.invocation_key,
  };
}

function validatePersistedFactBatch(rows: readonly EventRow[]): void {
  const laterTypesByAttempt = new Map<string, Set<string>>();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined) throw new CoordinatorRunStateCorruptError();
    if (
      (row.type !== 'node.started' && row.type !== 'node.progress') ||
      (row.attempt_status === 'running' && row.node_status === 'running')
    ) {
      if (row.attempt_id !== null) {
        const types =
          laterTypesByAttempt.get(row.attempt_id) ?? new Set<string>();
        types.add(row.type);
        laterTypesByAttempt.set(row.attempt_id, types);
      }
      continue;
    }
    const requiredLaterType =
      row.node_status === 'waiting'
        ? row.attempt_status === 'succeeded'
          ? 'node.waiting'
          : row.attempt_status === 'failed'
            ? 'node.retry_scheduled'
            : undefined
        : row.attempt_status === row.node_status && row.node_status !== null
          ? `node.${row.node_status}`
          : undefined;
    if (
      row.attempt_id === null ||
      requiredLaterType === undefined ||
      !laterTypesByAttempt.get(row.attempt_id)?.has(requiredLaterType)
    )
      throw new CoordinatorRunStateCorruptError();
    const types = laterTypesByAttempt.get(row.attempt_id) ?? new Set<string>();
    types.add(row.type);
    laterTypesByAttempt.set(row.attempt_id, types);
  }
}

function mapEvent(row: EventRow): unknown {
  const payload = eventPayloadRecord(row.payload);
  if (payload.schemaVersion !== 1) throw new CoordinatorRunStateCorruptError();
  const occurredAt = new Date(row.created_at).toISOString();
  if (row.type === 'run.cancel_requested')
    return { kind: 'cancel_requested', sequence: row.sequence, occurredAt };
  if (row.type === 'node.started' || row.type === 'node.progress') {
    const physicalStatusIsCoherent =
      row.attempt_status === row.node_status ||
      (row.node_status === 'waiting' &&
        (row.attempt_status === 'succeeded' ||
          row.attempt_status === 'failed'));
    if (
      row.attempt_status === null ||
      !physicalStatusIsCoherent ||
      ![
        'running',
        'succeeded',
        'failed',
        'canceled',
        'timed_out',
        'outcome_unknown',
      ].includes(row.attempt_status)
    )
      throw new CoordinatorRunStateCorruptError();
    return {
      kind: 'cursor_only',
      eventName: row.type,
      sequence: row.sequence,
      occurredAt,
      ...attemptFact(row, payload),
    };
  }
  if (row.type === 'node.waiting' || row.type === 'node.retry_scheduled') {
    const resumeAt = canonicalTimestamp(payload.dueAt);
    const persistedDueAt =
      row.type === 'node.waiting' ? row.resume_at : row.retry_due_at;
    if (
      row.attempt_status !==
        (row.type === 'node.waiting' ? 'succeeded' : 'failed') ||
      row.node_status !== 'waiting' ||
      serializeStoredExecutionJsonValue(row.attempt_output_ref) !==
        serializeStoredExecutionJsonValue(row.node_output_ref) ||
      persistedDueAt?.toISOString() !== resumeAt
    )
      throw new CoordinatorRunStateCorruptError();
    return {
      kind: 'wait',
      eventName: row.type,
      sequence: row.sequence,
      occurredAt,
      resumeAt,
      ...attemptFact(row, payload),
    };
  }
  const status = terminalStatus(row.type);
  if (status === undefined) throw new CoordinatorRunStateCorruptError();
  const identity = attemptFact(row, payload);
  if (
    row.attempt_status !== status ||
    row.node_status !== status ||
    serializeStoredExecutionJsonValue(row.attempt_output_ref) !==
      serializeStoredExecutionJsonValue(row.node_output_ref)
  )
    throw new CoordinatorRunStateCorruptError();
  let output: unknown;
  if (row.attempt_output_ref !== null) {
    let stored;
    try {
      stored = parseStoredExecutionValueV1(row.attempt_output_ref);
    } catch {
      throw new CoordinatorRunStateCorruptError();
    }
    output =
      stored.kind === 'inline'
        ? { kind: 'inline', attemptId: identity.attemptId }
        : { kind: 'artifact', artifactId: stored.artifactId };
  }
  return {
    kind: 'outcome',
    sequence: row.sequence,
    occurredAt,
    status,
    ...identity,
    ...(output === undefined ? {} : { output }),
    ...(typeof payload.safeErrorCode === 'string'
      ? { reasonCode: payload.safeErrorCode }
      : {}),
  };
}

function completedInlineOutput(row: EventRow): readonly unknown[] {
  if (row.type !== 'node.succeeded' || row.attempt_output_ref === null)
    return [];
  const identity = attemptFact(row);
  let stored;
  try {
    stored = parseStoredExecutionValueV1(row.attempt_output_ref);
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
  const value = stored.kind === 'inline' ? stored.value : undefined;
  const isRecord =
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const outputRecord = isRecord
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
  const isForEachOutput =
    outputRecord !== undefined &&
    Object.keys(outputRecord).length === 2 &&
    Array.isArray(outputRecord.items) &&
    outputRecord.items.length <= 1_000 &&
    Number.isSafeInteger(outputRecord.iterationCount) &&
    outputRecord.iterationCount === outputRecord.items.length;
  return stored.kind === 'inline' &&
    isRecord &&
    (Object.hasOwn(outputRecord ?? {}, 'selectedPort') || isForEachOutput)
    ? [
        {
          sequence: row.sequence,
          attemptId: identity.attemptId,
          invocationKey: identity.invocationKey,
          value: stored.value,
        },
      ]
    : [];
}

function parsedPhysicalOutput(
  row: PhysicalInvocationRow,
  expected: PersistedPhase3Checkpoint['invocations'][number]['output'],
): string | undefined {
  if (expected === undefined) {
    if (row.node_output_ref !== null || row.attempt_output_ref !== null)
      throw new CoordinatorRunStateCorruptError();
    return undefined;
  }
  if (row.attempt_id === null) throw new CoordinatorRunStateCorruptError();
  let nodeValue;
  let attemptValue;
  try {
    nodeValue = parseStoredExecutionValueV1(row.node_output_ref);
    attemptValue = parseStoredExecutionValueV1(row.attempt_output_ref);
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
  if (
    serializeStoredExecutionJsonValue(nodeValue) !==
    serializeStoredExecutionJsonValue(attemptValue)
  )
    throw new CoordinatorRunStateCorruptError();
  if (expected.kind === 'inline') {
    if (nodeValue.kind !== 'inline' || expected.attemptId !== row.attempt_id)
      throw new CoordinatorRunStateCorruptError();
    return undefined;
  }
  if (
    nodeValue.kind !== 'artifact' ||
    nodeValue.artifactId !== expected.artifactId
  )
    throw new CoordinatorRunStateCorruptError();
  return expected.artifactId;
}

async function validateLoadedCheckpointPhysicalState(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  checkpoint: PersistedPhase3Checkpoint,
  observations: readonly unknown[],
): Promise<void> {
  const result = await client.query<PhysicalInvocationRow>(
    `select node.invocation_key, node.node_id, node.branch_context,
             node.control_kind,
            node.status as node_status,
            node.current_attempt_id, node.current_attempt_number,
            node.resume_at, node.retry_due_at,
            node.output_ref as node_output_ref,
            attempt.id as attempt_id, attempt.attempt_number,
            attempt.status as attempt_status,
            attempt.output_ref as attempt_output_ref
     from app.node_runs node
     left join app.node_attempts attempt
       on attempt.workspace_id=node.workspace_id
      and attempt.id=node.current_attempt_id
     where node.workspace_id=$1 and node.workflow_run_id=$2`,
    [workspaceId, runId],
  );
  const rows = new Map(
    result.rows.map((row) => [row.invocation_key, row] as const),
  );
  if (
    rows.size !== result.rows.length ||
    rows.size !== checkpoint.invocations.length
  )
    throw new CoordinatorRunStateCorruptError();

  const freshSemanticFacts = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  for (const observation of observations) {
    const value = record(observation);
    if (
      (value.kind === 'wait' ||
        value.kind === 'outcome' ||
        value.kind === 'attempt_failure') &&
      typeof value.invocationKey === 'string'
    )
      freshSemanticFacts.set(value.invocationKey, value);
  }

  const artifactIds = new Set<string>();
  for (const invocation of checkpoint.invocations) {
    const row = rows.get(invocation.invocationKey);
    const expectedBranchContext = {
      ...('branchPath' in invocation && invocation.branchPath !== undefined
        ? { branchPath: invocation.branchPath }
        : {}),
      ...('iterationPath' in invocation &&
      invocation.iterationPath !== undefined
        ? { iterationPath: invocation.iterationPath }
        : {}),
    };
    if (
      row?.node_id !== invocation.nodeId ||
      serializeStoredExecutionJsonValue(row.branch_context) !==
        serializeStoredExecutionJsonValue(expectedBranchContext)
    )
      throw new CoordinatorRunStateCorruptError();
    if (invocation.attemptNumber === 0) {
      if (
        row.current_attempt_id !== null ||
        row.current_attempt_number !== null ||
        row.attempt_id !== null ||
        row.attempt_number !== null ||
        row.attempt_status !== null
      )
        throw new CoordinatorRunStateCorruptError();
    } else if (
      row.current_attempt_id === null ||
      row.current_attempt_id !== row.attempt_id ||
      row.current_attempt_number !== invocation.attemptNumber ||
      row.attempt_number !== invocation.attemptNumber ||
      row.attempt_status === null
    ) {
      throw new CoordinatorRunStateCorruptError();
    }

    const freshFact = freshSemanticFacts.get(invocation.invocationKey);
    if (invocation.status === 'running') {
      const physicalInFlight =
        (row.node_status === 'ready' && row.attempt_status === 'ready') ||
        (row.node_status === 'running' && row.attempt_status === 'running');
      const physicalAheadWithFact =
        freshFact?.attemptNumber === invocation.attemptNumber &&
        (freshFact.kind === 'wait' ||
          freshFact.kind === 'outcome' ||
          (freshFact.kind === 'attempt_failure' &&
            row.node_status === 'running' &&
            row.attempt_status === 'failed'));
      if (!physicalInFlight && !physicalAheadWithFact)
        throw new CoordinatorRunStateCorruptError();
    } else if (invocation.status === 'waiting') {
      const dueAt = row.retry_due_at ?? row.resume_at;
      const isLoopBarrier = checkpoint.loops.some(
        ({ controlInvocationKey }) =>
          controlInvocationKey === invocation.invocationKey,
      );
      if (
        row.node_status !== 'waiting' ||
        (isLoopBarrier
          ? row.control_kind !== 'for_each_barrier'
          : row.control_kind !== null) ||
        (row.attempt_status !== 'succeeded' &&
          row.attempt_status !== 'failed') ||
        (isLoopBarrier
          ? invocation.resumeAt !== undefined || dueAt !== null
          : invocation.resumeAt === undefined ||
            dueAt?.toISOString() !== invocation.resumeAt)
      )
        throw new CoordinatorRunStateCorruptError();
    } else if (invocation.status === 'ready') {
      if (
        row.node_status !== 'ready' ||
        row.resume_at !== null ||
        row.retry_due_at !== null ||
        (invocation.attemptNumber > 0 &&
          row.attempt_status !== 'succeeded' &&
          row.attempt_status !== 'failed')
      )
        throw new CoordinatorRunStateCorruptError();
    } else if (invocation.status === 'pending') {
      if (row.node_status !== 'pending' || invocation.attemptNumber !== 0)
        throw new CoordinatorRunStateCorruptError();
    } else if (row.node_status !== invocation.status) {
      throw new CoordinatorRunStateCorruptError();
    }

    if (!(invocation.status === 'running' && freshFact !== undefined)) {
      const artifactId = parsedPhysicalOutput(row, invocation.output);
      if (artifactId !== undefined) artifactIds.add(artifactId);
    }
  }

  if (artifactIds.size === 0) return;
  const available = await client.query<{ id: string }>(
    `select id from app.artifacts
     where workspace_id=$1 and id=any($2::uuid[])
       and status='available' and deleted_at is null`,
    [workspaceId, [...artifactIds]],
  );
  if (new Set(available.rows.map(({ id }) => id)).size !== artifactIds.size)
    throw new CoordinatorRunStateCorruptError();
}

type ParsedTransitionPlan = Omit<
  z.output<typeof transitionPlanSchema>,
  'checkpoint'
> & { readonly checkpoint: PersistedPhase3Checkpoint };

function parseTransitionPlan(value: unknown): ParsedTransitionPlan {
  try {
    const parsed = transitionPlanSchema.parse(normalizedJson(value));
    return Object.freeze({
      ...parsed,
      checkpoint: parsePersistedPhase3Checkpoint(parsed.checkpoint),
    });
  } catch {
    throw new CoordinatorPlanInvalidError();
  }
}

function validateTransitionPlan(
  plan: ParsedTransitionPlan,
  workflowVersionId: string,
): void {
  const firstDerivedSequence = plan.consumedThroughEventSequence + 1;
  if (
    plan.expectedNextEventSequence > firstDerivedSequence ||
    plan.checkpoint.revision !== plan.expectedRevision + 1 ||
    plan.checkpoint.workflowVersionId !== workflowVersionId ||
    plan.checkpoint.nextEventSequence !==
      firstDerivedSequence + plan.events.length ||
    plan.events.some(
      ({ sequence }, index) => sequence !== firstDerivedSequence + index,
    ) ||
    plan.events.some(({ name }) => name === 'run.cancel_requested') ||
    ((plan.checkpoint.cancelRequested || plan.checkpoint.deadlineExpired) &&
      (plan.attempts.length > 0 || plan.nodeRunAdmissions.length > 0))
  )
    throw new CoordinatorPlanInvalidError();
  const invocations = new Map(
    plan.checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  if (invocations.size !== plan.checkpoint.invocations.length)
    throw new CoordinatorPlanInvalidError();
  if (
    new Set(plan.checkpoint.admittedInvocationKeys).size !==
    plan.checkpoint.admittedInvocationKeys.length
  )
    throw new CoordinatorPlanInvalidError();
  const nodeAdmissions = new Map(
    plan.nodeRunAdmissions.map((admission) => [
      admission.invocationKey,
      admission,
    ]),
  );
  if (nodeAdmissions.size !== plan.nodeRunAdmissions.length)
    throw new CoordinatorPlanInvalidError();
  const attemptKeys = new Set<string>();
  for (const attempt of plan.attempts) {
    const invocation = invocations.get(attempt.invocationKey);
    const materialized = nodeAdmissions.get(attempt.invocationKey);
    if (
      attemptKeys.has(attempt.invocationKey) ||
      (attempt.sideEffectClass === 'idempotent_with_key') !==
        (attempt.providerIdempotencyKey !== undefined) ||
      invocation?.nodeId !== attempt.nodeId ||
      invocation.status !== 'running' ||
      invocation.attemptNumber !== attempt.attemptNumber ||
      !plan.checkpoint.admittedInvocationKeys.includes(attempt.invocationKey) ||
      (materialized !== undefined &&
        (materialized.nodeId !== attempt.nodeId ||
          materialized.sideEffectClass !== attempt.sideEffectClass ||
          materialized.providerIdempotencyKey !==
            attempt.providerIdempotencyKey ||
          serializeStoredExecutionJsonValue(materialized.branchPath ?? []) !==
            serializeStoredExecutionJsonValue(attempt.branchPath ?? []) ||
          serializeStoredExecutionJsonValue(
            materialized.iterationPath ?? [],
          ) !== serializeStoredExecutionJsonValue(attempt.iterationPath ?? [])))
    )
      throw new CoordinatorPlanInvalidError();
    attemptKeys.add(attempt.invocationKey);
  }
  for (const admission of plan.nodeRunAdmissions) {
    const invocation = invocations.get(admission.invocationKey);
    if (
      (admission.sideEffectClass === 'idempotent_with_key') !==
        (admission.providerIdempotencyKey !== undefined) ||
      invocation?.nodeId !== admission.nodeId ||
      serializeStoredExecutionJsonValue(
        invocationScope(invocation, 'branchPath'),
      ) !== serializeStoredExecutionJsonValue(admission.branchPath ?? []) ||
      serializeStoredExecutionJsonValue(
        invocationScope(invocation, 'iterationPath'),
      ) !== serializeStoredExecutionJsonValue(admission.iterationPath ?? []) ||
      (invocation.status !== 'pending' &&
        invocation.status !== 'ready' &&
        invocation.status !== 'running' &&
        invocation.status !== 'skipped')
    )
      throw new CoordinatorPlanInvalidError();
    if (
      (invocation.status === 'running') !==
      attemptKeys.has(admission.invocationKey)
    )
      throw new CoordinatorPlanInvalidError();
  }
  for (const event of plan.events) {
    const isNodeEvent = event.name.startsWith('node.');
    if (!isNodeEvent) {
      if (event.invocationKey !== undefined || event.nodeId !== undefined)
        throw new CoordinatorPlanInvalidError();
      continue;
    }
    if (event.invocationKey === undefined || event.nodeId === undefined)
      throw new CoordinatorPlanInvalidError();
    const invocation = invocations.get(event.invocationKey);
    const expectedEventAttemptNumber =
      event.name === 'node.ready' &&
      invocation?.status === 'running' &&
      attemptKeys.has(event.invocationKey)
        ? invocation.attemptNumber - 1
        : invocation?.attemptNumber;
    if (
      invocation?.nodeId !== event.nodeId ||
      event.attemptNumber !== expectedEventAttemptNumber ||
      (event.name === 'node.retry_scheduled') !== (event.dueAt !== undefined) ||
      (event.name === 'node.retry_scheduled' &&
        event.dueAt !== invocation.resumeAt)
    )
      throw new CoordinatorPlanInvalidError();
  }
}

function transitionFingerprint(
  input: Readonly<{
    plan: ParsedTransitionPlan;
    traceparent: string | undefined;
    workflowVersionId: string;
  }>,
): string {
  return createHash('sha256')
    .update(
      serializeStoredExecutionJsonValue({
        schemaVersion: 1,
        workflowVersionId: input.workflowVersionId,
        plan: input.plan,
        traceparent: input.traceparent ?? null,
      }),
    )
    .digest('hex');
}

function sameKeys(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

function invocationScope(
  invocation: PersistedPhase3Checkpoint['invocations'][number] | undefined,
  field: 'branchPath' | 'iterationPath',
): readonly unknown[] {
  if (invocation === undefined || !(field in invocation)) return [];
  return (
    (
      invocation as Readonly<
        Record<'branchPath' | 'iterationPath', readonly unknown[] | undefined>
      >
    )[field] ?? []
  );
}

function validateTransitionDelta(
  current: PersistedPhase3Checkpoint,
  plan: ParsedTransitionPlan,
): void {
  const expectedAdmittedKeys = new Set([
    ...current.admittedInvocationKeys,
    ...plan.attempts.map(({ invocationKey }) => invocationKey),
  ]);
  const currentLoops = new Map(
    current.loops.map((loop) => [loop.controlInvocationKey, loop]),
  );
  const declaredLoops = plan.checkpoint.loops.filter(
    (loop) => !currentLoops.has(loop.controlInvocationKey),
  );
  const reservedIterations = declaredLoops.reduce(
    (total, loop) => total + loop.collectionSize,
    0,
  );
  if (
    plan.checkpoint.engineVersion !== current.engineVersion ||
    plan.checkpoint.remainingIterationBudget !==
      current.remainingIterationBudget - reservedIterations ||
    ('initialIterationBudget' in current &&
      current.initialIterationBudget !== undefined &&
      (!('initialIterationBudget' in plan.checkpoint) ||
        plan.checkpoint.initialIterationBudget !==
          current.initialIterationBudget)) ||
    !sameKeys(
      expectedAdmittedKeys,
      new Set(plan.checkpoint.admittedInvocationKeys),
    )
  )
    throw new CoordinatorPlanInvalidError();
  const currentInvocations = new Map(
    current.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  for (const nextLoop of plan.checkpoint.loops) {
    const previous = currentLoops.get(nextLoop.controlInvocationKey);
    if (previous === undefined) continue;
    const immutable = (loop: typeof nextLoop): unknown => ({
      controlInvocationKey: loop.controlInvocationKey,
      loopId: loop.loopId,
      branchPath: loop.branchPath,
      iterationPath: loop.iterationPath,
      bodyRootNodeIds: loop.bodyRootNodeIds,
      bodySinkNodeId: loop.bodySinkNodeId,
      collection: loop.collection,
      collectionChecksum: loop.collectionChecksum,
      collectionSize: loop.collectionSize,
      maxConcurrency: loop.maxConcurrency,
      maxIterations: loop.maxIterations,
    });
    if (
      serializeStoredExecutionJsonValue(immutable(previous)) !==
      serializeStoredExecutionJsonValue(immutable(nextLoop))
    )
      throw new CoordinatorPlanInvalidError();
  }
  const nextInvocations = new Map(
    plan.checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  for (const loop of plan.checkpoint.loops) {
    for (const ordinal of loop.activeOrdinals) {
      const iterationPath = [
        ...loop.iterationPath,
        { loopNodeId: loop.loopId, ordinal },
      ];
      for (const rootNodeId of loop.bodyRootNodeIds) {
        const root = [...nextInvocations.values()].find(
          (invocation) =>
            invocation.nodeId === rootNodeId &&
            serializeStoredExecutionJsonValue(
              invocationScope(invocation, 'branchPath'),
            ) === serializeStoredExecutionJsonValue(loop.branchPath) &&
            serializeStoredExecutionJsonValue(
              invocationScope(invocation, 'iterationPath'),
            ) === serializeStoredExecutionJsonValue(iterationPath),
        );
        if (
          root === undefined ||
          !['ready', 'running', 'waiting'].includes(root.status)
        )
          throw new CoordinatorPlanInvalidError();
      }
    }
  }
  const expectedNodeRunAdmissions = new Set(
    [...nextInvocations.keys()].filter((key) => !currentInvocations.has(key)),
  );
  const actualNodeRunAdmissions = new Set(
    plan.nodeRunAdmissions.map(({ invocationKey }) => invocationKey),
  );
  if (!sameKeys(expectedNodeRunAdmissions, actualNodeRunAdmissions))
    throw new CoordinatorPlanInvalidError();

  const expectedAttempts = new Set<string>();
  for (const [key, next] of nextInvocations) {
    const previous = currentInvocations.get(key);
    if (next.status !== 'running' || previous?.status === 'running') continue;
    const expectedAttemptNumber =
      previous === undefined ? 1 : previous.attemptNumber + 1;
    if (
      (previous !== undefined &&
        previous.status !== 'pending' &&
        previous.status !== 'ready' &&
        previous.status !== 'waiting') ||
      next.attemptNumber !== expectedAttemptNumber
    )
      throw new CoordinatorPlanInvalidError();
    expectedAttempts.add(key);
  }
  const actualAttempts = new Set(
    plan.attempts.map(({ invocationKey }) => invocationKey),
  );
  if (!sameKeys(expectedAttempts, actualAttempts))
    throw new CoordinatorPlanInvalidError();
}

function validateStatusTransitions(
  current: PersistedPhase3Checkpoint,
  plan: ParsedTransitionPlan,
  persistedFacts: readonly Readonly<{
    invocationKey: string | null;
    observation: Readonly<Record<string, unknown>>;
    type: string;
  }>[],
): void {
  const currentInvocations = new Map(
    current.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const plannedNodeEvents = new Set(
    plan.events.flatMap((event) =>
      event.invocationKey === undefined
        ? []
        : [`${event.invocationKey}:${event.name}`],
    ),
  );
  const expectedNodeEvents = new Set<string>();
  const persistedNodeFacts = new Set<string>();
  const persistedByInvocation = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  for (const fact of persistedFacts) {
    if (fact.type.startsWith('node.') && fact.invocationKey === null)
      throw new CoordinatorRunStateCorruptError();
    if (fact.invocationKey !== null) {
      persistedNodeFacts.add(`${fact.invocationKey}:${fact.type}`);
      persistedByInvocation.set(fact.invocationKey, fact.observation);
    }
  }
  const nextInvocations = new Map(
    plan.checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  if (
    current.invocations.some(
      ({ invocationKey }) => !nextInvocations.has(invocationKey),
    )
  )
    throw new CoordinatorPlanInvalidError();
  for (const fact of persistedFacts) {
    if (fact.invocationKey === null) continue;
    const next = nextInvocations.get(fact.invocationKey);
    const kind = fact.observation.kind;
    if (kind === 'wait') {
      if (next?.status !== 'waiting') throw new CoordinatorPlanInvalidError();
      if (
        next.attemptNumber !== fact.observation.attemptNumber ||
        next.resumeAt !== fact.observation.resumeAt
      )
        throw new CoordinatorPlanInvalidError();
    } else if (kind === 'outcome') {
      if (next === undefined) throw new CoordinatorPlanInvalidError();
      const declaredLoopBarrier =
        next.status === 'waiting' &&
        next.resumeAt === undefined &&
        fact.observation.status === 'succeeded' &&
        plan.checkpoint.loops.some(
          ({ controlInvocationKey }) =>
            controlInvocationKey === next.invocationKey &&
            !current.loops.some(
              (loop) => loop.controlInvocationKey === controlInvocationKey,
            ),
        );
      if (next.status !== fact.observation.status && !declaredLoopBarrier)
        throw new CoordinatorPlanInvalidError();
      if (
        next.attemptNumber !== fact.observation.attemptNumber ||
        serializeStoredExecutionJsonValue(next.output ?? null) !==
          serializeStoredExecutionJsonValue(fact.observation.output ?? null)
      )
        throw new CoordinatorPlanInvalidError();
    }
  }
  for (const next of plan.checkpoint.invocations) {
    const previous = currentInvocations.get(next.invocationKey);
    if (previous === undefined) {
      if (
        next.status === 'pending' &&
        plan.checkpoint.joins.some(({ joinId }) => joinId === next.nodeId)
      )
        continue;
      const eventName =
        next.status === 'skipped' ? 'node.skipped' : 'node.ready';
      expectedNodeEvents.add(`${next.invocationKey}:${eventName}`);
      if (!plannedNodeEvents.has(`${next.invocationKey}:${eventName}`))
        throw new CoordinatorPlanInvalidError();
      continue;
    }
    if (previous.nodeId !== next.nodeId)
      throw new CoordinatorPlanInvalidError();
    if (previous.status === next.status) {
      if (
        serializeStoredExecutionJsonValue(previous) !==
        serializeStoredExecutionJsonValue(next)
      )
        throw new CoordinatorPlanInvalidError();
      continue;
    }
    const terminalEvent = `node.${next.status}`;
    if (previous.status === 'waiting' && next.status === 'ready') {
      expectedNodeEvents.add(`${next.invocationKey}:node.ready`);
      if (
        !plannedNodeEvents.has(`${next.invocationKey}:node.ready`) ||
        next.attemptNumber !== previous.attemptNumber ||
        next.resumeAt !== undefined ||
        serializeStoredExecutionJsonValue(next.output ?? null) !==
          serializeStoredExecutionJsonValue(previous.output ?? null)
      )
        throw new CoordinatorPlanInvalidError();
      continue;
    }
    if (
      previous.status === 'pending' &&
      next.status === 'running' &&
      plan.checkpoint.joins.some(({ joinId }) => joinId === next.nodeId)
    ) {
      expectedNodeEvents.add(`${next.invocationKey}:node.ready`);
      if (
        !plannedNodeEvents.has(`${next.invocationKey}:node.ready`) ||
        next.attemptNumber !== previous.attemptNumber + 1
      )
        throw new CoordinatorPlanInvalidError();
      continue;
    }
    if (
      (previous.status === 'ready' || previous.status === 'waiting') &&
      next.status === 'running'
    ) {
      if (previous.status === 'waiting')
        expectedNodeEvents.add(`${next.invocationKey}:node.ready`);
      if (
        next.attemptNumber !== previous.attemptNumber + 1 ||
        next.resumeAt !== undefined ||
        serializeStoredExecutionJsonValue(next.output ?? null) !==
          serializeStoredExecutionJsonValue(previous.output ?? null)
      )
        throw new CoordinatorPlanInvalidError();
      continue;
    }
    if (
      previous.status === 'running' &&
      (next.status === 'waiting' || terminalStatus(terminalEvent) !== undefined)
    ) {
      const pending = persistedByInvocation.get(next.invocationKey);
      if (pending?.kind === 'attempt_failure') {
        const expectedEvent =
          next.status === 'waiting' ? 'node.retry_scheduled' : terminalEvent;
        expectedNodeEvents.add(`${next.invocationKey}:${expectedEvent}`);
        if (
          !plannedNodeEvents.has(`${next.invocationKey}:${expectedEvent}`) ||
          next.attemptNumber !== previous.attemptNumber ||
          (next.status === 'waiting' &&
            (next.resumeAt === undefined ||
              plan.events.find(
                (event) =>
                  event.invocationKey === next.invocationKey &&
                  event.name === expectedEvent,
              )?.dueAt !== next.resumeAt))
        )
          throw new CoordinatorPlanInvalidError();
        continue;
      }
      const sourceNames =
        next.status === 'waiting'
          ? ['node.waiting', 'node.retry_scheduled']
          : [terminalEvent];
      const observation = persistedByInvocation.get(next.invocationKey);
      const declaredLoopBarrier = plan.checkpoint.loops.some(
        ({ controlInvocationKey }) =>
          controlInvocationKey === next.invocationKey &&
          !current.loops.some(
            (loop) => loop.controlInvocationKey === controlInvocationKey,
          ),
      );
      if (
        declaredLoopBarrier &&
        next.status === 'waiting' &&
        next.resumeAt === undefined &&
        observation?.kind === 'outcome' &&
        observation.status === 'succeeded' &&
        next.attemptNumber === previous.attemptNumber &&
        serializeStoredExecutionJsonValue(next.output ?? null) ===
          serializeStoredExecutionJsonValue(observation.output ?? null)
      )
        continue;
      if (
        sourceNames.some((name) =>
          persistedNodeFacts.has(`${next.invocationKey}:${name}`),
        ) &&
        observation !== undefined &&
        next.attemptNumber === previous.attemptNumber &&
        (next.status !== 'waiting' || next.resumeAt === observation.resumeAt) &&
        (next.status === 'waiting' ||
          (observation.status === next.status &&
            serializeStoredExecutionJsonValue(next.output ?? null) ===
              serializeStoredExecutionJsonValue(observation.output ?? null)))
      )
        continue;
    } else if (
      (previous.status === 'ready' || previous.status === 'waiting') &&
      terminalStatus(terminalEvent) !== undefined &&
      plannedNodeEvents.has(`${next.invocationKey}:${terminalEvent}`)
    ) {
      expectedNodeEvents.add(`${next.invocationKey}:${terminalEvent}`);
      if (
        next.attemptNumber !== previous.attemptNumber ||
        next.resumeAt !== undefined ||
        serializeStoredExecutionJsonValue(next.output ?? null) !==
          serializeStoredExecutionJsonValue(previous.output ?? null)
      )
        throw new CoordinatorPlanInvalidError();
      continue;
    }
    throw new CoordinatorPlanInvalidError();
  }

  const plannedNodeEventCount = plan.events.filter(({ name }) =>
    name.startsWith('node.'),
  ).length;
  if (
    plannedNodeEventCount !== expectedNodeEvents.size ||
    !sameKeys(plannedNodeEvents, expectedNodeEvents)
  )
    throw new CoordinatorPlanInvalidError();

  const expectedRunEvents = new Set<string>();
  if (
    current.runStatus === 'queued' &&
    plan.checkpoint.runStatus !== 'canceled' &&
    plan.checkpoint.runStatus !== 'timed_out'
  )
    expectedRunEvents.add('run.started');
  if (
    current.runStatus !== 'waiting' &&
    plan.checkpoint.runStatus === 'waiting'
  )
    expectedRunEvents.add('run.waiting');
  if (terminalRunStatuses.has(plan.checkpoint.runStatus))
    expectedRunEvents.add(`run.${plan.checkpoint.runStatus}`);
  const plannedRunEvents = plan.events.filter(({ name }) =>
    name.startsWith('run.'),
  );
  if (
    plannedRunEvents.length !== expectedRunEvents.size ||
    plannedRunEvents.some(({ name }) => !expectedRunEvents.has(name))
  )
    throw new CoordinatorPlanInvalidError();
}

async function validateCheckpointOutputOwnership(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  checkpoint: PersistedPhase3Checkpoint,
): Promise<void> {
  const expected = checkpoint.invocations.filter(
    (invocation) => invocation.output !== undefined,
  );
  if (expected.length === 0) return;
  const rows = await client.query<{
    attempt_id: string | null;
    attempt_output_ref: unknown;
    attempt_status: string | null;
    control_kind: string | null;
    invocation_key: string;
    node_output_ref: unknown;
    node_status: string;
  }>(
    `select node.invocation_key, node.status as node_status,node.control_kind,
            node.output_ref as node_output_ref,
            attempt.id as attempt_id, attempt.status as attempt_status,
            attempt.output_ref as attempt_output_ref
     from app.node_runs node
     join app.node_attempts attempt
       on attempt.workspace_id=node.workspace_id
      and attempt.id=node.current_attempt_id
     where node.workspace_id=$1 and node.workflow_run_id=$2
       and node.invocation_key=any($3::varchar[])
     for share of node, attempt`,
    [workspaceId, runId, expected.map(({ invocationKey }) => invocationKey)],
  );
  const physical = new Map(rows.rows.map((row) => [row.invocation_key, row]));
  const artifacts = new Set<string>();
  for (const invocation of expected) {
    const row = physical.get(invocation.invocationKey);
    const isLoopControl = checkpoint.loops.some(
      ({ controlInvocationKey }) =>
        controlInvocationKey === invocation.invocationKey,
    );
    const physicalLoopStatus =
      isLoopControl && row?.control_kind === 'for_each_barrier'
        ? 'waiting'
        : 'succeeded';
    if (
      row?.attempt_id === undefined ||
      row.attempt_id === null ||
      row.node_status !==
        (isLoopControl ? physicalLoopStatus : invocation.status) ||
      row.attempt_status !== (isLoopControl ? 'succeeded' : invocation.status)
    )
      throw new CoordinatorRunStateCorruptError();
    let nodeValue;
    let attemptValue;
    try {
      nodeValue = parseStoredExecutionValueV1(row.node_output_ref);
      attemptValue = parseStoredExecutionValueV1(row.attempt_output_ref);
    } catch {
      throw new CoordinatorRunStateCorruptError();
    }
    if (
      serializeStoredExecutionJsonValue(nodeValue) !==
      serializeStoredExecutionJsonValue(attemptValue)
    )
      throw new CoordinatorRunStateCorruptError();
    const output = invocation.output;
    if (output === undefined) throw new CoordinatorRunStateCorruptError();
    if (output.kind === 'inline') {
      if (output.attemptId !== row.attempt_id || nodeValue.kind !== 'inline')
        throw new CoordinatorRunStateCorruptError();
    } else {
      if (
        nodeValue.kind !== 'artifact' ||
        nodeValue.artifactId !== output.artifactId
      )
        throw new CoordinatorRunStateCorruptError();
      artifacts.add(output.artifactId);
    }
  }
  if (artifacts.size === 0) return;
  const available = await client.query<{ id: string }>(
    `select id from app.artifacts
     where workspace_id=$1 and id=any($2::uuid[])
       and status='available' and deleted_at is null
     for share`,
    [workspaceId, [...artifacts]],
  );
  if (available.rows.length !== artifacts.size)
    throw new CoordinatorRunStateCorruptError();
}

async function persistLoopBarrierTransitions(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  current: PersistedPhase3Checkpoint,
  next: PersistedPhase3Checkpoint,
): Promise<void> {
  const currentLoops = new Set(
    current.loops.map(({ controlInvocationKey }) => controlInvocationKey),
  );
  const barriers = next.loops.filter(
    ({ controlInvocationKey }) => !currentLoops.has(controlInvocationKey),
  );
  if (barriers.length === 0) return;
  const updated = await client.query(
    `update app.node_runs
     set status='waiting', control_kind='for_each_barrier', completed_at=null,
         resume_at=null, retry_due_at=null, due_wakeup_at=null,
         updated_at=clock_timestamp()
     where workspace_id=$1 and workflow_run_id=$2
       and invocation_key=any($3::varchar[]) and status='succeeded'`,
    [
      workspaceId,
      runId,
      barriers.map(({ controlInvocationKey }) => controlInvocationKey),
    ],
  );
  if (updated.rowCount !== barriers.length)
    throw new CoordinatorRunStateCorruptError();
}

async function persistDueReadyTransitions(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  current: PersistedPhase3Checkpoint,
  next: PersistedPhase3Checkpoint,
): Promise<void> {
  const currentInvocations = new Map(
    current.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const transitions = next.invocations.filter(
    (invocation) =>
      invocation.status === 'ready' &&
      currentInvocations.get(invocation.invocationKey)?.status === 'waiting',
  );
  if (transitions.length === 0) return;
  const rows = await client.query<{
    current_attempt_number: number | null;
    invocation_key: string;
    is_due: boolean;
  }>(
    `select invocation_key, current_attempt_number,
            coalesce(retry_due_at,resume_at) is not null
              and coalesce(retry_due_at,resume_at) <= clock_timestamp() as is_due
     from app.node_runs
     where workspace_id=$1 and workflow_run_id=$2
       and invocation_key=any($3::varchar[]) and status='waiting'
     for update`,
    [workspaceId, runId, transitions.map(({ invocationKey }) => invocationKey)],
  );
  const physical = new Map(rows.rows.map((row) => [row.invocation_key, row]));
  if (
    transitions.some((transition) => {
      const row = physical.get(transition.invocationKey);
      return (
        row?.is_due !== true ||
        row.current_attempt_number !== transition.attemptNumber
      );
    })
  )
    throw new CoordinatorPlanInvalidError();
  const updated = await client.query(
    `update app.node_runs
     set status='ready', resume_at=null, retry_due_at=null, due_wakeup_at=null,
         updated_at=clock_timestamp()
     where workspace_id=$1 and workflow_run_id=$2
       and invocation_key=any($3::varchar[]) and status='waiting'`,
    [workspaceId, runId, transitions.map(({ invocationKey }) => invocationKey)],
  );
  if (updated.rowCount !== transitions.length)
    throw new CoordinatorRunStateCorruptError();
}

const terminalRunStatuses = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);
const allowedRunTransitions: Readonly<Record<string, ReadonlySet<string>>> = {
  queued: new Set([
    'running',
    'waiting',
    'succeeded',
    'failed',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ]),
  running: new Set([
    'running',
    'waiting',
    'succeeded',
    'failed',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ]),
  waiting: new Set([
    'running',
    'waiting',
    'succeeded',
    'failed',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ]),
};

export function createCoordinatorRunStore(
  config: DatabaseConfig,
): CoordinatorRunStore {
  const pool = new Pool(config);
  return Object.freeze({
    acknowledgeAdvanceDelivery: async (
      input: AcknowledgeAdvanceDeliveryInput,
    ): Promise<AcknowledgeAdvanceDeliveryResult> => {
      assertNotAborted(input.signal);
      let workspaceId: string;
      let runId: string;
      let delivery: CoordinatorAdvanceDelivery;
      try {
        workspaceId = identitySchema.parse(input.workspaceId);
        runId = identitySchema.parse(input.runId);
        delivery = coordinatorDeliverySchema.parse(input.delivery);
      } catch {
        throw new CoordinatorDeliveryMismatchError();
      }
      try {
        return await withWorkspaceWriteClient(
          pool,
          workspaceId,
          input.signal,
          async (client) => {
            await validateAuthoritativeAdvanceDelivery(
              client,
              workspaceId,
              runId,
              delivery,
            );
            const receipt = await claimCoordinatorReceipt(
              client,
              workspaceId,
              delivery,
            );
            if (receipt === 'duplicate')
              return Object.freeze({ kind: 'duplicate' as const });
            await completeCoordinatorReceipt(client, workspaceId, delivery);
            return Object.freeze({ kind: 'acknowledged' as const });
          },
        );
      } catch (error: unknown) {
        if (error instanceof DeliveryMismatch)
          return auditCoordinatorDeliveryMismatch(
            pool,
            workspaceId,
            delivery,
            input.signal,
          );
        throw error;
      }
    },
    loadAdvanceState: async (
      input: LoadAdvanceStateInput,
    ): Promise<LoadAdvanceStateResult> => {
      assertNotAborted(input.signal);
      const workspaceId = identitySchema.parse(input.workspaceId);
      const runId = identitySchema.parse(input.runId);
      return withWorkspaceClient(
        pool,
        workspaceId,
        input.signal,
        async (client) => {
          const result = await client.query<{
            run_id: string;
            workflow_version_id: string;
            status: string;
            cancel_requested_at: Date | null;
            deadline_at: Date | null;
            database_now: Date;
            revision: number;
            engine_version: string;
            scheduler_state: unknown;
            executable_schema_version: number | null;
            event_high_water: number;
          }>(
            `select run.id as run_id, run.workflow_version_id, run.status,
                    run.cancel_requested_at, run.deadline_at,
                    clock_timestamp() as database_now,
                    checkpoint.revision, checkpoint.engine_version,
                    checkpoint.scheduler_state,
                    version.executable_schema_version,
                    coalesce((select max(event.sequence) from app.run_events event
                              where event.workspace_id = run.workspace_id
                                and event.workflow_run_id = run.id), 0)::int as event_high_water
             from app.workflow_runs run
             join app.run_checkpoints checkpoint
               on checkpoint.workspace_id = run.workspace_id
              and checkpoint.workflow_run_id = run.id
              and checkpoint.workflow_version_id = run.workflow_version_id
             left join app.workflow_versions version
               on version.workspace_id = run.workspace_id
              and version.id = run.workflow_version_id
             where run.workspace_id = $1 and run.id = $2`,
            [workspaceId, runId],
          );
          assertNotAborted(input.signal);
          const row = result.rows[0];
          if (row === undefined) return Object.freeze({ kind: 'not_found' });
          if (row.executable_schema_version !== 2)
            return Object.freeze({ kind: 'not_executable' });
          let checkpoint: PersistedPhase3Checkpoint;
          try {
            checkpoint = parsePersistedPhase3Checkpoint(row.scheduler_state);
          } catch {
            return Object.freeze({ kind: 'unsupported_checkpoint' });
          }
          if (
            checkpoint.revision !== row.revision ||
            checkpoint.engineVersion !== row.engine_version ||
            checkpoint.workflowVersionId !== row.workflow_version_id ||
            checkpoint.runStatus !== row.status
          )
            throw new CoordinatorRunStateCorruptError();

          const factCapacity = await persistedFactCapacity(
            client,
            workspaceId,
            runId,
            checkpoint.nextEventSequence,
          );
          if (factCapacity.count > maximumPersistedFacts)
            return Object.freeze({ kind: 'capacity_exceeded' });
          const events = await readPersistedFacts(client, {
            count: factCapacity.count,
            firstSequence: checkpoint.nextEventSequence,
            runId,
            workspaceId,
          });
          if (events.length !== factCapacity.count)
            throw new CoordinatorRunStateCorruptError();
          for (const [index, event] of events.entries()) {
            if (event.sequence !== checkpoint.nextEventSequence + index)
              throw new CoordinatorRunStateCorruptError();
          }
          const observedHighWater =
            checkpoint.nextEventSequence + events.length - 1;
          if (observedHighWater !== row.event_high_water)
            throw new CoordinatorRunStateCorruptError();
          validatePersistedFactBatch(events);
          const observations = events.map(mapEvent);
          const completedOutputs = events.flatMap(completedInlineOutput);
          const pendingFailures = await client.query<{
            attempt_id: string;
            attempt_number: number;
            completed_at: Date;
            executor_error_kind: string;
            executor_failure_kind: string;
            executor_possibly_dispatched: boolean;
            invocation_key: string;
            safe_error_code: string;
          }>(
            `select attempt.id attempt_id,attempt.attempt_number,
                    attempt.completed_at,attempt.executor_failure_kind,
                    attempt.executor_error_kind,
                    attempt.executor_possibly_dispatched,
                    attempt.safe_error_code,node.invocation_key
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id
              and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and node.workflow_run_id=$2
               and node.current_attempt_id=attempt.id
               and node.current_attempt_number=attempt.attempt_number
               and node.status='running' and attempt.status='failed'
               and attempt.retry_decision='pending'
             order by node.invocation_key,attempt.id`,
            [workspaceId, runId],
          );
          for (const failure of pendingFailures.rows) {
            if (
              !['failed', 'canceled', 'retry', 'outcome_unknown'].includes(
                failure.executor_failure_kind,
              ) ||
              ![
                'authentication',
                'canceled',
                'configuration',
                'internal',
                'network',
                'provider',
                'rate_limit',
                'timeout',
              ].includes(failure.executor_error_kind)
            )
              throw new CoordinatorRunStateCorruptError();
            observations.push({
              kind: 'attempt_failure',
              occurredAt: failure.completed_at.toISOString(),
              invocationKey: failure.invocation_key,
              attemptId: failure.attempt_id,
              attemptNumber: failure.attempt_number,
              failureKind: failure.executor_failure_kind,
              errorKind: failure.executor_error_kind,
              possiblyDispatched: failure.executor_possibly_dispatched,
              safeErrorCode: failure.safe_error_code,
            });
          }
          const checkpointInvocations = new Map(
            checkpoint.invocations.map((invocation) => [
              invocation.invocationKey,
              invocation,
            ]),
          );
          for (const observation of observations) {
            const value = record(observation);
            if (value.kind === 'cancel_requested') continue;
            if (
              typeof value.invocationKey !== 'string' ||
              typeof value.attemptNumber !== 'number'
            )
              throw new CoordinatorRunStateCorruptError();
            const invocation = checkpointInvocations.get(value.invocationKey);
            if (
              invocation?.status !== 'running' ||
              invocation.attemptNumber !== value.attemptNumber
            )
              throw new CoordinatorRunStateCorruptError();
          }
          await validateLoadedCheckpointPhysicalState(
            client,
            workspaceId,
            runId,
            checkpoint,
            observations,
          );
          const hasFreshCancellation = observations.some(
            (observation) => record(observation).kind === 'cancel_requested',
          );
          if (
            (checkpoint.cancelRequested && row.cancel_requested_at === null) ||
            (hasFreshCancellation && row.cancel_requested_at === null) ||
            (checkpoint.deadlineExpired &&
              (row.deadline_at === null || row.deadline_at > row.database_now))
          )
            throw new CoordinatorRunStateCorruptError();
          const artifactIds = observations.flatMap((observation) => {
            const value = record(observation);
            const output = value.output;
            if (output === undefined) return [];
            const parsedOutput = record(output);
            return parsedOutput.kind === 'artifact' &&
              typeof parsedOutput.artifactId === 'string'
              ? [parsedOutput.artifactId]
              : [];
          });
          if (artifactIds.length > 0) {
            const availableArtifacts = await client.query<{ id: string }>(
              `select id from app.artifacts
               where workspace_id = $1 and id = any($2::uuid[])
                 and status = 'available' and deleted_at is null`,
              [workspaceId, artifactIds],
            );
            if (
              new Set(availableArtifacts.rows.map(({ id }) => id)).size !==
              new Set(artifactIds).size
            )
              throw new CoordinatorRunStateCorruptError();
          }
          if (
            row.cancel_requested_at !== null &&
            !checkpoint.cancelRequested &&
            !hasFreshCancellation
          )
            throw new CoordinatorRunStateCorruptError();
          if (
            row.deadline_at !== null &&
            row.deadline_at <= row.database_now &&
            !checkpoint.deadlineExpired
          )
            observations.push({
              kind: 'deadline_expired',
              occurredAt: row.deadline_at.toISOString(),
            });

          const due = await client.query<{
            invocation_key: string;
            due_at: Date;
          }>(
            `select invocation_key, coalesce(retry_due_at, resume_at) as due_at
             from app.node_runs
             where workspace_id = $1 and workflow_run_id = $2
               and status = 'waiting'
               and coalesce(retry_due_at, resume_at) <= $3
               and invocation_key = any($4::varchar[])
             order by invocation_key
             limit 10001`,
            [
              workspaceId,
              runId,
              row.database_now,
              checkpoint.invocations
                .filter(({ status }) => status === 'waiting')
                .map(({ invocationKey }) => invocationKey),
            ],
          );
          if (due.rows.length > 10_000)
            throw new CoordinatorRunStateCorruptError();
          observations.push(
            ...due.rows.map(
              ({ invocation_key: invocationKey, due_at: dueAt }) => {
                const invocation = checkpointInvocations.get(invocationKey);
                if (
                  invocation?.status !== 'waiting' ||
                  invocation.resumeAt !== dueAt.toISOString()
                )
                  throw new CoordinatorRunStateCorruptError();
                return {
                  kind: 'due_at',
                  invocationKey,
                  occurredAt: dueAt.toISOString(),
                };
              },
            ),
          );
          assertNotAborted(input.signal);
          return Object.freeze({
            kind: 'ready',
            state: Object.freeze({
              runId: row.run_id,
              workflowVersionId: row.workflow_version_id,
              checkpoint,
              observations: Object.freeze(observations.map(Object.freeze)),
              completedOutputs: Object.freeze(
                completedOutputs.map(Object.freeze),
              ),
            }),
          });
        },
      );
    },
    commitAdvancePlan: async (
      input: CommitAdvancePlanInput,
    ): Promise<CommitAdvancePlanResult> => {
      if (!(input.signal instanceof AbortSignal))
        throw new CoordinatorPlanInvalidError();
      assertNotAborted(input.signal);
      let workspaceId: string;
      let runId: string;
      let workflowVersionId: string;
      let traceparent: string | undefined;
      let delivery: CoordinatorAdvanceDelivery;
      try {
        workspaceId = identitySchema.parse(input.workspaceId);
        runId = identitySchema.parse(input.runId);
        workflowVersionId = identitySchema.parse(input.workflowVersionId);
        traceparent = traceparentSchema.parse(input.traceparent);
        delivery = coordinatorDeliverySchema.parse(input.delivery);
      } catch {
        throw new CoordinatorPlanInvalidError();
      }
      const plan = parseTransitionPlan(input.plan);
      validateTransitionPlan(plan, workflowVersionId);
      const checkpointJson = serializePersistedPhase3Checkpoint(
        plan.checkpoint,
      );
      const planFingerprint = transitionFingerprint({
        plan,
        traceparent,
        workflowVersionId,
      });
      try {
        return await withWorkspaceWriteClient(
          pool,
          workspaceId,
          input.signal,
          async (client) => {
            await validateAuthoritativeAdvanceDelivery(
              client,
              workspaceId,
              runId,
              delivery,
            );
            const locked = await client.query<{
              revision: number;
              scheduler_state: unknown;
              last_transition_fingerprint: string | null;
              workflow_version_id: string;
              status: string;
              cancel_requested_at: Date | null;
              deadline_expired: boolean;
            }>(
              `select checkpoint.revision, checkpoint.scheduler_state,
                    checkpoint.last_transition_fingerprint,
                    checkpoint.workflow_version_id, run.status,
                    run.cancel_requested_at,
                    run.deadline_at is not null
                      and run.deadline_at <= clock_timestamp() as deadline_expired
             from app.workflow_runs run
             join app.run_checkpoints checkpoint
               on checkpoint.workspace_id = run.workspace_id
              and checkpoint.workflow_run_id = run.id
             where run.workspace_id = $1 and run.id = $2
             for update of run, checkpoint`,
              [workspaceId, runId],
            );
            const row = locked.rows[0];
            if (row === undefined) return Object.freeze({ kind: 'not_found' });
            if (row.workflow_version_id !== workflowVersionId)
              throw new CoordinatorPlanInvalidError();
            if (row.revision !== plan.expectedRevision) {
              if (
                row.revision === plan.expectedRevision + 1 &&
                row.last_transition_fingerprint === planFingerprint &&
                serializeStoredExecutionJsonValue(row.scheduler_state) ===
                  checkpointJson
              ) {
                const receipt = await claimCoordinatorReceipt(
                  client,
                  workspaceId,
                  delivery,
                );
                if (receipt === 'new')
                  await completeCoordinatorReceipt(
                    client,
                    workspaceId,
                    delivery,
                  );
                return Object.freeze({
                  kind: 'already_committed',
                  revision: row.revision,
                });
              }
              return Object.freeze({ kind: 'stale', revision: row.revision });
            }
            let currentCheckpoint: PersistedPhase3Checkpoint;
            try {
              currentCheckpoint = parsePersistedPhase3Checkpoint(
                row.scheduler_state,
              );
            } catch {
              throw new CoordinatorRunStateCorruptError();
            }
            if (
              currentCheckpoint.workflowVersionId !== workflowVersionId ||
              currentCheckpoint.revision !== row.revision ||
              currentCheckpoint.runStatus !== row.status ||
              currentCheckpoint.nextEventSequence !==
                plan.expectedNextEventSequence
            )
              throw new CoordinatorRunStateCorruptError();
            validateTransitionDelta(currentCheckpoint, plan);
            if (
              !allowedRunTransitions[currentCheckpoint.runStatus]?.has(
                plan.checkpoint.runStatus,
              )
            )
              throw new CoordinatorPlanInvalidError();
            const highWaterResult = await client.query<{ high_water: number }>(
              `select coalesce(max(sequence), 0)::int as high_water
             from app.run_events
             where workspace_id = $1 and workflow_run_id = $2`,
              [workspaceId, runId],
            );
            if (
              highWaterResult.rows[0]?.high_water !==
              plan.consumedThroughEventSequence
            )
              return Object.freeze({ kind: 'stale', revision: row.revision });
            const expectedPersistedFactCount = Math.max(
              0,
              plan.consumedThroughEventSequence -
                currentCheckpoint.nextEventSequence +
                1,
            );
            const factCapacity = await persistedFactCapacity(
              client,
              workspaceId,
              runId,
              currentCheckpoint.nextEventSequence,
              plan.consumedThroughEventSequence,
            );
            if (factCapacity.count !== expectedPersistedFactCount)
              return Object.freeze({ kind: 'stale', revision: row.revision });
            if (factCapacity.count > maximumPersistedFacts)
              throw new CoordinatorRunStateCorruptError();
            const persistedFacts = await readPersistedFacts(client, {
              count: factCapacity.count,
              firstSequence: currentCheckpoint.nextEventSequence,
              lastSequence: plan.consumedThroughEventSequence,
              runId,
              workspaceId,
            });
            if (persistedFacts.length !== expectedPersistedFactCount)
              return Object.freeze({ kind: 'stale', revision: row.revision });
            validatePersistedFactBatch(persistedFacts);
            const pendingFailures = await client.query<{
              attempt_id: string;
              attempt_number: number;
              executor_error_kind: string;
              executor_failure_kind: string;
              executor_possibly_dispatched: boolean;
              invocation_key: string;
              safe_error_code: string;
            }>(
              `select attempt.id attempt_id,attempt.attempt_number,
                      attempt.executor_failure_kind,attempt.executor_error_kind,
                      attempt.executor_possibly_dispatched,attempt.safe_error_code,
                      node.invocation_key
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
               where attempt.workspace_id=$1 and node.workflow_run_id=$2
                 and node.current_attempt_id=attempt.id
                 and node.status='running' and attempt.status='failed'
                 and attempt.retry_decision='pending'
               order by node.invocation_key,attempt.id
               for update of node,attempt`,
              [workspaceId, runId],
            );
            validateStatusTransitions(currentCheckpoint, plan, [
              ...persistedFacts.map((fact) => ({
                invocationKey: fact.invocation_key,
                observation: record(mapEvent(fact)),
                type: fact.type,
              })),
              ...pendingFailures.rows.map((failure) => ({
                invocationKey: failure.invocation_key,
                type: 'attempt_failure',
                observation: record({
                  kind: 'attempt_failure',
                  attemptId: failure.attempt_id,
                  attemptNumber: failure.attempt_number,
                  failureKind: failure.executor_failure_kind,
                  errorKind: failure.executor_error_kind,
                  possiblyDispatched: failure.executor_possibly_dispatched,
                  safeErrorCode: failure.safe_error_code,
                }),
              })),
            ]);
            if (
              (currentCheckpoint.cancelRequested &&
                row.cancel_requested_at === null) ||
              (currentCheckpoint.deadlineExpired && !row.deadline_expired)
            )
              throw new CoordinatorRunStateCorruptError();
            const authoritativeCancellation =
              currentCheckpoint.cancelRequested ||
              row.cancel_requested_at !== null;
            const authoritativeDeadline =
              currentCheckpoint.deadlineExpired || row.deadline_expired;
            if (
              plan.checkpoint.cancelRequested !== authoritativeCancellation ||
              plan.checkpoint.deadlineExpired !== authoritativeDeadline
            ) {
              if (
                (!plan.checkpoint.cancelRequested &&
                  authoritativeCancellation) ||
                (!plan.checkpoint.deadlineExpired && authoritativeDeadline)
              )
                return Object.freeze({ kind: 'stale', revision: row.revision });
              throw new CoordinatorPlanInvalidError();
            }
            await validateCheckpointOutputOwnership(
              client,
              workspaceId,
              runId,
              plan.checkpoint,
            );
            await persistLoopBarrierTransitions(
              client,
              workspaceId,
              runId,
              currentCheckpoint,
              plan.checkpoint,
            );
            await persistDueReadyTransitions(
              client,
              workspaceId,
              runId,
              currentCheckpoint,
              plan.checkpoint,
            );
            assertNotAborted(input.signal);
            const receipt = await claimCoordinatorReceipt(
              client,
              workspaceId,
              delivery,
            );
            if (receipt === 'duplicate')
              return Object.freeze({
                kind: 'already_committed' as const,
                revision: row.revision,
              });

            const invocations = new Map(
              plan.checkpoint.invocations.map((invocation) => [
                invocation.invocationKey,
                invocation,
              ]),
            );
            const physical = new Map<
              string,
              { nodeRunId: string; attemptId?: string; attemptNumber?: number }
            >();
            for (const failure of pendingFailures.rows) {
              const event = plan.events.find(
                (candidate) =>
                  candidate.invocationKey === failure.invocation_key &&
                  [
                    'node.retry_scheduled',
                    'node.failed',
                    'node.canceled',
                    'node.timed_out',
                    'node.outcome_unknown',
                  ].includes(candidate.name),
              );
              const invocation = invocations.get(failure.invocation_key);
              if (event === undefined || invocation === undefined)
                throw new CoordinatorPlanInvalidError();
              const decision =
                event.name === 'node.retry_scheduled'
                  ? 'retry'
                  : event.name.slice('node.'.length);
              if (
                ![
                  'retry',
                  'failed',
                  'canceled',
                  'timed_out',
                  'outcome_unknown',
                ].includes(decision)
              )
                throw new CoordinatorPlanInvalidError();
              const finalized = await client.query(
                `update app.node_attempts set retry_decision=$3,updated_at=clock_timestamp()
                 where workspace_id=$1 and id=$2 and retry_decision='pending'`,
                [workspaceId, failure.attempt_id, decision],
              );
              if (finalized.rowCount !== 1)
                throw new CoordinatorRunStateCorruptError();
              const nodeStatus = decision === 'retry' ? 'waiting' : decision;
              const updated = await client.query(
                `update app.node_runs
                 set status=$4::varchar,retry_due_at=$5,due_wakeup_at=null,
                     completed_at=case when $4::varchar='waiting' then null else clock_timestamp() end,
                     safe_error_code=$6,updated_at=clock_timestamp()
                 where workspace_id=$1 and workflow_run_id=$2
                   and invocation_key=$3 and current_attempt_id=$7
                   and status='running'`,
                [
                  workspaceId,
                  runId,
                  failure.invocation_key,
                  nodeStatus,
                  decision === 'retry' ? event.dueAt : null,
                  failure.safe_error_code,
                  failure.attempt_id,
                ],
              );
              if (updated.rowCount !== 1)
                throw new CoordinatorRunStateCorruptError();
            }
            for (const admission of plan.nodeRunAdmissions) {
              const invocation = invocations.get(admission.invocationKey);
              if (invocation === undefined)
                throw new CoordinatorPlanInvalidError();
              const attempt = plan.attempts.find(
                ({ invocationKey }) =>
                  invocationKey === admission.invocationKey,
              );
              const nodeRunId = randomUUID();
              const attemptId =
                attempt === undefined ? undefined : randomUUID();
              await client.query(
                `insert into app.node_runs (
                  id, workspace_id, workflow_run_id, node_id, invocation_key,
                  branch_context, status, side_effect_class, provider_idempotency_key,
                  current_attempt_id, current_attempt_number, completed_at
                ) values (
                  $1,$2,$3,$4,$5,$6::jsonb,$7::varchar,$8,$9,$10,$11,
                  case when $7::varchar = 'skipped' then clock_timestamp() else null end
                )`,
                [
                  nodeRunId,
                  workspaceId,
                  runId,
                  admission.nodeId,
                  admission.invocationKey,
                  serializeStoredExecutionJsonValue({
                    ...('branchPath' in invocation &&
                    invocation.branchPath !== undefined
                      ? { branchPath: invocation.branchPath }
                      : {}),
                    ...('iterationPath' in invocation &&
                    invocation.iterationPath !== undefined
                      ? { iterationPath: invocation.iterationPath }
                      : {}),
                  }),
                  invocation.status === 'pending'
                    ? 'pending'
                    : invocation.status === 'skipped'
                      ? 'skipped'
                      : 'ready',
                  admission.sideEffectClass,
                  admission.providerIdempotencyKey ?? null,
                  attemptId ?? null,
                  attempt?.attemptNumber ?? null,
                ],
              );
              physical.set(admission.invocationKey, {
                nodeRunId,
                ...(attemptId === undefined || attempt === undefined
                  ? {}
                  : { attemptId, attemptNumber: attempt.attemptNumber }),
              });
            }

            for (const attempt of plan.attempts) {
              let ids = physical.get(attempt.invocationKey);
              if (ids === undefined) {
                const existing = await client.query<{
                  id: string;
                  current_attempt_number: number | null;
                  provider_idempotency_key: string | null;
                  side_effect_class: string;
                  status: string;
                  is_due: boolean;
                }>(
                  `select id, current_attempt_number, side_effect_class,
                        provider_idempotency_key, status,
                        coalesce(retry_due_at, resume_at) is not null
                          and coalesce(retry_due_at, resume_at) <= clock_timestamp()
                          as is_due
                 from app.node_runs
                 where workspace_id = $1 and workflow_run_id = $2
                   and invocation_key = $3
                 for update`,
                  [workspaceId, runId, attempt.invocationKey],
                );
                const node = existing.rows[0];
                const isFirstReadyAttempt =
                  (node?.status === 'ready' || node?.status === 'pending') &&
                  (node.current_attempt_number === null
                    ? attempt.attemptNumber === 1
                    : node.current_attempt_number ===
                      attempt.attemptNumber - 1);
                const isDueAttempt =
                  node?.status === 'waiting' &&
                  node.is_due &&
                  node.current_attempt_number === attempt.attemptNumber - 1;
                if (
                  node?.side_effect_class !== attempt.sideEffectClass ||
                  node.provider_idempotency_key !==
                    (attempt.providerIdempotencyKey ?? null) ||
                  (!isFirstReadyAttempt && !isDueAttempt)
                )
                  throw new CoordinatorPlanInvalidError();
                ids = {
                  nodeRunId: node.id,
                  attemptId: randomUUID(),
                  attemptNumber: attempt.attemptNumber,
                };
                physical.set(attempt.invocationKey, ids);
                await client.query(
                  `update app.node_runs
                 set status='ready', current_attempt_id=$1,
                     current_attempt_number=$2, resume_at=null,
                      retry_due_at=null, due_wakeup_at=null, updated_at=clock_timestamp()
                 where workspace_id=$3 and id=$4`,
                  [
                    ids.attemptId,
                    attempt.attemptNumber,
                    workspaceId,
                    ids.nodeRunId,
                  ],
                );
              }
              if (ids.attemptId === undefined)
                throw new CoordinatorPlanInvalidError();
              await client.query(
                `insert into app.node_attempts (
                  id, workspace_id, node_run_id, attempt_number, status,
                  side_effect_class, provider_idempotency_key
                ) values ($1,$2,$3,$4,'ready',$5,$6)`,
                [
                  ids.attemptId,
                  workspaceId,
                  ids.nodeRunId,
                  attempt.attemptNumber,
                  attempt.sideEffectClass,
                  attempt.providerIdempotencyKey ?? null,
                ],
              );
              const outboxEventId = randomUUID();
              const payload = {
                schemaVersion: 1,
                workspaceId,
                runId,
                nodeRunId: ids.nodeRunId,
                attemptId: ids.attemptId,
                outboxEventId,
                ...(traceparent === undefined ? {} : { traceparent }),
              } as const;
              await client.query(
                `insert into app.outbox_events (
                 id, workspace_id, job_name, schema_version, aggregate_type,
                 aggregate_id, payload, payload_checksum
               ) values ($1,$2,'execute-node-attempt',1,'node-attempt',$3,$4::jsonb,$5)`,
                [
                  outboxEventId,
                  workspaceId,
                  ids.attemptId,
                  serializeStoredExecutionJsonValue(payload),
                  canonicalOutboxPayloadChecksum(payload),
                ],
              );
            }

            const missingEventInvocationKeys = [
              ...new Set(
                plan.events.flatMap(({ invocationKey }) =>
                  invocationKey === undefined || physical.has(invocationKey)
                    ? []
                    : [invocationKey],
                ),
              ),
            ];
            if (missingEventInvocationKeys.length > 0) {
              const existingNodes = await client.query<{
                id: string;
                invocation_key: string;
                current_attempt_id: string | null;
                current_attempt_number: number | null;
              }>(
                `select id, invocation_key, current_attempt_id,
                      current_attempt_number
               from app.node_runs
               where workspace_id=$1 and workflow_run_id=$2
                 and invocation_key=any($3::varchar[])
               for update`,
                [workspaceId, runId, missingEventInvocationKeys],
              );
              for (const node of existingNodes.rows)
                physical.set(node.invocation_key, {
                  nodeRunId: node.id,
                  ...(node.current_attempt_id === null
                    ? {}
                    : {
                        attemptId: node.current_attempt_id,
                        ...(node.current_attempt_number === null
                          ? {}
                          : { attemptNumber: node.current_attempt_number }),
                      }),
                });
              if (missingEventInvocationKeys.some((key) => !physical.has(key)))
                throw new CoordinatorRunStateCorruptError();
            }

            for (const event of plan.events) {
              const ids =
                event.invocationKey === undefined
                  ? undefined
                  : physical.get(event.invocationKey);
              const payload = {
                schemaVersion: event.schemaVersion,
                ...(event.invocationKey === undefined
                  ? {}
                  : { invocationKey: event.invocationKey }),
                ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
                ...(event.attemptNumber === undefined
                  ? {}
                  : { attemptNumber: event.attemptNumber }),
                ...(event.reasonCode === undefined
                  ? {}
                  : { reasonCode: event.reasonCode }),
                ...(event.dueAt === undefined ? {} : { dueAt: event.dueAt }),
                ...(ids === undefined ? {} : { nodeRunId: ids.nodeRunId }),
                ...(ids?.attemptId !== undefined &&
                ids.attemptNumber === event.attemptNumber
                  ? { attemptId: ids.attemptId }
                  : {}),
              };
              await client.query(
                `insert into app.run_events (
                 workspace_id, workflow_run_id, sequence, type, payload, created_at
               ) values ($1,$2,$3,$4,$5::jsonb,$6)`,
                [
                  workspaceId,
                  runId,
                  event.sequence,
                  event.name,
                  serializeStoredExecutionJsonValue(payload),
                  event.occurredAt,
                ],
              );
              const terminalNodeStatus = terminalStatus(event.name);
              if (
                terminalNodeStatus !== undefined &&
                event.invocationKey !== undefined &&
                !pendingFailures.rows.some(
                  (failure) => failure.invocation_key === event.invocationKey,
                )
              ) {
                const updatedNode = await client.query(
                  `update app.node_runs
                  set status=$1, completed_at=clock_timestamp(),
                       safe_error_code=$2, resume_at=null, retry_due_at=null,
                       due_wakeup_at=null, control_kind=null,
                     updated_at=clock_timestamp()
                 where workspace_id=$3 and workflow_run_id=$4
                   and invocation_key=$5
                   and status in ('pending','ready','waiting')`,
                  [
                    terminalNodeStatus,
                    event.reasonCode ?? null,
                    workspaceId,
                    runId,
                    event.invocationKey,
                  ],
                );
                if (updatedNode.rowCount !== 1)
                  throw new CoordinatorRunStateCorruptError();
              }
            }

            const checkpointUpdate = await client.query(
              `update app.run_checkpoints
             set revision=$1, engine_version=$2, scheduler_state=$3::jsonb,
                 last_transition_fingerprint=$7,
                 resume_at=null, resume_lease_owner=null,
                 resume_lease_token=null, resume_lease_expires_at=null,
                 updated_at=clock_timestamp()
             where workspace_id=$4 and workflow_run_id=$5 and revision=$6`,
              [
                plan.checkpoint.revision,
                plan.checkpoint.engineVersion,
                checkpointJson,
                workspaceId,
                runId,
                plan.expectedRevision,
                planFingerprint,
              ],
            );
            if (checkpointUpdate.rowCount !== 1)
              throw new CoordinatorRunStateCorruptError();
            const startedAt = plan.events.find(
              ({ name }) => name === 'run.started',
            )?.occurredAt;
            const completedAt = plan.events.find(
              ({ name }) =>
                name.startsWith('run.') &&
                terminalRunStatuses.has(name.slice(4)),
            )?.occurredAt;
            await client.query(
              `update app.workflow_runs
             set status=$1,
                 started_at=coalesce(started_at,$2::timestamptz),
                 completed_at=case when $3::timestamptz is null
                   then completed_at else $3::timestamptz end,
                 updated_at=clock_timestamp()
             where workspace_id=$4 and id=$5`,
              [
                plan.checkpoint.runStatus,
                startedAt ?? null,
                completedAt ?? null,
                workspaceId,
                runId,
              ],
            );
            await completeCoordinatorReceipt(client, workspaceId, delivery);
            assertNotAborted(input.signal);
            return Object.freeze({
              kind: 'committed',
              revision: plan.checkpoint.revision,
              admittedAttempts: Object.freeze(
                plan.attempts.map(({ invocationKey }) => {
                  const ids = physical.get(invocationKey);
                  if (ids?.attemptId === undefined)
                    throw new CoordinatorPlanInvalidError();
                  return Object.freeze({
                    invocationKey,
                    nodeRunId: ids.nodeRunId,
                    attemptId: ids.attemptId,
                  });
                }),
              ),
            });
          },
        );
      } catch (error: unknown) {
        if (error instanceof DeliveryMismatch)
          return auditCoordinatorDeliveryMismatch(
            pool,
            workspaceId,
            delivery,
            input.signal,
          );
        throw error;
      }
    },
    close: async (): Promise<void> => pool.end(),
  });
}
