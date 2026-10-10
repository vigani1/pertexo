import { createRootRouteWithContext } from '@tanstack/react-router';
import { RootLayout } from './layout';
import type { RouterContext } from './route-context';
import { RootNotFound } from './status/not-found';
import { BootPage, RouteError } from './status/pages';

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: RouteError,
  pendingComponent: BootPage,
  notFoundComponent: RootNotFound,
  head: () => ({ meta: [{ title: 'Pertexo' }] }),
});
