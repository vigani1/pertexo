import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { useTestConnectionMutation } from '@/features/connections/connections.mutations';
import {
  connectionDetailQueryOptions,
  connectionKeys,
} from '@/features/connections/connections.queries';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const timestamp = '2026-09-15T10:00:00.000Z';
const connection: ConnectionResponse = {
  id: connectionId,
  workspaceId,
  providerKey: 'slack',
  name: 'Incident Slack',
  authType: 'slack_bot_token',
  status: 'active',
  secretVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  health: {
    lastTestedAt: timestamp,
    lastHealthyAt: timestamp,
    lastErrorCode: null,
  },
  createdAt: timestamp,
  updatedAt: timestamp,
};
const command = {
  connectionId,
  request: { providerKey: 'slack' as const },
  idempotencyKey: 'connection-command-fence',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function wrapper(client: QueryClient) {
  return function QueryOwner({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function tested() {
  return Response.json({
    connection,
    outcome: { ok: true, httpStatus: 200, errorCode: null },
  });
}

describe('connection command response fences', () => {
  it.each(['user', 'workspace'] as const)(
    'a held Test cannot store or invalidate after the same hook changes %s scope',
    async (changed) => {
      const client = new QueryClient();
      const held = deferred<Response>();
      const dispatched = deferred<undefined>();
      const apiClient = createApiClient({
        readCsrfToken: () => 'connection-command-csrf-123456789012345678901234',
        fetch: () => {
          dispatched.resolve(undefined);
          return held.promise;
        },
      });
      const hook = renderHook(
        (scope) => useTestConnectionMutation({ apiClient, ...scope }),
        {
          initialProps: { userId, workspaceId },
          wrapper: wrapper(client),
        },
      );
      let response!: ReturnType<typeof hook.result.current.mutateAsync>;
      act(() => {
        response = hook.result.current.mutateAsync(command);
      });
      await dispatched.promise;
      const nextScope = {
        userId:
          changed === 'user' ? 'ffffffff-ffff-4fff-8fff-ffffffffffff' : userId,
        workspaceId:
          changed === 'workspace'
            ? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
            : workspaceId,
      };
      hook.rerender(nextScope);
      client.clear();
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      const store = vi.spyOn(client, 'setQueryData');
      held.resolve(tested());
      await act(async () => {
        await response;
      });
      expect(store).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      for (const scope of [{ userId, workspaceId }, nextScope])
        expect(
          client.getQueryData(
            connectionKeys.detail(
              scope.userId,
              scope.workspaceId,
              connectionId,
            ),
          ),
        ).toBeUndefined();
      hook.unmount();
      client.clear();
    },
  );
  it('a successful explicit test cancels a held earlier GET before storing recovered health', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const held = deferred<Response>();
    const dispatched = deferred<AbortSignal>();
    const apiClient = createApiClient({
      readCsrfToken: () => 'connection-command-csrf-123456789012345678901234',
      fetch: (input, init) => {
        const path =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (path.endsWith('/test')) return Promise.resolve(tested());
        if (init?.signal == null) throw new Error('Read must be abortable');
        dispatched.resolve(init.signal);
        return held.promise;
      },
    });
    const stale = {
      ...connection,
      status: 'reauthorization_required',
      health: {
        lastTestedAt: null,
        lastHealthyAt: null,
        lastErrorCode: 'connection.slack_token_revoked',
      },
    };
    const key = connectionKeys.detail(userId, workspaceId, connectionId);
    client.setQueryData(key, stale);
    const read = client
      .query({
        ...connectionDetailQueryOptions(
          apiClient,
          userId,
          workspaceId,
          connectionId,
        ),
        staleTime: 0,
      })
      .catch(() => undefined);
    const signal = await dispatched.promise;
    const hook = renderHook(
      () => useTestConnectionMutation({ apiClient, userId, workspaceId }),
      { wrapper: wrapper(client) },
    );
    await act(async () => {
      await hook.result.current.mutateAsync(command);
    });
    expect(signal.aborted).toBe(true);
    held.resolve(Response.json(stale));
    await read;
    expect(client.getQueryData(key)).toEqual(connection);
    hook.unmount();
    client.clear();
  });

  it('a disposed permission/session owner cannot restore cached data from a late test response', async () => {
    const client = new QueryClient();
    const held = deferred<Response>();
    const dispatched = deferred<undefined>();
    const apiClient = createApiClient({
      readCsrfToken: () => 'connection-command-csrf-123456789012345678901234',
      fetch: () => {
        dispatched.resolve(undefined);
        return held.promise;
      },
    });
    const hook = renderHook(
      () => useTestConnectionMutation({ apiClient, userId, workspaceId }),
      { wrapper: wrapper(client) },
    );
    let response!: ReturnType<typeof hook.result.current.mutateAsync>;
    act(() => {
      response = hook.result.current.mutateAsync(command);
    });
    await dispatched.promise;
    hook.unmount();
    client.clear();
    held.resolve(tested());
    await act(async () => {
      await response;
    });
    expect(
      client.getQueryData(
        connectionKeys.detail(userId, workspaceId, connectionId),
      ),
    ).toBeUndefined();
    client.clear();
  });
});
