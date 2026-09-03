import { generatePersistedId } from '../platform/persisted-id.js';

import type { PoolClient } from 'pg';
import type { z } from 'zod';

import {
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
} from './node-attempt-run-store-contract.js';
import type {
  completionSchema,
  CompleteNodeAttemptResult,
} from './node-attempt-run-store-contract.js';
import { completeReceipt } from './node-attempt-run-store-delivery.js';
import { canonicalOutboxPayloadChecksum } from './outbox.js';
import {
  serializeStoredExecutionJsonValue,
  serializeStoredExecutionValueV1,
} from './stored-execution-value.js';

type CompletionInput = z.output<typeof completionSchema>;
type ExecutorOutcome = Extract<
  CompletionInput['outcome'],
  { status: 'executor_failure' }
>;

export interface CompletionReceiptRow {
  readonly completed_at: Date | null;
  readonly payload_checksum: string;
}

export interface LockedAttemptRow {
  readonly attempt_status: string;
  readonly error_summary: string | null;
  readonly executor_error_kind: string | null;
  readonly executor_failure_kind: string | null;
  readonly executor_possibly_dispatched: boolean | null;
  readonly fence_token: string;
  readonly lease_valid: boolean;
  readonly lease_expires_at: Date | null;
  readonly lease_owner: string | null;
  readonly node_status: string;
  readonly output_ref: unknown;
  readonly safe_error_code: string | null;
  readonly retry_decision: string | null;
  readonly wait_kind: string | null;
}

interface CompletionFields {
  readonly durableStatus: string;
  readonly errorSummary: string | null;
  readonly executorOutcome: ExecutorOutcome | undefined;
  readonly safeErrorCode: string | null;
}

function completionFields(input: CompletionInput): CompletionFields {
  const executorOutcome =
    input.outcome.status === 'executor_failure' ? input.outcome : undefined;
  return {
    executorOutcome,
    durableStatus:
      executorOutcome !== undefined
        ? 'failed'
        : input.outcome.status === 'suspended'
          ? 'succeeded'
          : input.outcome.status,
    safeErrorCode:
      input.outcome.status === 'succeeded' ||
      input.outcome.status === 'suspended'
        ? null
        : input.outcome.safeErrorCode,
    errorSummary:
      input.outcome.status === 'succeeded' ||
      input.outcome.status === 'suspended' ||
      input.outcome.status === 'executor_failure'
        ? null
        : (input.outcome.errorSummary ?? null),
  };
}

async function duplicateCompletion(
  client: PoolClient,
  input: CompletionInput,
  row: LockedAttemptRow,
  receipt: CompletionReceiptRow,
  serializedOutput: string | null,
  fields: CompletionFields,
): Promise<CompleteNodeAttemptResult | undefined> {
  if (
    ![
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
    ].includes(row.attempt_status)
  ) {
    return undefined;
  }
  const persistedOutput =
    row.output_ref === null
      ? null
      : serializeStoredExecutionValueV1(row.output_ref);
  const executorMismatch =
    fields.executorOutcome !== undefined &&
    (row.executor_failure_kind !== fields.executorOutcome.failureKind ||
      row.executor_error_kind !== fields.executorOutcome.errorKind ||
      row.executor_possibly_dispatched !==
        fields.executorOutcome.possiblyDispatched ||
      row.retry_decision === null);
  if (
    row.attempt_status !== fields.durableStatus ||
    (fields.executorOutcome === undefined &&
      input.outcome.status !== 'suspended' &&
      row.node_status !== fields.durableStatus) ||
    (input.outcome.status === 'suspended' &&
      (row.node_status !== 'waiting' || row.wait_kind !== 'node_wait')) ||
    persistedOutput !== serializedOutput ||
    row.safe_error_code !== fields.safeErrorCode ||
    row.error_summary !== fields.errorSummary ||
    executorMismatch
  ) {
    throw new NodeAttemptStateCorruptError();
  }
  if (receipt.completed_at === null) {
    await completeReceipt(
      client,
      input.lease.workspaceId,
      input.lease.delivery,
    );
  }
  return Object.freeze({ kind: 'duplicate' as const, outboxEventId: null });
}

function assertActiveLease(
  input: CompletionInput,
  row: LockedAttemptRow,
  receipt: CompletionReceiptRow,
): void {
  if (
    row.attempt_status !== 'running' ||
    row.node_status !== 'running' ||
    row.lease_owner !== input.lease.workerId ||
    Number(row.fence_token) !== input.lease.fenceToken ||
    row.lease_expires_at === null ||
    !row.lease_valid ||
    receipt.completed_at !== null
  ) {
    throw new NodeAttemptReconciliationRequiredError();
  }
}

async function updateAttempt(
  client: PoolClient,
  input: CompletionInput,
  serializedOutput: string | null,
  fields: CompletionFields,
): Promise<void> {
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
      fields.durableStatus,
      serializedOutput,
      fields.safeErrorCode,
      fields.errorSummary,
      fields.executorOutcome?.failureKind ?? null,
      fields.executorOutcome?.errorKind ?? null,
      fields.executorOutcome?.possiblyDispatched ?? null,
      fields.executorOutcome === undefined ? null : 'pending',
    ],
  );
}

async function enqueueAdvance(
  client: PoolClient,
  input: CompletionInput,
): Promise<string> {
  const outboxEventId = generatePersistedId();
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
  return outboxEventId;
}

async function commitAndReceipt(
  client: PoolClient,
  input: CompletionInput,
): Promise<CompleteNodeAttemptResult> {
  const outboxEventId = await enqueueAdvance(client, input);
  await completeReceipt(client, input.lease.workspaceId, input.lease.delivery);
  return Object.freeze({ kind: 'committed' as const, outboxEventId });
}

async function commitSuspension(
  client: PoolClient,
  input: CompletionInput & {
    readonly outcome: Extract<
      CompletionInput['outcome'],
      { status: 'suspended' }
    >;
  },
  serializedOutput: string | null,
): Promise<CompleteNodeAttemptResult> {
  const suspended = await client.query<{ resume_at: Date }>(
    `update app.node_runs
     set status='waiting',output_ref=$3::jsonb,wait_kind='node_wait',
         resume_at=clock_timestamp()+make_interval(secs=>$4),
         retry_due_at=null,due_wakeup_at=null,safe_error_code=null,
         completed_at=null,updated_at=clock_timestamp()
     where workspace_id=$1 and id=$2 and current_attempt_id=$5
       and status='running'
     returning resume_at`,
    [
      input.lease.workspaceId,
      input.lease.nodeRunId,
      serializedOutput,
      input.outcome.durationSeconds,
      input.lease.attemptId,
    ],
  );
  const resumeAt = suspended.rows[0]?.resume_at;
  if (resumeAt === undefined) throw new NodeAttemptStateCorruptError();
  const sequenceResult = await client.query<{ sequence: number }>(
    `select coalesce(max(sequence),0)::int+1 sequence
     from app.run_events where workspace_id=$1 and workflow_run_id=$2`,
    [input.lease.workspaceId, input.lease.runId],
  );
  const sequence = sequenceResult.rows[0]?.sequence;
  if (sequence === undefined) throw new NodeAttemptStateCorruptError();
  await client.query(
    `insert into app.run_events (
       workspace_id,workflow_run_id,sequence,type,payload
     ) values ($1,$2,$3,'node.waiting',$4::jsonb)`,
    [
      input.lease.workspaceId,
      input.lease.runId,
      sequence,
      serializeStoredExecutionJsonValue({
        schemaVersion: 1,
        nodeRunId: input.lease.nodeRunId,
        attemptId: input.lease.attemptId,
        invocationKey: input.lease.invocationKey,
        nodeId: input.lease.nodeId,
        attemptNumber: input.lease.attemptNumber,
        dueAt: new Date(resumeAt).toISOString(),
        waitKind: 'node_wait',
      }),
    ],
  );
  return commitAndReceipt(client, input);
}

async function commitTerminal(
  client: PoolClient,
  input: CompletionInput,
  serializedOutput: string | null,
  fields: CompletionFields,
): Promise<CompleteNodeAttemptResult> {
  const node = await client.query(
    `update app.node_runs
     set status=$3,output_ref=$4::jsonb,safe_error_code=$5,
         completed_at=clock_timestamp(),updated_at=clock_timestamp()
     where workspace_id=$1 and id=$2 and current_attempt_id=$6`,
    [
      input.lease.workspaceId,
      input.lease.nodeRunId,
      fields.durableStatus,
      serializedOutput,
      fields.safeErrorCode,
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
  if (sequence === undefined) throw new NodeAttemptStateCorruptError();
  await client.query(
    `insert into app.run_events (
       workspace_id,workflow_run_id,sequence,type,payload
     ) values ($1,$2,$3,$4,$5::jsonb)`,
    [
      input.lease.workspaceId,
      input.lease.runId,
      sequence,
      `node.${input.outcome.status}`,
      serializeStoredExecutionJsonValue({
        schemaVersion: 1,
        nodeRunId: input.lease.nodeRunId,
        attemptId: input.lease.attemptId,
        invocationKey: input.lease.invocationKey,
        nodeId: input.lease.nodeId,
        attemptNumber: input.lease.attemptNumber,
        ...(fields.safeErrorCode === null
          ? {}
          : { safeErrorCode: fields.safeErrorCode }),
      }),
    ],
  );
  return commitAndReceipt(client, input);
}

export async function applyNodeAttemptCompletion(
  client: PoolClient,
  input: CompletionInput,
  row: LockedAttemptRow,
  receipt: CompletionReceiptRow,
  serializedOutput: string | null,
): Promise<CompleteNodeAttemptResult> {
  const fields = completionFields(input);
  const duplicate = await duplicateCompletion(
    client,
    input,
    row,
    receipt,
    serializedOutput,
    fields,
  );
  if (duplicate !== undefined) return duplicate;
  assertActiveLease(input, row, receipt);
  await updateAttempt(client, input, serializedOutput, fields);
  if (fields.executorOutcome !== undefined) {
    return commitAndReceipt(client, input);
  }
  if (input.outcome.status === 'suspended') {
    return commitSuspension(
      client,
      input as CompletionInput & {
        readonly outcome: Extract<
          CompletionInput['outcome'],
          { status: 'suspended' }
        >;
      },
      serializedOutput,
    );
  }
  return commitTerminal(client, input, serializedOutput, fields);
}
