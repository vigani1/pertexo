import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createQueryClient } from '@/app/query-client';
import { NotificationsProvider } from '@/components/ui/toast';

/**
 * Renders one component inside a minimal router, a fresh query client and
 * the notification provider, for pages whose links and toasts need them.
 */
export function renderInRouter(ui: ReactNode) {
  const queryClient = createQueryClient();
  const rootRoute = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <NotificationsProvider>
        <RouterProvider router={router} />
      </NotificationsProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient, router };
}
