import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflowTriggers,
  workflows,
} from '../../../schema/authoring/workflows.js';
import { triggerSchedules } from '../../../schema/triggers/schedules.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
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

function scheduleQuery(client: PoolClient) {
  return drizzle(client)
    .select({
      id: workflowTriggers.id,
      workflowId: workflowTriggers.workflowId,
      workflowVersionId: workflowTriggers.workflowVersionId,
      nodeId: workflowTriggers.nodeId,
      kind: sql<'schedule'>`'schedule'`,
      status: workflowTriggers.status,
      healthStatus: triggerSchedules.healthStatus,
      lastErrorCode: triggerSchedules.lastErrorCode,
      reconciledAt: workflowTriggers.reconciledAt,
      recurrenceFields: {
        recurrence_kind: triggerSchedules.recurrenceKind,
        cron_expression: triggerSchedules.cronExpression,
        timezone: triggerSchedules.timezone,
        interval_minutes: triggerSchedules.intervalMinutes,
      },
      misfirePolicy: triggerSchedules.misfirePolicy,
      nextFireAt: triggerSchedules.nextFireAt,
      lastFireAt: triggerSchedules.lastFireAt,
    })
    .from(triggerSchedules)
    .innerJoin(
      workflowTriggers,
      and(
        eq(workflowTriggers.workspaceId, triggerSchedules.workspaceId),
        eq(workflowTriggers.id, triggerSchedules.triggerId),
      ),
    );
}
function scheduleRecord({
  recurrenceFields,
  ...row
}: Awaited<ReturnType<typeof scheduleQuery>>[number]): ScheduleTriggerRecord {
  return {
    ...row,
    recurrence: parsePersistedScheduleRecurrence(recurrenceFields),
  };
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

export async function readSchedules(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  const published = drizzle(client)
    .select({ id: workflows.publishedVersionId })
    .from(workflows)
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    );
  const rows = await scheduleQuery(client)
    .where(
      and(
        eq(triggerSchedules.workspaceId, workspaceId),
        eq(workflowTriggers.workflowId, workflowId),
        eq(workflowTriggers.kind, 'schedule'),
        eq(workflowTriggers.workflowVersionId, published),
      ),
    )
    .orderBy(workflowTriggers.nodeId, workflowTriggers.id)
    .limit(1000)
    .catch(rethrowQueryFailure);
  return Object.freeze(rows.map(scheduleRecord));
}

export async function readSchedule(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
  triggerId: string,
): Promise<ScheduleTriggerRecord> {
  const result = await scheduleQuery(client)
    .where(
      and(
        eq(triggerSchedules.workspaceId, workspaceId),
        eq(workflowTriggers.workflowId, workflowId),
        eq(workflowTriggers.id, triggerId),
        eq(workflowTriggers.kind, 'schedule'),
      ),
    )
    .catch(rethrowQueryFailure);
  const row = result[0];
  if (row === undefined) throw new ScheduleTriggerError('not_found');
  return scheduleRecord(row);
}

export async function readScheduleCommandTarget(
  client: PoolClient,
  input: SetEnabledInput,
  identity: ScheduleCommandIdentity,
) {
  const db = drizzle(client);
  const schedule = alias(triggerSchedules, 'schedule');
  const trigger = alias(workflowTriggers, 'trigger');
  const published = db
    .select({ id: workflows.publishedVersionId })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, identity.workflowId),
      ),
    );
  const result = await db
    .select({
      workflow_id: trigger.workflowId,
      status: schedule.status,
      recurrence_kind: schedule.recurrenceKind,
      cron_expression: schedule.cronExpression,
      timezone: schedule.timezone,
      interval_minutes: schedule.intervalMinutes,
      misfire_policy: schedule.misfirePolicy,
      anchor_at: schedule.anchorAt,
      next_fire_at: schedule.nextFireAt,
      admission_deferred_until: schedule.admissionDeferredUntil,
      observed_at: sql<Date>`clock_timestamp()`.mapWith(schedule.createdAt),
    })
    .from(schedule)
    .innerJoin(trigger, eq(trigger.id, schedule.triggerId))
    .where(
      and(
        eq(schedule.workspaceId, input.workspaceId),
        eq(schedule.triggerId, identity.triggerId),
        eq(trigger.workflowId, identity.workflowId),
        eq(trigger.workflowVersionId, published),
        eq(trigger.kind, 'schedule'),
      ),
    )
    .for('update', { of: [schedule, trigger] })
    .catch(rethrowQueryFailure);
  const row = result[0];
  if (row === undefined) throw new ScheduleTriggerError('not_found');
  return row;
}

export function scheduleHealthTransition(
  input: SetEnabledInput,
  target: ScheduleCommandTarget,
): ScheduleHealthTransition {
  let nextFireAt = target.next_fire_at;
  const enablesSkippedSchedule =
    input.enabled &&
    target.status === 'disabled' &&
    target.misfire_policy === 'skip';
  if (enablesSkippedSchedule) {
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
    healthStatus: scheduleHealthStatus(input, { retainsAdmissionBackoff }),
    lastErrorCode: retainsAdmissionBackoff
      ? 'schedule.admission_throttled'
      : null,
    nextFireAt,
    scheduleStatus: input.enabled ? 'enabled' : 'disabled',
    triggerStatus: input.enabled ? 'active' : 'disabled',
  });
}

function scheduleHealthStatus(
  input: Pick<SetEnabledInput, 'enabled'>,
  { retainsAdmissionBackoff }: Readonly<{ retainsAdmissionBackoff: boolean }>,
): ScheduleHealthTransition['healthStatus'] {
  if (input.enabled) {
    if (retainsAdmissionBackoff) {
      return 'degraded';
    }
    return 'healthy';
  }
  return 'disabled';
}
