import { useRunEvents } from '@/features/workflow-runs/hooks/use-run-events';

import type { ApiByteStream, ApiClient } from '@/lib/api/client';

import { ApiError } from '@/lib/api/error';

import type { WorkflowRunEvent } from '@pertexo/contracts';

import { act, renderHook, waitFor } from '@testing-library/react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendRunEvent,
  classifyRunEvent,
  decodeRunEvent,
  RUN_TIMELINE_LIMIT,
} from '../../../src/features/workflow-runs/model/timeline/run-events';

import {
  event,
  openEventStream,
  queryWrapper,
  reachFirstSnapshotRecovery,
  streamApiClient,
} from './events/fixture';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
      download: vi.fn(),
      request: vi.fn(),
      stream,
    } satisfies ApiClient;
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
      const apiClient = {
        download: vi.fn(),
        request: vi.fn(),
        stream,
      } satisfies ApiClient;
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
    const apiClient = {
      download: vi.fn(),
      request: vi.fn(),
      stream,
    } satisfies ApiClient;
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
    const apiClient = {
      download: vi.fn(),
      request: vi.fn(),
      stream,
    } satisfies ApiClient;
    const result = renderHook(
      () => useRunEvents(apiClient, 'user-a', 'workspace-a', 'run-a'),
      { wrapper: queryWrapper(false) },
    );

    await waitFor(() => {
      expect(result.result.current.connectionStatus).toBe('failed');
    });
    expect(result.result.current.recoveryMessage).toMatch(
      /sent an update this page couldn’t read/u,
    );
    expect(stream).toHaveBeenCalledOnce();
  });
  it('reconnects on request after a pause and backfills from the first event', async () => {
    const stream = vi
      .fn<ApiClient['stream']>()
      .mockRejectedValueOnce(
        new ApiError({ kind: 'problem', message: 'forbidden', status: 403 }),
      )
      .mockResolvedValueOnce(openEventStream([event(1), event(2)]));
    const apiClient = {
      download: vi.fn(),
      request: vi.fn(),
      stream,
    } satisfies ApiClient;
    const result = renderHook(
      () => useRunEvents(apiClient, 'user-a', 'workspace-a', 'run-a'),
      { wrapper: queryWrapper(false) },
    );
    await waitFor(() => {
      expect(result.result.current.connectionStatus).toBe('access-denied');
    });
    act(() => {
      result.result.current.reconnect();
    });
    await waitFor(() => {
      expect(result.result.current.timeline).toHaveLength(2);
    });
    expect(stream).toHaveBeenCalledTimes(2);
    expect(stream.mock.calls[1]?.[0].headers).toEqual({ 'Last-Event-ID': '0' });
    result.unmount();
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
    const apiClient = {
      download: vi.fn(),
      request: vi.fn(),
      stream,
    } satisfies ApiClient;
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
  it('treats a drop after a stream that delivered as a fresh one, not one more in a row', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const disconnected = new ApiError({
      kind: 'network',
      message: 'disconnected',
    });
    const stream = vi
      .fn<ApiClient['stream']>()
      .mockRejectedValueOnce(disconnected)
      .mockRejectedValueOnce(disconnected)
      .mockRejectedValueOnce(disconnected)
      .mockResolvedValueOnce(openEventStream([event(1)], { ends: true }))
      .mockReturnValue(new Promise(() => undefined));
    const request = vi
      .fn<ApiClient['request']>()
      .mockResolvedValue({ run: { status: 'running' } } as never);
    const apiClient =
      /* Vitest retains only the last request overload; this recorder supplies the response exercised by the case. */ {
        request,
        stream,
      } as unknown as ApiClient;
    const result = renderHook(
      () => useRunEvents(apiClient, 'user-a', 'workspace-a', 'run-a'),
      { wrapper: queryWrapper(false) },
    );

    await reachFirstSnapshotRecovery();
    expect(result.result.current.connectionStatus).toBe('degraded');
    // The fourth stream delivers an event, then drops.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await Promise.resolve();
    });
    expect(result.result.current.timeline).toEqual([event(1)]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
    });
    expect(stream).toHaveBeenCalledTimes(5);
    expect(result.result.current.connectionStatus).toBe('reconnecting');
  });
});
