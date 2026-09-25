import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { LoadMore } from '@/components/patterns/load-more';
import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';
import type { ApiClient } from '@/lib/api/client';
import type { RecentRunTicks } from '../use-recent-run-ticks';
import { WORKFLOW_ROW_COLUMNS, WorkflowRow } from './workflow-row';

const SKELETON_WIDTHS = [62, 44, 78, 36, 58, 70] as const;

/** Rows in the list's own shape; waits 150 ms so fast loads never flash. */
export function WorkflowRowsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading workflows"
      className="flex flex-col motion-safe:animate-[rise_0.3s_var(--ease-unspool)_150ms_backwards]"
    >
      {SKELETON_WIDTHS.map((width, order) => (
        <div
          key={width}
          className={`grid ${WORKFLOW_ROW_COLUMNS} items-center gap-x-4 border-t border-border px-3 py-4 first:border-t-0`}
        >
          <Skeleton className="h-3 w-14 rounded-full" />
          <div className="flex flex-col gap-2">
            <Skeleton
              className="h-3"
              style={{ width: `${String(width / 2)}%` }}
            />
            <SkeletonThread
              order={order}
              style={{ width: `${String(width)}%` }}
            />
          </div>
          <Skeleton className="hidden h-2.5 w-16 lg:block" />
          <Skeleton className="hidden h-2.5 w-8 lg:block" />
          <SkeletonThread order={order + 2} className="hidden lg:block" />
          <Skeleton className="hidden h-2.5 w-12 lg:block" />
          <span />
        </div>
      ))}
    </div>
  );
}

export function WorkflowRows({
  apiClient,
  userId,
  workspace,
  workflows,
  runs,
  onRename,
  onLifecycle,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflows: readonly WorkflowSummary[];
  runs: RecentRunTicks;
  onRename: (workflow: WorkflowSummary) => void;
  onLifecycle: (workflow: WorkflowSummary) => void;
}>) {
  return (
    <div>
      <div
        aria-hidden="true"
        className={`hidden ${WORKFLOW_ROW_COLUMNS} gap-x-4 px-3 pb-2 font-mono text-[0.68rem] text-subtle-foreground lg:grid`}
      >
        <span />
        <span>Workflow</span>
        <span>State</span>
        <span>Triggers</span>
        <span>{runs.enabled ? 'Recent runs' : ''}</span>
        <span>Updated</span>
        <span />
      </div>
      <ul aria-label="Workflows" className="flex flex-col">
        {workflows.map((workflow) => (
          <WorkflowRow
            key={workflow.id}
            apiClient={apiClient}
            userId={userId}
            workspace={workspace}
            workflow={workflow}
            runs={runs}
            onRename={onRename}
            onLifecycle={onLifecycle}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * Loading more pages, plus honest notes on what the filter and the run strips
 * can see: only loaded workflows, and only the workspace's latest runs (once
 * there are any).
 */
export function WorkflowListFooter({
  hasNextPage,
  loadingNextPage,
  nextPageError,
  filtering,
  loadedCount,
  runCount,
  onLoadMore,
}: Readonly<{
  hasNextPage: boolean;
  loadingNextPage: boolean;
  nextPageError: boolean;
  filtering: boolean;
  loadedCount: number;
  runCount: number | undefined;
  onLoadMore: () => void;
}>) {
  return (
    <div className="flex flex-col items-center gap-3 pt-2 text-center">
      <LoadMore
        subject="workflows"
        hasNextPage={hasNextPage}
        loading={loadingNextPage}
        failed={nextPageError}
        onLoadMore={onLoadMore}
      />
      {filtering && hasNextPage ? (
        <p className="text-xs text-subtle-foreground">
          The filter covers the {String(loadedCount)} workflows loaded so far.
          Load more to include the rest.
        </p>
      ) : null}
      {runCount === undefined || runCount === 0 ? null : (
        <p className="font-mono text-[0.7rem] text-subtle-foreground">
          Run strips show each workflow among the latest {String(runCount)} runs
          in this workspace.
        </p>
      )}
    </div>
  );
}
