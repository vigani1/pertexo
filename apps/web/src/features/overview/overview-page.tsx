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
    <div>
      <header className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs tracking-[0.2em] text-secondary">
            WORKSPACE PULSE
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
            Overview
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Recent retained activity for {workspace.name}. Each list refreshes
            independently and is not an aggregate reporting snapshot.
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

      <div className="mt-8 grid gap-5 xl:grid-cols-2">
        {canReadWorkflows ? (
          <OverviewCard
            title="Recently managed workflows"
            description="The five workflows with the latest lifecycle or publication metadata changes. Draft-only edits are not included."
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
                  className="flex min-w-0 items-center justify-between gap-4 py-4"
                >
                  <div className="min-w-0">
                    <Link
                      to="/w/$workspaceId/workflows/$workflowId"
                      params={{
                        workspaceId: workspace.id,
                        workflowId: workflow.id,
                      }}
                      className="block truncate font-medium text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
            title="Recent runs"
            description="The five newest workflow runs."
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
            />
          </OverviewCard>
        ) : null}

        {canReadRuns ? (
          <OverviewCard
            title="Recent failed runs"
            description="The five newest runs whose status is failed."
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
}: Readonly<{
  workspaceId: string;
  runs: readonly WorkflowRunReadSummary[];
}>) {
  return (
    <ul className="divide-y divide-border" aria-label="Workflow runs">
      {runs.map((run) => (
        <li
          key={run.id}
          className="flex min-w-0 items-center justify-between gap-4 py-4"
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
          <Badge variant={runStatusVariant(run.status)}>
            {run.status.replaceAll('_', ' ')}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
