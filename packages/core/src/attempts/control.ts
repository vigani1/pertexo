import type { NodeAttemptControl } from './node-attempt.js';

export function attemptControl(
  abortReason: 'canceled' | 'timed_out' | null,
): NodeAttemptControl {
  return abortReason === null
    ? { kind: 'none' }
    : { kind: 'abort', reason: abortReason };
}
