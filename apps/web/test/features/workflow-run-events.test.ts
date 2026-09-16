import type { WorkflowRunEvent } from '@pertexo/contracts/schemas/workflow-runs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiByteStream, ApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/api-error';
import { useRunEvents } from '@/features/workflow-runs/use-run-events';
import {
  appendRunEvent,
  classifyRunEvent,
  decodeRunEvent,
  RUN_TIMELINE_LIMIT,
} from '../../src/features/workflow-runs/model/run-events';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function event(sequence: number): WorkflowRunEvent {
  return {
    sequence,
    type: 'node.progress',
    createdAt: '2026-09-14T10:00:00.000Z',
    payload: { schemaVersion: 1 },
  };
}

describe('run event protocol model', () => {
  it('validates the SSE ID and event type against the payload', () => {
    expect(
      decodeRunEvent({
        id: '1',
        event: 'node.progress',
        data: JSON.stringify(event(1)),
      }),
    ).toEqual(event(1));
    expect(() =>
      decodeRunEvent({
        id: '2',
        event: 'node.progress',
        data: JSON.stringify(event(1)),
      }),
    ).toThrow(/did not match/u);
  });

  it('deduplicates replay and rejects gaps', () => {
    expect(classifyRunEvent(4, event(4))).toBe('duplicate');
    expect(classifyRunEvent(4, event(5))).toBe('append');
    expect(() => classifyRunEvent(4, event(6))).toThrow(/skipped/u);
  });

  it('bounds the retained timeline', () => {
    let timeline: readonly WorkflowRunEvent[] = [];
    let truncated = 0;
    for (let sequence = 1; sequence <= RUN_TIMELINE_LIMIT + 12; sequence += 1) {
      const result = appendRunEvent(timeline, event(sequence));
      timeline = result.timeline;
      truncated += result.truncated;
    }
    expect(timeline).toHaveLength(RUN_TIMELINE_LIMIT);
    expect(timeline[0]?.sequence).toBe(13);
    expect(truncated).toBe(12);
  });
});

describe('run event lifecycle', () => {
  it('updates timeline overflow atomically under StrictMode', async () => {
    const events = Array.from({ length: RUN_TIMELINE_LIMIT + 1 }, (_, index) =>
      event(index + 1),
    );
    const apiClient = streamApiClient(() => openEventStream(events));
    const wrapper = queryWrapper(true);

    const result = renderHook(
      () => useRunEvents(apiClient, 'user-a', 'workspace-a', 'run-a'),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.result.current.timeline).toHaveLength(RUN_TIMELINE_LIMIT);
    });
    expect(result.result.current.timeline[0]?.sequence).toBe(2);
    expect(result.result.current.truncatedCount).toBe(1);
  });

  it('resets the complete stream state and ignores a late prior-run stream', async () => {
    let resolveFirst: ((stream: ApiByteStream) => void) | undefined;
    const first = new Promise<ApiByteStream>((resolve) => {
      resolveFirst = resolve;
    });
    const closeFirst = vi.fn();
    const stream = vi
      .fn<ApiClient['stream']>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(openEventStream([event(1)]));
    const apiClient = {
      request: vi.fn(),
      stream,
    } as unknown as ApiClient;
    const result = renderHook(
      ({ runId }) => useRunEvents(apiClient, 'user-a', 'workspace-a', runId),
      { initialProps: { runId: 'run-a' }, wrapper: queryWrapper(false) },
    );

    result.rerender({ runId: 'run-b' });
    await waitFor(() => {
      expect(result.result.current.timeline).toHaveLength(1);
    });
    resolveFirst?.({
      ...openEventStream([event(2)]),
      close: closeFirst,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(result.result.current.timeline.map((item) => item.sequence)).toEqual(
      [1],
    );
    expect(result.result.current.truncatedCount).toBe(0);
    expect(closeFirst).toHaveBeenCalledOnce();
  });

  it.each([
    [401, 'authentication-required'],
    [403, 'access-denied'],
    [404, 'unavailable'],
  ] as const)(
    'stops reconnecting after an HTTP %s response',
    async (status, expected) => {
      const stream = vi.fn<ApiClient['stream']>().mockRejectedValue(
        new ApiError({
          kind: 'problem',
          message: 'unavailable',
          status,
        }),
      );
      const apiClient = { request: vi.fn(), stream } as unknown as ApiClient;
      const result = renderHook(
        () => useRunEvents(apiClient, 'user-a', 'workspace-a', 'run-a'),
        { wrapper: queryWrapper(false) },
      );

      await waitFor(() => {
        expect(result.result.current.connectionStatus).toBe(expected);
      });
      expect(result.result.current.recoveryMessage).toBeTruthy();
      expect(stream).toHaveBeenCalledOnce();
    },
  );

  it('honors bounded Retry-After before reconnecting a rate-limited stream', async () => {
    vi.useFakeTimers();
    const stream = vi
      .fn<ApiClient['stream']>()
      .mockRejectedValueOnce(
        new ApiError({
          kind: 'problem',
          message: 'rate limited',
          status: 429,
          retryAfterMs: 4_000,
        }),
      )
      .mockResolvedValueOnce(openEventStream([event(1)]));
    const apiClient = { request: vi.fn(), stream } as unknown as ApiClient;
    const result = renderHook(
      () => useRunEvents(apiClient, 'user-a', 'workspace-a', 'run-a'),
      { wrapper: queryWrapper(false) },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.result.current.connectionStatus).toBe('rate-limited');
    expect(stream).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_999);
    });
    expect(stream).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    expect(stream).toHaveBeenCalledTimes(2);
    expect(result.result.current.timeline).toEqual([event(1)]);
    result.unmount();
  });

  it('stops after a non-transient protocol failure', async () => {
    const stream = vi.fn<ApiClient['stream']>().mockRejectedValue(
      new ApiError({
        kind: 'protocol',
        message: 'invalid event stream response',
        status: 400,
      }),
    );
    const apiClient = { request: vi.fn(), stream } as unknown as ApiClient;
    const result = renderHook(
      () => useRunEvents(apiClient, 'user-a', 'workspace-a', 'run-a'),
      { wrapper: queryWrapper(false) },
    );

    await waitFor(() => {
      expect(result.result.current.connectionStatus).toBe('failed');
    });
    expect(result.result.current.recoveryMessage).toMatch(
      /response was invalid/u,
    );
    expect(stream).toHaveBeenCalledOnce();
  });

  it('uses bounded backoff for a transient disconnect and closes on unmount', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const close = vi.fn();
    const stream = vi
      .fn<ApiClient['stream']>()
      .mockRejectedValueOnce(
        new ApiError({ kind: 'network', message: 'disconnected' }),
      )
      .mockResolvedValueOnce({ ...openEventStream([event(1)]), close });
    const apiClient = { request: vi.fn(), stream } as unknown as ApiClient;
    const result = renderHook(
      () => useRunEvents(apiClient, 'user-a', 'workspace-a', 'run-a'),
      { wrapper: queryWrapper(false) },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.result.current.connectionStatus).toBe('reconnecting');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
    });
    expect(result.result.current.timeline).toEqual([event(1)]);
    result.unmount();
    expect(close).toHaveBeenCalledOnce();
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

async function reachFirstSnapshotRecovery() {
  await act(async () => {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
  });
}

function queryWrapper(strict: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    const value = createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    );
    return strict ? createElement(StrictMode, null, value) : value;
  };
}

function streamApiClient(open: () => ApiByteStream): ApiClient {
  return {
    request: vi.fn(),
    stream: vi.fn(() => Promise.resolve(open())),
  } as ApiClient;
}

function openEventStream(events: readonly WorkflowRunEvent[]): ApiByteStream {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      for (const item of events) {
        controller.enqueue(
          encoder.encode(
            `id: ${String(item.sequence)}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`,
          ),
        );
      }
    },
  });
  return {
    body,
    close: () => {
      try {
        streamController?.close();
      } catch {
        // StrictMode may close the same test stream after its reader cancels.
      }
    },
  };
}
