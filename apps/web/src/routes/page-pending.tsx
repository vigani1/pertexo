import { useQueryClient } from '@tanstack/react-query';
import { useRouteContext, useRouterState } from '@tanstack/react-router';
import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';
import {
  WorkflowHubBar,
  type WorkflowHubTab,
} from '@/features/workflows/hub.public';
import { cachedWorkflowSummary } from '@/features/workflows/queries.public';

const ROWS = [72, 38, 90, 24, 56, 64] as const;

/**
 * A page loading: a title bar and spooling thread rows. The router shows it
 * after 150 ms, so its skeletons don't wait again.
 */
export function PagePending() {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="flex flex-col gap-8 [--skeleton-wait:0ms]"
    >
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-3 w-80 max-w-full" />
      </div>
      <div className="flex flex-col gap-5">
        {ROWS.map((width, order) => (
          <div
            key={order}
            className="grid grid-cols-[1rem_minmax(0,14rem)_minmax(0,1fr)_3rem] items-center gap-4"
          >
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-2.5" />
            <SkeletonThread
              order={order}
              style={{ width: `${String(width)}%` }}
            />
            <Skeleton className="h-2.5" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The hub tab a workflow path opens, from its last segment. */
function hubTabOf(pathname: string): WorkflowHubTab {
  const tab = /\/workflows\/[^/]+\/([a-z]+)\/?$/u.exec(pathname)?.[1];
  return tab === 'runs' ||
    tab === 'triggers' ||
    tab === 'versions' ||
    tab === 'settings'
    ? tab
    : 'build';
}

/**
 * A workflow hub page loading. The real bar renders at once, with its tabs
 * and the name when a list already showed it, so it stays put when the page
 * lands; under it Build waits on the canvas and the other tabs on a page
 * skeleton inside the hub's own margins.
 */
export function WorkflowHubPending() {
  const { apiClient, user, workspace, workflowId } = useRouteContext({
    from: '/w/$workspaceId/workflows/$workflowId',
  });
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const queryClient = useQueryClient();
  const tab = hubTabOf(pathname);
  // The bar is a picture of what's coming: inert, so nothing can be started
  // in it (a rename) that the arriving page would then throw away.
  const bar =
    workflowId === null ? null : (
      <div inert aria-hidden="true">
        <WorkflowHubBar
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflowId={workflowId}
          workflow={cachedWorkflowSummary(
            queryClient,
            user.id,
            workspace.id,
            workflowId,
          )}
          activeTab={tab}
        />
      </div>
    );
  if (tab === 'build')
    return (
      <div
        role="status"
        aria-label="Loading the canvas"
        className="weave relative h-svh overflow-hidden p-3"
      >
        {bar}
      </div>
    );
  return (
    <div className="[--skeleton-wait:0ms]">
      <div className="sticky top-0 z-30 px-3 pt-3">{bar}</div>
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 sm:px-6">
        <PagePending />
      </div>
    </div>
  );
}
