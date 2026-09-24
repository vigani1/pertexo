import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext } from '@tanstack/react-router';
import type { ApiClient } from '@/lib/api/client';
import {
  NotFoundPage,
  PendingPage,
  RootLayout,
  RouteError,
} from './root-layout';

export type RouterContext = Readonly<{
  queryClient: QueryClient;
  apiClient: ApiClient;
}>;

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: RouteError,
  pendingComponent: PendingPage,
  notFoundComponent: NotFoundPage,
});
