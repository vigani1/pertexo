function throwableError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error
    ? value
    : new Error(fallbackMessage, { cause: value });
}

/** What an aborted scan reports: the signal's reason, as an Error. */
export function cancellationFailure(
  signal: AbortSignal | undefined,
): Error | undefined {
  if (!signal?.aborted) return undefined;
  return throwableError(signal.reason, 'Schedule scan aborted');
}

/** One close failure as itself, several as one AggregateError. */
export function scannerCloseFailure(
  failures: readonly unknown[],
): Error | undefined {
  if (failures.length === 0) return undefined;
  if (failures.length === 1)
    return throwableError(failures[0], 'Schedule scanner close failed');
  return new AggregateError(failures, 'Schedule scanner close failed');
}
