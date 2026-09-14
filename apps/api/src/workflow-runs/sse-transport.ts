import { workflowRunEventSchema } from '@pertexo/contracts/workflow-runs';

import type {
  SseVisibilityMetrics,
  SseVisibilityPath,
} from '../platform/observability/sse-visibility-metrics.js';
import type { WorkflowRunEventFrame } from './ports.js';
import {
  NO_STREAM_FAILURE,
  preserveFailureDuringBoundedStreamCleanup,
  STREAM_CLEANUP_BUDGET_MS,
  streamProducerFailureFromReason,
  type StreamFailure,
} from './stream-cleanup.js';

interface SseDestination {
  readonly destroyed: boolean;
  write(chunk: string): boolean;
  end(): void;
  destroy(error?: Error): void;
  once(
    event: 'close' | 'drain' | 'error',
    listener: (...args: unknown[]) => void,
  ): unknown;
  off(
    event: 'close' | 'drain' | 'error',
    listener: (...args: unknown[]) => void,
  ): unknown;
}

export async function writeSseFrames(
  frames: AsyncIterable<WorkflowRunEventFrame>,
  destination: SseDestination,
  controller: AbortController,
  visibilityMetrics: SseVisibilityMetrics,
  fallbackPath: SseVisibilityPath,
  cleanupBudgetMs: number = STREAM_CLEANUP_BUDGET_MS,
): Promise<void> {
  let iterator: AsyncIterator<WorkflowRunEventFrame> | undefined;
  let abandonedPull: Promise<IteratorResult<WorkflowRunEventFrame>> | undefined;
  let lastRecordedSequence: number | undefined;
  let primary: StreamFailure = NO_STREAM_FAILURE;
  try {
    iterator = frames[Symbol.asyncIterator]();
    while (!controller.signal.aborted && !destination.destroyed) {
      const next = await nextFrameOrAbort(
        iterator,
        controller.signal,
        (pull) => {
          abandonedPull = pull;
        },
      );
      if (next === undefined) break;
      if (next.done === true) break;
      const event = workflowRunEventSchema.parse(JSON.parse(next.value.data));
      const accepted = destination.write(
        encodeSseFrame(String(next.value.id), next.value.event, event),
      );
      if (!accepted) {
        const drained = await waitForDrain(destination, controller.signal);
        if (!drained) break;
      }
      if (lastRecordedSequence !== event.sequence) {
        lastRecordedSequence = event.sequence;
        try {
          visibilityMetrics.recordFirstEligibleFrame({
            createdAt: new Date(event.createdAt),
            path: next.value.visibilityPath ?? fallbackPath,
          });
        } catch {
          // Visibility diagnostics cannot terminate an accepted event stream.
        }
      }
    }
  } catch (error) {
    primary = { error, failed: true };
    throw error;
  } finally {
    await preserveFailureDuringBoundedStreamCleanup(
      primary,
      [
        () => {
          controller.abort();
        },
        async () => {
          if (abandonedPull === undefined) return;
          try {
            await abandonedPull;
          } catch (error: unknown) {
            if (primary.failed && error === primary.error) return;
            throw error;
          }
        },
        async () => iterator?.return?.(),
        () => {
          if (!destination.destroyed) destination.end();
        },
      ],
      cleanupBudgetMs,
    );
  }
}

async function nextFrameOrAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
  retainAbandonedPull: (pull: Promise<IteratorResult<T>>) => void,
): Promise<IteratorResult<T> | undefined> {
  if (streamAborted(signal)) return undefined;
  let resolveAbort!: () => void;
  const aborted = new Promise<undefined>((resolve) => {
    resolveAbort = () => {
      resolve(undefined);
    };
  });
  const onAbort = (): void => {
    resolveAbort();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (streamAborted(signal)) onAbort();
  let pull: Promise<IteratorResult<T>>;
  try {
    pull = Promise.resolve(iterator.next());
    const outcome = await Promise.race([pull, aborted]);
    if (!streamAborted(signal)) return outcome;
    retainAbandonedPull(pull);
    const failure = streamProducerFailureFromReason(signal.reason);
    if (failure?.failed === true) {
      // Producer adapters may reject with arbitrary values; identity is part
      // of the stream error contract.
      throw failure.error;
    }
    return undefined;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function streamAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function encodeSseFrame(id: string, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function waitForDrain(
  destination: SseDestination,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || destination.destroyed) return Promise.resolve(false);
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = (): void => {
      destination.off('drain', onDrain);
      destination.off('close', onClose);
      destination.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (value: boolean): void => {
      cleanup();
      resolve(value);
    };
    const onDrain = (): void => {
      finish(true);
    };
    const onClose = (): void => {
      finish(false);
    };
    const onAbort = (): void => {
      finish(false);
    };
    const onError = (...args: unknown[]): void => {
      cleanup();
      const error = args[0];
      reject(
        error instanceof Error ? error : new Error('SSE transport failed'),
      );
    };
    destination.once('drain', onDrain);
    destination.once('close', onClose);
    destination.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
