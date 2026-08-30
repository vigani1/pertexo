import { metrics, type Meter } from '@opentelemetry/api';

/**
 * The path is deliberately a closed set. It describes how the API recovered
 * the persisted event, never which tenant, run, or URL was involved.
 */
export type SseVisibilityPath =
  | 'initial_backfill'
  | 'reconnect_backfill'
  | 'live_wakeup'
  | 'recovery_backfill';

export const SSE_VISIBILITY_METRIC_NAME = Object.freeze({
  clockSkew: 'pertexo.api.sse.persisted_to_visible.skew.count',
  persistedToVisible: 'pertexo.api.sse.persisted_to_visible.duration',
});
export const SSE_VISIBILITY_METRICS = Symbol('SSE_VISIBILITY_METRICS');

export interface SseVisibilityMetrics {
  recordFirstEligibleFrame(input: {
    readonly createdAt: Date;
    readonly path: SseVisibilityPath;
  }): void;
}

export interface SseVisibilityMetricsOptions {
  /** Injection seam for deterministic tests; production uses the wall clock. */
  readonly now?: () => number;
  readonly meter?: Meter;
}

/**
 * Records the first successful `subscriber.next` for each persisted frame.
 * Database timestamps are authoritative. A frame whose timestamp is in the
 * future is excluded from the latency histogram and counted as clock skew so
 * one host's clock cannot create a negative SLO observation.
 */
export function createSseVisibilityMetrics(
  options: SseVisibilityMetricsOptions = {},
): SseVisibilityMetrics {
  const meter = options.meter ?? metrics.getMeter('@pertexo/api.sse', '0.0.0');
  const now = options.now ?? Date.now;
  const duration = meter.createHistogram(
    SSE_VISIBILITY_METRIC_NAME.persistedToVisible,
    {
      description:
        'Seconds from persisted run-event creation to first successful SSE frame emission',
      unit: 's',
    },
  );
  const clockSkew = meter.createCounter(SSE_VISIBILITY_METRIC_NAME.clockSkew, {
    description:
      'Persisted run-event SSE observations excluded because the database timestamp is in the future',
    unit: '{observation}',
  });

  return Object.freeze({
    recordFirstEligibleFrame: ({
      createdAt,
      path,
    }: {
      readonly createdAt: Date;
      readonly path: SseVisibilityPath;
    }) => {
      const createdAtMs = createdAt.getTime();
      const observedAtMs = now();
      const latencyMs = observedAtMs - createdAtMs;
      if (
        !Number.isFinite(createdAtMs) ||
        !Number.isFinite(observedAtMs) ||
        latencyMs < 0
      ) {
        clockSkew.add(1, { path });
        return;
      }
      duration.record(latencyMs / 1_000, { path });
    },
  });
}
