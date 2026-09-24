import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowRunReadSummary } from '@pertexo/contracts/schemas/workflow-runs';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { recentWorkflowsQueryOptions } from '@/features/workflows/public';
import { recentWorkflowRunsQueryOptions } from '@/features/workflow-runs/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { OverviewCard } from './components/overview-card';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function runStatusVariant(
  status: WorkflowRunReadSummary['status'],
): 'default' | 'secondary' | 'muted' | 'destructive' {
  if (status === 'succeeded') return 'default';
  if (status === 'failed' || status === 'timed_out') return 'destructive';
  if (status === 'running' || status === 'waiting') return 'secondary';
  return 'muted';
}

export function OverviewPage({
  apiClient,
  user,
  workspace,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
}>) {
  const queryClient = useQueryClient();
  const canReadWorkflows = workspace.capabilities.includes('workflow:read');
  const canReadRuns = workspace.capabilities.includes('run:read');
  const workflowsOptions = recentWorkflowsQueryOptions(
    apiClient,
    user.id,
    workspace.id,
  );
  const recentRunsOptions = recentWorkflowRunsQueryOptions(
    apiClient,
    user.id,
    workspace.id,
    'all',
  );
  const failedRunsOptions = recentWorkflowRunsQueryOptions(
    apiClient,
    user.id,
    workspace.id,
    'failed',
  );
  const workflows = useQuery({
    ...workflowsOptions,
    enabled: canReadWorkflows,
  });
  const recentRuns = useQuery({ ...recentRunsOptions, enabled: canReadRuns });
  const failedRuns = useQuery({ ...failedRunsOptions, enabled: canReadRuns });
  const refreshing =
    workflows.isRefetching ||
    recentRuns.isRefetching ||
    failedRuns.isRefetching;

  function refreshAuthorizedCards() {
    const refreshes: Promise<unknown>[] = [];
    if (canReadWorkflows)
      refreshes.push(
        queryClient.refetchQueries({ queryKey: workflowsOptions.queryKey }),
      );
    if (canReadRuns) {
      refreshes.push(
        queryClient.refetchQueries({ queryKey: recentRunsOptions.queryKey }),
        queryClient.refetchQueries({ queryKey: failedRunsOptions.queryKey }),
      );
    }
    void Promise.all(refreshes);
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div>
          <h1 className="sr-only text-3xl font-semibold tracking-tight lg:not-sr-only lg:block lg:text-4xl">
            Overview
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Resume recent work and inspect the latest retained execution
            activity for {workspace.name}.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={refreshing || (!canReadWorkflows && !canReadRuns)}
          onClick={refreshAuthorizedCards}
        >
          <RefreshCwIcon aria-hidden="true" />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.75fr)]">
        {canReadWorkflows ? (
          <OverviewCard
            appearance="resume"
            title="Recent workflows"
            description="Return to workflows whose lifecycle or publication metadata changed most recently. Draft-only edits are not included."
            updatedAt={workflows.dataUpdatedAt}
            pending={workflows.isPending}
            error={workflows.isError}
            dataAvailable={workflows.data !== undefined}
            empty={workflows.data?.items.length === 0}
            retrying={workflows.isRefetching}
            onRetry={() => void workflows.refetch()}
          >
            <ul
              className="divide-y divide-border"
              aria-label="Recently managed workflows"
            >
              {workflows.data?.items.map((workflow) => (
                <li
                  key={workflow.id}
                  className="flex min-w-0 items-start justify-between gap-4 py-5"
                >
                  <div className="min-w-0">
                    <Link
                      to="/w/$workspaceId/workflows/$workflowId"
                      params={{
                        workspaceId: workspace.id,
                        workflowId: workflow.id,
                      }}
                      className="block truncate font-heading text-lg font-semibold text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      {workflow.name}
                    </Link>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Metadata updated{' '}
                      {dateFormatter.format(new Date(workflow.updatedAt))}
                    </p>
                  </div>
                  <Badge
                    variant={
                      workflow.lifecycleStatus === 'active'
                        ? 'default'
                        : 'muted'
                    }
                  >
                    {workflow.lifecycleStatus}
                  </Badge>
                </li>
              ))}
            </ul>
          </OverviewCard>
        ) : null}

        {canReadRuns ? (
          <OverviewCard
            appearance="attention"
            title="Recent failed runs"
            description="The newest retained runs whose outcome is failed."
            updatedAt={failedRuns.dataUpdatedAt}
            pending={failedRuns.isPending}
            error={failedRuns.isError}
            dataAvailable={failedRuns.data !== undefined}
            empty={failedRuns.data?.items.length === 0}
            retrying={failedRuns.isRefetching}
            onRetry={() => void failedRuns.refetch()}
          >
            <RunList
              workspaceId={workspace.id}
              runs={failedRuns.data?.items ?? []}
              appearance="attention"
            />
            <Link
              to="/w/$workspaceId/runs"
              params={{ workspaceId: workspace.id }}
              search={{ status: 'failed' }}
              className="mt-4 inline-flex text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              View failed run history
            </Link>
          </OverviewCard>
        ) : null}

        {canReadRuns ? (
          <OverviewCard
            className="xl:col-span-2"
            appearance="activity"
            title="Recent run activity"
            description="The five newest workflow runs, in accepted order."
            updatedAt={recentRuns.dataUpdatedAt}
            pending={recentRuns.isPending}
            error={recentRuns.isError}
            dataAvailable={recentRuns.data !== undefined}
            empty={recentRuns.data?.items.length === 0}
            retrying={recentRuns.isRefetching}
            onRetry={() => void recentRuns.refetch()}
          >
            <RunList
              workspaceId={workspace.id}
              runs={recentRuns.data?.items ?? []}
              appearance="activity"
            />
          </OverviewCard>
        ) : null}

        {!canReadWorkflows && !canReadRuns ? (
          <section className="glass-panel rounded-xl p-6 xl:col-span-2">
            <h2 className="text-xl font-semibold">Overview unavailable</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Your workspace role does not allow access to workflows or run
              history.
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function RunList({
  workspaceId,
  runs,
  appearance,
}: Readonly<{
  workspaceId: string;
  runs: readonly WorkflowRunReadSummary[];
  appearance: 'attention' | 'activity';
}>) {
  return (
    <ul className="divide-y divide-border" aria-label="Workflow runs">
      {runs.map((run) => (
        <li
          key={run.id}
          className={
            appearance === 'attention'
              ? 'flex min-w-0 items-start justify-between gap-4 border-l-2 border-destructive/30 py-4 pl-3'
              : 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-4 sm:grid-cols-[minmax(0,1fr)_10rem_auto]'
          }
        >
          <div className="min-w-0">
            <Link
              to="/w/$workspaceId/runs/$runId"
              params={{ workspaceId, runId: run.id }}
              className="block truncate font-medium text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {run.workflowName ?? 'Workflow name unavailable'}
            </Link>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {run.triggerType} · Workflow {run.workflowId.slice(0, 8)}… · Run{' '}
              {run.id.slice(0, 8)}…
            </p>
          </div>
          {appearance === 'activity' ? (
            <time
              dateTime={run.createdAt}
              className="hidden text-sm text-muted-foreground sm:block"
            >
              {dateFormatter.format(new Date(run.createdAt))}
            </time>
          ) : null}
          <Badge variant={runStatusVariant(run.status)}>
            {run.status.replaceAll('_', ' ')}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
