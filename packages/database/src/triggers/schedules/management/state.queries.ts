import type { PoolClient } from 'pg';
import { z } from 'zod';

import { ScheduleTriggerError } from '../errors.js';
import {
  parsePersistedScheduleRecurrence,
  resolveScheduleObservation,
} from '../recurrence.js';

import {
  scheduleTriggerSchema,
  type ScheduleTriggerRecord,
  type SetEnabledInput,
  type ScheduleCommandIdentity,
  type ScheduleCommandTarget,
  type ScheduleHealthTransition,
} from './contract.js';

export function mapScheduleTrigger(
  row: Record<string, unknown>,
): ScheduleTriggerRecord {
  const kind = z.enum(['cron', 'interval']).parse(row.recurrence_kind);
  return scheduleTriggerSchema.parse({
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    nodeId: row.node_id,
    kind: 'schedule',
    status: row.status,
    healthStatus: row.health_status,
    lastErrorCode: row.last_error_code,
    reconciledAt: row.reconciled_at,
    recurrence: parsePersistedScheduleRecurrence({
      recurrence_kind: kind,
      cron_expression: z.string().nullable().parse(row.cron_expression),
      timezone: z.string().nullable().parse(row.timezone),
      interval_minutes: z.number().int().nullable().parse(row.interval_minutes),
    }),
    misfirePolicy: row.misfire_policy,
    nextFireAt: row.next_fire_at,
    lastFireAt: row.last_fire_at,
  });
}

export function parseStoredScheduleTrigger(
  value: unknown,
): ScheduleTriggerRecord {
  const stored = z.record(z.string(), z.unknown()).parse(value);
  return scheduleTriggerSchema.parse({
    ...stored,
    reconciledAt:
      stored.reconciledAt === null
        ? null
        : new Date(z.string().parse(stored.reconciledAt)),
    nextFireAt: new Date(z.string().parse(stored.nextFireAt)),
    lastFireAt:
      stored.lastFireAt === null
        ? null
        : new Date(z.string().parse(stored.lastFireAt)),
  });
}

export const scheduleProjection = `select trigger.id,trigger.workflow_id,trigger.workflow_version_id,
       trigger.node_id,trigger.status,schedule.health_status,schedule.last_error_code,
       trigger.reconciled_at,schedule.recurrence_kind,schedule.cron_expression,
       schedule.timezone,schedule.interval_minutes,schedule.misfire_policy,
       schedule.next_fire_at,schedule.last_fire_at
  from app.trigger_schedules schedule
  join app.workflow_triggers trigger on trigger.workspace_id=schedule.workspace_id
   and trigger.id=schedule.trigger_id`;

export async function readSchedule(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
  triggerId: string,
): Promise<ScheduleTriggerRecord> {
  const result = await client.query<Record<string, unknown>>(
    `${scheduleProjection}
      where schedule.workspace_id=$1 and trigger.workflow_id=$2 and trigger.id=$3
        and trigger.kind='schedule'`,
    [workspaceId, workflowId, triggerId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ScheduleTriggerError('not_found');
  return mapScheduleTrigger(row);
}

export async function readScheduleCommandTarget(
  client: PoolClient,
  input: SetEnabledInput,
  identity: ScheduleCommandIdentity,
): Promise<ScheduleCommandTarget> {
  const result = await client.query<ScheduleCommandTarget>(
    `select trigger.workflow_id,schedule.status,schedule.recurrence_kind,
            schedule.cron_expression,schedule.timezone,schedule.interval_minutes,
            schedule.misfire_policy,schedule.anchor_at,schedule.next_fire_at,
            schedule.admission_deferred_until,clock_timestamp() observed_at
       from app.trigger_schedules schedule
       join app.workflow_triggers trigger on trigger.id=schedule.trigger_id
       where schedule.workspace_id=$1 and schedule.trigger_id=$2
         and trigger.workflow_id=$3
         and trigger.workflow_version_id=(select published_version_id
           from app.workflows where workspace_id=$1 and id=$3)
         and trigger.kind='schedule' for update of schedule,trigger`,
    [input.workspaceId, identity.triggerId, identity.workflowId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ScheduleTriggerError('not_found');
  return row;
}

export function scheduleHealthTransition(
  input: SetEnabledInput,
  target: ScheduleCommandTarget,
): ScheduleHealthTransition {
  let nextFireAt = target.next_fire_at;
  if (
    input.enabled &&
    target.status === 'disabled' &&
    target.misfire_policy === 'skip'
  ) {
    nextFireAt = resolveScheduleObservation(
      parsePersistedScheduleRecurrence(target),
      target.anchor_at,
      target.observed_at,
    ).nextAt;
  }
  const retainsAdmissionBackoff =
    input.enabled &&
    target.admission_deferred_until !== null &&
    target.admission_deferred_until.getTime() > target.observed_at.getTime();
  return Object.freeze({
    healthStatus: input.enabled
      ? retainsAdmissionBackoff
        ? 'degraded'
        : 'healthy'
      : 'disabled',
    lastErrorCode: retainsAdmissionBackoff
      ? 'schedule.admission_throttled'
      : null,
    nextFireAt,
    scheduleStatus: input.enabled ? 'enabled' : 'disabled',
    triggerStatus: input.enabled ? 'active' : 'disabled',
  });
}
