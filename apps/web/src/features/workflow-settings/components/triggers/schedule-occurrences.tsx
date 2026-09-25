import type { ScheduleOccurrenceResponse } from '@pertexo/contracts/schemas/schedules';
import { useInfiniteQuery } from '@tanstack/react-query';
import { RecentLog, RecentLogEntry } from '@/components/patterns/recent-log';
import type { ApiClient } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format-time';
import { describeOccurrence } from '../../model/occurrence-outcome';
import { scheduleOccurrencesInfiniteQueryOptions } from '../../workflow-settings.queries';
import { RunLink } from './run-link';

function OccurrenceEntry({
  occurrence,
  workspaceId,
}: Readonly<{ occurrence: ScheduleOccurrenceResponse; workspaceId: string }>) {
  const outcome = describeOccurrence(occurrence);
  return (
    <RecentLogEntry
      tone={outcome.tone}
      label={outcome.label}
      detail={outcome.detail}
      action={
        occurrence.runId === null ? undefined : (
          <RunLink workspaceId={workspaceId} runId={occurrence.runId} />
        )
      }
      at={occurrence.scheduledAt}
      meta={formatDateTime(occurrence.scheduledAt)}
    />
  );
}

/**
 * What each recorded run time of one schedule did, newest first: the run it
 * started, or that the missed-run setting skipped it. Metadata only.
 */
export function ScheduleOccurrences({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  triggerId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  triggerId: string;
}>) {
  const occurrences = useInfiniteQuery(
    scheduleOccurrencesInfiniteQueryOptions(
      apiClient,
      userId,
      workspaceId,
      workflowId,
      triggerId,
    ),
  );
  return (
    <RecentLog
      title="Recent runs of this schedule"
      note="Kept for 90 days"
      subject="run times"
      loadMoreLabel="Load older run times"
      empty="No run times yet. Each time this schedule comes due, it shows up here with the run it started."
      query={occurrences}
      items={occurrences.data?.pages.flatMap(({ items }) => items)}
      itemKey={(occurrence) => occurrence.id}
      renderItem={(occurrence) => (
        <OccurrenceEntry occurrence={occurrence} workspaceId={workspaceId} />
      )}
    />
  );
}
