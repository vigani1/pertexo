import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { expect } from 'vitest';
import { z } from 'zod';

import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';

export const executable = composeExecutableCatalog(PLATFORM_NODE_CATALOG);

export const httpScopeSchema = z.strictObject({
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  workflowVersionId: z.uuid(),
  triggerId: z.uuid(),
});

export const httpEvidenceSchema = httpScopeSchema.extend({
  connectionId: z.uuid(),
  trueRunId: z.uuid(),
  falseRunId: z.uuid(),
  senderKey: z.uuid(),
  falseKey: z.uuid(),
  publishKey: z.uuid(),
  provisionKey: z.uuid(),
  webhookId: z.string().min(1).max(256),
  validateId: z.string().min(1).max(256),
  mapId: z.string().min(1).max(256),
  conditionId: z.string().min(1).max(256),
  httpId: z.string().min(1).max(256),
  stopId: z.string().min(1).max(256),
  recovery: z.strictObject({
    failedRunId: z.uuid(),
    recoveryRunId: z.uuid(),
    unknownRunId: z.uuid(),
    unknownRecoveryRunId: z.uuid(),
    networkRunId: z.uuid(),
    networkRecoveryRunId: z.uuid(),
    recoveryKey: z.uuid(),
  }),
});

export const httpEffectsSchema = z.strictObject({
  phase: z.literal('controlled-http-effects'),
  requests: z.number().int().nonnegative(),
  effects: z.number().int().nonnegative(),
  bodyHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(10),
});

export const httpActionBody = JSON.stringify({
  marker: 'browser-mapped',
  amount: 7,
});

export const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

type Scope = z.infer<typeof httpScopeSchema>;

/** Allowlisted identities survive a failed qualification, never credentials. */
export function submittedHttpEvidenceIds(
  evidence: z.infer<typeof httpEvidenceSchema>,
) {
  return {
    workspaceId: evidence.workspaceId,
    workflowId: evidence.workflowId,
    workflowVersionId: evidence.workflowVersionId,
    triggerId: evidence.triggerId,
    connectionId: evidence.connectionId,
    trueRunId: evidence.trueRunId,
    falseRunId: evidence.falseRunId,
  };
}

/** Public endpoint matches this browser-created, published trigger; hashes only. */
export async function verifyHttpEndpoint(
  database: Pool,
  scope: Scope,
  endpointKey: string,
) {
  const result = await database.query(
    `select endpoint.id from app.webhook_trigger_endpoints endpoint
       join app.workflow_triggers trigger on trigger.workflow_id=endpoint.workflow_id and trigger.node_id=endpoint.node_id and trigger.workspace_id=endpoint.workspace_id
       join app.workflows workflow on workflow.id=trigger.workflow_id and workflow.workspace_id=trigger.workspace_id
      where trigger.workspace_id=$1 and trigger.workflow_id=$2 and trigger.workflow_version_id=$3
        and trigger.id=$4 and trigger.kind='webhook' and trigger.status='active'
        and workflow.published_version_id=$3 and endpoint.endpoint_key_hash=$5`,
    [
      scope.workspaceId,
      scope.workflowId,
      scope.workflowVersionId,
      scope.triggerId,
      hash(endpointKey),
    ],
  );
  expect(result.rowCount).toBe(1);
}

/** At upstream 202 these must already be durable, even if execution raced ahead. */
export async function verifyHttpAccepted(
  database: Pool,
  scope: Scope,
  runId: string,
) {
  const result = await database.query(
    `select run.id,run.workflow_version_id,run.trigger_type,
       (select count(*)::int from app.run_checkpoints checkpoint where checkpoint.workspace_id=run.workspace_id and checkpoint.workflow_run_id=run.id) checkpoints,
       (select count(*)::int from app.run_events event where event.workspace_id=run.workspace_id and event.workflow_run_id=run.id and event.type='run.queued') queued,
       (select count(*)::int from app.outbox_events event where event.workspace_id=run.workspace_id and event.aggregate_id=run.id and event.job_name='advance-workflow-run'
         and event.id=(select (receipt.result_ref->>'outboxEventId')::uuid from app.idempotency_records receipt where receipt.workspace_id=run.workspace_id and receipt.resource_id=run.id and receipt.operation='workflow.run.accept' and receipt.status='completed')) outbox,
       (select count(*)::int from app.webhook_trigger_deliveries delivery
         join app.webhook_trigger_endpoints endpoint on endpoint.workspace_id=delivery.workspace_id and endpoint.id=delivery.endpoint_id
         join app.workflow_triggers trigger on trigger.workspace_id=endpoint.workspace_id and trigger.workflow_id=endpoint.workflow_id and trigger.node_id=endpoint.node_id
         where delivery.workspace_id=run.workspace_id and delivery.workflow_run_id=run.id and trigger.id=$5 and delivery.outcome='accepted') deliveries
       from app.workflow_runs run where run.workspace_id=$1 and run.workflow_id=$2 and run.workflow_version_id=$3 and run.id=$4`,
    [
      scope.workspaceId,
      scope.workflowId,
      scope.workflowVersionId,
      runId,
      scope.triggerId,
    ],
  );
  expect(result.rows).toEqual([
    {
      id: runId,
      workflow_version_id: scope.workflowVersionId,
      trigger_type: 'webhook',
      checkpoints: 1,
      queued: 1,
      outbox: 1,
      deliveries: 1,
    },
  ]);
}
