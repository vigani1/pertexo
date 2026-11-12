import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import { createApiClient } from '@/lib/api/client';
import { NotificationsProvider } from '@/components/ui/toast';
import { useNodeTest } from '@/features/workflow-testing/components/node-preview/use-test';
import { useConnectionTest } from '@/features/connections/components/connection-test/use-command';
import { useDestinationTest } from '@/features/failure-notifications/hooks/use-destination-test';
import {
  connection,
  destination,
  workspaceId,
} from './failure-notifications/destinations/fixture';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
afterEach(() => vi.restoreAllMocks());

it.each(['node', 'connection', 'destination'] as const)(
  'never turns an expired %s retry into a new request',
  async (kind) => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const keys: (string | null)[] = [];
    const apiClient = createApiClient({
      readCsrfToken: () => 'csrf-token-1234567890',
      fetch: (_url, init) => {
        keys.push(new Headers(init?.headers).get('idempotency-key'));
        if (kind === 'destination')
          return Promise.resolve(
            new Response(
              JSON.stringify({
                connection,
                outcome: {
                  ok: false,
                  httpStatus: null,
                  errorCode: 'connection.test.network_failed',
                },
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        return Promise.reject(new TypeError('Acceptance response lost'));
      },
    });
    const scope = { apiClient, userId, workspaceId };
    function useNode() {
      const test = useNodeTest({
        apiClient,
        workspaceId,
        workflowId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        nodeId: 'send',
        expectedSampleId: null,
        checkContext: 'send',
        ensureSaved: () => Promise.resolve({ revision: 1 }),
      });
      return {
        run: () => test.runTest({ text: '{}' }),
        uncertain: test.recoveryPending,
      };
    }
    function useConnection() {
      const test = useConnectionTest(scope);
      return {
        run: () => {
          test.run(connection, { providerKey: 'slack' });
        },
        uncertain: test.phase === 'unsure',
      };
    }
    function useDestination() {
      const test = useDestinationTest(scope, {
        ...destination(),
        kind: 'slack',
        config: {
          kind: 'slack',
          connectionId: connection.id,
          channelId: 'C0123456789',
        },
      });
      return { run: test.run, uncertain: test.phase === 'unsure' };
    }
    const useCaller = {
      node: useNode,
      connection: useConnection,
      destination: useDestination,
    }[kind];
    const cache = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={cache}>
        <NotificationsProvider>{children}</NotificationsProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(useCaller, { wrapper });
    await act(async () => {
      result.current.run();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.uncertain).toBe(true);
    });
    now += 86_400_000 - 1;
    await act(async () => {
      result.current.run();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(keys).toHaveLength(2);
    });
    expect(keys[1]).toBe(keys[0]);
    now += 1;
    await act(async () => {
      result.current.run();
      await Promise.resolve();
    });
    expect(keys).toHaveLength(2);
    now += 1;
    await act(async () => {
      result.current.run();
      await Promise.resolve();
    });
    expect(keys).toHaveLength(2);
    cache.clear();
  },
);
