import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  workflowActivationAfterReconciliation,
  workflowLifecycleStatusSchema,
  workflowTriggerStatusSchema,
  type WorkflowTriggerStatus,
} from '@pertexo/workflow-model/lifecycle';

export type WorkflowTriggerHealth = Readonly<{
  id: string;
  workflowId: string;
  workflowVersionId: string;
  nodeId: string;
  kind: 'webhook' | 'schedule';
  status: WorkflowTriggerStatus;
  healthStatus: 'pending' | 'healthy' | 'degraded' | 'unhealthy' | 'disabled';
  lastErrorCode: string | null;
  endpointReady: boolean;
  reconciledAt: Date | null;
}>;

function mapHealth(row: Record<string, unknown>): WorkflowTriggerHealth {
  return Object.freeze({
    id: z.uuid().parse(row.id),
    workflowId: z.uuid().parse(row.workflow_id),
    workflowVersionId: z.uuid().parse(row.workflow_version_id),
    nodeId: z.string().parse(row.node_id),
    kind: z.enum(['webhook', 'schedule']).parse(row.kind),
    status: workflowTriggerStatusSchema.parse(row.status),
    healthStatus: z
      .enum(['pending', 'healthy', 'degraded', 'unhealthy', 'disabled'])
      .parse(row.health_status),
    lastErrorCode: z.string().nullable().parse(row.last_error_code),
    endpointReady: z.boolean().parse(row.endpoint_ready),
    reconciledAt: z.date().nullable().parse(row.reconciled_at),
  });
}

export async function refreshWorkflowActivation(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
  failed = false,
): Promise<void> {
  const authority = await client.query<{
    lifecycle_status: unknown;
    published_version_id: unknown;
  }>(
    `select lifecycle_status,published_version_id from app.workflows
      where workspace_id=$1 and id=$2 for update`,
    [workspaceId, workflowId],
  );
  const workflow = authority.rows[0];
  if (workflow === undefined) return;
  const publishedVersionId = z
    .uuid()
    .nullable()
    .parse(workflow.published_version_id);
  const triggers = await client.query<{ status: unknown }>(
    `select status from app.workflow_triggers
      where workspace_id=$1 and workflow_id=$2 and workflow_version_id=$3`,
    [workspaceId, workflowId, publishedVersionId],
  );
  const activation = workflowActivationAfterReconciliation({
    lifecycleStatus: workflowLifecycleStatusSchema.parse(
      workflow.lifecycle_status,
    ),
    hasPublishedVersion: publishedVersionId !== null,
    triggerStatuses: triggers.rows.map(({ status }) =>
      workflowTriggerStatusSchema.parse(status),
    ),
    failed,
  });
  await client.query(
    `update app.workflows set activation_status=$3,updated_at=clock_timestamp()
      where workspace_id=$1 and id=$2`,
    [workspaceId, workflowId, activation],
  );
}

export async function readHealth(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
): Promise<readonly WorkflowTriggerHealth[]> {
  const result = await client.query<Record<string, unknown>>(
    `select trigger.id,trigger.workflow_id,trigger.workflow_version_id,
            trigger.node_id,trigger.kind,trigger.status,trigger.health_status,
            trigger.last_error_code,trigger.reconciled_at,
            (endpoint.id is not null and endpoint.status='active') endpoint_ready
       from app.workflow_triggers trigger
       left join app.webhook_trigger_endpoints endpoint
         on endpoint.workspace_id=trigger.workspace_id and endpoint.trigger_id=trigger.id
      where trigger.workspace_id=$1 and trigger.workflow_id=$2
        and trigger.workflow_version_id=(select published_version_id from app.workflows
          where workspace_id=$1 and id=$2)
      order by trigger.node_id`,
    [workspaceId, workflowId],
  );
  return Object.freeze(result.rows.map(mapHealth));
}
