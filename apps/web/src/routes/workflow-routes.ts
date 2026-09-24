import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { workflowIdentifierSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { workflowRunIdentifierSchema } from '@pertexo/contracts/schemas/workflow-runs';
import { authoringCatalogQueryOptions } from '@/features/catalog/public';
import { connectionDiscoveryQueryOptions } from '@/features/connections/queries.public';
import { workflowsInfiniteQueryOptions } from '@/features/workflows/queries.public';
import { workflowDraftQueryOptions } from '@/features/workflow-editor/draft.public';
import {
  runHistorySearchSchema,
  workflowRunQueryOptions,
  workflowRunsInfiniteQueryOptions,
} from '@/features/workflow-runs/queries.public';
import { rootRoute } from './root-route';
import {
  loadCurrentUser,
  loadWorkspace,
  redirectWhenAnyUnauthenticated,
  redirectWhenUnauthenticated,
  rethrowError,
} from './route-loaders';

export const workflowListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/workflows',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace !== null) {
      const discoveries = await Promise.allSettled([
        context.queryClient.infiniteQuery(
          workflowsInfiniteQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
          ),
        ),
        context.queryClient.query(
          authoringCatalogQueryOptions(context.apiClient, user.id),
        ),
        context.queryClient.query(
          connectionDiscoveryQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
          ),
        ),
      ]);
      await redirectWhenAnyUnauthenticated(context, discoveries);
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./workflow-list-route'),
    'WorkflowListRoute',
  ),
});

export const workflowEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/workflows/$workflowId',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const parsedWorkflowId = workflowIdentifierSchema.safeParse(
      params.workflowId,
    );
    if (!parsedWorkflowId.success) return { user, workspace: null };
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace !== null) {
      try {
        await Promise.all([
          context.queryClient.query(
            workflowDraftQueryOptions(
              context.apiClient,
              user.id,
              workspace.id,
              parsedWorkflowId.data,
            ),
          ),
          context.queryClient.query(
            authoringCatalogQueryOptions(context.apiClient, user.id),
          ),
          context.queryClient.query(
            connectionDiscoveryQueryOptions(
              context.apiClient,
              user.id,
              workspace.id,
            ),
          ),
        ]);
      } catch (error) {
        await redirectWhenUnauthenticated(context, error);
        rethrowError(error);
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./workflow-editor-route'),
    'WorkflowEditorRoute',
  ),
});

export const workflowSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/workflows/$workflowId/settings',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const parsedWorkflowId = workflowIdentifierSchema.safeParse(
      params.workflowId,
    );
    if (!parsedWorkflowId.success) return { user, workspace: null };
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./workflow-settings-route'),
    'WorkflowSettingsRoute',
  ),
});

export const runHistoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/runs',
  validateSearch: (search) => runHistorySearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, params, deps }) => {
    const user = await loadCurrentUser(context);
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace?.capabilities.includes('run:read') === true) {
      try {
        await context.queryClient.infiniteQuery(
          workflowRunsInfiniteQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
            deps,
          ),
        );
      } catch (error) {
        await redirectWhenUnauthenticated(context, error);
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./run-history-route'),
    'RunHistoryRoute',
  ),
});

export const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/runs/$runId',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const parsedRunId = workflowRunIdentifierSchema.safeParse(params.runId);
    if (!parsedRunId.success) return { user, workspace: null };
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace !== null) {
      try {
        await context.queryClient.query(
          workflowRunQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
            parsedRunId.data,
          ),
        );
      } catch (error) {
        await redirectWhenUnauthenticated(context, error);
        rethrowError(error);
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./run-detail-route'),
    'RunDetailRoute',
  ),
});
