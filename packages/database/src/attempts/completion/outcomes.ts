import { canonicalJson } from '@pertexo/workflow-model';
import { generatePersistedId } from '../../platform/persisted-id.js';
import type { PoolClient } from 'pg';

import {
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
} from '../contract.js';
import type { CompleteNodeAttemptResult } from '../contract.js';
import { completeReceipt } from './receipts.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';
import { serializeStoredExecutionJsonValue } from '../../platform/stored-execution-value.js';
import { persistConnectionHealthObservation } from './connection-health.js';
import type {
  CompletionInput,
  SuspendedOutcome,
  CompletionReceiptRow,
  LockedAttemptRow,
  CompletionFields,
} from './contract.js';
import { duplicateCompletion } from './replay.js';

function completionFields(input: CompletionInput): CompletionFields {
  const outcome = input.outcome;
  switch (outcome.status) {
    case 'succeeded':
      return {
        durableStatus: 'succeeded',
        errorSummary: null,
        executorOutcome: undefined,
        safeErrorCode: null,
        suspendedOutcome: undefined,
      };
    case 'suspended':
      return {
        durableStatus: 'succeeded',
        errorSummary: null,
        executorOutcome: undefined,
        safeErrorCode: null,
        suspendedOutcome: outcome,
      };
    case 'executor_failure':
      return {
        durableStatus: 'failed',
        errorSummary: outcome.errorSummary ?? null,
        executorOutcome: outcome,
        safeErrorCode: outcome.safeErrorCode,
        suspendedOutcome: undefined,
      };
    case 'canceled':
    case 'failed':
    case 'outcome_unknown':
    case 'timed_out':
      return {
        durableStatus: outcome.status,
        errorSummary: outcome.errorSummary ?? null,
        executorOutcome: undefined,
        safeErrorCode: outcome.safeErrorCode,
        suspendedOutcome: undefined,
      };
  }
}

function assertActiveLease(
  input: CompletionInput,
  row: LockedAttemptRow,
  receipt: CompletionReceiptRow,
): void {
  const staleAttemptLease =
    row.attempt_status !== 'running' ||
    !row.current_attempt ||
    row.node_status !== 'running' ||
    row.lease_owner !== input.lease.workerId ||
    Number(row.fence_token) !== input.lease.fenceToken ||
    row.lease_expires_at === null ||
    !row.lease_valid ||
    receipt.completed_at !== null;
  if (staleAttemptLease) {
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
          output_ref=$4::json,safe_error_code=$5,error_summary=$6,
          executor_failure_kind=$7,executor_error_kind=$8,
          executor_possibly_dispatched=$9,retry_decision=$10,code_diagnostics=$11::jsonb,executor_retry_after_millis=$12,
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
      input.codeDiagnostics === undefined
        ? null
        : canonicalJson(input.codeDiagnostics),
      fields.executorOutcome?.minimumRetryDelayMillis ?? null,
    ],
  );
}

async function enqueueAdvance(
  client: PoolClient,
  input: CompletionInput,
): Promise<string> {
  const outboxEventId = generatePersistedId();
  const payload = {
    workspaceId: input.lease.workspaceId,
    runId: input.lease.runId,
    outboxEventId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  } as const;
  await client.query(
    `insert into app.outbox_events (
       id,workspace_id,job_name,aggregate_type,
       aggregate_id,payload,payload_checksum
     ) values ($1,$2,'advance-workflow-run','workflow-run',$3,$4::jsonb,$5)`,
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
  input: CompletionInput,
  outcome: SuspendedOutcome,
  serializedOutput: string | null,
): Promise<CompleteNodeAttemptResult> {
  const suspended = await client.query<{ resume_at: Date }>(
    `update app.node_runs
     set status='waiting',output_ref=$3::json,wait_kind='node_wait',
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
      outcome.durationSeconds,
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
     set status=$3,output_ref=$4::json,safe_error_code=$5,
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
  {
    row,
    receipt,
    serializedOutput,
    controlActive,
  }: Readonly<{
    row: LockedAttemptRow;
    receipt: CompletionReceiptRow;
    serializedOutput: string | null;
    controlActive: boolean;
  }>,
): Promise<CompleteNodeAttemptResult> {
  const fields = completionFields(input);
  const duplicate = await duplicateCompletion(client, input, {
    row,
    receipt,
    serializedOutput,
    fields,
  });
  if (duplicate !== undefined) return duplicate;
  if (fields.suspendedOutcome !== undefined && controlActive)
    throw new NodeAttemptReconciliationRequiredError();
  assertActiveLease(input, row, receipt);
  await updateAttempt(client, input, serializedOutput, fields);
  await persistConnectionHealthObservation(client, input);
  if (fields.executorOutcome !== undefined) {
    return commitAndReceipt(client, input);
  }
  if (fields.suspendedOutcome !== undefined)
    return commitSuspension(
      client,
      input,
      fields.suspendedOutcome,
      serializedOutput,
    );
  return commitTerminal(client, input, serializedOutput, fields);
}
