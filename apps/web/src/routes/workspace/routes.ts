import { parseTaskSearch } from '@/features/pending-tasks/queries.public';
import { createRoute, notFound, redirect } from '@tanstack/react-router';
import { lazyRoute } from '@/components/patterns/app-update/lazy';
import {
  type AccessibleWorkspace,
  workflowRunIdentifierSchema,
} from '@pertexo/contracts';
import {
  connectionsInfiniteQueryOptions,
  parseConnectionsSearch,
} from '@/features/connections/queries.public';
import {
  inboxSummaryQueryOptions,
  inboxThreadsInfiniteQueryOptions,
  parseInboxSearch,
} from '@/features/inbox/queries.public';
import {
  filtersFromSearch,
  runStatisticsQueryOptions,
  sanitizeRunSearch,
  workflowRunQueryOptions,
  workflowRunsInfiniteQueryOptions,
} from '@/features/workflow-runs/queries.public';
import { parseWorkflowListSearch } from '@/features/workflows/list-search.public';
import { workflowListQueryOptions } from '@/features/workflows/queries.public';
import {
  parseTeamSearch,
  workspaceMembersInfiniteQueryOptions,
} from '@/features/workspaces/queries.public';
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
  if (workspace === null)
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
  staticData: { crumb: 'Workflows' },
  // `create` opens the New workflow lens; `view` and `sort` keep the list's
  // filters shareable. Unknown values fall back to the defaults.
  validateSearch: (search) => parseWorkflowListSearch(search),
  loaderDeps: ({ search: { create: _create, ...list } }) => list,
  loader: ({ context, deps }) => {
    const { apiClient, queryClient, user, workspace } = context;
    warmPrefetches(context, [
      queryClient.infiniteQuery(
        workflowListQueryOptions(apiClient, user.id, workspace.id, deps),
      ),
      ...authoringPrefetches(context, user.id, workspace.id),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Workflows', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('../workflow/list'), 'WorkflowListRoute'),
});

export const runsRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'runs',
  staticData: { crumb: 'Runs' },
  // Unknown or malformed keys are dropped, never thrown: a bad link still
  // opens the Runs page.
  validateSearch: (search) => sanitizeRunSearch(search),
  loaderDeps: ({ search }) => filtersFromSearch(search),
  loader: ({ context, deps }) => {
    const { apiClient, queryClient, user, workspace } = context;
    if (!workspace.capabilities.includes('run:read')) return;
    warmPrefetches(context, [
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
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Runs', match.context.workspace.name) }],
  }),
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
  }): Promise<Readonly<{ found: boolean; run?: RunCrumb }>> => {
    const { apiClient, queryClient, user, workspace } = context;
    const runId = workflowRunIdentifierSchema.safeParse(params.runId);
    if (!runId.success) return { found: false };
    const read = queryClient.query(
      workflowRunQueryOptions(apiClient, user.id, workspace.id, runId.data),
    );
    const { found } = await prefetchResource(context, [read]);
    if (!found) return { found };
    const { run } = await read;
    return {
      found,
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
  staticData: { crumb: 'Connections' },
  validateSearch: (search) => parseConnectionsSearch(search),
  loader: ({ context }) => {
    const { apiClient, queryClient, user, workspace } = context;
    if (!workspace.capabilities.includes('connection:read')) return;
    warmPrefetches(context, [
      queryClient.infiniteQuery(
        connectionsInfiniteQueryOptions(apiClient, user.id, workspace.id),
      ),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Connections', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('./connections'), 'ConnectionsRoute'),
});

/** ADR 055: the person's failure notices for this workspace. */
export const inboxRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'inbox',
  staticData: { crumb: 'Inbox' },
  validateSearch: (search) => parseInboxSearch(search),
  loaderDeps: ({ search }) => ({
    filter: search.filter ?? ('all' as const),
    noticeKind: search.noticeKind,
  }),
  loader: ({ context, deps }) => {
    const { apiClient, queryClient, user, workspace } = context;
    if (!workspace.capabilities.includes('workspace:read')) return;
    warmPrefetches(context, [
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
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Inbox', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('./inbox'), 'InboxRoute'),
});

export const teamRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'team',
  staticData: { crumb: 'Team' },
  validateSearch: (search) => parseTeamSearch(search),
  loader: ({ context }) => {
    const { apiClient, queryClient, user, workspace } = context;
    if (!workspace.capabilities.includes('member:read')) return;
    warmPrefetches(context, [
      queryClient.infiniteQuery(
        workspaceMembersInfiniteQueryOptions(apiClient, user.id, workspace.id),
      ),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Team', match.context.workspace.name) }],
  }),
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
  staticData: { crumb: 'Account & security' },
  head: ({ match }) => ({
    meta: [
      { title: pageTitle('Account & security', match.context.workspace.name) },
    ],
  }),
  component: lazyRoute(() => import('./account'), 'WorkspaceAccountRoute'),
});

export const approvalsRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'approvals',
  staticData: { crumb: 'Approvals' },
  validateSearch: (search) => parseTaskSearch(search, 'approval'),
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Approvals', match.context.workspace.name) }],
  }),
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
  staticData: { crumb: 'Requests' },
  validateSearch: (search) => parseTaskSearch(search),
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Requests', match.context.workspace.name) }],
  }),
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
  staticData: { crumb: 'Data tables' },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Data tables', match.context.workspace.name) }],
  }),
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
