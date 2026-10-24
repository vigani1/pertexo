import type { ScheduleOccurrenceDisposition } from './misfire.js';

/** ADR 056: a paused workflow's occurrence is recorded without a run. */
export type RecordedScheduleOccurrence =
  ScheduleOccurrenceDisposition | 'paused';

export type ScheduleOccurrenceOutcome = RecordedScheduleOccurrence;

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
