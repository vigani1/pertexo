import { TRIGGER_HISTORY_PAGE_LIMIT } from '../../shared/page-limits.js';
import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/policy';
import type { Pool, PoolClient } from 'pg';
import { withWorkflowAccess } from '../../shared/access/workflow-access.js';
import { readDatabaseClock } from '../../shared/database-clock.repository.js';
import { scheduleCanFire } from './schedule-standing.js';
import type {
  ListScheduleOccurrencesInput,
  NextScheduleFireTimesInput,
  PreviewScheduleFireTimesInput,
  ScheduleFireTimes,
} from './schedule-occurrence.types.js';
import {
  ScheduleTriggerError,
  requireSchedule,
} from './schedule-trigger.errors.js';
import {
  readPersistedScheduleRecurrence,
  projectScheduleOccurrences,
} from './recurrence.js';
import {
  readOccurrencePage,
  readScheduleState,
  scheduleTriggerExists,
  type ScheduleState,
} from './schedule-reads.repository.js';

/**
 * ADR 048: reads of what a schedule did and will do. Occurrence history is
 * the metadata the scanner already records; fire times are projected by the
 * scheduler's own recurrence engine from database time. Nothing here writes.
 */
export function createScheduleTriggerReads(pool: Pool) {
  return Object.freeze({
    listOccurrences: (input: ListScheduleOccurrencesInput) => {
      const limit = input.limit ?? TRIGGER_HISTORY_PAGE_LIMIT;
      return withScheduleReader(pool, input, async (client) => {
        if (!(await scheduleTriggerExists(client, input)))
          throw new ScheduleTriggerError('not_found');
        return readOccurrencePage(client, input, limit, input.after);
      });
    },
    nextFireTimes: async (input: NextScheduleFireTimesInput) => {
      const row = await withScheduleReader(pool, input, async (client) =>
        requireSchedule(await readScheduleState(client, input)),
      );
      return projectPersistedSchedule(row, input.count);
    },
    previewFireTimes: async (input: PreviewScheduleFireTimesInput) => {
      const { count, recurrence } = input;
      const observedAt = await withScheduleReader(
        pool,
        input,
        readDatabaseClock,
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

/** Every member may read schedule state, on a suspended workspace too. */
export function withScheduleReader<T>(
  pool: Pool,
  input: Readonly<{ workspaceId: string; actorId: string; workflowId: string }>,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withWorkflowAccess(
    pool,
    {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      workflowId: input.workflowId,
    },
    {
      mode: 'read',
      capability: 'workflow:read',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
      folderCapability: 'workflow:read',
      denied: () => new ScheduleTriggerError('not_found'),
    },
    work,
  );
}

/** Computed after the read transaction ends, so no connection waits on it. */
function projectPersistedSchedule(
  row: ScheduleState,
  count: number,
): ScheduleFireTimes {
  const observedAt = row.observed_at;
  // A schedule the scanner would not claim has no upcoming fire times.
  if (!scheduleCanFire(row))
    return Object.freeze({ observedAt, items: Object.freeze([]) });
  const nextFireAt = row.next_fire_at;
  const recurrence = readPersistedScheduleRecurrence(row);
  if (recurrence === null)
    return Object.freeze({ observedAt, items: Object.freeze([]) });
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
