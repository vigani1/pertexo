import { render, screen, waitFor } from '@testing-library/react';
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import {
  connectionResponseSchema,
  failureNotificationDestinationResponseSchema,
} from '@pertexo/contracts';
import { createApiClient } from '@/lib/api/client';
import { NotificationsProvider } from '@/components/ui/toast';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { NewWorkflowSheet } from '@/features/workflows/components/creation/new-workflow-sheet';
import { ReplaceCredentialForm } from '@/features/connections/components/detail/replace-credential-form';
import { AddConnectionSheet } from '@/features/connections/components/add-connection/sheet';
import { DestinationForm } from '@/features/failure-notifications/components/destination-form';
import {
  connection,
  destination,
  workspaceId,
} from './failure-notifications/destinations/fixture';

afterEach(() => {
  vi.restoreAllMocks();
});
it.each(['workflow', 'credential', 'destination', 'connection'] as const)(
  'keeps the %s form retry exact until expiry and requires a new-attempt decision',
  async (kind) => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const keys: (string | null)[] = [];
    const apiClient = createApiClient({
      readCsrfToken: () => 'csrf-token-1234567890',
      fetch: (_url, init) => {
        keys.push(new Headers(init?.headers).get('idempotency-key'));
        return Promise.reject(new TypeError('Acceptance response lost'));
      },
    });
    const scope = {
      apiClient,
      workspaceId,
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    const cache = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    let view;
    if (kind === 'workflow')
      view = (
        <NewWorkflowSheet
          {...scope}
          open
          onOpenChange={() => undefined}
          onCreated={() => undefined}
        />
      );
    else if (kind === 'credential')
      view = (
        <ReplaceCredentialForm
          scope={scope}
          connection={connectionResponseSchema.parse(connection)}
          onDone={() => undefined}
        />
      );
    else if (kind === 'connection')
      view = (
        <AddConnectionSheet
          scope={scope}
          workspaceName="Incident"
          request="slack"
          onClose={() => undefined}
        />
      );
    else
      view = (
        <Sheet open>
          <SheetContent>
            <DestinationForm
              scope={scope}
              destination={failureNotificationDestinationResponseSchema.parse(
                destination(),
              )}
              connections={[connectionResponseSchema.parse(connection)]}
              channelNames={new Map()}
              listRefresh={{
                failed: false,
                pending: false,
                updatedAt: now,
                reload: () => Promise.resolve([]),
              }}
              onDone={() => undefined}
              onCancel={() => undefined}
            />
          </SheetContent>
        </Sheet>
      );
    const routeTree = createRootRoute({
      component: () => (
        <QueryClientProvider client={cache}>
          <NotificationsProvider>{view}</NotificationsProvider>
        </QueryClientProvider>
      ),
    });
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    if (kind === 'workflow')
      await user.type(
        await screen.findByLabelText('Workflow name'),
        'Retained workflow',
      );
    if (kind === 'credential' || kind === 'connection') {
      await user.type(
        await screen.findByLabelText('Slack bot token'),
        'xoxb-test-secret',
      );
      if (kind === 'connection')
        await user.click(screen.getByRole('button', { name: 'Continue' }));
    }
    const submitLabel = {
      workflow: 'Create workflow',
      credential: 'Replace credential',
      destination: 'Save changes',
      connection: 'Save and test',
    }[kind];
    await user.click(await screen.findByRole('button', { name: submitLabel }));
    const retryLabel = kind === 'workflow' ? 'Retry safely' : 'Try again';
    const retry = await screen.findByRole('button', {
      name: retryLabel,
    });
    await waitFor(() => {
      expect(keys).toHaveLength(1);
    });
    now += 86_400_000 - 1;
    await user.click(retry);
    await waitFor(() => {
      expect(keys).toHaveLength(2);
    });
    await waitFor(() => {
      expect(retry).toBeEnabled();
    });
    expect(keys[1]).toBe(keys[0]);
    now += 1;
    await user.click(retry);
    expect(keys).toHaveLength(2);
    expect(
      await screen.findByText(/retry window.*ended|retry.*expired/i),
    ).toBeVisible();
    now += 1;
    await user.click(retry);
    expect(keys).toHaveLength(2);
    await user.click(
      screen.getByRole('button', { name: 'Start a new attempt' }),
    );
    expect(keys).toHaveLength(2);
    await user.click(await screen.findByRole('button', { name: submitLabel }));
    await waitFor(() => {
      expect(keys).toHaveLength(3);
    });
    expect(keys[2]).toBeTruthy();
    expect(keys[2]).not.toBe(keys[0]);
    cache.clear();
  },
);
