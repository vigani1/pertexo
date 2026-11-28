import type { AccessibleWorkspace } from '@pertexo/contracts';
import { ActiveRunStep } from '@/features/workflow-runs/workflow-runs-views.public';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import { QueryView } from '@/components/patterns/states/query-view';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { formatCount } from '@/lib/format/count';
import { CLOCK_TICK, useNow } from '@/lib/hooks/use-now';
import type { ApiClient } from '@/lib/api/client';
import {
  describeRunStatus,
  isActiveRunStatus,
} from '@/features/workflow-runs/public';
import { runLoomQueryOptions } from '@/features/workflow-runs/workflow-runs-queries.public';

// A local day can be longer when the clocks change.
const TODAY_LOOKBACK_MS = 26 * 60 * 60 * 1000;

export function TodayRuns({
  apiClient,
  userId,
  workspace,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
}>) {
  const workspaceId = workspace.id;
  const now = useNow({ intervalMs: CLOCK_TICK.relativeTime });
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const query = useQuery(
    runLoomQueryOptions(apiClient, userId, workspaceId, TODAY_LOOKBACK_MS),
  );
  return (
    <section aria-labelledby="home-today" className="grid gap-3">
      <RuleHeading id="home-today">Today</RuleHeading>
      <QueryView query={query} resource="Today’s runs">
        {({ runs, capped }) => {
          const unique = [
            ...new Map(runs.map((run) => [run.id, run])).values(),
          ];
          const today = unique.filter(
            (run) => Date.parse(run.createdAt) >= midnight.getTime(),
          );
          const current =
            unique.find((run) => run.status === 'running') ?? today[0];
          const finished = today.filter(
            (run) => !isActiveRunStatus(run.status),
          ).length;
          return (
            <div className="grid gap-2 rounded-lg border border-border p-3">
              {current === undefined ? null : (
                <Link
                  to="/w/$workspaceId/runs/$runId"
                  params={{ workspaceId, runId: current.id }}
                  className="inline-flex min-h-10 flex-wrap items-center justify-between gap-2 underline-offset-4 hover:underline"
                >
                  <span className="min-w-0 wrap-anywhere">
                    {current.workflowName ?? 'Open run'}
                    <ActiveRunStep
                      run={current}
                      scope={{ apiClient, userId, workspace }}
                    />
                  </span>
                  <StatusMark
                    tone={describeRunStatus({ status: current.status }).tone}
                  >
                    {describeRunStatus({ status: current.status }).label}
                  </StatusMark>
                </Link>
              )}
              <p className="text-sm text-muted-foreground">
                {capped
                  ? `${formatCount(finished, 'loaded run')} started today and finished.`
                  : `${formatCount(finished, 'run')} started today and finished.`}
              </p>
            </div>
          );
        }}
      </QueryView>
    </section>
  );
}
