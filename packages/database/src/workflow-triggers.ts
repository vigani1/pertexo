import { createHash, randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';
import {
  parseScheduleRecurrence,
  resolveScheduleObservation,
  type ScheduleRecurrence,
} from './schedule-recurrence.js';
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

function desiredScheduleConfig(value: unknown): Readonly<{
  recurrence: ScheduleRecurrence;
  misfirePolicy: 'catch_up_once' | 'skip';
}> {
  const config = z.record(z.string(), z.unknown()).parse(value);
  const kind = z.enum(['cron', 'interval']).parse(config.kind);
  return Object.freeze({
    recurrence: parseScheduleRecurrence(
      kind === 'cron'
        ? {
            kind,
            expression: config.expression,
            timezone: config.timezone,
          }
        : { kind, intervalMinutes: config.intervalMinutes },
    ),
    misfirePolicy: z
      .enum(['catch_up_once', 'skip'])
      .default('catch_up_once')
      .parse(config.misfirePolicy),
  });
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
            `update app.trigger_schedules schedule set status='disabled',health_status='disabled',
               lease_owner=null,lease_token=null,lease_acquired_at=null,lease_expires_at=null,
               updated_at=clock_timestamp()
              where schedule.workspace_id=$1 and exists (
                select 1 from app.workflow_triggers trigger
                 where trigger.id=schedule.trigger_id and trigger.workflow_id=$2
                   and trigger.workflow_version_id<>$3) and schedule.status<>'disabled'`,
            [input.workspaceId, workflowId, versionId],
          );
          const observation = await client.query<{ observed_at: Date }>(
            'select clock_timestamp() observed_at',
          );
          const observedAt = observation.rows[0]?.observed_at;
          if (observedAt === undefined)
            throw new Error('Schedule database observation is unavailable');
          const desiredSchedules = await client.query<{
            id: string;
            desired_config: unknown;
            config_fingerprint: string;
            schedule_status: string | null;
            persisted_fingerprint: string | null;
            anchor_at: Date | null;
          }>(
            `select trigger.id,trigger.desired_config,trigger.config_fingerprint,
                    schedule.status schedule_status,schedule.config_fingerprint persisted_fingerprint,
                    schedule.anchor_at
               from app.workflow_triggers trigger
               left join app.trigger_schedules schedule on schedule.trigger_id=trigger.id
              where trigger.workspace_id=$1 and trigger.workflow_id=$2
                and trigger.workflow_version_id=$3 and trigger.kind='schedule'
              order by trigger.id for update of trigger`,
            [input.workspaceId, workflowId, versionId],
          );
          for (const row of desiredSchedules.rows) {
            const desired = desiredScheduleConfig(row.desired_config);
            if (row.persisted_fingerprint === null) {
              const nextAt = resolveScheduleObservation(
                desired.recurrence,
                observedAt,
                observedAt,
              ).nextAt;
              await client.query(
                `insert into app.trigger_schedules
                  (trigger_id,workspace_id,recurrence_kind,cron_expression,timezone,
                   interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at)
                 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [
                  row.id,
                  input.workspaceId,
                  desired.recurrence.kind,
                  desired.recurrence.kind === 'cron'
                    ? desired.recurrence.expression
                    : null,
                  desired.recurrence.kind === 'cron'
                    ? desired.recurrence.timezone
                    : null,
                  desired.recurrence.kind === 'interval'
                    ? desired.recurrence.intervalMinutes
                    : null,
                  desired.misfirePolicy,
                  row.config_fingerprint,
                  observedAt,
                  nextAt,
                ],
              );
            } else if (row.persisted_fingerprint !== row.config_fingerprint) {
              throw new WorkflowTriggerReconciliationMismatchError(
                'Materialized schedule configuration does not match its immutable trigger',
              );
            } else if (row.schedule_status === 'disabled') {
              const nextAt =
                desired.misfirePolicy === 'skip'
                  ? resolveScheduleObservation(
                      desired.recurrence,
                      row.anchor_at ?? observedAt,
                      observedAt,
                    ).nextAt
                  : null;
              await client.query(
                `update app.trigger_schedules set status='enabled',health_status='healthy',
                   last_error_code=null,next_fire_at=coalesce($3,next_fire_at),updated_at=clock_timestamp()
                  where workspace_id=$1 and trigger_id=$2`,
                [input.workspaceId, row.id, nextAt],
              );
            }
          }
          await client.query(
            `update app.workflow_triggers trigger set
               status=case when trigger.kind='schedule' and exists (
                    select 1 from app.trigger_schedules schedule where schedule.trigger_id=trigger.id
                      and schedule.status='enabled') then 'active'
                 when exists (select 1 from app.webhook_trigger_endpoints endpoint
                   where endpoint.workspace_id=trigger.workspace_id
                     and endpoint.trigger_id=trigger.id and endpoint.status='active')
                 then 'active' else 'configuration_required' end,
               health_status=case when trigger.kind='schedule' and exists (
                    select 1 from app.trigger_schedules schedule where schedule.trigger_id=trigger.id
                      and schedule.status='enabled') then 'healthy'
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
