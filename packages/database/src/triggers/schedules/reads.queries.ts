import { and, desc, eq, sql, type SQLWrapper } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import {
  workflowTriggers as triggers,
  workflows,
} from '../../schema/authoring/workflows.js';
import {
  triggerScheduleOccurrences as occurrences,
  triggerSchedules as schedules,
} from '../../schema/triggers/schedules.js';
import type {
  ScheduleFireTimes,
  ScheduleOccurrencePage,
  ScheduleOccurrencePosition,
  ScheduleTriggerReads,
  TriggerRead,
} from './contract.js';

import type { Pool, PoolClient } from 'pg';

import { authorizeWorkflowResource } from '../../tenant-access/resources/authority.js';
import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../../tenant-access/transactions.js';
import { ScheduleTriggerError } from './errors.js';
import {
  parsePersistedScheduleRecurrence,
  projectScheduleOccurrences,
} from './recurrence.js';

/**
 * ADR 048: reads of what a schedule did and will do. Occurrence history is
 * the metadata the scanner already records; fire times are projected by the
 * scheduler's own recurrence engine from database time. Nothing here writes.
 */
const DEFAULT_PAGE_LIMIT = 25;
const utcInstant = (column: SQLWrapper) =>
  sql<string>`to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Every active member of an active workspace may read schedule state. */
export async function authorizeScheduleReader(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  workflowId: string,
): Promise<void> {
  if (
    !(await authorizeWorkflowResource(
      client,
      { workspaceId, actorId, workflowId },
      { capability: 'workflow:read', locking: false, browsing: true },
    ))
  )
    throw new ScheduleTriggerError('not_found');
}

function tenantScope(read: Pick<TriggerRead, 'workspaceId' | 'actorId'>) {
  return { workspaceId: read.workspaceId, actorId: read.actorId };
}

async function readOccurrencePage(
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
        sql`${occurrences.scheduledAt}>clock_timestamp()-interval '90 days'`,
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

type ScheduleState = Awaited<ReturnType<typeof readScheduleState>>;

async function readScheduleState(client: PoolClient, read: TriggerRead) {
  const result = await drizzle(client)
    .select({
      recurrence_kind: schedules.recurrenceKind,
      cron_expression: schedules.cronExpression,
      timezone: schedules.timezone,
      interval_minutes: schedules.intervalMinutes,
      anchor_at: schedules.anchorAt,
      next_fire_at: schedules.nextFireAt,
      observed_at: sql<Date>`clock_timestamp()`.mapWith(schedules.createdAt),
      fires: sql<
        boolean | null
      >`(${schedules.status}='enabled' and ${triggers.status}='active' and ${workflows.lifecycleStatus}='active'
      and ${workflows.activationStatus} in ('active','degraded') and ${workflows.publishedVersionId}=${triggers.workflowVersionId})`,
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
    .where(
      and(
        eq(schedules.workspaceId, read.workspaceId),
        eq(triggers.workflowId, read.workflowId),
        eq(triggers.id, read.triggerId),
        eq(triggers.kind, 'schedule'),
      ),
    )
    .catch(rethrowQueryFailure);
  const row = result[0];
  if (row === undefined) throw new ScheduleTriggerError('not_found');
  return row;
}

async function readDatabaseTime(client: PoolClient): Promise<Date> {
  const result = await drizzle(client)
    .execute<{ observedAt: string }>(sql`select clock_timestamp() "observedAt"`)
    .catch(rethrowQueryFailure);
  const at = result.rows[0]?.observedAt;
  if (at === undefined)
    throw new Error('Schedule database observation is unavailable');
  return new Date(at);
}

/** Computed after the read transaction ends, so no connection waits on it. */
function projectPersistedSchedule(
  row: ScheduleState,
  count: number,
): ScheduleFireTimes {
  const observedAt = row.observed_at;
  // A schedule the scanner would not claim has no upcoming fire times.
  if (!(row.fires ?? false))
    return Object.freeze({ observedAt, items: Object.freeze([]) });
  const nextFireAt = row.next_fire_at;
  const recurrence = parsePersistedScheduleRecurrence(row);
  // The persisted next fire comes first, even while it waits for a scanner;
  // after it, each instant is what the scanner persists when it claims.
  const later =
    count === 1
      ? []
      : projectScheduleOccurrences(
          recurrence,
          row.anchor_at,
          nextFireAt > observedAt ? nextFireAt : observedAt,
          count - 1,
        );
  return Object.freeze({
    observedAt,
    items: Object.freeze([nextFireAt, ...later]),
  });
}

export function createScheduleTriggerReads(pool: Pool): ScheduleTriggerReads {
  return Object.freeze({
    listOccurrences: (
      input: Parameters<ScheduleTriggerReads['listOccurrences']>[0],
    ) => {
      const read = input;
      const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
      const after = input.after;
      return withTenantScopedClient(pool, tenantScope(read), async (client) => {
        await authorizeScheduleReader(
          client,
          read.workspaceId,
          read.actorId,
          read.workflowId,
        );
        const trigger = await drizzle(client)
          .select({ one: sql`1` })
          .from(triggers)
          .where(
            and(
              eq(triggers.workspaceId, read.workspaceId),
              eq(triggers.id, read.triggerId),
              eq(triggers.workflowId, read.workflowId),
              eq(triggers.kind, 'schedule'),
            ),
          )
          .catch(rethrowQueryFailure);
        if (trigger.length !== 1) throw new ScheduleTriggerError('not_found');
        return readOccurrencePage(client, read, limit, after);
      });
    },
    nextFireTimes: async (
      input: Parameters<ScheduleTriggerReads['nextFireTimes']>[0],
    ) => {
      const read = input;
      const count = input.count;
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
        workspaceId: input.workspaceId,
        actorId: input.actorId,
      };
      const workflowId = input.workflowId;
      const count = input.count;
      const recurrence = input.recurrence;
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
