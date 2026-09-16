import { createRouter, type RouterHistory } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { routeTree } from '../routes/route-tree';

export function createAppRouter(
  queryClient: QueryClient,
  apiClient: ApiClient,
  history?: RouterHistory,
) {
  return createRouter({
    routeTree,
    context: { queryClient, apiClient },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    ...(history ? { history } : {}),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
