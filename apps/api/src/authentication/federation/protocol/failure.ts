import type { FederationFailureReason } from '@pertexo/contracts';

/**
 * Why a provider's proof was refused. Only the code travels: never what the
 * proof said. To anything else it's the same plain refusal as before.
 */
export class FederationProofError extends Error {
  readonly #reason: FederationFailureReason;
  constructor(reason: FederationFailureReason, message: string) {
    super(message);
    this.#reason = reason;
  }
  get reason(): FederationFailureReason {
    return this.#reason;
  }
}

/** A library's error can quote what it was given, so it stops here. */
export function refuseAs<T>(
  reason: FederationFailureReason,
  message: string,
  step: Promise<T>,
): Promise<T> {
  return step.catch(() => {
    throw new FederationProofError(reason, message);
  });
}

export function federationFailureReason(
  error: unknown,
): FederationFailureReason {
  return error instanceof FederationProofError ? error.reason : 'unavailable';
}
