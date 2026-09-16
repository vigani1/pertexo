import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { createQueryClient } from '@/app/query-client';
import { createAppRouter } from '@/app/router';
import { createApiClient } from '@/lib/api/client';

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
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  const result = render(
    options.strict === true ? <StrictMode>{app}</StrictMode> : app,
  );
  return { ...result, apiClient, queryClient, router };
}
