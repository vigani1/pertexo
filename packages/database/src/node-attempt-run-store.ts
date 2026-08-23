import { createHash, randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';
import { canonicalOutboxPayloadChecksum } from './outbox.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
  serializeStoredExecutionValueV1,
} from './stored-execution-value.js';

const identitySchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const checksumSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const workerIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u);
const deliverySchema = z
  .object({
    outboxEventId: identitySchema,
    payloadChecksum: checksumSchema,
  })
  .strict();
const claimDeliverySchema = z
  .object({
    workspaceId: identitySchema,
    runId: identitySchema,
    nodeRunId: identitySchema,
    attemptId: identitySchema,
    delivery: deliverySchema,
    leaseDurationSeconds: z.number().int().min(1).max(300),
    workerId: workerIdSchema,
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();
const attemptJobPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: identitySchema,
    runId: identitySchema,
    nodeRunId: identitySchema,
    attemptId: identitySchema,
    outboxEventId: identitySchema,
    traceparent: z
      .string()
      .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
      .optional(),
  })
  .strict();

const consumerName = 'node-attempt-worker';
const nodeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const invocationKeySchema = z.string().min(1).max(256);
const sideEffectClassSchema = z.enum(['safe', 'idempotent_with_key', 'unsafe']);

export type NodeAttemptDelivery = Readonly<z.output<typeof deliverySchema>>;

export type NodeAttemptLease = Readonly<{
  workspaceId: string;
  runId: string;
  workflowVersionId: string;
  nodeRunId: string;
  attemptId: string;
  attemptNumber: number;
  invocationKey: string;
  nodeId: string;
  sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
  providerIdempotencyKey?: string;
  workerId: string;
  fenceToken: number;
  leaseExpiresAt: Date;
  delivery: NodeAttemptDelivery;
}>;

const nodeAttemptLeaseSchema = z
  .object({
    workspaceId: identitySchema,
    runId: identitySchema,
    workflowVersionId: identitySchema,
    nodeRunId: identitySchema,
    attemptId: identitySchema,
    attemptNumber: z.number().int().positive(),
    invocationKey: invocationKeySchema,
    nodeId: nodeIdSchema,
    sideEffectClass: sideEffectClassSchema,
    providerIdempotencyKey: z.string().min(1).max(256).optional(),
    workerId: workerIdSchema,
    fenceToken: z.number().int().positive(),
    leaseExpiresAt: z.date(),
    delivery: deliverySchema,
  })
  .strict();

const loadInputsSchema = z
  .object({
    lease: nodeAttemptLeaseSchema,
    upstreamNodeIds: z
      .array(nodeIdSchema)
      .max(100)
      .refine((values) => new Set(values).size === values.length),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();
const ownedLeaseSchema = z
  .object({
    lease: nodeAttemptLeaseSchema,
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();
const heartbeatSchema = ownedLeaseSchema
  .extend({ leaseDurationSeconds: z.number().int().min(1).max(300) })
  .strict();
const safeErrorCodeSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const executorFailureKindSchema = z.enum([
  'failed',
  'canceled',
  'retry',
  'outcome_unknown',
]);
const executorErrorKindSchema = z.enum([
  'authentication',
  'canceled',
  'configuration',
  'internal',
  'network',
  'provider',
  'rate_limit',
  'timeout',
]);
const completionOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('succeeded'), output: z.unknown() }).strict(),
  z
    .object({
      status: z.enum(['failed', 'canceled', 'timed_out', 'outcome_unknown']),
      safeErrorCode: safeErrorCodeSchema,
      errorSummary: z.string().max(2048).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('executor_failure'),
      failureKind: executorFailureKindSchema,
      errorKind: executorErrorKindSchema,
      possiblyDispatched: z.boolean(),
      safeErrorCode: safeErrorCodeSchema,
    })
    .strict(),
]);
const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .optional();
const completionSchema = ownedLeaseSchema
  .extend({ outcome: completionOutcomeSchema, traceparent: traceparentSchema })
  .strict();

export type NodeAttemptClaimResult =
  | Readonly<{ kind: 'duplicate' }>
  | Readonly<{ kind: 'claimed'; lease: NodeAttemptLease }>;

export type NodeAttemptInputs = Readonly<{
  runInput: unknown;
  completedNodeOutputs: Readonly<Record<string, unknown>>;
  abortRequested: boolean;
  abortReason?: 'canceled' | 'timed_out';
  deadlineAt?: Date;
}>;

export type NodeAttemptCompletion =
  | Readonly<{ status: 'succeeded'; output: unknown }>
  | Readonly<{
      status: 'failed' | 'canceled' | 'timed_out' | 'outcome_unknown';
      safeErrorCode: string;
      errorSummary?: string;
    }>
  | Readonly<{
      status: 'executor_failure';
      failureKind: z.output<typeof executorFailureKindSchema>;
      errorKind: z.output<typeof executorErrorKindSchema>;
      possiblyDispatched: boolean;
      safeErrorCode: string;
    }>;

export type CompleteNodeAttemptResult =
  | Readonly<{ kind: 'committed'; outboxEventId: string }>
  | Readonly<{ kind: 'duplicate'; outboxEventId: null }>;

export interface NodeAttemptRunStore {
  claimDelivery(
    input: Readonly<z.input<typeof claimDeliverySchema>>,
  ): Promise<NodeAttemptClaimResult>;
  loadInputs(
    input: Readonly<{
      lease: NodeAttemptLease;
      upstreamNodeIds: readonly string[];
      signal: AbortSignal;
    }>,
  ): Promise<NodeAttemptInputs>;
  markDispatched(
    input: Readonly<{
      lease: NodeAttemptLease;
      signal: AbortSignal;
    }>,
  ): Promise<Readonly<{ dispatchedAt: Date }>>;
  heartbeat(
    input: Readonly<{
      lease: NodeAttemptLease;
      leaseDurationSeconds: number;
      signal: AbortSignal;
    }>,
  ): Promise<
    Readonly<{
      leaseExpiresAt: Date;
      abortRequested: boolean;
      abortReason?: 'canceled' | 'timed_out';
    }>
  >;
  complete(
    input: Readonly<{
      lease: NodeAttemptLease;
      outcome: NodeAttemptCompletion;
      traceparent?: string;
      signal: AbortSignal;
    }>,
  ): Promise<CompleteNodeAttemptResult>;
  close(): Promise<void>;
}

export class NodeAttemptDeliveryMismatchError extends Error {
  public override readonly name = 'NodeAttemptDeliveryMismatchError';
  public constructor() {
    super('Node attempt delivery does not match its durable outbox identity');
  }
}

export class NodeAttemptReconciliationRequiredError extends Error {
  public override readonly name = 'NodeAttemptReconciliationRequiredError';
  public constructor() {
    super('Node attempt requires lease reconciliation before execution');
  }
}

export class NodeAttemptControlActiveError extends Error {
  public override readonly name = 'NodeAttemptControlActiveError';
  public constructor() {
    super('Node attempt cannot start after durable run control activation');
  }
}

export class NodeAttemptStateCorruptError extends Error {
  public override readonly name = 'NodeAttemptStateCorruptError';
  public constructor() {
    super('Persisted node attempt state is invalid');
  }
}

export class NodeAttemptOutputInvalidError extends Error {
  public override readonly name = 'NodeAttemptOutputInvalidError';
  public constructor() {
    super('Node attempt output violates the inline execution-value contract');
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
  const onAbort = (): void => rejectAbort?.(abortFailure);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) throw abortFailure;
    return await Promise.race([connection, abort]);
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

async function withWorkspaceWriteClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertNotAborted(signal);
  const abortFailure = new Error('Node attempt transaction aborted');
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

async function withWorkspaceReadClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertNotAborted(signal);
  const abortFailure = new Error('Node attempt read aborted');
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

async function validateDelivery(
  client: PoolClient,
  input: z.output<typeof claimDeliverySchema>,
): Promise<void> {
  const result = await client.query<{
    aggregate_id: string;
    aggregate_type: string;
    job_name: string;
    payload: unknown;
    payload_checksum: string;
    schema_version: number;
  }>(
    `select aggregate_id,aggregate_type,job_name,payload,
            payload_checksum,schema_version
     from app.outbox_events
     where workspace_id=$1 and id=$2`,
    [input.workspaceId, input.delivery.outboxEventId],
  );
  const row = result.rows[0];
  let payload: z.output<typeof attemptJobPayloadSchema> | undefined;
  let checksum: string | undefined;
  try {
    payload = attemptJobPayloadSchema.parse(row?.payload);
    checksum = createHash('sha256')
      .update(serializeStoredExecutionJsonValue(payload))
      .digest('hex');
  } catch {
    throw new DeliveryMismatch();
  }
  if (
    row?.aggregate_id !== input.attemptId ||
    row.aggregate_type !== 'node-attempt' ||
    row.job_name !== 'execute-node-attempt' ||
    row.schema_version !== 1 ||
    row.payload_checksum !== input.delivery.payloadChecksum ||
    checksum !== row.payload_checksum ||
    payload.workspaceId !== input.workspaceId ||
    payload.runId !== input.runId ||
    payload.nodeRunId !== input.nodeRunId ||
    payload.attemptId !== input.attemptId ||
    payload.outboxEventId !== input.delivery.outboxEventId
  )
    throw new DeliveryMismatch();
}

async function claimReceipt(
  client: PoolClient,
  workspaceId: string,
  delivery: NodeAttemptDelivery,
): Promise<'new' | 'incomplete' | 'completed'> {
  const inserted = await client.query(
    `insert into app.inbox_receipts (
       consumer_name,message_id,workspace_id,payload_checksum
     ) values ($1,$2,$3,$4)
     on conflict (consumer_name,message_id) do nothing
     returning message_id`,
    [
      consumerName,
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
    `select completed_at,payload_checksum
     from app.inbox_receipts
     where consumer_name=$1 and message_id=$2 and workspace_id=$3
     for update`,
    [consumerName, delivery.outboxEventId, workspaceId],
  );
  const receipt = existing.rows[0];
  if (receipt === undefined) throw new NodeAttemptStateCorruptError();
  if (receipt.payload_checksum !== delivery.payloadChecksum)
    throw new DeliveryMismatch();
  return receipt.completed_at === null ? 'incomplete' : 'completed';
}

async function completeReceipt(
  client: PoolClient,
  workspaceId: string,
  delivery: NodeAttemptDelivery,
): Promise<void> {
  const result = await client.query(
    `update app.inbox_receipts set completed_at=clock_timestamp()
     where consumer_name=$1 and message_id=$2 and workspace_id=$3
       and payload_checksum=$4 and completed_at is null`,
    [
      consumerName,
      delivery.outboxEventId,
      workspaceId,
      delivery.payloadChecksum,
    ],
  );
  if (result.rowCount !== 1) throw new NodeAttemptStateCorruptError();
}

async function auditMismatch(
  pool: Pool,
  workspaceId: string,
  delivery: NodeAttemptDelivery,
  signal: AbortSignal,
): Promise<never> {
  await withWorkspaceWriteClient(pool, workspaceId, signal, async (client) => {
    await client.query(
      `insert into app.transport_security_audit_facts (
         id,workspace_id,fact_type,consumer_name,message_id
       ) values ($1,$2,'inbox_checksum_mismatch',$3,$4)`,
      [randomUUID(), workspaceId, consumerName, delivery.outboxEventId],
    );
  });
  throw new NodeAttemptDeliveryMismatchError();
}

async function appendStartedEvent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    nodeRunId: string;
    attemptId: string;
    invocationKey: string;
    nodeId: string;
    attemptNumber: number;
  }>,
): Promise<void> {
  const sequence = await client.query<{ sequence: number }>(
    `select coalesce(max(sequence),0)::int + 1 as sequence
     from app.run_events where workspace_id=$1 and workflow_run_id=$2`,
    [input.workspaceId, input.runId],
  );
  const next = sequence.rows[0]?.sequence;
  if (next === undefined) throw new NodeAttemptStateCorruptError();
  const payload = serializeStoredExecutionJsonValue({
    schemaVersion: 1,
    nodeRunId: input.nodeRunId,
    attemptId: input.attemptId,
    invocationKey: input.invocationKey,
    nodeId: input.nodeId,
    attemptNumber: input.attemptNumber,
  });
  await client.query(
    `insert into app.run_events (
       workspace_id,workflow_run_id,sequence,type,payload
     ) values ($1,$2,$3,'node.started',$4::jsonb)`,
    [input.workspaceId, input.runId, next, payload],
  );
}

export function createNodeAttemptRunStore(
  config: DatabaseConfig,
): NodeAttemptRunStore {
  const pool = new Pool(config);
  return Object.freeze({
    claimDelivery: async (
      inputValue: Parameters<NodeAttemptRunStore['claimDelivery']>[0],
    ): Promise<NodeAttemptClaimResult> => {
      assertNotAborted(inputValue.signal);
      let input: z.output<typeof claimDeliverySchema>;
      try {
        input = claimDeliverySchema.parse(inputValue);
      } catch {
        throw new NodeAttemptDeliveryMismatchError();
      }
      try {
        return await withWorkspaceWriteClient(
          pool,
          input.workspaceId,
          input.signal,
          async (client) => {
            await validateDelivery(client, input);
            const receipt = await claimReceipt(
              client,
              input.workspaceId,
              input.delivery,
            );
            if (receipt === 'completed')
              return Object.freeze({ kind: 'duplicate' as const });

            const candidate = await client.query<{ run_id: string }>(
              `select node.workflow_run_id as run_id
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
               where attempt.workspace_id=$1 and attempt.id=$2`,
              [input.workspaceId, input.attemptId],
            );
            if (candidate.rows[0]?.run_id !== input.runId)
              throw new NodeAttemptStateCorruptError();
            const run = await client.query<{
              cancel_requested_at: Date | null;
              control_active: boolean;
              deadline_at: Date | null;
              workflow_version_id: string;
            }>(
              `select workflow_version_id,cancel_requested_at,deadline_at,
                      (cancel_requested_at is not null or
                       (deadline_at is not null and
                        deadline_at <= clock_timestamp())) control_active
               from app.workflow_runs
               where workspace_id=$1 and id=$2 for update`,
              [input.workspaceId, input.runId],
            );
            const runRow = run.rows[0];
            if (runRow === undefined) throw new NodeAttemptStateCorruptError();
            const locked = await client.query<{
              attempt_number: number;
              attempt_status: string;
              dispatch_marked_at: Date | null;
              fence_token: string;
              invocation_key: string;
              lease_valid: boolean;
              lease_expires_at: Date | null;
              node_id: string;
              node_status: string;
              provider_idempotency_key: string | null;
              side_effect_class: string;
            }>(
              `select attempt.attempt_number,
                      attempt.status as attempt_status,
                      attempt.dispatch_marked_at,attempt.fence_token,
                      attempt.lease_expires_at,
                      (attempt.lease_expires_at > clock_timestamp()) lease_valid,
                      node.invocation_key,node.node_id,
                      node.status as node_status,attempt.side_effect_class,
                      attempt.provider_idempotency_key
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
               where attempt.workspace_id=$1 and attempt.id=$2
                 and attempt.node_run_id=$3 and node.workflow_run_id=$4
                 and node.current_attempt_id=attempt.id
                 and node.current_attempt_number=attempt.attempt_number
               for update of node,attempt`,
              [
                input.workspaceId,
                input.attemptId,
                input.nodeRunId,
                input.runId,
              ],
            );
            const row = locked.rows[0];
            if (row === undefined) throw new NodeAttemptStateCorruptError();
            if (
              [
                'succeeded',
                'failed',
                'canceled',
                'timed_out',
                'outcome_unknown',
              ].includes(row.attempt_status)
            ) {
              await completeReceipt(client, input.workspaceId, input.delivery);
              return Object.freeze({ kind: 'duplicate' as const });
            }
            if (row.attempt_status === 'running') {
              if (row.lease_expires_at !== null && row.lease_valid)
                return Object.freeze({ kind: 'duplicate' as const });
              throw new NodeAttemptReconciliationRequiredError();
            }
            if (row.attempt_status !== 'ready' || row.node_status !== 'ready')
              throw new NodeAttemptStateCorruptError();
            if (runRow.control_active)
              throw new NodeAttemptControlActiveError();
            if (
              row.side_effect_class !== 'safe' &&
              row.side_effect_class !== 'idempotent_with_key' &&
              row.side_effect_class !== 'unsafe'
            )
              throw new NodeAttemptStateCorruptError();

            const claimed = await client.query<{
              fence_token: string;
              lease_expires_at: Date;
            }>(
              `update app.node_attempts
               set status='running',lease_owner=$3,
                   lease_expires_at=clock_timestamp()+make_interval(secs=>$4),
                   fence_token=fence_token+1,
                   started_at=coalesce(started_at,clock_timestamp()),
                   updated_at=clock_timestamp()
               where workspace_id=$1 and id=$2
               returning fence_token,lease_expires_at`,
              [
                input.workspaceId,
                input.attemptId,
                input.workerId,
                input.leaseDurationSeconds,
              ],
            );
            const claim = claimed.rows[0];
            if (claim === undefined) throw new NodeAttemptStateCorruptError();
            await client.query(
              `update app.node_runs
               set status='running',started_at=coalesce(started_at,clock_timestamp()),
                   updated_at=clock_timestamp()
               where workspace_id=$1 and id=$2`,
              [input.workspaceId, input.nodeRunId],
            );
            await appendStartedEvent(client, {
              workspaceId: input.workspaceId,
              runId: input.runId,
              nodeRunId: input.nodeRunId,
              attemptId: input.attemptId,
              invocationKey: row.invocation_key,
              nodeId: row.node_id,
              attemptNumber: row.attempt_number,
            });
            const lease: NodeAttemptLease = Object.freeze({
              workspaceId: input.workspaceId,
              runId: input.runId,
              workflowVersionId: runRow.workflow_version_id,
              nodeRunId: input.nodeRunId,
              attemptId: input.attemptId,
              attemptNumber: row.attempt_number,
              invocationKey: row.invocation_key,
              nodeId: row.node_id,
              sideEffectClass: row.side_effect_class,
              ...(row.provider_idempotency_key === null
                ? {}
                : { providerIdempotencyKey: row.provider_idempotency_key }),
              workerId: input.workerId,
              fenceToken: Number(claim.fence_token),
              leaseExpiresAt: new Date(claim.lease_expires_at),
              delivery: Object.freeze(input.delivery),
            });
            if (
              !Number.isSafeInteger(lease.fenceToken) ||
              lease.fenceToken <= 0
            )
              throw new NodeAttemptStateCorruptError();
            return Object.freeze({ kind: 'claimed' as const, lease });
          },
        );
      } catch (error: unknown) {
        if (error instanceof DeliveryMismatch)
          return auditMismatch(
            pool,
            input.workspaceId,
            input.delivery,
            input.signal,
          );
        throw error;
      }
    },
    loadInputs: async (
      inputValue: Parameters<NodeAttemptRunStore['loadInputs']>[0],
    ): Promise<NodeAttemptInputs> => {
      assertNotAborted(inputValue.signal);
      let input: z.output<typeof loadInputsSchema>;
      try {
        input = loadInputsSchema.parse(inputValue);
      } catch {
        throw new NodeAttemptStateCorruptError();
      }
      return withWorkspaceReadClient(
        pool,
        input.lease.workspaceId,
        input.signal,
        async (client) => {
          const current = await client.query<{
            abort_reason: 'canceled' | 'timed_out' | null;
            abort_requested: boolean;
            deadline_at: Date | null;
            input_ref: unknown;
          }>(
            `select run.input_ref,run.deadline_at,
                    (run.cancel_requested_at is not null or
                     (run.deadline_at is not null and
                      run.deadline_at <= clock_timestamp())) as abort_requested,
                    case
                      when run.cancel_requested_at is not null then 'canceled'
                      when run.deadline_at is not null and
                           run.deadline_at <= clock_timestamp() then 'timed_out'
                      else null
                    end as abort_reason
             from app.workflow_runs run
             join app.node_runs node
               on node.workspace_id=run.workspace_id
              and node.workflow_run_id=run.id
             join app.node_attempts attempt
               on attempt.workspace_id=node.workspace_id
              and attempt.node_run_id=node.id
             where run.workspace_id=$1 and run.id=$2
               and run.workflow_version_id=$3 and node.id=$4
               and node.node_id=$5 and node.invocation_key=$6
               and node.current_attempt_id=$7
               and node.current_attempt_number=$8
               and attempt.id=$7 and attempt.attempt_number=$8
               and attempt.status='running' and attempt.lease_owner=$9
               and attempt.fence_token=$10
               and attempt.lease_expires_at > clock_timestamp()`,
            [
              input.lease.workspaceId,
              input.lease.runId,
              input.lease.workflowVersionId,
              input.lease.nodeRunId,
              input.lease.nodeId,
              input.lease.invocationKey,
              input.lease.attemptId,
              input.lease.attemptNumber,
              input.lease.workerId,
              input.lease.fenceToken,
            ],
          );
          const row = current.rows[0];
          if (row === undefined) throw new NodeAttemptStateCorruptError();
          let runInput: unknown = null;
          if (row.input_ref !== null) {
            const stored = parseStoredExecutionValueV1(row.input_ref);
            if (stored.kind !== 'inline')
              throw new NodeAttemptStateCorruptError();
            runInput = stored.value;
          }

          const completedNodeOutputs: Record<string, unknown> = {};
          if (input.upstreamNodeIds.length > 0) {
            const outputs = await client.query<{
              node_id: string;
              node_output_ref: unknown;
              attempt_output_ref: unknown;
            }>(
              `select node.node_id,node.output_ref as node_output_ref,
                      attempt.output_ref as attempt_output_ref
               from app.node_runs node
               join app.node_attempts attempt
                 on attempt.workspace_id=node.workspace_id
                and attempt.id=node.current_attempt_id
               where node.workspace_id=$1 and node.workflow_run_id=$2
                 and node.node_id=any($3::varchar[])
                 and node.status='succeeded' and attempt.status='succeeded'
                 and attempt.node_run_id=node.id`,
              [
                input.lease.workspaceId,
                input.lease.runId,
                input.upstreamNodeIds,
              ],
            );
            if (outputs.rows.length !== input.upstreamNodeIds.length)
              throw new NodeAttemptStateCorruptError();
            for (const output of outputs.rows) {
              if (
                serializeStoredExecutionJsonValue(output.node_output_ref) !==
                serializeStoredExecutionJsonValue(output.attempt_output_ref)
              )
                throw new NodeAttemptStateCorruptError();
              const stored = parseStoredExecutionValueV1(
                output.attempt_output_ref,
              );
              if (
                stored.kind !== 'inline' ||
                Object.hasOwn(completedNodeOutputs, output.node_id)
              )
                throw new NodeAttemptStateCorruptError();
              completedNodeOutputs[output.node_id] = stored.value;
            }
          }
          return Object.freeze({
            runInput,
            completedNodeOutputs: Object.freeze(completedNodeOutputs),
            abortRequested: row.abort_requested,
            ...(row.abort_reason === null
              ? {}
              : { abortReason: row.abort_reason }),
            ...(row.deadline_at === null
              ? {}
              : { deadlineAt: new Date(row.deadline_at) }),
          });
        },
      );
    },
    markDispatched: async (
      inputValue: Parameters<NodeAttemptRunStore['markDispatched']>[0],
    ): Promise<Readonly<{ dispatchedAt: Date }>> => {
      assertNotAborted(inputValue.signal);
      let input: z.output<typeof ownedLeaseSchema>;
      try {
        input = ownedLeaseSchema.parse(inputValue);
      } catch {
        throw new NodeAttemptStateCorruptError();
      }
      return withWorkspaceWriteClient(
        pool,
        input.lease.workspaceId,
        input.signal,
        async (client) => {
          const result = await client.query<{ dispatch_marked_at: Date }>(
            `update app.node_attempts attempt
             set dispatch_marked_at=coalesce(dispatch_marked_at,clock_timestamp()),
                 updated_at=clock_timestamp()
             from app.node_runs node,app.workflow_runs run
             where attempt.workspace_id=$1 and attempt.id=$2
               and attempt.node_run_id=$3 and attempt.attempt_number=$4
               and attempt.status='running' and attempt.lease_owner=$5
               and attempt.fence_token=$6
               and attempt.lease_expires_at > clock_timestamp()
               and node.workspace_id=attempt.workspace_id
               and node.id=attempt.node_run_id
               and node.workflow_run_id=$7 and node.node_id=$8
               and node.invocation_key=$9 and node.current_attempt_id=attempt.id
               and run.workspace_id=node.workspace_id and run.id=node.workflow_run_id
               and run.workflow_version_id=$10
             returning attempt.dispatch_marked_at`,
            [
              input.lease.workspaceId,
              input.lease.attemptId,
              input.lease.nodeRunId,
              input.lease.attemptNumber,
              input.lease.workerId,
              input.lease.fenceToken,
              input.lease.runId,
              input.lease.nodeId,
              input.lease.invocationKey,
              input.lease.workflowVersionId,
            ],
          );
          const dispatchedAt = result.rows[0]?.dispatch_marked_at;
          if (dispatchedAt === undefined)
            throw new NodeAttemptReconciliationRequiredError();
          return Object.freeze({ dispatchedAt: new Date(dispatchedAt) });
        },
      );
    },
    heartbeat: async (
      inputValue: Parameters<NodeAttemptRunStore['heartbeat']>[0],
    ): Promise<
      Readonly<{
        leaseExpiresAt: Date;
        abortRequested: boolean;
        abortReason?: 'canceled' | 'timed_out';
      }>
    > => {
      assertNotAborted(inputValue.signal);
      let input: z.output<typeof heartbeatSchema>;
      try {
        input = heartbeatSchema.parse(inputValue);
      } catch {
        throw new NodeAttemptStateCorruptError();
      }
      return withWorkspaceWriteClient(
        pool,
        input.lease.workspaceId,
        input.signal,
        async (client) => {
          const result = await client.query<{
            abort_reason: 'canceled' | 'timed_out' | null;
            abort_requested: boolean;
            lease_expires_at: Date;
          }>(
            `update app.node_attempts attempt
             set lease_expires_at=clock_timestamp()+make_interval(secs=>$7),
                 updated_at=clock_timestamp()
             from app.node_runs node,app.workflow_runs run
             where attempt.workspace_id=$1 and attempt.id=$2
               and attempt.node_run_id=$3 and attempt.attempt_number=$4
               and attempt.status='running' and attempt.lease_owner=$5
               and attempt.fence_token=$6
               and attempt.lease_expires_at > clock_timestamp()
               and node.workspace_id=attempt.workspace_id
               and node.id=attempt.node_run_id and node.workflow_run_id=$8
               and node.node_id=$9 and node.invocation_key=$10
               and node.current_attempt_id=attempt.id
               and run.workspace_id=node.workspace_id and run.id=node.workflow_run_id
               and run.workflow_version_id=$11
             returning attempt.lease_expires_at,
               (run.cancel_requested_at is not null or
                (run.deadline_at is not null and
                 run.deadline_at <= clock_timestamp())) as abort_requested,
               case
                 when run.cancel_requested_at is not null then 'canceled'
                 when run.deadline_at is not null and
                      run.deadline_at <= clock_timestamp() then 'timed_out'
                 else null
               end as abort_reason`,
            [
              input.lease.workspaceId,
              input.lease.attemptId,
              input.lease.nodeRunId,
              input.lease.attemptNumber,
              input.lease.workerId,
              input.lease.fenceToken,
              input.leaseDurationSeconds,
              input.lease.runId,
              input.lease.nodeId,
              input.lease.invocationKey,
              input.lease.workflowVersionId,
            ],
          );
          const row = result.rows[0];
          if (row === undefined)
            throw new NodeAttemptReconciliationRequiredError();
          return Object.freeze({
            leaseExpiresAt: new Date(row.lease_expires_at),
            abortRequested: row.abort_requested,
            ...(row.abort_reason === null
              ? {}
              : { abortReason: row.abort_reason }),
          });
        },
      );
    },
    complete: async (
      inputValue: Parameters<NodeAttemptRunStore['complete']>[0],
    ): Promise<CompleteNodeAttemptResult> => {
      assertNotAborted(inputValue.signal);
      let input: z.output<typeof completionSchema>;
      try {
        input = completionSchema.parse(inputValue);
      } catch {
        throw new NodeAttemptStateCorruptError();
      }
      let serializedOutput: string | null = null;
      if (input.outcome.status === 'succeeded') {
        try {
          serializedOutput = serializeStoredExecutionValueV1({
            schemaVersion: 1,
            kind: 'inline',
            value: input.outcome.output,
          });
        } catch {
          throw new NodeAttemptOutputInvalidError();
        }
      }
      try {
        return await withWorkspaceWriteClient(
          pool,
          input.lease.workspaceId,
          input.signal,
          async (client) => {
            await validateDelivery(client, {
              workspaceId: input.lease.workspaceId,
              runId: input.lease.runId,
              nodeRunId: input.lease.nodeRunId,
              attemptId: input.lease.attemptId,
              delivery: input.lease.delivery,
              leaseDurationSeconds: 1,
              workerId: input.lease.workerId,
              signal: input.signal,
            });
            const receipt = await client.query<{
              completed_at: Date | null;
              payload_checksum: string;
            }>(
              `select completed_at,payload_checksum
               from app.inbox_receipts
               where consumer_name=$1 and message_id=$2 and workspace_id=$3
               for update`,
              [
                consumerName,
                input.lease.delivery.outboxEventId,
                input.lease.workspaceId,
              ],
            );
            const receiptRow = receipt.rows[0];
            if (
              receiptRow?.payload_checksum !==
              input.lease.delivery.payloadChecksum
            )
              throw new NodeAttemptStateCorruptError();

            const run = await client.query(
              `select id from app.workflow_runs
               where workspace_id=$1 and id=$2 and workflow_version_id=$3
               for update`,
              [
                input.lease.workspaceId,
                input.lease.runId,
                input.lease.workflowVersionId,
              ],
            );
            if (run.rowCount !== 1) throw new NodeAttemptStateCorruptError();
            const locked = await client.query<{
              attempt_status: string;
              error_summary: string | null;
              executor_error_kind: string | null;
              executor_failure_kind: string | null;
              executor_possibly_dispatched: boolean | null;
              fence_token: string;
              lease_valid: boolean;
              lease_expires_at: Date | null;
              lease_owner: string | null;
              node_status: string;
              output_ref: unknown;
              safe_error_code: string | null;
              retry_decision: string | null;
            }>(
              `select attempt.status attempt_status,attempt.fence_token,
                      attempt.lease_owner,attempt.lease_expires_at,
                      (attempt.lease_expires_at > clock_timestamp()) lease_valid,
                      attempt.output_ref,attempt.safe_error_code,
                       attempt.error_summary,attempt.executor_failure_kind,
                       attempt.executor_error_kind,
                       attempt.executor_possibly_dispatched,
                       attempt.retry_decision,node.status node_status
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
               where attempt.workspace_id=$1 and attempt.id=$2
                 and attempt.node_run_id=$3 and attempt.attempt_number=$4
                 and node.workflow_run_id=$5 and node.node_id=$6
                 and node.invocation_key=$7
                 and node.current_attempt_id=attempt.id
               for update of node,attempt`,
              [
                input.lease.workspaceId,
                input.lease.attemptId,
                input.lease.nodeRunId,
                input.lease.attemptNumber,
                input.lease.runId,
                input.lease.nodeId,
                input.lease.invocationKey,
              ],
            );
            const row = locked.rows[0];
            if (row === undefined) throw new NodeAttemptStateCorruptError();
            const executorOutcome =
              input.outcome.status === 'executor_failure'
                ? input.outcome
                : undefined;
            const durableStatus =
              executorOutcome !== undefined ? 'failed' : input.outcome.status;
            const safeErrorCode =
              input.outcome.status === 'succeeded'
                ? null
                : input.outcome.safeErrorCode;
            const errorSummary =
              input.outcome.status === 'succeeded' ||
              input.outcome.status === 'executor_failure'
                ? null
                : (input.outcome.errorSummary ?? null);
            if (
              [
                'succeeded',
                'failed',
                'canceled',
                'timed_out',
                'outcome_unknown',
              ].includes(row.attempt_status)
            ) {
              const persistedOutput =
                row.output_ref === null
                  ? null
                  : serializeStoredExecutionValueV1(row.output_ref);
              if (
                row.attempt_status !== durableStatus ||
                (executorOutcome === undefined &&
                  row.node_status !== durableStatus) ||
                persistedOutput !== serializedOutput ||
                row.safe_error_code !== safeErrorCode ||
                row.error_summary !== errorSummary ||
                (executorOutcome !== undefined &&
                  (row.executor_failure_kind !== executorOutcome.failureKind ||
                    row.executor_error_kind !== executorOutcome.errorKind ||
                    row.executor_possibly_dispatched !==
                      executorOutcome.possiblyDispatched ||
                    row.retry_decision === null))
              )
                throw new NodeAttemptStateCorruptError();
              if (receiptRow.completed_at === null)
                await completeReceipt(
                  client,
                  input.lease.workspaceId,
                  input.lease.delivery,
                );
              return Object.freeze({
                kind: 'duplicate' as const,
                outboxEventId: null,
              });
            }
            if (
              row.attempt_status !== 'running' ||
              row.node_status !== 'running' ||
              row.lease_owner !== input.lease.workerId ||
              Number(row.fence_token) !== input.lease.fenceToken ||
              row.lease_expires_at === null ||
              !row.lease_valid ||
              receiptRow.completed_at !== null
            )
              throw new NodeAttemptReconciliationRequiredError();

            await client.query(
              `update app.node_attempts
                set status=$3,lease_owner=null,lease_expires_at=null,
                    output_ref=$4::jsonb,safe_error_code=$5,error_summary=$6,
                    executor_failure_kind=$7,executor_error_kind=$8,
                    executor_possibly_dispatched=$9,retry_decision=$10,
                    completed_at=clock_timestamp(),updated_at=clock_timestamp()
                where workspace_id=$1 and id=$2`,
              [
                input.lease.workspaceId,
                input.lease.attemptId,
                durableStatus,
                serializedOutput,
                safeErrorCode,
                errorSummary,
                executorOutcome?.failureKind ?? null,
                executorOutcome?.errorKind ?? null,
                executorOutcome?.possiblyDispatched ?? null,
                executorOutcome === undefined ? null : 'pending',
              ],
            );
            if (executorOutcome !== undefined) {
              const outboxEventId = randomUUID();
              const payload = {
                schemaVersion: 1,
                workspaceId: input.lease.workspaceId,
                runId: input.lease.runId,
                outboxEventId,
                ...(input.traceparent === undefined
                  ? {}
                  : { traceparent: input.traceparent }),
              } as const;
              await client.query(
                `insert into app.outbox_events (
                   id,workspace_id,job_name,schema_version,aggregate_type,
                   aggregate_id,payload,payload_checksum
                 ) values ($1,$2,'advance-workflow-run',1,'workflow-run',$3,$4::jsonb,$5)`,
                [
                  outboxEventId,
                  input.lease.workspaceId,
                  input.lease.runId,
                  serializeStoredExecutionJsonValue(payload),
                  canonicalOutboxPayloadChecksum(payload),
                ],
              );
              await completeReceipt(
                client,
                input.lease.workspaceId,
                input.lease.delivery,
              );
              return Object.freeze({
                kind: 'committed' as const,
                outboxEventId,
              });
            }
            const node = await client.query(
              `update app.node_runs
               set status=$3,output_ref=$4::jsonb,safe_error_code=$5,
                   completed_at=clock_timestamp(),updated_at=clock_timestamp()
               where workspace_id=$1 and id=$2 and current_attempt_id=$6`,
              [
                input.lease.workspaceId,
                input.lease.nodeRunId,
                durableStatus,
                serializedOutput,
                safeErrorCode,
                input.lease.attemptId,
              ],
            );
            if (node.rowCount !== 1) throw new NodeAttemptStateCorruptError();

            const eventSequence = await client.query<{ sequence: number }>(
              `select coalesce(max(sequence),0)::int+1 sequence
               from app.run_events where workspace_id=$1 and workflow_run_id=$2`,
              [input.lease.workspaceId, input.lease.runId],
            );
            const sequence = eventSequence.rows[0]?.sequence;
            if (sequence === undefined)
              throw new NodeAttemptStateCorruptError();
            const eventPayload = serializeStoredExecutionJsonValue({
              schemaVersion: 1,
              nodeRunId: input.lease.nodeRunId,
              attemptId: input.lease.attemptId,
              invocationKey: input.lease.invocationKey,
              nodeId: input.lease.nodeId,
              attemptNumber: input.lease.attemptNumber,
              ...(safeErrorCode === null ? {} : { safeErrorCode }),
            });
            await client.query(
              `insert into app.run_events (
                 workspace_id,workflow_run_id,sequence,type,payload
               ) values ($1,$2,$3,$4,$5::jsonb)`,
              [
                input.lease.workspaceId,
                input.lease.runId,
                sequence,
                `node.${input.outcome.status}`,
                eventPayload,
              ],
            );

            const outboxEventId = randomUUID();
            const payload = {
              schemaVersion: 1,
              workspaceId: input.lease.workspaceId,
              runId: input.lease.runId,
              outboxEventId,
              ...(input.traceparent === undefined
                ? {}
                : { traceparent: input.traceparent }),
            } as const;
            await client.query(
              `insert into app.outbox_events (
                 id,workspace_id,job_name,schema_version,aggregate_type,
                 aggregate_id,payload,payload_checksum
               ) values ($1,$2,'advance-workflow-run',1,'workflow-run',$3,$4::jsonb,$5)`,
              [
                outboxEventId,
                input.lease.workspaceId,
                input.lease.runId,
                serializeStoredExecutionJsonValue(payload),
                canonicalOutboxPayloadChecksum(payload),
              ],
            );
            await completeReceipt(
              client,
              input.lease.workspaceId,
              input.lease.delivery,
            );
            return Object.freeze({
              kind: 'committed' as const,
              outboxEventId,
            });
          },
        );
      } catch (error: unknown) {
        if (error instanceof DeliveryMismatch)
          return auditMismatch(
            pool,
            input.lease.workspaceId,
            input.lease.delivery,
            input.signal,
          );
        throw error;
      }
    },
    close: async (): Promise<void> => pool.end(),
  });
}
