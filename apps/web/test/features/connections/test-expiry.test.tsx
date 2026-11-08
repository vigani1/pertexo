import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { afterEach, expect, it, vi } from 'vitest';
import { NotificationsProvider } from '@/components/ui/toast';
import { ConnectionTestPanel } from '@/features/connections/components/connection-test/panel';
import { useConnectionTest } from '@/features/connections/components/connection-test/use-command';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import {
  base,
  connection,
  connectionId,
  userId,
  workspaceId,
} from './page/fixture';

afterEach(() => vi.restoreAllMocks());
it('requires new email consent after an unconfirmed connection test expires', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const keys: (string | null)[] = [];
  mockServer.use(
    http.post(`${base}/${connectionId}/test`, ({ request }) => {
      keys.push(request.headers.get('idempotency-key'));
      return HttpResponse.error();
    }),
  );
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-1234567890',
  });
  function Test() {
    const test = useConnectionTest({ apiClient, userId, workspaceId });
    return (
      <ConnectionTestPanel
        provider="email"
        test={test}
        onRun={(request) => {
          test.run(connection('Email', { providerKey: 'email' }), request);
        }}
      />
    );
  }
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <NotificationsProvider>
        <Test />
      </NotificationsProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const consent = screen.getByRole('checkbox', {
    name: 'Send a real test email',
  });
  await user.click(consent);
  await user.click(screen.getByRole('button', { name: 'Send test email' }));
  const retry = await screen.findByRole('button', { name: 'Test again' });
  await waitFor(() => expect(retry).toBeEnabled());
  now += 86_400_000 - 1;
  await user.click(retry);
  await waitFor(() => {
    expect(keys).toHaveLength(2);
    expect(retry).toBeEnabled();
  });
  expect(keys[1]).toBe(keys[0]);
  now += 1;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const start = await screen.findByRole('button', {
    name: 'Start a new attempt',
  });
  expect(screen.getByText(/24-hour retry window has ended/)).toBeVisible();
  expect(retry).toBeDisabled();
  await user.click(retry);
  expect(keys).toHaveLength(2);
  await user.click(start);
  expect(keys).toHaveLength(2);
  expect(consent).not.toBeChecked();
  await user.click(screen.getByRole('button', { name: 'Send test email' }));
  expect(keys).toHaveLength(2);
  expect(screen.getByText('Tick this to allow the test email.')).toBeVisible();
  await user.click(consent);
  await user.click(screen.getByRole('button', { name: 'Send test email' }));
  await waitFor(() => {
    expect(keys).toHaveLength(3);
  });
  expect(keys[0]).toBeTruthy();
  expect(keys[2]).not.toBe(keys[0]);
  cache.clear();
});
