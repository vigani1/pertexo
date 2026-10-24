import type { TransportMetrics } from '@pertexo/observability';
import { vi } from 'vitest';

export function transportMetrics() {
  return {
    addActiveConcurrency:
      vi.fn<NonNullable<TransportMetrics['addActiveConcurrency']>>(),
    observeArtifacts:
      vi.fn<NonNullable<TransportMetrics['observeArtifacts']>>(),
    observeExecutionStorage:
      vi.fn<NonNullable<TransportMetrics['observeExecutionStorage']>>(),
    observeOutbox: vi.fn<NonNullable<TransportMetrics['observeOutbox']>>(),
    observeQueue: vi.fn<NonNullable<TransportMetrics['observeQueue']>>(),
    recordHandlerFinished:
      vi.fn<NonNullable<TransportMetrics['recordHandlerFinished']>>(),
    recordConsumerLifecycle:
      vi.fn<NonNullable<TransportMetrics['recordConsumerLifecycle']>>(),
    recordOutboxClaim:
      vi.fn<NonNullable<TransportMetrics['recordOutboxClaim']>>(),
    recordOutboxLeaseEvent:
      vi.fn<NonNullable<TransportMetrics['recordOutboxLeaseEvent']>>(),
    recordOutboxPublish:
      vi.fn<NonNullable<TransportMetrics['recordOutboxPublish']>>(),
    recordOutboxDispatchLatency:
      vi.fn<NonNullable<TransportMetrics['recordOutboxDispatchLatency']>>(),
    recordQueueStall:
      vi.fn<NonNullable<TransportMetrics['recordQueueStall']>>(),
    recordWorkerProcessStart:
      vi.fn<NonNullable<TransportMetrics['recordWorkerProcessStart']>>(),
  } satisfies TransportMetrics;
}
