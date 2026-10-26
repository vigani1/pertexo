import { createRoute } from '@tanstack/react-router';
import { lazyRoute } from '@/components/patterns/app-update/lazy';

import { pageTitle } from '../../root/page-title';
import { warmPrefetches } from '../../root/route-context';
import { workspaceShellRoute } from '../routes';

export const homeRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  path: '/',
  staticData: { crumb: 'Home' },
  // Every block warms its read without holding the page: the Loom may page
  // through 300 runs, and each block shows its own skeleton and retries on
  // mount if its warm-up read failed.
  loader: async ({ context }) => {
    const [
      { connectionDiscoveryQueryOptions },
      { failureNotificationDestinationsQueryOptions },
      {
        anyRunQueryOptions,
        attentionRunsQueryOptions,
        loomStatisticsQueryOptions,
        runLoomQueryOptions,
        runStatisticsQueryOptions,
      },
      { recentWorkflowsQueryOptions, workflowsInfiniteQueryOptions },
    ] = await Promise.all([
      import('@/features/connections/queries.public'),
      import('@/features/failure-notifications/queries.public'),
      import('@/features/workflow-runs/queries.public'),
      import('@/features/workflows/queries.public'),
    ]);

    const { apiClient, queryClient, user, workspace } = context;
    const can = (capability: (typeof workspace.capabilities)[number]) =>
      workspace.capabilities.includes(capability);
    warmPrefetches(context, [
      ...(can('run:read')
        ? [
            queryClient.query(
              runStatisticsQueryOptions(apiClient, user.id, workspace.id),
            ),
            queryClient.query(
              attentionRunsQueryOptions(apiClient, user.id, workspace.id),
            ),
            queryClient.query(
              anyRunQueryOptions(apiClient, user.id, workspace.id),
            ),
            queryClient.query(
              runLoomQueryOptions(apiClient, user.id, workspace.id, 3_600_000),
            ),
            queryClient.query(
              loomStatisticsQueryOptions(
                apiClient,
                user.id,
                workspace.id,
                '1h',
              ),
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
      ...(can('connection:read')
        ? [
            queryClient.query(
              connectionDiscoveryQueryOptions(apiClient, user.id, workspace.id),
            ),
          ]
        : []),
      ...(can('workflow:update')
        ? [
            queryClient.query(
              failureNotificationDestinationsQueryOptions(
                apiClient,
                user.id,
                workspace.id,
              ),
            ),
          ]
        : []),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle(match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('./page'), 'HomeRoute'),
});
