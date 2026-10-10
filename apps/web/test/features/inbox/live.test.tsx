import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useInboxLive } from '@/features/inbox/live.public';
import { ApiError } from '@/lib/api/error';
import type { ApiByteStream, ApiClient } from '@/lib/api/client';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function client(stream: ApiClient['stream']): ApiClient {
  return {
    request: vi.fn(),
    stream,
  };
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function openStream(text: string): ApiByteStream {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
  });
  return { body, close: vi.fn() };
}

describe('inbox live updates', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([401, 403, 404])(
    'stops for good when the stream answers %i',
    async (status) => {
      const stream = vi.fn(() =>
        Promise.reject(
          new ApiError({ kind: 'problem', status, message: 'No access' }),
        ),
      );
      const queryClient = new QueryClient();
      const apiClient = client(stream);
      const { result } = renderHook(
        () => useInboxLive(apiClient, userId, workspaceId, true),
        { wrapper: wrapper(queryClient) },
      );
      await waitFor(() => {
        expect(result.current).toBe('paused');
      });
      expect(stream).toHaveBeenCalledOnce();
    },
  );

  it('reconnects after a dropped stream and refetches what it missed', async () => {
    vi.useFakeTimers();
    const stream = vi
      .fn<ApiClient['stream']>()
      .mockRejectedValueOnce(
        new ApiError({ kind: 'network', message: 'offline' }),
      )
      .mockResolvedValue(
        openStream(
          'event: inbox.ready\ndata: {"schemaVersion":1,"revision":null}\n\n',
        ),
      );
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const apiClient = client(stream);
    const { result } = renderHook(
      () => useInboxLive(apiClient, userId, workspaceId, true),
      { wrapper: wrapper(queryClient) },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe('reconnecting');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(stream).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['identity', userId, 'workspace', workspaceId, 'inbox'],
    });
  });

  it.each([502, 503])(
    'keeps reconnecting through a %i gateway answer without problem details',
    async (status) => {
      vi.useFakeTimers();
      const stream = vi
        .fn<ApiClient['stream']>()
        .mockRejectedValueOnce(
          new ApiError({
            kind: 'protocol',
            status,
            message: 'The server returned an unexpected error response.',
          }),
        )
        .mockResolvedValue(
          openStream(
            'event: inbox.ready\ndata: {"schemaVersion":1,"revision":null}\n\n',
          ),
        );
      const apiClient = client(stream);
      const { result } = renderHook(
        () => useInboxLive(apiClient, userId, workspaceId, true),
        { wrapper: wrapper(new QueryClient()) },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current).toBe('reconnecting');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(stream).toHaveBeenCalledTimes(2);
      expect(result.current).toBe('live');
    },
  );

  it('stops when a successful answer is not an event stream', async () => {
    const stream = vi.fn(() =>
      Promise.reject(
        new ApiError({
          kind: 'protocol',
          status: 200,
          message: 'The server returned an unexpected content type.',
        }),
      ),
    );
    const apiClient = client(stream);
    const { result } = renderHook(
      () => useInboxLive(apiClient, userId, workspaceId, true),
      { wrapper: wrapper(new QueryClient()) },
    );
    await waitFor(() => {
      expect(result.current).toBe('paused');
    });
    expect(stream).toHaveBeenCalledOnce();
  });

  it('opens nothing for a person without the inbox', () => {
    const stream = vi.fn<ApiClient['stream']>();
    const apiClient = client(stream);
    const { result } = renderHook(
      () => useInboxLive(apiClient, userId, workspaceId, false),
      { wrapper: wrapper(new QueryClient()) },
    );
    expect(result.current).toBe('paused');
    expect(stream).not.toHaveBeenCalled();
  });
});
