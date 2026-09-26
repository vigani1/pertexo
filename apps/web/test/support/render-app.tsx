import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { createAppRouter } from '@/app/router';
import { createApiClient } from '@/lib/api/client';
import { NotificationsProvider } from '@/components/ui/toast';

export const testFetch: typeof fetch = (input, init) => {
  const request =
    typeof input === 'string' ? new URL(input, 'http://pertexo.test') : input;
  return globalThis.fetch(request, init);
};

export function renderApp(
  initialPath: string,
  options: Readonly<{ strict?: boolean }> = {},
) {
  const queryClient = createQueryClient();
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  const history = createMemoryHistory({ initialEntries: [initialPath] });
  const router = createAppRouter(queryClient, apiClient, history);
  const app = (
    <QueryClientProvider client={queryClient}>
      <NotificationsProvider>
        <RouterProvider router={router} />
      </NotificationsProvider>
    </QueryClientProvider>
  );
  const result = render(
    options.strict === true ? <StrictMode>{app}</StrictMode> : app,
  );
  return { ...result, apiClient, queryClient, router };
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
