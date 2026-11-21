export class CoreStepRefusal extends Error {
  readonly failure;
  constructor(safeErrorCode: string, errorSummary: string) {
    super(errorSummary);
    this.failure = {
      kind: 'failed',
      errorKind: 'configuration',
      safeErrorCode,
      errorSummary,
    } as const;
  }
}
