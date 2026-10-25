import { useRunEvents } from '@/features/workflow-runs/hooks/use-run-events';

import type { ApiClient } from '@/lib/api/client';

import { ApiError } from '@/lib/api/error';

import { act, renderHook } from '@testing-library/react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { queryWrapper, reachFirstSnapshotRecovery } from './fixture';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('run event lifecycle', () => {
  it('treats a drop after a long quiet stream as a fresh one', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const disconnected = new ApiError({
      kind: 'network',
      message: 'disconnected',
    });
    // Opens quietly, then drops 30 seconds after it opened.
    const quiet = () =>
      Promise.resolve({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              controller.error(new TypeError('network connection was lost'));
            }, 30_000);
          },
        }),
        close: () => undefined,
      });
    const stream = vi
      .fn<ApiClient['stream']>()
      .mockRejectedValueOnce(disconnected)
      .mockRejectedValueOnce(disconnected)
      .mockRejectedValueOnce(disconnected)
      .mockImplementationOnce(quiet)
      .mockReturnValue(new Promise(() => undefined));
    const request = vi
      .fn<ApiClient['request']>()
      .mockResolvedValue({ run: { status: 'waiting' } } as never);
    const apiClient = { request, stream } as unknown as ApiClient;
    const result = renderHook(
      () => useRunEvents(apiClient, 'user-a', 'workspace-a', 'run-a'),
      { wrapper: queryWrapper(false) },
    );

    await reachFirstSnapshotRecovery();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(result.result.current.connectionStatus).toBe('live');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
      await Promise.resolve();
    });
    expect(stream).toHaveBeenCalledTimes(5);
    expect(result.result.current.connectionStatus).toBe('reconnecting');
  });
  it('does not retry a rate-limited degraded snapshot before Retry-After', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const stream = vi
      .fn<ApiClient['stream']>()
      .mockRejectedValue(
        new ApiError({ kind: 'network', message: 'disconnected' }),
      );
    const request = vi
      .fn<ApiClient['request']>()
      .mockRejectedValueOnce(
        new ApiError({
          kind: 'problem',
          message: 'rate limited',
          status: 429,
          retryAfterMs: 120_000,
        }),
      )
      .mockResolvedValueOnce({ run: { status: 'succeeded' } } as never);
    const apiClient = { request, stream } as unknown as ApiClient;
    const result = renderHook(
      () => useRunEvents(apiClient, 'user-a', 'workspace-a', 'run-a'),
      { wrapper: queryWrapper(false) },
    );

    await reachFirstSnapshotRecovery();
    expect(request).toHaveBeenCalledOnce();
    expect(result.result.current.connectionStatus).toBe('rate-limited');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(119_999);
    });
    expect(request).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.result.current.connectionStatus).toBe('stopped');
  });
  it('cancels a rate-limited degraded snapshot wait on unmount', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const stream = vi
      .fn<ApiClient['stream']>()
      .mockRejectedValue(
        new ApiError({ kind: 'network', message: 'disconnected' }),
      );
    const request = vi.fn<ApiClient['request']>().mockRejectedValue(
      new ApiError({
        kind: 'problem',
        message: 'rate limited',
        status: 429,
        retryAfterMs: 120_000,
      }),
    );
    const apiClient = { request, stream } as unknown as ApiClient;
    const result = renderHook(
      () => useRunEvents(apiClient, 'user-a', 'workspace-a', 'run-a'),
      { wrapper: queryWrapper(false) },
    );

    await reachFirstSnapshotRecovery();
    expect(request).toHaveBeenCalledOnce();
    const streamCalls = stream.mock.calls.length;
    result.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(request).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledTimes(streamCalls);
  });
});
