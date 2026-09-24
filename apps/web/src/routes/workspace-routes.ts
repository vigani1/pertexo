import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { workspaceLifecycleOperationIdentifierSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { workspaceMembersInfiniteQueryOptions } from '@/features/workspaces/members.queries.public';
import { workspaceLifecycleOperationQueryOptions } from '@/features/workspaces/lifecycle.queries.public';
import {
  connectionDiscoveryQueryOptions,
  connectionsInfiniteQueryOptions,
} from '@/features/connections/queries.public';
import { failureNotificationDestinationsQueryOptions } from '@/features/failure-notifications/queries.public';
import { recentWorkflowsQueryOptions } from '@/features/workflows/queries.public';
import { recentWorkflowRunsQueryOptions } from '@/features/workflow-runs/queries.public';
import { rootRoute } from './root-route';
import {
  loadCurrentUser,
  loadWorkspace,
  loadWorkspaces,
  redirectWhenAnyUnauthenticated,
  redirectWhenUnauthenticated,
} from './route-loaders';

export const workspacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces',
  loader: async ({ context }) => {
    const user = await loadCurrentUser(context);
    const workspaces = await loadWorkspaces(context, user.id);
    return { user, workspaces };
  },
  component: lazyRouteComponent(
    () => import('./workspace-selection-route'),
    'WorkspaceSelectionRoute',
  ),
});

export const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/overview',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace !== null) {
      const reads: Promise<unknown>[] = [];
      if (workspace.capabilities.includes('workflow:read'))
        reads.push(
          context.queryClient.query(
            recentWorkflowsQueryOptions(
              context.apiClient,
              user.id,
              workspace.id,
            ),
          ),
        );
      if (workspace.capabilities.includes('run:read'))
        reads.push(
          context.queryClient.query(
            recentWorkflowRunsQueryOptions(
              context.apiClient,
              user.id,
              workspace.id,
              'all',
            ),
          ),
          context.queryClient.query(
            recentWorkflowRunsQueryOptions(
              context.apiClient,
              user.id,
              workspace.id,
              'failed',
            ),
          ),
        );
      const results = await Promise.allSettled(reads);
      await redirectWhenAnyUnauthenticated(context, results);
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./overview-route'),
    'OverviewRoute',
  ),
});

export const connectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/connections',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace?.capabilities.includes('connection:read') === true) {
      try {
        await context.queryClient.infiniteQuery(
          connectionsInfiniteQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
          ),
        );
      } catch (error) {
        await redirectWhenUnauthenticated(context, error);
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./connections-route'),
    'ConnectionsRoute',
  ),
});

export const workspaceMembersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/settings/members',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace?.capabilities.includes('member:read') === true) {
      try {
        await context.queryClient.infiniteQuery(
          workspaceMembersInfiniteQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
          ),
        );
      } catch (error) {
        await redirectWhenUnauthenticated(context, error);
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./workspace-members-route'),
    'WorkspaceMembersRoute',
  ),
});

export const workspaceGeneralRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/settings/general',
  validateSearch: (search) => {
    const parsed = workspaceLifecycleOperationIdentifierSchema.safeParse(
      Reflect.get(search, 'operationId'),
    );
    return parsed.success ? { operationId: parsed.data } : {};
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ context, params, deps }) => {
    const user = await loadCurrentUser(context);
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (
      workspace?.capabilities.includes('workspace:manage') === true &&
      deps.operationId !== undefined
    ) {
      try {
        await context.queryClient.query(
          workspaceLifecycleOperationQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
            deps.operationId,
          ),
        );
      } catch (error) {
        await redirectWhenUnauthenticated(context, error);
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./workspace-general-route'),
    'WorkspaceGeneralRoute',
  ),
});

export const workspaceNotificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/settings/notifications',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace?.capabilities.includes('workflow:update') === true) {
      const reads: Promise<unknown>[] = [
        context.queryClient.query(
          failureNotificationDestinationsQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
          ),
        ),
      ];
      if (
        workspace.capabilities.includes('connection:manage') &&
        workspace.capabilities.includes('connection:read')
      )
        reads.push(
          context.queryClient.query(
            connectionDiscoveryQueryOptions(
              context.apiClient,
              user.id,
              workspace.id,
            ),
          ),
        );
      try {
        await Promise.all(reads);
      } catch (error) {
        await redirectWhenUnauthenticated(context, error);
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./workspace-notifications-route'),
    'WorkspaceNotificationsRoute',
  ),
});
