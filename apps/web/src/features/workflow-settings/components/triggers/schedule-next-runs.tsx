import { useId } from 'react';
import type { ScheduleTriggerHealthResponse } from '@pertexo/contracts/schemas/schedules';
import { useQuery } from '@tanstack/react-query';
import { ReadFailure } from '@/components/patterns/read-failure';
import { Skeleton } from '@/components/ui/skeleton';
import { ScheduleRunTimes } from '@/features/catalog/presentation.public';
import type { ApiClient } from '@/lib/api/client';
import { scheduleNextRunsQueryOptions } from '../../workflow-settings.queries';

/**
 * The next three times a published schedule runs, as the server's scheduler
 * computes them — on the schedule's own clock and on this person's.
 */
export function ScheduleNextRuns({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  trigger,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  trigger: ScheduleTriggerHealthResponse;
}>) {
  const headingId = useId();
  const nextRuns = useQuery(
    scheduleNextRunsQueryOptions(
      apiClient,
      userId,
      workspaceId,
      workflowId,
      trigger.id,
    ),
  );
  const times = nextRuns.data?.items.map(({ scheduledAt }) => scheduledAt);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h4 id={headingId} className="text-sm font-semibold">
        Next runs
      </h4>
      {nextRuns.isPending ? (
        <div
          role="status"
          aria-label="Loading next runs"
          className="flex flex-col gap-2 py-1"
        >
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-3 w-3/5" />
          ))}
        </div>
      ) : null}
      {nextRuns.isError ? (
        <ReadFailure
          resource="Next runs"
          error={nextRuns.error}
          showing={times !== undefined}
          retrying={nextRuns.isFetching}
          updatedAt={nextRuns.dataUpdatedAt}
          onRetry={() => void nextRuns.refetch()}
        />
      ) : null}
      {times?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {trigger.status === 'disabled'
            ? 'Paused — nothing runs until the schedule is turned back on.'
            : 'Nothing is scheduled. Runs start again once this version is published and active.'}
        </p>
      ) : null}
      {times === undefined || times.length === 0 ? null : (
        <ScheduleRunTimes
          label="Next runs"
          times={times}
          {...(trigger.recurrence.kind === 'cron'
            ? { timezone: trigger.recurrence.timezone }
            : {})}
        />
      )}
    </section>
  );
}
