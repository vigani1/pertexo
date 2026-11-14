/** A caller built a decision or subject the limiter can't count: a bug, not a limit. */
export class RateLimitDecisionError extends Error {
  public override readonly name = 'RateLimitDecisionError';
}

/**
 * The shared counter store failed, timed out, answered nonsense or is closed.
 * Callers apply the decision's failure mode instead of the store's answer.
 */
export class RateLimitBackendError extends Error {
  public override readonly name = 'RateLimitBackendError';
}
