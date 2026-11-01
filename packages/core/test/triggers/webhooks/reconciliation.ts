import { randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  withWorkspaceTransaction,
} from '@pertexo/database/primitives';

import { claimedScheduleWorkflowPaused } from '../../../src/triggers/schedules/pause.queries.js';
import { reconciliation, workerPool, ownerQuery } from './base.js';
import { workspaceId } from './context.js';

/** Whether a claimed schedule's workflow is paused now. */
export function pausedNow(
  claim: Readonly<{ trigger_id: string; lease_token: string }>,
) {
  return withWorkspaceTransaction(workerPool, workspaceId, (transaction) =>
    claimedScheduleWorkflowPaused(transaction, claim, new Date()),
  );
}

export async function workflowTriggerIds(workflowIdInput: string) {
  const result = await ownerQuery<{
    id: string;
    kind: 'webhook' | 'schedule';
    node_id: string;
  }>(
    `select id,kind,node_id from app.workflow_triggers
         where workspace_id=$1 and workflow_id=$2
           and workflow_version_id=(select published_version_id from app.workflows
             where workspace_id=$1 and id=$2)
         order by node_id`,
    [workspaceId, workflowIdInput],
  );
  const webhookTrigger = result.rows.find(({ kind }) => kind === 'webhook');
  const scheduleTrigger = result.rows.find(({ kind }) => kind === 'schedule');
  if (webhookTrigger === undefined || scheduleTrigger === undefined)
    throw new Error('Published trigger projection is incomplete');
  return Object.freeze({
    webhookId: webhookTrigger.id,
    scheduleId: scheduleTrigger.id,
  });
}

export async function appendReconciliationEvent(
  workflowIdInput: string,
  versionIdInput: string,
) {
  const eventId = randomUUID();
  const payload = {
    workspaceId,
    outboxEventId: eventId,
    workflowId: workflowIdInput,
    publishedVersionId: versionIdInput,
  };
  const payloadChecksum = canonicalOutboxPayloadChecksum(payload);
  await ownerQuery(
    `insert into app.outbox_events(id,workspace_id,job_name,
         aggregate_type,aggregate_id,payload,payload_checksum)
       values($1,$2,'reconcile-workflow-triggers','workflow',$3,$4::jsonb,$5)`,
    [
      eventId,
      workspaceId,
      workflowIdInput,
      JSON.stringify(payload),
      payloadChecksum,
    ],
  );
  return Object.freeze({ eventId, payloadChecksum });
}

export async function deliverReconciliation(
  workflowIdInput: string,
  versionIdInput: string,
  event: Readonly<{ eventId: string; payloadChecksum: string }>,
) {
  return reconciliation.reconcile({
    workspaceId,
    workflowId: workflowIdInput,
    publishedVersionId: versionIdInput,
    outboxEventId: event.eventId,
    delivery: {
      outboxEventId: event.eventId,
      payloadChecksum: event.payloadChecksum,
    },
  });
}

export async function setWorkflowLifecycle(
  workflowIdInput: string,
  lifecycleStatus: 'active' | 'archived',
  activationStatus:
    | 'inactive'
    | 'activating'
    | 'active'
    | 'deactivating'
    | 'degraded'
    | 'error',
): Promise<void> {
  await ownerQuery(
    `update app.workflows set lifecycle_status=$2,activation_status=$3,
         updated_at=clock_timestamp() where workspace_id=$1 and id=$4`,
    [workspaceId, lifecycleStatus, activationStatus, workflowIdInput],
  );
}

export async function immutableWorkflowHistory(workflowIdInput: string) {
  const draft = await ownerQuery<{
    graph_json: unknown;
    revision: number;
  }>(
    `select revision,graph_json from app.workflow_drafts
         where workspace_id=$1 and workflow_id=$2`,
    [workspaceId, workflowIdInput],
  );
  const versions = await ownerQuery<{
    checksum: string;
    graph_json: unknown;
    id: string;
    version_number: number;
  }>(
    `select id,version_number,checksum,graph_json from app.workflow_versions
         where workspace_id=$1 and workflow_id=$2 order by version_number`,
    [workspaceId, workflowIdInput],
  );
  const runs = await ownerQuery<{
    created_at: Date;
    id: string;
    status: string;
    trigger_type: string;
    updated_at: Date;
    workflow_version_id: string;
  }>(
    `select id,status,trigger_type,workflow_version_id,created_at,updated_at
         from app.workflow_runs where workspace_id=$1 and workflow_id=$2
         order by id`,
    [workspaceId, workflowIdInput],
  );
  return Object.freeze({
    draft: draft.rows,
    runs: runs.rows,
    versions: versions.rows,
  });
}

export async function triggerFacts(workflowIdInput: string) {
  const result = await ownerQuery<{
    endpoint_status: 'active' | 'disabled' | null;
    endpoint_ready: boolean;
    endpoint_id: string | null;
    health_status: string;
    kind: string;
    last_error_code: string | null;
    node_id: string;
    schedule_health_status: string | null;
    schedule_status: 'enabled' | 'disabled' | null;
    status: string;
    trigger_id: string;
  }>(
    `select trigger.id trigger_id,trigger.node_id,trigger.kind,trigger.status,
              trigger.health_status,trigger.last_error_code,
              endpoint.id endpoint_id,endpoint.status endpoint_status,
              (endpoint.id is not null and endpoint.status='active') endpoint_ready,
              schedule.status schedule_status,schedule.health_status schedule_health_status
         from app.workflow_triggers trigger
         left join app.webhook_trigger_endpoints endpoint
           on endpoint.workspace_id=trigger.workspace_id and endpoint.workflow_id=trigger.workflow_id
          and endpoint.node_id=trigger.node_id and trigger.kind='webhook'
         left join app.trigger_schedules schedule
           on schedule.workspace_id=trigger.workspace_id and schedule.trigger_id=trigger.id
        where trigger.workspace_id=$1 and trigger.workflow_id=$2
          and trigger.workflow_version_id=(select published_version_id from app.workflows
            where workspace_id=$1 and id=$2)
        order by trigger.node_id`,
    [workspaceId, workflowIdInput],
  );
  return result.rows;
}

export async function workflowState(workflowIdInput: string) {
  const result = await ownerQuery<{
    activation_status: string;
    lifecycle_status: string;
    published_version_id: string | null;
  }>(
    `select lifecycle_status,activation_status,published_version_id
         from app.workflows where workspace_id=$1 and id=$2`,
    [workspaceId, workflowIdInput],
  );
  const state = result.rows[0];
  if (state === undefined) throw new Error('Workflow state is missing');
  return state;
}
