export class NodeAttemptHandlerStateError extends Error {
  public override readonly name = 'NodeAttemptHandlerStateError';
  public constructor(readonly code: string) {
    super(`Node attempt delivery cannot execute: ${code}`);
  }
}
