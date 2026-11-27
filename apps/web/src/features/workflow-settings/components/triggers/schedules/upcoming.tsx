import { useQueries } from '@tanstack/react-query';
import type { ScheduleTriggerHealthResponse } from '@pertexo/contracts';
import { Row, RowList } from '@/components/patterns/lists/row';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import type { ApiClient } from '@/lib/api/client';
import { CLOCK_TICK, useNow } from '@/lib/hooks/use-now';
import {
  formatDateTime,
  formatMoment,
  formatRelativeTime,
} from '@/lib/format/time';
import { scheduleNextRunsQueryOptions } from '../../../data/workflow-settings.queries';
import {
  positionInWindow,
  upcomingRuns,
} from '../../../model/triggers/upcoming';

/**
 * The schedule runs due in the next 24 hours, on a strip and as rows. Only
 * schedules are known ahead; webhooks and forms start runs when they arrive.
 */
export function UpcomingRuns({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  triggers,
  stepNameFor,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  triggers: readonly ScheduleTriggerHealthResponse[];
  stepNameFor: (trigger: ScheduleTriggerHealthResponse) => string;
}>) {
  const now = useNow({ intervalMs: CLOCK_TICK.relativeTime });
  const active = triggers.filter(
    (trigger) => trigger.status !== 'disabled' && trigger.recurrence !== null,
  );
  const readings = useQueries({
    queries: active.map((trigger) =>
      scheduleNextRunsQueryOptions({
        apiClient,
        userId,
        workspaceId,
        workflowId,
        triggerId: trigger.id,
      }),
    ),
  });
  const runs = upcomingRuns(
    active.map((trigger, index) => ({
      triggerId: trigger.id,
      name: stepNameFor(trigger),
      times:
        readings[index]?.data?.items.map(({ scheduledAt }) => scheduledAt) ??
        [],
    })),
    now,
  );
  return (
    <section aria-labelledby="upcoming-runs" className="flex flex-col gap-3">
      <RuleHeading id="upcoming-runs">Next 24 hours</RuleHeading>
      <p className="text-meta text-subtle-foreground">
        Only schedules are known ahead. Webhooks and forms start runs when they
        arrive.
      </p>
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No schedule runs in the next 24 hours.
        </p>
      ) : (
        <>
          <div aria-hidden="true" className="relative mt-4 mb-2 h-6">
            <span className="absolute inset-x-0 top-1/2 h-px bg-border-strong" />
            <span className="absolute top-1/2 left-0 size-1.75 -translate-y-1/2 rounded-full bg-muted-foreground" />
            {runs.map((run) => (
              <span
                key={`${run.triggerId}:${run.scheduledAt}`}
                className="absolute top-1/2 size-2.25 -translate-1/2 rounded-full border-[1.5px] border-muted-foreground bg-background"
                style={{
                  left: `${String(positionInWindow(run.scheduledAt, now) * 100)}%`,
                }}
              />
            ))}
          </div>
          <RowList aria-label="Next 24 hours">
            {runs.map((run) => (
              <Row
                key={`${run.triggerId}:${run.scheduledAt}`}
                lift="none"
                className="grid-cols-[minmax(0,1fr)_auto] py-2.5 sm:grid-cols-[11rem_minmax(0,1fr)_auto]"
              >
                <time
                  dateTime={run.scheduledAt}
                  title={formatDateTime(run.scheduledAt)}
                  className="font-mono text-caption text-muted-foreground max-sm:col-span-2"
                >
                  {formatMoment(run.scheduledAt)}
                </time>
                <span className="truncate text-sm">{run.name}</span>
                <span className="font-mono text-caption text-subtle-foreground">
                  {formatRelativeTime(run.scheduledAt, now)}
                </span>
              </Row>
            ))}
          </RowList>
        </>
      )}
    </section>
  );
}
