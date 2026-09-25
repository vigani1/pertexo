import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../tenant-access/workspace.js';
import {
  MAX_SCHEDULE_PROJECTION,
  parsePersistedScheduleRecurrence,
  parseScheduleRecurrence,
  projectScheduleOccurrences,
  type ScheduleRecurrence,
} from './schedule-recurrence.js';
import { ScheduleTriggerError } from './schedule-trigger-errors.js';

/**
 * ADR 048: reads of what a schedule did and will do. Occurrence history is
 * the metadata the scanner already records; fire times are projected by the
 * scheduler's own recurrence engine from database time. Nothing here writes.
 */
const OUTCOMES = ['accepted', 'skipped'] as const;
const DEFAULT_PAGE_LIMIT = 25;

export type ScheduleOccurrenceOutcome = (typeof OUTCOMES)[number];

export type ScheduleOccurrenceRecord = Readonly<{
  id: string;
  scheduledAt: string;
  recordedAt: string;
  outcome: ScheduleOccurrenceOutcome;
  runId: string | null;
}>;

/** Newest-first keyset position: `(scheduled_at desc, id asc)`. */
export type ScheduleOccurrencePosition = Readonly<{
  scheduledAt: string;
  id: string;
}>;

export type ScheduleOccurrencePage = Readonly<{
  items: readonly ScheduleOccurrenceRecord[];
  nextCursor?: ScheduleOccurrencePosition;
}>;

/** Projected fire instants and the database time they were computed at. */
export type ScheduleFireTimes = Readonly<{
  observedAt: Date;
  items: readonly Date[];
}>;

type TriggerRead = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
  triggerId: string;
}>;

export interface ScheduleTriggerReads {
  listOccurrences(
    input: TriggerRead &
      Readonly<{ limit?: number; after?: ScheduleOccurrencePosition }>,
  ): Promise<ScheduleOccurrencePage>;
  nextFireTimes(
    input: TriggerRead & Readonly<{ count: number }>,
  ): Promise<ScheduleFireTimes>;
  previewFireTimes(
    input: Omit<TriggerRead, 'triggerId'> &
      Readonly<{ recurrence: unknown; count: number }>,
  ): Promise<ScheduleFireTimes>;
}

const uuidSchema = z.uuid();
const pageLimitSchema = z.number().int().positive().max(100);
const countSchema = z.number().int().min(1).max(MAX_SCHEDULE_PROJECTION);
const instantSchema = z.iso
  .datetime({ precision: 6 })
  .refine((value) => !value.startsWith('0000-'), {
    message: 'PostgreSQL timestamps do not support year zero',
  });
const positionSchema = z
  .object({ scheduledAt: instantSchema, id: uuidSchema })
  .strict();
const utcInstant = (column: string) =>
  `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Every active member of an active workspace may read schedule state. */
export async function authorizeScheduleReader(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  workflowId: string,
): Promise<void> {
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
      join app.workspaces workspace on workspace.id=membership.workspace_id
      join app.users actor on actor.id=membership.user_id
      join app.workflows workflow on workflow.workspace_id=membership.workspace_id
     where membership.workspace_id=$1 and membership.user_id=$2 and workflow.id=$3
       and membership.status='active'
       and membership.role in ('owner','admin','builder','operator','viewer')
       and workspace.status='active' and actor.status='active'`,
    [workspaceId, actorId, workflowId],
  );
  if (result.rowCount !== 1) throw new ScheduleTriggerError('not_found');
}

function tenantScope(read: Pick<TriggerRead, 'workspaceId' | 'actorId'>) {
  return { workspaceId: read.workspaceId, actorId: read.actorId };
}

function parseTriggerRead(input: TriggerRead): TriggerRead {
  return Object.freeze({
    workspaceId: uuidSchema.parse(input.workspaceId),
    actorId: uuidSchema.parse(input.actorId),
    workflowId: uuidSchema.parse(input.workflowId),
    triggerId: uuidSchema.parse(input.triggerId),
  });
}

function mapOccurrence(row: Record<string, unknown>): ScheduleOccurrenceRecord {
  const outcome = z.enum(OUTCOMES).parse(row.disposition);
  const runId = uuidSchema.nullable().parse(row.workflow_run_id);
  if ((outcome === 'accepted') !== (runId !== null))
    throw new TypeError('Schedule occurrence outcome and run disagree');
  return Object.freeze({
    id: uuidSchema.parse(row.id),
    scheduledAt: instantSchema.parse(row.scheduled_at_cursor),
    recordedAt: instantSchema.parse(row.recorded_at),
    outcome,
    runId,
  });
}

async function readOccurrencePage(
  client: PoolClient,
  read: TriggerRead,
  limit: number,
  after: ScheduleOccurrencePosition | undefined,
): Promise<ScheduleOccurrencePage> {
  // Occurrences past ADR 013's 90-day trigger-summary cutoff are never
  // served, even before the bounded retention stage removes them.
  const result = await client.query<Record<string, unknown>>(
    `select id,disposition,workflow_run_id,
            ${utcInstant('scheduled_at')} scheduled_at_cursor,
            ${utcInstant('created_at')} recorded_at
       from app.trigger_schedule_occurrences
      where workspace_id=$1 and trigger_id=$2
        and scheduled_at>clock_timestamp()-interval '90 days'
        and ($3::timestamptz is null or scheduled_at<$3::timestamptz
          or (scheduled_at=$3::timestamptz and id>$4::uuid))
      order by scheduled_at desc,id asc
      limit $5`,
    [
      read.workspaceId,
      read.triggerId,
      after?.scheduledAt ?? null,
      after?.id ?? null,
      limit + 1,
    ],
  );
  const items = Object.freeze(result.rows.slice(0, limit).map(mapOccurrence));
  const last = items.at(-1);
  if (result.rows.length <= limit || last === undefined)
    return Object.freeze({ items });
  return Object.freeze({
    items,
    nextCursor: Object.freeze({ scheduledAt: last.scheduledAt, id: last.id }),
  });
}

async function readScheduleState(
  client: PoolClient,
  read: TriggerRead,
): Promise<Record<string, unknown>> {
  const result = await client.query<Record<string, unknown>>(
    `select schedule.recurrence_kind,schedule.cron_expression,schedule.timezone,
            schedule.interval_minutes,schedule.anchor_at,schedule.next_fire_at,
            clock_timestamp() observed_at,
            (schedule.status='enabled' and trigger.status='active'
              and workflow.lifecycle_status='active'
              and workflow.activation_status in ('active','degraded')
              and workflow.published_version_id=trigger.workflow_version_id) fires
       from app.trigger_schedules schedule
       join app.workflow_triggers trigger on trigger.workspace_id=schedule.workspace_id
        and trigger.id=schedule.trigger_id
       join app.workflows workflow on workflow.workspace_id=trigger.workspace_id
        and workflow.id=trigger.workflow_id
      where schedule.workspace_id=$1 and trigger.workflow_id=$2
        and trigger.id=$3 and trigger.kind='schedule'`,
    [read.workspaceId, read.workflowId, read.triggerId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ScheduleTriggerError('not_found');
  return row;
}

async function readDatabaseTime(client: PoolClient): Promise<Date> {
  const result = await client.query<{ observed_at: Date }>(
    'select clock_timestamp() observed_at',
  );
  return z.date().parse(result.rows[0]?.observed_at);
}

/** Computed after the read transaction ends, so no connection waits on it. */
function projectPersistedSchedule(
  row: Record<string, unknown>,
  count: number,
): ScheduleFireTimes {
  const observedAt = z.date().parse(row.observed_at);
  // A schedule the scanner would not claim has no upcoming fire times.
  if (row.fires !== true)
    return Object.freeze({ observedAt, items: Object.freeze([]) });
  const nextFireAt = z.date().parse(row.next_fire_at);
  const recurrence = parsePersistedScheduleRecurrence({
    recurrence_kind: z.enum(['cron', 'interval']).parse(row.recurrence_kind),
    cron_expression: z.string().nullable().parse(row.cron_expression),
    timezone: z.string().nullable().parse(row.timezone),
    interval_minutes: z.number().int().nullable().parse(row.interval_minutes),
  });
  // The persisted next fire comes first, even while it waits for a scanner;
  // after it, each instant is what the scanner persists when it claims.
  const later =
    count === 1
      ? []
      : projectScheduleOccurrences(
          recurrence,
          z.date().parse(row.anchor_at),
          nextFireAt > observedAt ? nextFireAt : observedAt,
          count - 1,
        );
  return Object.freeze({
    observedAt,
    items: Object.freeze([nextFireAt, ...later]),
  });
}

function parseDraftRecurrence(value: unknown): ScheduleRecurrence {
  try {
    return parseScheduleRecurrence(value);
  } catch (error: unknown) {
    throw new ScheduleTriggerError('invalid_recurrence', { cause: error });
  }
}

export function createScheduleTriggerReads(pool: Pool): ScheduleTriggerReads {
  return Object.freeze({
    listOccurrences: (
      input: Parameters<ScheduleTriggerReads['listOccurrences']>[0],
    ) => {
      const read = parseTriggerRead(input);
      const limit = pageLimitSchema.parse(input.limit ?? DEFAULT_PAGE_LIMIT);
      const after =
        input.after === undefined
          ? undefined
          : positionSchema.parse(input.after);
      return withTenantScopedClient(pool, tenantScope(read), async (client) => {
        await authorizeScheduleReader(
          client,
          read.workspaceId,
          read.actorId,
          read.workflowId,
        );
        const trigger = await client.query(
          `select 1 from app.workflow_triggers
            where workspace_id=$1 and id=$2 and workflow_id=$3
              and kind='schedule'`,
          [read.workspaceId, read.triggerId, read.workflowId],
        );
        if (trigger.rowCount !== 1) throw new ScheduleTriggerError('not_found');
        return readOccurrencePage(client, read, limit, after);
      });
    },
    nextFireTimes: async (
      input: Parameters<ScheduleTriggerReads['nextFireTimes']>[0],
    ) => {
      const read = parseTriggerRead(input);
      const count = countSchema.parse(input.count);
      const row = await withTenantScopedReadClient(
        pool,
        tenantScope(read),
        async (client) => {
          await authorizeScheduleReader(
            client,
            read.workspaceId,
            read.actorId,
            read.workflowId,
          );
          return readScheduleState(client, read);
        },
      );
      return projectPersistedSchedule(row, count);
    },
    previewFireTimes: async (
      input: Parameters<ScheduleTriggerReads['previewFireTimes']>[0],
    ) => {
      const scope = {
        workspaceId: uuidSchema.parse(input.workspaceId),
        actorId: uuidSchema.parse(input.actorId),
      };
      const workflowId = uuidSchema.parse(input.workflowId);
      const count = countSchema.parse(input.count);
      const recurrence = parseDraftRecurrence(input.recurrence);
      const observedAt = await withTenantScopedReadClient(
        pool,
        scope,
        async (client) => {
          await authorizeScheduleReader(
            client,
            scope.workspaceId,
            scope.actorId,
            workflowId,
          );
          return readDatabaseTime(client);
        },
      );
      // Publication anchors a new schedule at database time (ADR 014), so an
      // unsaved rule is projected as if it were published at this instant.
      return Object.freeze({
        observedAt,
        items: projectScheduleOccurrences(
          recurrence,
          observedAt,
          observedAt,
          count,
        ),
      });
    },
  });
}
