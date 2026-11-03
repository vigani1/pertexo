import type { ScheduleOccurrenceDisposition } from './misfire.js';
import type { ScheduleRecurrence } from './recurrence.js';

/** ADR 056: a paused workflow's occurrence is recorded without a run. */
export type RecordedScheduleOccurrence =
  ScheduleOccurrenceDisposition | 'paused';

export type ScheduleOccurrenceOutcome = RecordedScheduleOccurrence;

// Projection formats timestamps and joins run and skip evidence.
export type ScheduleOccurrenceRecord = Readonly<{
  id: string;
  scheduledAt: string;
  recordedAt: string;
  outcome: ScheduleOccurrenceOutcome;
  runId: string | null;
  skipReason?: 'concurrency_limit';
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

export type TriggerRead = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
  triggerId: string;
}>;

export type ListScheduleOccurrencesInput = TriggerRead &
  Readonly<{ limit?: number; after?: ScheduleOccurrencePosition }>;

export type NextScheduleFireTimesInput = TriggerRead &
  Readonly<{ count: number }>;

export type PreviewScheduleFireTimesInput = Omit<TriggerRead, 'triggerId'> &
  Readonly<{ recurrence: ScheduleRecurrence; count: number }>;
