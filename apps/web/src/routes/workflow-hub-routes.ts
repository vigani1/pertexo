import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { workflowIdentifierSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { authoringCatalogQueryOptions } from '@/features/catalog/public';
import { connectionDiscoveryQueryOptions } from '@/features/connections/queries.public';
import { failureNotificationDestinationsQueryOptions } from '@/features/failure-notifications/queries.public';
import {
  scheduleTriggersQueryOptions,
  webhookTriggersQueryOptions,
  workflowVersionsQueryOptions,
} from '@/features/workflow-settings/queries.public';
import { workflowDraftQueryOptions } from '@/features/workflow-editor/draft.public';
import { workflowRunsInfiniteQueryOptions } from '@/features/workflow-runs/queries.public';
import { workflowSummaryQueryOptions } from '@/features/workflows/public';
import { isNotFound } from '@/lib/api/api-error-copy';
import { PagePending } from './page-pending';
import { pageTitle } from './page-title';
import { rethrowError, settlePrefetches } from './route-context';
import { workspaceScopeRoute } from './workspace-routes';

/**
 * `/workflows/$workflowId` is an immersive hub (no spine): a floating command
 * bar with Build, Runs, Triggers, Versions and Settings tabs. An invalid ID
 * leaves `workflowId` null and the hub renders "doesn't exist".
 */
export const workflowHubRoute = createRoute({
  getParentRoute: () => workspaceScopeRoute,
  path: 'workflows/$workflowId',
  beforeLoad: ({ params }) => {
    const parsed = workflowIdentifierSchema.safeParse(params.workflowId);
    return { workflowId: parsed.success ? parsed.data : null };
  },
  loader: async ({ context }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null) return;
    await settlePrefetches(context, [
      queryClient.query(
        workflowSummaryQueryOptions(
          apiClient,
          user.id,
          workspace.id,
          workflowId,
        ),
      ),
    ]);
  },
  pendingComponent: PagePending,
  component: lazyRouteComponent(
    () => import('./workflow-hub-route'),
    'WorkflowHubRoute',
  ),
});

export const workflowBuildRoute = createRoute({
  getParentRoute: () => workflowHubRoute,
  path: '/',
  loader: async ({ context }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null) return { found: false as const };
    try {
      await settlePrefetches(
        context,
        [
          queryClient.query(
            workflowDraftQueryOptions(
              apiClient,
              user.id,
              workspace.id,
              workflowId,
            ),
          ),
          queryClient.query(authoringCatalogQueryOptions(apiClient, user.id)),
          queryClient.query(
            connectionDiscoveryQueryOptions(apiClient, user.id, workspace.id),
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
    meta: [{ title: pageTitle('Build', match.context.workspace.name) }],
  }),
  component: lazyRouteComponent(
    () => import('./workflow-build-route'),
    'WorkflowBuildRoute',
  ),
});

export const workflowRunsRoute = createRoute({
  getParentRoute: () => workflowHubRoute,
  path: 'runs',
  loader: async ({ context }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null || !workspace.capabilities.includes('run:read'))
      return;
    await settlePrefetches(context, [
      queryClient.infiniteQuery(
        workflowRunsInfiniteQueryOptions(apiClient, user.id, workspace.id, {
          workflowId,
        }),
      ),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Workflow runs', match.context.workspace.name) }],
  }),
  component: lazyRouteComponent(
    () => import('./workflow-runs-route'),
    'WorkflowRunsRoute',
  ),
});

export const workflowTriggersRoute = createRoute({
  getParentRoute: () => workflowHubRoute,
  path: 'triggers',
  loader: async ({ context }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null) return;
    await settlePrefetches(context, [
      queryClient.query(
        webhookTriggersQueryOptions(
          apiClient,
          user.id,
          workspace.id,
          workflowId,
        ),
      ),
      queryClient.query(
        scheduleTriggersQueryOptions(
          apiClient,
          user.id,
          workspace.id,
          workflowId,
        ),
      ),
      queryClient.query(
        workflowVersionsQueryOptions(
          apiClient,
          user.id,
          workspace.id,
          workflowId,
        ),
      ),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Triggers', match.context.workspace.name) }],
  }),
  component: lazyRouteComponent(
    () => import('./workflow-triggers-route'),
    'WorkflowTriggersRoute',
  ),
});

export const workflowVersionsRoute = createRoute({
  getParentRoute: () => workflowHubRoute,
  path: 'versions',
  loader: async ({ context }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null) return;
    await settlePrefetches(context, [
      queryClient.query(
        workflowVersionsQueryOptions(
          apiClient,
          user.id,
          workspace.id,
          workflowId,
        ),
      ),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Versions', match.context.workspace.name) }],
  }),
  component: lazyRouteComponent(
    () => import('./workflow-versions-route'),
    'WorkflowVersionsRoute',
  ),
});

export const workflowSettingsRoute = createRoute({
  getParentRoute: () => workflowHubRoute,
  path: 'settings',
  loader: async ({ context }) => {
    const { apiClient, queryClient, user, workspace } = context;
    if (!workspace.capabilities.includes('workflow:update')) return;
    await settlePrefetches(context, [
      queryClient.query(
        failureNotificationDestinationsQueryOptions(
          apiClient,
          user.id,
          workspace.id,
        ),
      ),
    ]);
  },
  head: ({ match }) => ({
    meta: [
      { title: pageTitle('Workflow settings', match.context.workspace.name) },
    ],
  }),
  component: lazyRouteComponent(
    () => import('./workflow-settings-route'),
    'WorkflowSettingsRoute',
  ),
});
