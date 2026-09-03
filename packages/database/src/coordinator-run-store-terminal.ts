import { createHash } from 'node:crypto';

import { generatePersistedId } from './persisted-id.js';

import type { PoolClient } from 'pg';
import { v5 as uuidv5 } from 'uuid';
import {
  FAILURE_NOTIFICATION_CONTEXT_MAX_BYTES,
  FailureNotificationContextV1Schema,
} from '@pertexo/workflow-model/failure-notification';

import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import { canonicalOutboxPayloadChecksum } from './outbox.js';
import { serializeStoredExecutionJsonValue } from './stored-execution-value.js';

const failureNotificationNamespace = '9fe280d8-40ca-4a20-930e-1bf77e48c817';

export async function persistFailureNotificationIntent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    workflowId: string;
    workflowVersionId: string;
    triggerType: string;
    startedAt: Date | null;
    createdAt: Date;
    policyVersion: number | null;
    destinationId: string | null;
    destinationConfigVersion: number | null;
    sideEffectClass: string | null;
    cancellationRequested: boolean;
    plan: ParsedTransitionPlan;
    traceparent?: string;
  }>,
): Promise<void> {
  const terminalEvent = input.plan.events.find(
    ({ name }) =>
      name === `run.${input.plan.checkpoint.runStatus}` &&
      ['run.failed', 'run.timed_out', 'run.outcome_unknown'].includes(name),
  );
  if (
    terminalEvent === undefined ||
    input.cancellationRequested ||
    input.policyVersion !== 1 ||
    input.destinationId === null ||
    input.destinationConfigVersion === null ||
    input.sideEffectClass === null
  )
    return;

  const failures = input.plan.checkpoint.invocations
    .filter(({ status }) =>
      ['failed', 'timed_out', 'outcome_unknown'].includes(status),
    )
    .sort((left, right) => {
      const severity = { outcome_unknown: 0, timed_out: 1, failed: 2 } as const;
      const statusOrder =
        severity[left.status as keyof typeof severity] -
        severity[right.status as keyof typeof severity];
      return (
        statusOrder || left.invocationKey.localeCompare(right.invocationKey)
      );
    });
  const primary = failures[0];
  if (primary === undefined) throw new CoordinatorRunStateCorruptError();
  const physical = await client.query<{
    current_attempt_number: number | null;
    node_id: string;
    safe_error_code: string | null;
    status: string;
  }>(
    `select node_id,status,current_attempt_number,safe_error_code
     from app.node_runs
     where workspace_id=$1 and workflow_run_id=$2 and invocation_key=$3`,
    [input.workspaceId, input.runId, primary.invocationKey],
  );
  const node = physical.rows[0];
  if (node?.node_id !== primary.nodeId || node.status !== primary.status)
    throw new CoordinatorRunStateCorruptError();
  const context = FailureNotificationContextV1Schema.parse({
    schemaVersion: 1,
    runId: input.runId,
    workflowId: input.workflowId,
    workflowVersionId: input.workflowVersionId,
    terminalEventSequence: terminalEvent.sequence,
    terminalStatus: input.plan.checkpoint.runStatus,
    triggerType: input.triggerType,
    startedAt: (input.startedAt ?? input.createdAt).toISOString(),
    completedAt: terminalEvent.occurredAt,
    primaryFailure: {
      nodeId: primary.nodeId,
      invocationKey: primary.invocationKey,
      nodeStatus: primary.status,
      attemptNumber: node.current_attempt_number ?? primary.attemptNumber,
      safeErrorCode:
        node.safe_error_code ??
        terminalEvent.reasonCode ??
        `execution.${primary.status}`,
    },
    totalFailureCount: failures.length,
  });
  const contextJson = serializeStoredExecutionJsonValue(context);
  if (
    Buffer.byteLength(contextJson, 'utf8') >
    FAILURE_NOTIFICATION_CONTEXT_MAX_BYTES
  )
    throw new CoordinatorRunStateCorruptError();
  const contextChecksum = createHash('sha256')
    .update(contextJson)
    .digest('hex');
  const intentId = uuidv5(
    `${input.runId}:${String(terminalEvent.sequence)}:${String(input.policyVersion)}`,
    failureNotificationNamespace,
  );
  const outboxEventId = uuidv5('delivery:1', intentId);
  const payload = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    notificationIntentId: intentId,
    outboxEventId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  } as const;
  const inserted = await client.query(
    `insert into app.run_failure_notification_intents (
       id,workspace_id,workflow_run_id,terminal_event_sequence,policy_version,
       destination_id,destination_config_version,side_effect_class,
       connection_secret_version_id,context,context_checksum
      ) select $1,run.workspace_id,run.id,$4,
               run.failure_notification_policy_version,
               run.failure_notification_destination_id,
               run.failure_notification_destination_config_version,
               run.failure_notification_side_effect_class,
               run.failure_notification_connection_secret_version_id,$9::jsonb,$10
        from app.workflow_runs run
       where run.workspace_id=$2 and run.id=$3
         and run.failure_notification_policy_version=$5
         and run.failure_notification_destination_id=$6
         and run.failure_notification_destination_config_version=$7
         and run.failure_notification_side_effect_class=$8
         and run.failure_notification_connection_secret_version_id is not null
     on conflict (workflow_run_id,terminal_event_sequence,policy_version) do nothing
     returning id`,
    [
      intentId,
      input.workspaceId,
      input.runId,
      terminalEvent.sequence,
      input.policyVersion,
      input.destinationId,
      input.destinationConfigVersion,
      input.sideEffectClass,
      contextJson,
      contextChecksum,
    ],
  );
  if (inserted.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  await client.query(
    `insert into app.outbox_events (
       id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,payload,payload_checksum
     ) values ($1,$2,'deliver-run-failure-notification',1,'run-failure-notification',$3,$4::jsonb,$5)`,
    [
      outboxEventId,
      input.workspaceId,
      intentId,
      serializeStoredExecutionJsonValue(payload),
      canonicalOutboxPayloadChecksum(payload),
    ],
  );
  await client.query(
    `insert into app.run_failure_notification_audit_facts
       (id,workspace_id,notification_intent_id,fact_type,attempt_number,possibly_dispatched)
     values ($1,$2,$3,'intent_created',0,false)`,
    [generatePersistedId(), input.workspaceId, intentId],
  );
}
