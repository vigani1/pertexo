import { createRootRouteWithContext } from '@tanstack/react-router';
import { RootLayout } from './layout';
import type { RouterContext } from './route-context';
import { RootNotFound } from './not-found';
import { BootPage, RouteError } from './system-pages';

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: RouteError,
  pendingComponent: BootPage,
  notFoundComponent: RootNotFound,
  head: () => ({ meta: [{ title: 'Pertexo' }] }),
});
