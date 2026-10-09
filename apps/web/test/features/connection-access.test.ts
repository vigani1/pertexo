import { QueryClient } from '@tanstack/react-query';
import type { ConnectionResponse } from '@pertexo/contracts';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import {
  connectionDetailQueryOptions,
  connectionKeys,
  connectionsInfiniteQueryOptions,
  connectionUsageQueryOptions,
} from '@/features/connections/connections.queries';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const connection: ConnectionResponse = {
  id: connectionId,
  workspaceId,
  providerKey: 'slack',
  name: 'Protected Slack',
  authType: 'slack_bot_token',
  status: 'active',
  secretVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
  createdAt: '2026-09-15T10:00:00.000Z',
  updatedAt: '2026-09-15T10:00:00.000Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('connection access fences', () => {
  it('does not resurrect denied data on a subsequent transient failure; a fresh authorized read recovers it', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let status = 403;
    const api = createApiClient({
      readCsrfToken: () => undefined,
      fetch: () =>
        Promise.resolve(
          status === 200
            ? Response.json({ ...connection, name: 'Fresh authorized Slack' })
            : Response.json(
                {
                  type: 'urn:pertexo:problem:resource.not_found',
                  title: 'Unavailable',
                  status,
                  code: 'resource.not_found',
                  requestId: 'connection-access-recovery',
                },
                {
                  status,
                  headers: { 'content-type': 'application/problem+json' },
                },
              ),
        ),
    });
    const options = {
      ...connectionDetailQueryOptions(api, userId, workspaceId, connectionId),
      staleTime: 0,
    };
    client.setQueryData(options.queryKey, connection);
    const unrelated = connectionKeys.detail(
      'other-user',
      workspaceId,
      connectionId,
    );
    client.setQueryData(unrelated, connection);
    await expect(client.query(options)).rejects.toBeDefined();
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    status = 503;
    await expect(client.query(options)).rejects.toBeDefined();
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    expect(client.getQueryData(unrelated)).toEqual(connection);
    status = 200;
    await expect(client.query(options)).resolves.toMatchObject({
      name: 'Fresh authorized Slack',
    });
    expect(client.getQueryData(options.queryKey)).toMatchObject({
      name: 'Fresh authorized Slack',
    });
    client.clear();
  });

  it('preserves the last authorized snapshot on an ordinary transient read failure', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const api = createApiClient({
      readCsrfToken: () => undefined,
      fetch: () => Promise.resolve(new Response(null, { status: 503 })),
    });
    const options = {
      ...connectionDetailQueryOptions(api, userId, workspaceId, connectionId),
      staleTime: 0,
    };
    client.setQueryData(options.queryKey, connection);
    await expect(client.query(options)).rejects.toBeDefined();
    expect(client.getQueryData(options.queryKey)).toEqual(connection);
    client.clear();
  });

  it.each([401, 403, 404, 409])(
    'forgets denied snapshots before a held earlier GET can restore them (%s)',
    async (status) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const held = deferred<Response>();
      const dispatched = deferred<AbortSignal>();
      const api = createApiClient({
        readCsrfToken: () => undefined,
        fetch: async (url, init) => {
          const path =
            typeof url === 'string'
              ? url
              : url instanceof URL
                ? url.href
                : url.url;
          if (path.includes(`/connections/${connectionId}`)) {
            if (init?.signal == null) throw new Error('Read must be abortable');
            dispatched.resolve(init.signal);
            // Deliberately ignore abort: Query must fence even a noncooperative transport.
            return held.promise;
          }
          return Response.json(
            {
              type: 'urn:pertexo:problem:resource.not_found',
              title: 'Unavailable',
              status,
              code: 'resource.not_found',
              requestId: 'connection-access-test',
            },
            { status, headers: { 'content-type': 'application/problem+json' } },
          );
        },
      });
      const detailKey = connectionKeys.detail(
        userId,
        workspaceId,
        connectionId,
      );
      const usageKey = connectionKeys.usage(userId, workspaceId, connectionId);
      client.setQueryData(detailKey, connection);
      client.setQueryData(usageKey, {
        pages: [
          { items: [{ workflowName: 'Protected workflow' }], nextCursor: null },
        ],
        pageParams: [null],
      });
      const read = client
        .query({
          ...connectionDetailQueryOptions(
            api,
            userId,
            workspaceId,
            connectionId,
          ),
          staleTime: 0,
        })
        .catch(() => undefined);
      const signal = await dispatched.promise;
      await expect(
        client.infiniteQuery(
          connectionsInfiniteQueryOptions(api, userId, workspaceId),
        ),
      ).rejects.toBeDefined();
      expect(signal.aborted).toBe(true);
      held.resolve(Response.json(connection));
      await read;
      expect(client.getQueryData(detailKey)).toBeUndefined();
      expect(client.getQueryData(usageKey)).toBeUndefined();
      client.clear();
    },
  );

  it('a denied workflow-usage read forgets usage without erasing connection-read metadata', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const api = createApiClient({
      readCsrfToken: () => undefined,
      fetch: () =>
        Promise.resolve(
          Response.json(
            {
              type: 'urn:pertexo:problem:auth.forbidden',
              title: 'Forbidden',
              status: 403,
              code: 'auth.forbidden',
              requestId: 'connection-usage-access',
            },
            {
              status: 403,
              headers: { 'content-type': 'application/problem+json' },
            },
          ),
        ),
    });
    const detailKey = connectionKeys.detail(userId, workspaceId, connectionId);
    const usageKey = connectionKeys.usage(userId, workspaceId, connectionId);
    client.setQueryData(detailKey, connection);
    client.setQueryData(usageKey, {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [null],
    });
    await expect(
      client.infiniteQuery({
        ...connectionUsageQueryOptions(api, userId, workspaceId, connectionId),
        staleTime: 0,
      }),
    ).rejects.toBeDefined();
    expect(client.getQueryData(usageKey)).toBeUndefined();
    expect(client.getQueryData(detailKey)).toEqual(connection);
    client.clear();
  });
});
