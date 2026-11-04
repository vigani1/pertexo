export class NodeAttemptHandlerStateError extends Error {
  public override readonly name = 'NodeAttemptHandlerStateError';
  public constructor(
    readonly code: string,
    readonly revision?: number | null,
    options?: ErrorOptions,
  ) {
    super(`Node attempt delivery cannot execute: ${code}`, options);
  }
}
