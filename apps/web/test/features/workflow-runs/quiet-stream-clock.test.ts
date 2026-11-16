import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRunEvents } from '@/features/workflow-runs/data/run-events';
import { useInboxLive } from '@/features/inbox/data/inbox-live';
import type { ApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/error';
import {
  queryWrapper,
  openEventStream,
  streamApiClient,
} from './events/fixture';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function useQuietRun(apiClient: ApiClient, now: () => number) {
  return useRunEvents({
    apiClient,
    userId: 'user',
    workspaceId: 'workspace',
    runId: 'run',
    now,
  });
}
function useQuietInbox(apiClient: ApiClient, now: () => number) {
  return useInboxLive({
    apiClient,
    userId: 'user',
    workspaceId: 'workspace',
    enabled: true,
    now,
  });
}

it.each(['run', 'inbox'] as const)(
  'resets the %s failure count only after the quiet-stream threshold',
  async (subject) => {
    for (const [elapsed, delay] of [
      [29_999, 2_000],
      [30_001, 1_000],
    ] as const) {
      vi.useFakeTimers({ now: 100_000 });
      vi.spyOn(Math, 'random').mockReturnValue(0);
      let current = 1_000_000;
      const now = () => current;
      let closeQuiet!: () => void;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          closeQuiet = () => {
            controller.close();
          };
        },
      });
      const stream = vi
        .fn<ApiClient['stream']>()
        .mockRejectedValueOnce(
          new ApiError({ kind: 'network', message: 'disconnected' }),
        )
        .mockResolvedValueOnce({ body, close: () => undefined })
        .mockResolvedValue(openEventStream([]));
      const apiClient = {
        ...streamApiClient(() => openEventStream([])),
        stream,
      };
      const useStream = subject === 'run' ? useQuietRun : useQuietInbox;
      const hook = renderHook(() => useStream(apiClient, now), {
        wrapper: queryWrapper(false),
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(stream).toHaveBeenCalledTimes(2);
      current += elapsed;
      await act(async () => {
        closeQuiet();
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay - 1);
      });
      expect(stream).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(stream).toHaveBeenCalledTimes(3);
      hook.unmount();
    }
  },
);
