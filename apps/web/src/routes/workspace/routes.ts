import { workspacePage, warmWorkspacePage } from './workspace-page';
import { parseTaskSearch } from '@/features/pending-tasks/pending-tasks-search.public';
import { createRoute, notFound, redirect } from '@tanstack/react-router';
import { lazyRoute } from '@/components/patterns/app-update/lazy';
import {
  type AccessibleWorkspace,
  workflowRunIdentifierSchema,
} from '@pertexo/contracts';
import { parseConnectionsSearch } from '@/features/connections/connections-search.public';
import { parseInboxSearch } from '@/features/inbox/inbox-search.public';
import {
  filtersFromSearch,
  sanitizeRunSearch,
} from '@/features/workflow-runs/workflow-runs-search.public';
import { parseWorkflowListSearch } from '@/features/workflows/list-search.public';
import { isWorkspaceOpenable } from '@/features/workspaces/availability.public';
import { parseTeamSearch } from '@/features/workspaces/workspaces-search.public';
import { pageTitle } from '../root/page-title';
import {
  findWorkspace,
  authoringPrefetches,
  loadCurrentUser,
  prefetchResource,
  warmPrefetches,
} from '../root/route-context';
import { rootRoute } from '../root/route';
import type { RunCrumb } from '../root/breadcrumbs';
import { WorkspaceBootPage } from '../root/status/pages';

function assertWorkspaceOpenable(
  workspace: AccessibleWorkspace | null,
): asserts workspace is AccessibleWorkspace {
  if (workspace === null || !isWorkspaceOpenable(workspace))
    notFound({
      routeId: rootRoute.id,
      data: { kind: 'workspace' },
      throw: true,
    });
}

/**
 * `/w/$workspaceId` resolves the person and workspace once for every page
 * below it. A workspace they can't open never renders a child.
 */
export const workspaceScopeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId',
  // A cold start: the Core gathers while the session and workspace resolve.
  pendingComponent: WorkspaceBootPage,
  component: lazyRoute(() => import('./shell/scope'), 'WorkspaceScopeRoute'),
  beforeLoad: async ({ context, params, location }) => {
    const user = await loadCurrentUser(context, location.pathname);
    const workspace = await findWorkspace(context, user.id, params.workspaceId);
    assertWorkspaceOpenable(workspace);
    return { user, workspace };
  },
});

/** Pathless layout: the spine, breadcrumb and banners around each page. */
export const workspaceShellRoute = createRoute({
  getParentRoute: () => workspaceScopeRoute,
  id: 'shell',
  // A page that doesn't exist inside a workspace keeps the spine and
  // breadcrumb, so people can move on without reloading.
  notFoundComponent: lazyRoute(
    () => import('./shell/not-found'),
    'ShellNotFound',
  ),
  component: lazyRoute(() => import('./shell/layout'), 'WorkspaceShellRoute'),
});

/** Any other address inside a workspace: the shell's not-found page. */
export const shellCatchAllRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: '$',
  beforeLoad: () => {
    notFound({ throw: true });
  },
  head: ({ match }) => ({
    meta: [
      { title: pageTitle('Page not found', match.context.workspace.name) },
    ],
  }),
});

export const workflowsRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'workflows',
  ...workspacePage('Workflows'),
  // `create` opens the New workflow lens; `view` and `sort` keep the list's
  // filters shareable. Unknown values fall back to the defaults.
  validateSearch: (search) => parseWorkflowListSearch(search),
  loaderDeps: ({ search: { create: _create, ...list } }) => list,
  loader: async ({ context, deps }) => {
    const { workflowListQueryOptions } =
      await import('@/features/workflows/workflows-queries.public');

    const { apiClient, queryClient, user, workspace } = context;
    warmPrefetches(context, [
      queryClient.infiniteQuery(
        workflowListQueryOptions(apiClient, user.id, workspace.id, deps),
      ),
      ...authoringPrefetches(context, user.id, workspace.id),
    ]);
  },

  component: lazyRoute(() => import('../workflow/list'), 'WorkflowListRoute'),
});

export const runsRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'runs',
  ...workspacePage('Runs'),
  // Unknown or malformed keys are dropped, never thrown: a bad link still
  // opens the Runs page.
  validateSearch: (search) => sanitizeRunSearch(search),
  loaderDeps: ({ search }) => filtersFromSearch(search),
  loader: async ({ context, deps }) => {
    return warmWorkspacePage(context, 'run:read', async () => {
      const { runStatisticsQueryOptions, workflowRunsInfiniteQueryOptions } =
        await import('@/features/workflow-runs/workflow-runs-queries.public');

      const { apiClient, queryClient, user, workspace } = context;

      return [
        queryClient.infiniteQuery(
          workflowRunsInfiniteQueryOptions(
            apiClient,
            user.id,
            workspace.id,
            deps,
          ),
        ),
        queryClient.query(
          runStatisticsQueryOptions(apiClient, user.id, workspace.id),
        ),
      ];
    });
  },

  component: lazyRoute(
    () => import('../workflow/run-history'),
    'RunHistoryRoute',
  ),
});

export const runDetailRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'runs/$runId',
  // The breadcrumb names the run's workflow: "Runs / Invoice intake / 7f3a…".
  loader: async ({
    context,
    params,
  }): Promise<
    Readonly<{ found: false }> | Readonly<{ found: true; run: RunCrumb }>
  > => {
    const { workflowRunQueryOptions } =
      await import('@/features/workflow-runs/workflow-runs-queries.public');

    const { apiClient, queryClient, user, workspace } = context;
    const runId = workflowRunIdentifierSchema.safeParse(params.runId);
    if (!runId.success) return { found: false };
    const read = queryClient.query(
      workflowRunQueryOptions(apiClient, user.id, workspace.id, runId.data),
    );
    const { found } = await prefetchResource(context, [read]);
    if (!found) return { found: false };
    const { run } = await read;
    return {
      found: true,
      run: {
        id: run.id,
        workflowId: run.workflowId,
        workflowName: run.workflowName ?? null,
      },
    };
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Run', match.context.workspace.name) }],
  }),
  component: lazyRoute(
    () => import('../workflow/run-detail'),
    'RunDetailRoute',
  ),
});

export const connectionsRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'connections',
  ...workspacePage('Connections'),
  validateSearch: (search) => parseConnectionsSearch(search),
  loader: async ({ context }) => {
    return warmWorkspacePage(context, 'connection:read', async () => {
      const { connectionsInfiniteQueryOptions } =
        await import('@/features/connections/connections-queries.public');

      const { apiClient, queryClient, user, workspace } = context;

      return [
        queryClient.infiniteQuery(
          connectionsInfiniteQueryOptions(apiClient, user.id, workspace.id),
        ),
      ];
    });
  },

  component: lazyRoute(() => import('./connections'), 'ConnectionsRoute'),
});

/** ADR 055: the person's failure notices for this workspace. */
export const inboxRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'inbox',
  ...workspacePage('Inbox'),
  validateSearch: (search) => parseInboxSearch(search),
  loaderDeps: ({ search }) => ({
    filter: search.filter ?? ('all' as const),
    noticeKind: search.noticeKind,
  }),
  loader: async ({ context, deps }) => {
    return warmWorkspacePage(context, 'workspace:read', async () => {
      const { inboxSummaryQueryOptions, inboxThreadsInfiniteQueryOptions } =
        await import('@/features/inbox/inbox-queries.public');

      const { apiClient, queryClient, user, workspace } = context;

      return [
        queryClient.infiniteQuery(
          inboxThreadsInfiniteQueryOptions({
            apiClient,
            userId: user.id,
            workspaceId: workspace.id,
            filter: deps.filter,
            noticeKind: deps.noticeKind,
          }),
        ),
        queryClient.query(
          inboxSummaryQueryOptions(apiClient, user.id, workspace.id),
        ),
      ];
    });
  },

  component: lazyRoute(() => import('./inbox'), 'InboxRoute'),
});

export const teamRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'team',
  ...workspacePage('Team'),
  validateSearch: (search) => parseTeamSearch(search),
  loader: async ({ context }) => {
    return warmWorkspacePage(context, 'member:read', async () => {
      const { workspaceMembersInfiniteQueryOptions } =
        await import('@/features/workspaces/workspaces-queries.public');

      const { apiClient, queryClient, user, workspace } = context;

      return [
        queryClient.infiniteQuery(
          workspaceMembersInfiniteQueryOptions(
            apiClient,
            user.id,
            workspace.id,
          ),
        ),
      ];
    });
  },

  component: lazyRoute(() => import('./team'), 'TeamRoute'),
});

/** Alerts moved into Settings; older links still arrive there. */
export const alertsRedirectRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'alerts',
  beforeLoad: ({ params }) => {
    redirect({
      to: '/w/$workspaceId/settings/alerts',
      params,
      replace: true,
      throw: true,
    });
  },
});

export const workspaceAccountRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'account',
  ...workspacePage('Account & security'),

  component: lazyRoute(() => import('./account'), 'WorkspaceAccountRoute'),
});

export const approvalsRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'approvals',
  ...workspacePage('Approvals'),
  validateSearch: (search) => parseTaskSearch(search, 'approval'),

  component: lazyRoute(() => import('./approvals/list'), 'ApprovalsRoute'),
});

export const approvalDetailRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'approvals/$taskId',
  staticData: { crumb: 'Approval' },
  component: lazyRoute(
    () => import('./approvals/detail'),
    'ApprovalDetailRoute',
  ),
});

export const memberFormRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'forms/$workflowId',
  staticData: { crumb: 'Form' },
  component: lazyRoute(() => import('../forms/member'), 'MemberFormRoute'),
});

export const requestsRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'requests',
  ...workspacePage('Requests'),
  validateSearch: (search) => parseTaskSearch(search),

  component: lazyRoute(() => import('./requests/list'), 'RequestsRoute'),
});

export const requestDetailRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'requests/$taskId',
  staticData: { crumb: 'Request' },
  component: lazyRoute(() => import('./requests/detail'), 'RequestDetailRoute'),
});

export const dataTablesRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'data-tables',
  ...workspacePage('Data tables'),

  component: lazyRoute(() => import('./data-tables'), 'DataTablesRoute'),
});

export const dataTableDetailRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'data-tables/$tableId',
  staticData: { crumb: 'Data table' },
  component: lazyRoute(() => import('./data-tables'), 'DataTablesRoute'),
});

export const publicationReviewRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'publish-reviews/$requestId',
  staticData: { crumb: 'Publication review' },
  component: lazyRoute(() => import('./review'), 'PublicationReviewRoute'),
});
