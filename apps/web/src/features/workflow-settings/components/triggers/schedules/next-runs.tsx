import { SCHEDULE_FIRE_TIME_DEFAULT_COUNT } from '@pertexo/contracts';
import { useId } from 'react';
import type { ScheduleTriggerHealthResponse } from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { QueryView } from '@/components/patterns/states/query-view';
import { SkeletonLines } from '@/components/patterns/states/loading';
import { ScheduleRunTimes } from '@/features/catalog/catalog-views.public';
import type { ApiClient } from '@/lib/api/client';
import { scheduleNextRunsQueryOptions } from '../../../data/workflow-settings.queries';

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
  const off = trigger.status === 'disabled';
  const nextRuns = useQuery({
    ...scheduleNextRunsQueryOptions({
      apiClient,
      userId,
      workspaceId,
      workflowId,
      triggerId: trigger.id,
    }),
    enabled: !off,
  });
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h4 id={headingId} className="text-sm font-semibold">
        Next runs
      </h4>
      {off ? (
        <p className="text-sm text-muted-foreground">
          Paused — nothing runs until the schedule is turned back on.
        </p>
      ) : (
        <QueryView
          query={nextRuns}
          resource="Next runs"
          loading={<SkeletonLines label="Loading next runs" />}
          failure={() => (
            <a href="#upcoming-runs" className="self-start text-sm inline-link">
              Check upcoming schedule runs
            </a>
          )}
          isEmpty={(data) => data.items.length === 0}
          empty={
            <p className="text-sm text-muted-foreground">
              Nothing is scheduled. Runs start again once this version is
              published and active.
            </p>
          }
        >
          {(data) => (
            <ScheduleRunTimes
              label="Next runs"
              times={data.items
                .slice(0, SCHEDULE_FIRE_TIME_DEFAULT_COUNT)
                .map(({ scheduledAt }) => scheduledAt)}
              {...(trigger.recurrence?.kind === 'cron'
                ? { timezone: trigger.recurrence.timezone }
                : {})}
            />
          )}
        </QueryView>
      )}
    </section>
  );
}
