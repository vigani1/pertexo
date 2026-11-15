export class BackgroundTaskShutdownTimeoutError extends Error {
  public override readonly name = 'BackgroundTaskShutdownTimeoutError';

  public constructor(timeoutMillis: number) {
    super(`Background task did not stop within ${String(timeoutMillis)}ms`);
  }
}
