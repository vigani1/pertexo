import {
  createRoute,
  lazyRouteComponent,
  notFound,
} from '@tanstack/react-router';
import {
  workspaceLifecycleOperationIdentifierSchema,
  type AccessibleWorkspace,
} from '@pertexo/contracts/schemas/identity-workspace';
import { workflowRunIdentifierSchema } from '@pertexo/contracts/schemas/workflow-runs';
import { authoringCatalogQueryOptions } from '@/features/catalog/public';
import {
  connectionDiscoveryQueryOptions,
  connectionsInfiniteQueryOptions,
  parseConnectionsSearch,
} from '@/features/connections/queries.public';
import { failureNotificationDestinationsQueryOptions } from '@/features/failure-notifications/queries.public';
import {
  anyRunQueryOptions,
  attentionRunsQueryOptions,
  filtersFromSearch,
  runLoomQueryOptions,
  runStatusCountsQueryOptions,
  sanitizeRunSearch,
  workflowRunQueryOptions,
  workflowRunsInfiniteQueryOptions,
} from '@/features/workflow-runs/queries.public';
import {
  WORKFLOW_ORDER_BY_SORT,
  parseWorkflowListSearch,
} from '@/features/workflows/list-search.public';
import {
  recentWorkflowsQueryOptions,
  workflowsInfiniteQueryOptions,
} from '@/features/workflows/queries.public';
import { workspaceLifecycleOperationQueryOptions } from '@/features/workspaces/lifecycle.queries.public';
import {
  parseTeamSearch,
  workspaceMembersInfiniteQueryOptions,
} from '@/features/workspaces/members.queries.public';
import { isNotFound } from '@/lib/api/api-error-copy';
import { PagePending } from './page-pending';
import { pageTitle } from './page-title';
import {
  findWorkspace,
  loadCurrentUser,
  rethrowError,
  settlePrefetches,
} from './route-context';
import { rootRoute } from './root-route';

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
  beforeLoad: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const workspace = await findWorkspace(context, user.id, params.workspaceId);
    assertWorkspaceOpenable(workspace);
    return { user, workspace };
  },
});

/** Pathless layout: the spine, breadcrumb and banners around each page. */
export const workspaceShellRoute = createRoute({
  getParentRoute: () => workspaceScopeRoute,
  id: 'shell',
  pendingComponent: PagePending,
  component: lazyRouteComponent(
    () => import('./workspace-shell-route'),
    'WorkspaceShellRoute',
  ),
});

export const homeRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: '/',
  staticData: { crumb: 'Home' },
  loader: async ({ context }) => {
    const { apiClient, queryClient, user, workspace } = context;
    const can = (capability: (typeof workspace.capabilities)[number]) =>
      workspace.capabilities.includes(capability);
    // Warm the slower or secondary reads without holding the page: the Loom
    // may page through 300 runs, and each block shows its own skeleton and
    // retries on mount if its warm-up read failed.
    const warm = (read: Promise<unknown>) => {
      read.catch(() => undefined);
    };
    if (can('run:read'))
      warm(
        queryClient.query(
          runLoomQueryOptions(apiClient, user.id, workspace.id, 3_600_000),
        ),
      );
    if (can('connection:read'))
      warm(
        queryClient.query(
          connectionDiscoveryQueryOptions(apiClient, user.id, workspace.id),
        ),
      );
    if (can('workflow:update'))
      warm(
        queryClient.query(
          failureNotificationDestinationsQueryOptions(
            apiClient,
            user.id,
            workspace.id,
          ),
        ),
      );
    await settlePrefetches(context, [
      ...(can('run:read')
        ? [
            queryClient.query(
              runStatusCountsQueryOptions(apiClient, user.id, workspace.id),
            ),
            queryClient.query(
              attentionRunsQueryOptions(apiClient, user.id, workspace.id),
            ),
            queryClient.query(
              anyRunQueryOptions(apiClient, user.id, workspace.id),
            ),
          ]
        : []),
      ...(can('workflow:read')
        ? [
            queryClient.query(
              recentWorkflowsQueryOptions(apiClient, user.id, workspace.id),
            ),
            queryClient.infiniteQuery(
              workflowsInfiniteQueryOptions(apiClient, user.id, workspace.id),
            ),
          ]
        : []),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle(match.context.workspace.name) }],
  }),
  component: lazyRouteComponent(() => import('./home-route'), 'HomeRoute'),
});

export const workflowsRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'workflows',
  staticData: { crumb: 'Workflows' },
  // `create` opens the New workflow lens; `view` and `sort` keep the list's
  // filters shareable. Unknown values fall back to the defaults.
  validateSearch: (search) => parseWorkflowListSearch(search),
  loaderDeps: ({ search }) => ({ sort: search.sort }),
  loader: async ({ context, deps }) => {
    const { apiClient, queryClient, user, workspace } = context;
    await settlePrefetches(context, [
      queryClient.infiniteQuery(
        workflowsInfiniteQueryOptions(
          apiClient,
          user.id,
          workspace.id,
          WORKFLOW_ORDER_BY_SORT[deps.sort ?? 'updated'],
        ),
      ),
      queryClient.query(authoringCatalogQueryOptions(apiClient, user.id)),
      queryClient.query(
        connectionDiscoveryQueryOptions(apiClient, user.id, workspace.id),
      ),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Workflows', match.context.workspace.name) }],
  }),
  component: lazyRouteComponent(
    () => import('./workflow-list-route'),
    'WorkflowListRoute',
  ),
});

export const runsRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'runs',
  staticData: { crumb: 'Runs' },
  // Unknown or malformed keys are dropped, never thrown: a bad link still
  // opens the Runs page.
  validateSearch: (search) => sanitizeRunSearch(search),
  loaderDeps: ({ search }) => filtersFromSearch(search),
  loader: async ({ context, deps }) => {
    const { apiClient, queryClient, user, workspace } = context;
    if (!workspace.capabilities.includes('run:read')) return;
    await settlePrefetches(context, [
      queryClient.infiniteQuery(
        workflowRunsInfiniteQueryOptions(
          apiClient,
          user.id,
          workspace.id,
          deps,
        ),
      ),
      queryClient.query(
        runStatusCountsQueryOptions(apiClient, user.id, workspace.id),
      ),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Runs', match.context.workspace.name) }],
  }),
  component: lazyRouteComponent(
    () => import('./run-history-route'),
    'RunHistoryRoute',
  ),
});

export const runDetailRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'runs/$runId',
  staticData: { crumb: 'Run' },
  loader: async ({ context, params }) => {
    const { apiClient, queryClient, user, workspace } = context;
    const runId = workflowRunIdentifierSchema.safeParse(params.runId);
    if (!runId.success) return { found: false as const };
    try {
      await settlePrefetches(
        context,
        [
          queryClient.query(
            workflowRunQueryOptions(
              apiClient,
              user.id,
              workspace.id,
              runId.data,
            ),
          ),
        ],
        'strict',
      );
    } catch (error) {
      if (isNotFound(error)) return { found: false as const };
      rethrowError(error);
    }
    return { found: true as const };
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Run', match.context.workspace.name) }],
  }),
  component: lazyRouteComponent(
    () => import('./run-detail-route'),
    'RunDetailRoute',
  ),
});

export const connectionsRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'connections',
  staticData: { crumb: 'Connections' },
  validateSearch: (search) => parseConnectionsSearch(search),
  loader: async ({ context }) => {
    const { apiClient, queryClient, user, workspace } = context;
    if (!workspace.capabilities.includes('connection:read')) return;
    await settlePrefetches(context, [
      queryClient.infiniteQuery(
        connectionsInfiniteQueryOptions(apiClient, user.id, workspace.id),
      ),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Connections', match.context.workspace.name) }],
  }),
  component: lazyRouteComponent(
    () => import('./connections-route'),
    'ConnectionsRoute',
  ),
});

export const teamRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'team',
  staticData: { crumb: 'Team' },
  validateSearch: (search) => parseTeamSearch(search),
  loader: async ({ context }) => {
    const { apiClient, queryClient, user, workspace } = context;
    if (!workspace.capabilities.includes('member:read')) return;
    await settlePrefetches(context, [
      queryClient.infiniteQuery(
        workspaceMembersInfiniteQueryOptions(apiClient, user.id, workspace.id),
      ),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Team', match.context.workspace.name) }],
  }),
  component: lazyRouteComponent(() => import('./team-route'), 'TeamRoute'),
});

export const alertsRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'alerts',
  staticData: { crumb: 'Alerts' },
  loader: async ({ context }) => {
    const { apiClient, queryClient, user, workspace } = context;
    const can = (capability: (typeof workspace.capabilities)[number]) =>
      workspace.capabilities.includes(capability);
    if (!can('workflow:update')) return;
    await settlePrefetches(context, [
      queryClient.query(
        failureNotificationDestinationsQueryOptions(
          apiClient,
          user.id,
          workspace.id,
        ),
      ),
      ...(can('connection:manage') && can('connection:read')
        ? [
            queryClient.query(
              connectionDiscoveryQueryOptions(apiClient, user.id, workspace.id),
            ),
          ]
        : []),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Alerts', match.context.workspace.name) }],
  }),
  component: lazyRouteComponent(() => import('./alerts-route'), 'AlertsRoute'),
});

export const workspaceSettingsRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: 'settings',
  staticData: { crumb: 'Settings' },
  validateSearch: (search) => {
    const parsed = workspaceLifecycleOperationIdentifierSchema.safeParse(
      Reflect.get(search, 'operationId'),
    );
    return parsed.success ? { operationId: parsed.data } : {};
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    const { apiClient, queryClient, user, workspace } = context;
    if (
      !workspace.capabilities.includes('workspace:manage') ||
      deps.operationId === undefined
    )
      return;
    await settlePrefetches(context, [
      queryClient.query(
        workspaceLifecycleOperationQueryOptions(
          apiClient,
          user.id,
          workspace.id,
          deps.operationId,
        ),
      ),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Settings', match.context.workspace.name) }],
  }),
  component: lazyRouteComponent(
    () => import('./workspace-settings-route'),
    'WorkspaceSettingsRoute',
  ),
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
  component: lazyRouteComponent(
    () => import('./workspace-account-route'),
    'WorkspaceAccountRoute',
  ),
});
