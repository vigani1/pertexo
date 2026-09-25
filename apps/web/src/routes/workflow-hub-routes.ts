import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { workflowIdentifierSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { failureNotificationDestinationsQueryOptions } from '@/features/failure-notifications/queries.public';
import {
  scheduleTriggersQueryOptions,
  webhookTriggersQueryOptions,
  workflowVersionsQueryOptions,
} from '@/features/workflow-settings/queries.public';
import { workflowDraftQueryOptions } from '@/features/workflow-editor/draft.public';
import {
  filtersFromSearch,
  sanitizeWorkflowRunSearch,
  workflowRunsInfiniteQueryOptions,
} from '@/features/workflow-runs/queries.public';
import { workflowSummaryQueryOptions } from '@/features/workflows/queries.public';
import { WorkflowHubPending } from './page-pending';
import { pageTitle } from './page-title';
import {
  authoringPrefetches,
  prefetchResource,
  probeResource,
  warmPrefetches,
} from './route-context';
import { workspaceScopeRoute } from './workspace-routes';

/**
 * `/workflows/$workflowId` is an immersive hub (no spine): a floating command
 * bar with Build, Runs, Triggers, Versions and Settings tabs. An invalid ID
 * leaves `workflowId` null and the hub renders "doesn't exist".
 */
export const workflowHubRoute = createRoute({
  getParentRoute: () => workspaceScopeRoute,
  path: 'workflows/$workflowId',
  pendingComponent: WorkflowHubPending,
  beforeLoad: ({ params }) => {
    const parsed = workflowIdentifierSchema.safeParse(params.workflowId);
    return { workflowId: parsed.success ? parsed.data : null };
  },
  // The summary decides whether the workflow exists; a missing one renders
  // inside the workspace shell instead of the hub.
  loader: ({ context }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null) return { found: false };
    return probeResource(
      context,
      queryClient.query(
        workflowSummaryQueryOptions(
          apiClient,
          user.id,
          workspace.id,
          workflowId,
        ),
      ),
    );
  },
  component: lazyRouteComponent(
    () => import('./workflow-hub-route'),
    'WorkflowHubRoute',
  ),
});

export const workflowBuildRoute = createRoute({
  getParentRoute: () => workflowHubRoute,
  pendingComponent: WorkflowHubPending,
  path: '/',
  loader: ({ context }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null) return { found: false };
    return prefetchResource(context, [
      queryClient.query(
        workflowDraftQueryOptions(apiClient, user.id, workspace.id, workflowId),
      ),
      ...authoringPrefetches(context, user.id, workspace.id),
    ]);
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
  pendingComponent: WorkflowHubPending,
  path: 'runs',
  validateSearch: (search) => sanitizeWorkflowRunSearch(search),
  loaderDeps: ({ search }) => filtersFromSearch(search),
  loader: ({ context, deps }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null || !workspace.capabilities.includes('run:read'))
      return;
    warmPrefetches(context, [
      queryClient.infiniteQuery(
        workflowRunsInfiniteQueryOptions(apiClient, user.id, workspace.id, {
          ...deps,
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
  pendingComponent: WorkflowHubPending,
  path: 'triggers',
  loader: ({ context }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null) return;
    warmPrefetches(context, [
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
  pendingComponent: WorkflowHubPending,
  path: 'versions',
  loader: ({ context }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null) return;
    warmPrefetches(context, [
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
  pendingComponent: WorkflowHubPending,
  path: 'settings',
  loader: ({ context }) => {
    const { apiClient, queryClient, user, workspace } = context;
    if (!workspace.capabilities.includes('workflow:update')) return;
    warmPrefetches(context, [
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
