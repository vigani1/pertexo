import { createHash, randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';
import { withTenantScopedClient } from './workspace.js';

const uuidSchema = z.uuid();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export type WorkflowTriggerHealth = Readonly<{
  id: string;
  workflowId: string;
  workflowVersionId: string;
  nodeId: string;
  kind: 'webhook' | 'schedule';
  status:
    | 'desired'
    | 'configuration_required'
    | 'pending'
    | 'active'
    | 'degraded'
    | 'disabled'
    | 'error';
  healthStatus: 'pending' | 'healthy' | 'degraded' | 'unhealthy' | 'disabled';
  lastErrorCode: string | null;
  endpointReady: boolean;
  reconciledAt: Date | null;
}>;

export interface WorkflowTriggerReconciliationDatabase {
  reconcile(
    input: Readonly<{
      workspaceId: string;
      workflowId: string;
      publishedVersionId: string;
      outboxEventId: string;
    }>,
  ): Promise<readonly WorkflowTriggerHealth[]>;
  close(): Promise<void>;
}

export class WorkflowTriggerReconciliationMismatchError extends Error {
  public override readonly name = 'WorkflowTriggerReconciliationMismatchError';
}

function mapHealth(row: Record<string, unknown>): WorkflowTriggerHealth {
  return Object.freeze({
    id: uuidSchema.parse(row.id),
    workflowId: uuidSchema.parse(row.workflow_id),
    workflowVersionId: uuidSchema.parse(row.workflow_version_id),
    nodeId: z.string().parse(row.node_id),
    kind: z.enum(['webhook', 'schedule']).parse(row.kind),
    status: z
      .enum([
        'desired',
        'configuration_required',
        'pending',
        'active',
        'degraded',
        'disabled',
        'error',
      ])
      .parse(row.status),
    healthStatus: z
      .enum(['pending', 'healthy', 'degraded', 'unhealthy', 'disabled'])
      .parse(row.health_status),
    lastErrorCode: z.string().nullable().parse(row.last_error_code),
    endpointReady: z.boolean().parse(row.endpoint_ready),
    reconciledAt: z.date().nullable().parse(row.reconciled_at),
  });
}

async function refreshWorkflowActivation(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
): Promise<void> {
  await client.query(
    `update app.workflows workflow set activation_status=case
       when workflow.lifecycle_status<>'active' then 'inactive'
       when not exists (select 1 from app.workflow_triggers trigger
         where trigger.workspace_id=$1 and trigger.workflow_id=$2
           and trigger.workflow_version_id=workflow.published_version_id) then 'active'
       when not exists (select 1 from app.workflow_triggers trigger
         where trigger.workspace_id=$1 and trigger.workflow_id=$2
           and trigger.workflow_version_id=workflow.published_version_id
           and trigger.status<>'active') then 'active'
       when exists (select 1 from app.workflow_triggers trigger
         where trigger.workspace_id=$1 and trigger.workflow_id=$2
           and trigger.workflow_version_id=workflow.published_version_id
           and trigger.status='active') then 'degraded'
       when exists (select 1 from app.workflow_triggers trigger
         where trigger.workspace_id=$1 and trigger.workflow_id=$2
           and trigger.workflow_version_id=workflow.published_version_id
           and trigger.status in ('desired','configuration_required','pending')) then 'activating'
       else 'error' end,
       updated_at=clock_timestamp()
     where workflow.workspace_id=$1 and workflow.id=$2`,
    [workspaceId, workflowId],
  );
}

async function readHealth(
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

export function createWorkflowTriggerReconciliationDatabase(
  config: DatabaseConfig,
): WorkflowTriggerReconciliationDatabase {
  const pool = new Pool(config);
  return Object.freeze({
    reconcile: async (
      input: Parameters<WorkflowTriggerReconciliationDatabase['reconcile']>[0],
    ) =>
      withTenantScopedClient(
        pool,
        { workspaceId: uuidSchema.parse(input.workspaceId) },
        async (client) => {
          const workflowId = uuidSchema.parse(input.workflowId);
          const versionId = uuidSchema.parse(input.publishedVersionId);
          const outboxEventId = uuidSchema.parse(input.outboxEventId);
          const authority = await client.query(
            `select 1 from app.workflows workflow
              join app.outbox_events event on event.workspace_id=workflow.workspace_id
               and event.id=$4 and event.job_name='reconcile-workflow-triggers'
               and event.aggregate_type='workflow' and event.aggregate_id=workflow.id
             where workflow.workspace_id=$1 and workflow.id=$2
               and workflow.lifecycle_status='active'
               and workflow.published_version_id=$3
               and event.payload->>'publishedVersionId'=$3::text
             for update of workflow`,
            [input.workspaceId, workflowId, versionId, outboxEventId],
          );
          if (authority.rowCount !== 1)
            throw new WorkflowTriggerReconciliationMismatchError(
              'Reconciliation no longer names the current published workflow version',
            );

          await client.query(
            `update app.workflow_triggers trigger
                set status='disabled',health_status='disabled',last_error_code=null,
                    reconciled_at=clock_timestamp(),updated_at=clock_timestamp()
              where trigger.workspace_id=$1 and trigger.workflow_id=$2
                and trigger.workflow_version_id<>$3 and trigger.status<>'disabled'`,
            [input.workspaceId, workflowId, versionId],
          );
          await client.query(
            `update app.webhook_trigger_endpoints endpoint set status='disabled',updated_at=clock_timestamp()
              where endpoint.workspace_id=$1 and exists (
                select 1 from app.workflow_triggers trigger
                 where trigger.workspace_id=endpoint.workspace_id
                   and trigger.id=endpoint.trigger_id and trigger.workflow_id=$2
                   and trigger.workflow_version_id<>$3)`,
            [input.workspaceId, workflowId, versionId],
          );
          await client.query(
            `update app.workflow_triggers trigger set
               status=case when trigger.kind='schedule' then 'pending'
                 when exists (select 1 from app.webhook_trigger_endpoints endpoint
                   where endpoint.workspace_id=trigger.workspace_id
                     and endpoint.trigger_id=trigger.id and endpoint.status='active')
                 then 'active' else 'configuration_required' end,
               health_status=case when trigger.kind='schedule' then 'pending'
                 when exists (select 1 from app.webhook_trigger_endpoints endpoint
                   where endpoint.workspace_id=trigger.workspace_id
                     and endpoint.trigger_id=trigger.id and endpoint.status='active')
                 then 'healthy' else 'pending' end,
               last_error_code=null,reconciled_at=clock_timestamp(),updated_at=clock_timestamp()
             where trigger.workspace_id=$1 and trigger.workflow_id=$2
               and trigger.workflow_version_id=$3`,
            [input.workspaceId, workflowId, versionId],
          );
          await refreshWorkflowActivation(
            client,
            input.workspaceId,
            workflowId,
          );
          return readHealth(client, input.workspaceId, workflowId);
        },
      ),
    close: () => pool.end(),
  });
}

export { refreshWorkflowActivation, readHealth };
