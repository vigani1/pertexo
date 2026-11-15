import { DATA_RETENTION_DAYS } from '@pertexo/workflow-model';
import { scheduleStandingColumns } from './schedule-standing.js';
import { and, desc, eq, sql, type SQLWrapper } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowTriggers as triggers,
  workflows,
  workspaces,
  triggerScheduleOccurrences as occurrences,
  triggerSchedules as schedules,
} from '@pertexo/database/schema';
import type {
  ListScheduleOccurrencesInput,
  ScheduleOccurrencePage,
  ScheduleOccurrencePosition,
  TriggerRead,
} from './schedule-occurrence.types.js';

import type { PoolClient } from 'pg';

/**
 * ADR 048: reads of what a schedule did and will do. Occurrence history is
 * the metadata the scanner already records; fire times are projected by the
 * scheduler's own recurrence engine from database time. Nothing here writes.
 */
const utcInstant = (column: SQLWrapper) =>
  sql<string>`to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function readOccurrencePage(
  client: PoolClient,
  read: TriggerRead,
  limit: number,
  after: ScheduleOccurrencePosition | undefined,
): Promise<ScheduleOccurrencePage> {
  // Occurrences past ADR 013's 90-day trigger-summary cutoff are never
  // served, even before the bounded retention stage removes them.
  const result = await drizzle(client)
    .select({
      id: occurrences.id,
      outcome: occurrences.disposition,
      runId: occurrences.workflowRunId,
      skipReason: occurrences.skipReason,
      scheduledAt: utcInstant(occurrences.scheduledAt),
      recordedAt: utcInstant(occurrences.createdAt),
    })
    .from(occurrences)
    .where(
      and(
        eq(occurrences.workspaceId, read.workspaceId),
        eq(occurrences.triggerId, read.triggerId),
        sql`${occurrences.scheduledAt}>clock_timestamp()-make_interval(days=>${DATA_RETENTION_DAYS.triggerHistory})`,
        sql`(${after?.scheduledAt ?? null}::timestamptz is null or ${occurrences.scheduledAt}<${after?.scheduledAt ?? null}::timestamptz or
        (${occurrences.scheduledAt}=${after?.scheduledAt ?? null}::timestamptz and ${occurrences.id}>${after?.id ?? null}::uuid))`,
      ),
    )
    .orderBy(desc(occurrences.scheduledAt), occurrences.id)
    .limit(limit + 1)
    .catch(rethrowQueryFailure);
  const items = Object.freeze(
    result.slice(0, limit).map(({ skipReason, ...row }) =>
      Object.freeze({
        ...row,
        ...(skipReason === null ? {} : { skipReason }),
      }),
    ),
  );
  const last = items.at(-1);
  if (result.length <= limit || last === undefined)
    return Object.freeze({ items });
  return Object.freeze({
    items,
    nextCursor: Object.freeze({ scheduledAt: last.scheduledAt, id: last.id }),
  });
}

export type ScheduleState = NonNullable<
  Awaited<ReturnType<typeof readScheduleState>>
>;

export async function readScheduleState(client: PoolClient, read: TriggerRead) {
  const result = await drizzle(client)
    .select({
      recurrence_kind: schedules.recurrenceKind,
      cron_expression: schedules.cronExpression,
      timezone: schedules.timezone,
      interval_minutes: schedules.intervalMinutes,
      anchor_at: schedules.anchorAt,
      next_fire_at: schedules.nextFireAt,
      observed_at: sql<Date>`clock_timestamp()`.mapWith(schedules.createdAt),
      ...scheduleStandingColumns,
    })
    .from(schedules)
    .innerJoin(
      triggers,
      and(
        eq(triggers.workspaceId, schedules.workspaceId),
        eq(triggers.id, schedules.triggerId),
      ),
    )
    .innerJoin(
      workflows,
      and(
        eq(workflows.workspaceId, triggers.workspaceId),
        eq(workflows.id, triggers.workflowId),
      ),
    )
    .innerJoin(workspaces, eq(workspaces.id, triggers.workspaceId))
    .where(
      and(
        eq(schedules.workspaceId, read.workspaceId),
        eq(triggers.workflowId, read.workflowId),
        eq(triggers.id, read.triggerId),
        eq(triggers.kind, 'schedule'),
      ),
    )
    .catch(rethrowQueryFailure);
  return result[0];
}

export async function scheduleTriggerExists(
  client: PoolClient,
  input: ListScheduleOccurrencesInput,
): Promise<boolean> {
  const trigger = await drizzle(client)
    .select({ one: sql`1` })
    .from(triggers)
    .where(
      and(
        eq(triggers.workspaceId, input.workspaceId),
        eq(triggers.id, input.triggerId),
        eq(triggers.workflowId, input.workflowId),
        eq(triggers.kind, 'schedule'),
      ),
    )
    .catch(rethrowQueryFailure);
  return trigger.length === 1;
}
