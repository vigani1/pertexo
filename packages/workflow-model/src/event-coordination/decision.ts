import type { EventCoordinationPolicy } from './contract.js';
export type EventCoordinationWindow = Readonly<{
  startedAt: number;
  used: number;
}>;
export type EventCoordinationDecision = Readonly<{
  window: EventCoordinationWindow;
  action: 'start' | 'deduplicated' | 'debounced' | 'throttled';
  dueAt?: number;
}>;
/** A token is consumed by the caller only after atomic run admission succeeds. */
export function decideEventCoordination(
  input: Readonly<{
    policy: EventCoordinationPolicy;
    now: number;
    window?: EventCoordinationWindow;
    hasPending: boolean;
  }>,
): EventCoordinationDecision {
  const { policy, now } = input;
  if (policy.mode === 'debounce')
    return {
      window: { startedAt: now, used: 0 },
      action: 'debounced',
      dueAt: now + policy.quietSeconds * 1_000,
    };
  const width = policy.windowSeconds * 1_000;
  const window =
    input.window === undefined || now >= input.window.startedAt + width
      ? { startedAt: now, used: 0 }
      : input.window;
  if (policy.mode === 'deduplicate')
    return { window, action: window.used > 0 ? 'deduplicated' : 'start' };
  if (window.used < policy.limit && !input.hasPending)
    return { window, action: 'start' };
  return {
    window,
    action: 'throttled',
    ...(policy.onExcess === 'skip'
      ? {}
      : {
          dueAt: window.used >= policy.limit ? window.startedAt + width : now,
        }),
  };
}
