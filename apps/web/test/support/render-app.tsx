import { synchronizeApplicationSession } from '@/app/session-sync';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { createAppRouter } from '@/app/router';
import { workflowBuildRoute } from '@/routes/workflow/hub/routes';
import { createApiClient } from '@/lib/api/client';
import { NotificationsProvider } from '@/components/ui/toast';

export const testFetch: typeof fetch = (input, init) => {
  const request =
    typeof input === 'string' ? new URL(input, 'http://pertexo.test') : input;
  return globalThis.fetch(request, init);
};

const sessionOwners = new Set<() => void>();
const clients = new Set<ReturnType<typeof createQueryClient>>();
const routers = new Set<ReturnType<typeof createAppRouter>>();

afterEach(async () => {
  // A navigation still loading when the test ends keeps its pending-UI
  // timer and its commit. Both hand matches to React through
  // `startTransition`, which the mounted Transitioner binds to a state
  // update; run after the environment closes, that update finds no
  // `window`. Unbind it before unmounting, so whatever the router finishes
  // later stays inside the router.
  for (const router of routers)
    router.startTransition = (commit) => {
      commit();
      return Promise.resolve(false);
    };
  routers.clear();
  cleanup();
  for (const stop of sessionOwners) stop();
  sessionOwners.clear();
  await Promise.all([...clients].map((client) => client.cancelQueries()));
  for (const client of clients) client.clear();
  clients.clear();
});

function prepareApp(initialPath: string) {
  const queryClient = createQueryClient();
  clients.add(queryClient);
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  const history = createMemoryHistory({ initialEntries: [initialPath] });
  const router = createAppRouter(queryClient, apiClient, history);
  routers.add(router);
  sessionOwners.add(synchronizeApplicationSession(queryClient, router));
  const app = (
    <QueryClientProvider client={queryClient}>
      <NotificationsProvider>
        <RouterProvider router={router} />
      </NotificationsProvider>
    </QueryClientProvider>
  );
  return {
    apiClient,
    queryClient,
    router,
    mount: (strict: boolean) =>
      render(strict ? <StrictMode>{app}</StrictMode> : app),
  };
}

export function renderApp(
  initialPath: string,
  options: Readonly<{ strict?: boolean }> = {},
) {
  const { mount, ...dependencies } = prepareApp(initialPath);
  return { ...mount(options.strict === true), ...dependencies };
}

/**
 * The app has landed on the sign-in page. Its loading, unavailable and form
 * panels share one title, and the loading one is swapped out as the page
 * settles, so the heading is found and checked in one pass, never across a
 * swap.
 */
export async function expectSignInPage() {
  await waitFor(() => {
    expect(
      screen.getByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
  });
}

/** Loads route guards, data and the lazy page before assertions start. */
export async function renderLoadedApp(
  initialPath: string,
  options: Readonly<{ strict?: boolean }> = {},
) {
  const { mount, ...dependencies } = prepareApp(initialPath);
  await dependencies.router.load();
  if (
    dependencies.router.state.matches.some(
      (match) => match.routeId === workflowBuildRoute.id,
    )
  )
    await import('@/features/workflow-editor/components/inspector/node');
  return { ...mount(options.strict === true), ...dependencies };
}
