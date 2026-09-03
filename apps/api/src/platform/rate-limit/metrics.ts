import { metrics, type Meter } from '@opentelemetry/api';

import type { RateLimitMetricRecorder } from './interceptor.js';

const RATE_LIMIT_METRIC_NAME = Object.freeze({
  decisions: 'pertexo.api.rate_limit.decision.count',
});

export function createRateLimitMetricRecorder(
  meter: Meter = metrics.getMeter('@pertexo/api.rate-limit', '0.0.0'),
): RateLimitMetricRecorder {
  const decisions = meter.createCounter(RATE_LIMIT_METRIC_NAME.decisions, {
    description:
      'Distributed abuse-limit decisions with bounded policy attributes',
    unit: '{decision}',
  });
  return {
    record: (event): void => {
      decisions.add(1, {
        endpoint_class: event.endpointClass,
        failure_mode: event.failureMode,
        outcome: event.outcome,
        limited_dimension: event.limitedDimension ?? 'none',
      });
    },
  };
}
