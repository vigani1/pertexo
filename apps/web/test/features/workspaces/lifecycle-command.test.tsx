import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createApiClient } from '@/lib/api/client';
import { useWorkspaceLifecycleCommand } from '@/features/workspaces/data/mutations/lifecycle/use-workspace-lifecycle-command';
import { useLeaveWorkspaceCommand } from '@/features/workspaces/data/mutations/lifecycle/use-leave-workspace-command';
import { accessibleWorkspacesQueryOptions } from '@/features/workspaces/data/workspaces.queries';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import { workspace, user } from './general/fixture';

const api = 'http://pertexo.test/v1';
const workspaceId = workspace.id;
const client = createApiClient({
  fetch: testFetch,
  readCsrfToken: () => 'workspace-command-csrf-123456789012345678901234',
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function wrapper(cache: QueryClient) {
  return function QueryOwner({ children }: Readonly<{ children: ReactNode }>) {
    return <QueryClientProvider client={cache}>{children}</QueryClientProvider>;
  };
}
const deleted = () =>
  HttpResponse.json({
    workspaceId,
    change: 'deletion_requested',
    occurredAt: '2026-09-15T10:00:00.000Z',
  });
const discovery = () =>
  HttpResponse.json({ items: [workspace], nextCursor: null });

function setupDeletion(cache: QueryClient, onCompleted: () => void) {
  return renderHook(
    () => ({
      read: useQuery(accessibleWorkspacesQueryOptions(client, user.id)),
      command: useWorkspaceLifecycleCommand({
        apiClient: client,
        userId: user.id,
        workspaceId,
        onCompleted,
      }),
    }),
    { wrapper: wrapper(cache) },
  );
}

describe('low-effect workspace mutations', () => {
  it('keeps a deletion pending through the real discovery refresh and prevents another confirmation meanwhile', async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const refreshed = deferred();
    let reads = 0;
    let writes = 0;
    mockServer.use(
      http.get(`${api}/workspaces`, async () => {
        reads += 1;
        if (reads > 1) await refreshed.promise;
        return discovery();
      }),
      http.post(`${api}/workspaces/${workspaceId}/deletion`, () => {
        writes += 1;
        return deleted();
      }),
    );
    const onCompleted = vi.fn();
    const f = setupDeletion(cache, onCompleted);
    await waitFor(() => {
      expect(f.result.current.read.isSuccess).toBe(true);
    });
    let first: Promise<boolean> | undefined;
    act(() => {
      first = f.result.current.command.start({
        command: 'request-deletion',
        reason: 'Closed project',
      });
    });
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    expect(f.result.current.command.pending).toBe(true);
    await act(async () => {
      expect(
        await f.result.current.command.start({
          command: 'request-deletion',
          reason: 'Closed project',
        }),
      ).toBe(false);
    });
    expect(writes).toBe(1);
    expect(onCompleted).not.toHaveBeenCalled();
    await act(async () => {
      refreshed.resolve();
      expect(await first).toBe(true);
    });
    expect(onCompleted).toHaveBeenCalledExactlyOnceWith('deletion_requested');
    f.unmount();
    cache.clear();
  });
  it('refreshes after an unconfirmed write and gives a new decision a fresh key and body', async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let reads = 0;
    const sent: { key: string | null; body: unknown }[] = [];
    mockServer.use(
      http.get(`${api}/workspaces`, () => {
        reads += 1;
        return discovery();
      }),
      http.post(
        `${api}/workspaces/${workspaceId}/deletion`,
        async ({ request }) => {
          sent.push({
            key: request.headers.get('idempotency-key'),
            body: await request.json(),
          });
          return sent.length === 1 ? HttpResponse.error() : deleted();
        },
      ),
    );
    const onCompleted = vi.fn();
    const f = setupDeletion(cache, onCompleted);
    await waitFor(() => {
      expect(reads).toBe(1);
    });
    await act(async () => {
      expect(
        await f.result.current.command.start({
          command: 'request-deletion',
          reason: 'Closed project',
        }),
      ).toBe(false);
    });
    await waitFor(() => {
      expect(f.result.current.command.error).toContain(
        'Check the refreshed current state',
      );
    });
    expect(reads).toBe(2);
    expect(onCompleted).not.toHaveBeenCalled();
    await act(async () => {
      expect(
        await f.result.current.command.start({
          command: 'request-deletion',
          reason: 'Reviewed closure',
        }),
      ).toBe(true);
    });
    expect(reads).toBe(3);
    expect(sent.map((item) => item.body)).toEqual([
      { reason: 'Closed project' },
      { reason: 'Reviewed closure' },
    ]);
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/u);
    expect(sent[1]?.key).not.toBe(sent[0]?.key);
    expect(onCompleted).toHaveBeenCalledOnce();
    f.unmount();
    cache.clear();
  });
  it('keeps an accepted write confirmed when its refreshed read fails', async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let reads = 0;
    mockServer.use(
      http.get(`${api}/workspaces`, () =>
        ++reads === 1 ? discovery() : HttpResponse.error(),
      ),
      http.post(`${api}/workspaces/${workspaceId}/deletion`, deleted),
    );
    const onCompleted = vi.fn();
    const f = setupDeletion(cache, onCompleted);
    await waitFor(() => {
      expect(f.result.current.read.isSuccess).toBe(true);
    });
    await act(async () => {
      expect(
        await f.result.current.command.start({
          command: 'request-deletion',
          reason: 'Closed project',
        }),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(f.result.current.read.isError).toBe(true);
    });
    expect(onCompleted).toHaveBeenCalledOnce();
    expect(f.result.current.command.error).toBeUndefined();
    f.unmount();
    cache.clear();
  });
  it('clears ended-session data before waiting for leave navigation', async () => {
    const cache = new QueryClient();
    cache.setQueryData(['private-workspace-data'], { name: 'Private' });
    const navigated = deferred();
    const onLeft = vi.fn(() => navigated.promise);
    mockServer.use(
      http.post(`${api}/workspaces/${workspaceId}/leave`, () =>
        HttpResponse.json({
          userId: user.id,
          roleRevision: 2,
          replayed: false,
        }),
      ),
    );
    const f = renderHook(
      () =>
        useLeaveWorkspaceCommand({ apiClient: client, workspaceId, onLeft }),
      { wrapper: wrapper(cache) },
    );
    let first: Promise<boolean> | undefined;
    let finished = false;
    act(() => {
      first = f.result.current.start().then((value) => {
        finished = true;
        return value;
      });
    });
    await waitFor(() => {
      expect(onLeft).toHaveBeenCalledExactlyOnceWith(true);
    });
    expect(cache.getQueryData(['private-workspace-data'])).toBeUndefined();
    expect(finished).toBe(false);
    await act(async () => {
      navigated.resolve();
      expect(await first).toBe(true);
    });
    f.unmount();
    cache.clear();
  });
  it('does not clear a later owner or navigate from a late leave reply after unmount', async () => {
    const cache = new QueryClient();
    const accepted = deferred();
    const onLeft = vi.fn();
    let writes = 0;
    mockServer.use(
      http.post(`${api}/workspaces/${workspaceId}/leave`, async () => {
        writes += 1;
        await accepted.promise;
        return HttpResponse.json({
          userId: user.id,
          roleRevision: 2,
          replayed: false,
        });
      }),
    );
    const f = renderHook(
      () =>
        useLeaveWorkspaceCommand({ apiClient: client, workspaceId, onLeft }),
      { wrapper: wrapper(cache) },
    );
    let first: Promise<boolean> | undefined;
    act(() => {
      first = f.result.current.start();
    });
    await waitFor(() => {
      expect(writes).toBe(1);
    });
    f.unmount();
    cache.setQueryData(['later-owner-data'], { name: 'Current' });
    await act(async () => {
      accepted.resolve();
      await first;
    });
    expect(cache.getQueryData(['later-owner-data'])).toEqual({
      name: 'Current',
    });
    expect(onLeft).not.toHaveBeenCalled();
    cache.clear();
  });
});
