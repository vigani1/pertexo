import type { ApiByteStream, ApiClient } from '@/lib/api/client';
import type { WorkflowRunEvent } from '@pertexo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from '@testing-library/react';
import { createElement, StrictMode, type ReactNode } from 'react';
import { vi } from 'vitest';
export function event(sequence: number): WorkflowRunEvent {
  return {
    sequence,
    type: 'node.progress',
    createdAt: '2026-09-14T10:00:00.000Z',
    payload: {},
  };
}

export async function reachFirstSnapshotRecovery() {
  await act(async () => {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
  });
}

export function queryWrapper(strict: boolean) {
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

export function streamApiClient(open: () => ApiByteStream): ApiClient {
  return {
    download: vi.fn(),
    request: vi.fn(),
    stream: vi.fn(() => Promise.resolve(open())),
  } as ApiClient;
}

export function openEventStream(
  events: readonly WorkflowRunEvent[],
  options: Readonly<{ ends?: boolean }> = {},
): ApiByteStream {
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
      if (options.ends === true) controller.close();
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
