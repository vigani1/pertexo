/** This transaction no longer owns the live polling observation. */
export class PollClaimLostError extends Error {
  override readonly name = 'PollClaimLostError';
}
