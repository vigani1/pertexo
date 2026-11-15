export class RunEventStreamUnauthorizedError extends Error {
  public override readonly name = 'RunEventStreamUnauthorizedError';
}

export class RunEventPageSizeError extends RangeError {
  public override readonly name = 'RunEventPageSizeError';
}
