import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import type { z } from 'zod';

import {
  completionSchema,
  DeliveryMismatch,
  NodeAttemptOutputInvalidError,
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
  type CompleteNodeAttemptResult,
  type NodeAttemptRunStore,
} from './node-attempt-run-store-contract.js';
import {
  auditMismatch,
  completeReceipt,
  nodeAttemptConsumerName as consumerName,
  validateDelivery,
} from './node-attempt-run-store-delivery.js';
import {
  assertNotAborted,
  withWorkspaceWriteClient,
} from './node-attempt-run-store-transactions.js';
import { canonicalOutboxPayloadChecksum } from './outbox.js';
import {
  serializeStoredExecutionJsonValue,
  serializeStoredExecutionValueV1,
} from './stored-execution-value.js';

export async function completeNodeAttempt(
  pool: Pool,
  inputValue: Parameters<NodeAttemptRunStore['complete']>[0],
): Promise<CompleteNodeAttemptResult> {
  assertNotAborted(inputValue.signal);
  let input: z.output<typeof completionSchema>;
  try {
    input = completionSchema.parse(inputValue);
  } catch {
    throw new NodeAttemptStateCorruptError();
  }
  let serializedOutput: string | null = null;
  if (
    input.outcome.status === 'succeeded' ||
    input.outcome.status === 'suspended'
  ) {
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
          receiptRow?.payload_checksum !== input.lease.delivery.payloadChecksum
        )
          throw new NodeAttemptStateCorruptError();

        const run = await client.query<{
          abort_requested: boolean;
        }>(
          `select (
             cancel_requested_at is not null or
             (deadline_at is not null and deadline_at <= clock_timestamp())
           ) abort_requested
           from app.workflow_runs
           where workspace_id=$1 and id=$2 and workflow_version_id=$3
           for update`,
          [
            input.lease.workspaceId,
            input.lease.runId,
            input.lease.workflowVersionId,
          ],
        );
        if (run.rowCount !== 1) throw new NodeAttemptStateCorruptError();
        if (
          input.outcome.status === 'suspended' &&
          run.rows[0]?.abort_requested
        )
          throw new NodeAttemptReconciliationRequiredError();
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
          wait_kind: string | null;
        }>(
          `select attempt.status attempt_status,attempt.fence_token,
                  attempt.lease_owner,attempt.lease_expires_at,
                  (attempt.lease_expires_at > clock_timestamp()) lease_valid,
                  attempt.output_ref,attempt.safe_error_code,
                   attempt.error_summary,attempt.executor_failure_kind,
                   attempt.executor_error_kind,
                   attempt.executor_possibly_dispatched,
                    attempt.retry_decision,node.status node_status,node.wait_kind
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
          executorOutcome !== undefined
            ? 'failed'
            : input.outcome.status === 'suspended'
              ? 'succeeded'
              : input.outcome.status;
        const safeErrorCode =
          input.outcome.status === 'succeeded' ||
          input.outcome.status === 'suspended'
            ? null
            : input.outcome.safeErrorCode;
        const errorSummary =
          input.outcome.status === 'succeeded' ||
          input.outcome.status === 'suspended' ||
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
              input.outcome.status !== 'suspended' &&
              row.node_status !== durableStatus) ||
            (input.outcome.status === 'suspended' &&
              (row.node_status !== 'waiting' ||
                row.wait_kind !== 'node_wait')) ||
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
        if (input.outcome.status === 'suspended') {
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
        if (sequence === undefined) throw new NodeAttemptStateCorruptError();
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
}
