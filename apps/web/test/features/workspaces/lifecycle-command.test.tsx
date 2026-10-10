import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { useWorkspaceLifecycleCommand } from '@/features/workspaces/data/mutations/lifecycle/use-command';
import { useLeaveWorkspaceCommand } from '@/features/workspaces/data/mutations/lifecycle/use-leave-workspace-command';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function wrapper(queryClient: QueryClient) {
  return function QueryOwner({ children }: Readonly<{ children: ReactNode }>) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe('workspace lifecycle completion', () => {
  it('blocks duplicate deletion commands and awaits cache reconciliation before completion', async () => {
    const queryClient = new QueryClient();
    const refreshed = deferred();
    const invalidate = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockReturnValue(refreshed.promise);
    const fetch = vi.fn(() =>
      Promise.resolve(
        Response.json({
          workspaceId,
          change: 'deletion_requested',
          occurredAt: '2026-09-15T10:00:00.000Z',
        }),
      ),
    );
    const apiClient = createApiClient({
      fetch,
      readCsrfToken: () => 'workspace-command-csrf-123456789012345678901234',
    });
    const onCompleted = vi.fn();
    const hook = renderHook(
      () =>
        useWorkspaceLifecycleCommand({
          apiClient,
          userId,
          workspaceId,
          onCompleted,
        }),
      { wrapper: wrapper(queryClient) },
    );
    let first!: Promise<boolean>;
    await act(async () => {
      first = hook.result.current.start({
        command: 'request-deletion',
        reason: 'Closed project',
      });
      expect(
        await hook.result.current.start({
          command: 'request-deletion',
          reason: 'Closed project',
        }),
      ).toBe(false);
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledOnce();
    });
    expect(hook.result.current.pending).toBe(true);
    expect(onCompleted).not.toHaveBeenCalled();
    await act(async () => {
      refreshed.resolve();
      expect(await first).toBe(true);
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onCompleted).toHaveBeenCalledExactlyOnceWith('deletion_requested');
    await waitFor(() => {
      expect(hook.result.current.pending).toBe(false);
    });
    hook.unmount();
    queryClient.clear();
  });

  it('clears ended-session data and stays pending until leave navigation finishes', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['private-workspace-data'], { name: 'Private' });
    const navigated = deferred();
    const onLeft = vi.fn(() => navigated.promise);
    const fetch = vi.fn(() =>
      Promise.resolve(
        Response.json({ userId, roleRevision: 2, replayed: false }),
      ),
    );
    const apiClient = createApiClient({
      fetch,
      readCsrfToken: () => 'workspace-command-csrf-123456789012345678901234',
    });
    const hook = renderHook(
      () => useLeaveWorkspaceCommand({ apiClient, workspaceId, onLeft }),
      {
        wrapper: wrapper(queryClient),
      },
    );
    let first!: Promise<boolean>;
    await act(async () => {
      first = hook.result.current.start();
      expect(await hook.result.current.start()).toBe(false);
    });
    await waitFor(() => {
      expect(onLeft).toHaveBeenCalledExactlyOnceWith(true);
    });
    expect(
      queryClient.getQueryData(['private-workspace-data']),
    ).toBeUndefined();
    expect(hook.result.current.pending).toBe(true);
    await act(async () => {
      navigated.resolve();
      await first;
    });
    expect(fetch).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(hook.result.current.pending).toBe(false);
    });
    hook.unmount();
    queryClient.clear();
  });

  it('does not clear a later owner after leave cancellation finishes', async () => {
    const queryClient = new QueryClient();
    const canceled = deferred();
    const cancel = vi
      .spyOn(queryClient, 'cancelQueries')
      .mockReturnValue(canceled.promise);
    const onLeft = vi.fn();
    const apiClient = createApiClient({
      fetch: () =>
        Promise.resolve(
          Response.json({ userId, roleRevision: 2, replayed: false }),
        ),
      readCsrfToken: () => 'workspace-command-csrf-123456789012345678901234',
    });
    const hook = renderHook(
      () => useLeaveWorkspaceCommand({ apiClient, workspaceId, onLeft }),
      { wrapper: wrapper(queryClient) },
    );
    let first!: Promise<boolean>;
    act(() => {
      first = hook.result.current.start();
    });
    await waitFor(() => {
      expect(cancel).toHaveBeenCalledOnce();
    });
    hook.unmount();
    queryClient.setQueryData(['later-owner-data'], { name: 'Current' });
    await act(async () => {
      canceled.resolve();
      await first;
    });
    expect(queryClient.getQueryData(['later-owner-data'])).toEqual({
      name: 'Current',
    });
    expect(onLeft).not.toHaveBeenCalled();
    queryClient.clear();
  });
});
