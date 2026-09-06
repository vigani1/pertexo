import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  parseScheduleRecurrence,
  resolveScheduleObservation,
  type ScheduleRecurrence,
} from './schedule-recurrence.js';
import { WorkflowTriggerReconciliationMismatchError } from './workflow-trigger-errors.js';

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

/** Apply immutable publication configuration without re-enabling disabled resources. */
export async function reconcileActiveWorkflowTriggers(
  client: PoolClient,
  scope: Readonly<{
    workspaceId: string;
    workflowId: string;
    versionId: string;
  }>,
): Promise<void> {
  const { workspaceId, workflowId, versionId } = scope;
  await client.query(
    `update app.workflow_triggers trigger
        set status='disabled',health_status='disabled',last_error_code=null,
            reconciled_at=clock_timestamp(),updated_at=clock_timestamp()
      where trigger.workspace_id=$1 and trigger.workflow_id=$2
        and trigger.workflow_version_id<>$3 and trigger.status<>'disabled'`,
    [workspaceId, workflowId, versionId],
  );
  await client.query(
    `update app.webhook_trigger_endpoints endpoint set status='disabled',updated_at=clock_timestamp()
      where endpoint.workspace_id=$1 and exists (
        select 1 from app.workflow_triggers trigger
         where trigger.workspace_id=endpoint.workspace_id
           and trigger.id=endpoint.trigger_id and trigger.workflow_id=$2
           and trigger.workflow_version_id<>$3)`,
    [workspaceId, workflowId, versionId],
  );
  await client.query(
    `update app.trigger_schedules schedule set status='disabled',health_status='disabled',
       lease_owner=null,lease_token=null,lease_acquired_at=null,lease_expires_at=null,
       updated_at=clock_timestamp()
      where schedule.workspace_id=$1 and exists (
        select 1 from app.workflow_triggers trigger
         where trigger.id=schedule.trigger_id and trigger.workflow_id=$2
           and trigger.workflow_version_id<>$3) and schedule.status<>'disabled'`,
    [workspaceId, workflowId, versionId],
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
    persisted_fingerprint: string | null;
  }>(
    `select trigger.id,trigger.desired_config,trigger.config_fingerprint,
            schedule.config_fingerprint persisted_fingerprint
       from app.workflow_triggers trigger
       left join app.trigger_schedules schedule on schedule.trigger_id=trigger.id
      where trigger.workspace_id=$1 and trigger.workflow_id=$2
        and trigger.workflow_version_id=$3 and trigger.kind='schedule'
      order by trigger.id for update of trigger`,
    [workspaceId, workflowId, versionId],
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
          workspaceId,
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
         then 'active'
         when exists (select 1 from app.trigger_schedules schedule
           where schedule.trigger_id=trigger.id and schedule.status='disabled')
           or exists (select 1 from app.webhook_trigger_endpoints endpoint
             where endpoint.workspace_id=trigger.workspace_id
               and endpoint.trigger_id=trigger.id and endpoint.status='disabled')
         then 'disabled' else 'configuration_required' end,
       health_status=case when trigger.kind='schedule' and exists (
            select 1 from app.trigger_schedules schedule where schedule.trigger_id=trigger.id
              and schedule.status='enabled') then 'healthy'
         when exists (select 1 from app.webhook_trigger_endpoints endpoint
           where endpoint.workspace_id=trigger.workspace_id
             and endpoint.trigger_id=trigger.id and endpoint.status='active')
         then 'healthy'
         when exists (select 1 from app.trigger_schedules schedule
           where schedule.trigger_id=trigger.id and schedule.status='disabled')
           or exists (select 1 from app.webhook_trigger_endpoints endpoint
             where endpoint.workspace_id=trigger.workspace_id
               and endpoint.trigger_id=trigger.id and endpoint.status='disabled')
         then 'disabled' else 'pending' end,
       last_error_code=null,reconciled_at=clock_timestamp(),updated_at=clock_timestamp()
     where trigger.workspace_id=$1 and trigger.workflow_id=$2
       and trigger.workflow_version_id=$3`,
    [workspaceId, workflowId, versionId],
  );
}
