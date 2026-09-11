import type { LeasedOutboxEvent } from '@pertexo/database/execution';
import type { TransportMetrics } from '@pertexo/observability/transport-metrics';

export type OutboxDispatchResult = Readonly<{
  claimed: number;
  failed: number;
  outcomeUnknown: number;
  published: number;
  stale: number;
}>;

export type OutboxPublicationOutcome =
  'failed' | 'outcome_unknown' | 'published' | 'stale';

export function summarizeDispatchOutcomes(
  claimed: number,
  outcomes: readonly OutboxPublicationOutcome[],
): OutboxDispatchResult {
  return Object.freeze({
    claimed,
    failed: outcomes.filter((outcome) => outcome === 'failed').length,
    outcomeUnknown: outcomes.filter((outcome) => outcome === 'outcome_unknown')
      .length,
    published: outcomes.filter((outcome) => outcome === 'published').length,
    stale: outcomes.filter((outcome) => outcome === 'stale').length,
  });
}

export function recordOutboxClaim(
  metrics: TransportMetrics,
  events: readonly LeasedOutboxEvent[],
  exhaustedCount: number,
): void {
  metrics.recordOutboxClaim({ batchSize: events.length });
  if (exhaustedCount > 0)
    metrics.recordOutboxLeaseEvent('attempt_exhausted', exhaustedCount);
  for (const event of events)
    if (event.publishAttempts > 1) metrics.recordOutboxLeaseEvent('reclaimed');
}
