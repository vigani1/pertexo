import { useQueryClient } from '@tanstack/react-query';
import { useRouteContext, useRouterState } from '@tanstack/react-router';
import {
  WorkflowHubBar,
  type WorkflowHubTab,
} from '@/features/workflows/hub.public';
import { cachedWorkflowSummary } from '@/features/workflows/queries.public';

import { PagePending } from './pending';

/** The hub tab a workflow path opens, from its last segment. */
function hubTabOf(pathname: string): WorkflowHubTab {
  const tab = /\/workflows\/[^/]+\/([a-z]+)\/?$/u.exec(pathname)?.[1];
  const hasWorkflowSubpage =
    tab === 'runs' ||
    tab === 'triggers' ||
    tab === 'versions' ||
    tab === 'settings';
  return hasWorkflowSubpage ? tab : 'build';
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
          workflow={cachedWorkflowSummary(
            queryClient,
            user.id,
            workspace.id,
            workflowId,
          )}
          activeTab={tab}
          scope={{
            apiClient,
            userId: user.id,
            workspace,
            workflowId,
          }}
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
