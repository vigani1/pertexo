export class CoreValidateExecutionAbortedError extends Error {
  public override readonly name = 'CoreValidateExecutionAbortedError';

  public constructor() {
    super('Validate execution was canceled');
  }
}
