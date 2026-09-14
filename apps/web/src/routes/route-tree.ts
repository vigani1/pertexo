import {
  createRootRouteWithContext,
  createRoute,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { FoundationPage } from './foundation-page';
import { RootLayout, RouteError, NotFoundPage } from './root-layout';

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
  errorComponent: RouteError,
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: FoundationPage,
});

export const routeTree = rootRoute.addChildren([indexRoute]);
