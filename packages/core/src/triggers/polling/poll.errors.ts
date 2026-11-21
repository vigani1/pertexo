/** This transaction no longer owns the live polling observation. */
export class PollClaimLostError extends Error {
  override readonly name = 'PollClaimLostError';
}

/** The immutable publication is missing the node that owns the poll. */
export class PollDefinitionMissingError extends Error {
  override readonly name = 'PollDefinitionMissingError';
}
