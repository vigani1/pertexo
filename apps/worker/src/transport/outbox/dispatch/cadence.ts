import type { OutboxDispatchResult } from './contract.js';

export const ACTIVE_POLL_INTERVAL_MILLIS = 25;

// A run's next step reaches the outbox a few dozen milliseconds after its
// previous publication, two hops per step. Polling quickly for this long after
// the last publication keeps those hops from each waiting out a backed-off
// interval; an idle worker still backs off once it passes.
const ACTIVE_WINDOW_MILLIS = 1_000;

export interface DispatchPollingState {
  readonly intervalMillis: number;
  readonly lastActivityAt: number;
}

export function nextDispatchPolling(
  previous: DispatchPollingState,
  result: OutboxDispatchResult,
  {
    now,
    activeIntervalMillis,
    idleIntervalMillis,
  }: Readonly<{
    now: number;
    activeIntervalMillis: number;
    idleIntervalMillis: number;
  }>,
): DispatchPollingState {
  if (result.published > 0 || result.outcomeUnknown > 0)
    return { lastActivityAt: now, intervalMillis: activeIntervalMillis };
  if (result.failed > 0)
    return {
      lastActivityAt: Number.NEGATIVE_INFINITY,
      intervalMillis: idleIntervalMillis,
    };
  if (now - previous.lastActivityAt < ACTIVE_WINDOW_MILLIS)
    return {
      lastActivityAt: previous.lastActivityAt,
      intervalMillis: activeIntervalMillis,
    };
  return {
    lastActivityAt: previous.lastActivityAt,
    intervalMillis: Math.min(previous.intervalMillis * 2, idleIntervalMillis),
  };
}
