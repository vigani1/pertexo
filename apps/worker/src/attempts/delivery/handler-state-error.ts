import type { NodeAttemptLease } from '@pertexo/core/attempts';
export class NodeAttemptHandlerStateError extends Error {
  public override readonly name = 'NodeAttemptHandlerStateError';
  public constructor(
    readonly code: string,
    readonly lease?: NodeAttemptLease,
    options?: ErrorOptions,
  ) {
    super(`Node attempt delivery cannot execute: ${code}`, options);
  }
}
