type OperationOutcome<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ error: unknown; ok: false }>;

async function settle<T>(
  operation: () => Promise<T>,
): Promise<OperationOutcome<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error: unknown) {
    return { error, ok: false };
  }
}

function throwable(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

function cleanupFailures(error: unknown): readonly unknown[] {
  return error instanceof AggregateError
    ? Array.from(error.errors as Iterable<unknown>)
    : [error];
}

/**
 * Runs test-fixture cleanup after every outcome without allowing cleanup to
 * replace the scenario failure that initiated it.
 */
export async function runWithCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
  label: string,
): Promise<T> {
  const operationOutcome = await settle(operation);
  const cleanupOutcome = await settle(cleanup);

  if (!operationOutcome.ok && !cleanupOutcome.ok)
    throw new AggregateError(
      [operationOutcome.error, ...cleanupFailures(cleanupOutcome.error)],
      `${label}: operation and cleanup failed`,
    );
  if (!operationOutcome.ok)
    throw throwable(operationOutcome.error, `${label}: operation failed`);
  if (!cleanupOutcome.ok)
    throw throwable(cleanupOutcome.error, `${label}: cleanup failed`);
  return operationOutcome.value;
}
