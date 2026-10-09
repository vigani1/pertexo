export type StreamFailure = Readonly<{
  error: unknown;
  failed: boolean;
}>;

export const NO_STREAM_FAILURE: StreamFailure = Object.freeze({
  error: undefined,
  failed: false,
});

export const STREAM_CLEANUP_BUDGET_MS = 5_000;

const producerFailureReasons = new WeakMap<object, unknown>();

export function streamProducerFailureReason(error: unknown): object {
  const reason = Object.freeze({ kind: 'workflow_event_producer_failure' });
  producerFailureReasons.set(reason, error);
  return reason;
}

export function streamProducerFailureFromReason(
  reason: unknown,
): StreamFailure | undefined {
  if (
    (typeof reason !== 'object' || reason === null) &&
    typeof reason !== 'function'
  )
    return undefined;
  if (!producerFailureReasons.has(reason)) return undefined;
  return { error: producerFailureReasons.get(reason), failed: true };
}

export class StreamCleanupIncompleteError extends AggregateError {
  public override readonly name = 'StreamCleanupIncompleteError';
  public readonly completion: Promise<void>;
  public constructor(
    errors: readonly unknown[],
    public readonly outcome: Promise<void>,
  ) {
    super(errors, 'Workflow event stream cleanup exceeded its bounded budget');
    this.completion = outcome.then(
      () => undefined,
      () => undefined,
    );
  }
}

type CleanupAttempt = Readonly<{
  errors(): unknown[];
  settlement: Promise<void>;
}>;

function startCleanups(
  cleanups: readonly (() => void | Promise<void>)[],
): CleanupAttempt {
  const failures: { error: unknown; index: number }[] = [];
  const settlement = Promise.all(
    cleanups.map((cleanup, index) =>
      Promise.resolve()
        .then(cleanup)
        .catch((error: unknown) => {
          failures.push({ error, index });
        }),
    ),
  ).then(() => undefined);
  return {
    errors: () =>
      failures
        .toSorted((left, right) => left.index - right.index)
        .map(({ error }) => error),
    settlement,
  };
}

function throwCleanupFailures(
  primary: StreamFailure,
  cleanupErrors: readonly unknown[],
): void {
  if (cleanupErrors.length === 0) return;
  if (primary.failed)
    throw new AggregateError(
      [primary.error, ...cleanupErrors],
      'Workflow event stream failed and its cleanup was incomplete',
    );
  if (cleanupErrors.length === 1) {
    const [cleanupError] = cleanupErrors;
    throw safelyIsError(cleanupError)
      ? cleanupError
      : new Error('Workflow event stream cleanup failed', {
          cause: cleanupError,
        });
  }
  throw new AggregateError(
    cleanupErrors,
    'Workflow event stream cleanup was incomplete',
  );
}

function safelyIsError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

export async function preserveFailureDuringStreamCleanup(
  primary: StreamFailure,
  cleanups: readonly (() => void | Promise<void>)[],
): Promise<void> {
  const attempt = startCleanups(cleanups);
  await attempt.settlement;
  throwCleanupFailures(primary, attempt.errors());
}

export async function preserveFailureDuringBoundedStreamCleanup(
  primary: StreamFailure,
  cleanups: readonly (() => void | Promise<void>)[],
  budgetMs: number = STREAM_CLEANUP_BUDGET_MS,
): Promise<void> {
  const attempt = startCleanups(cleanups);
  const outcome = attempt.settlement.then(() => {
    throwCleanupFailures(primary, attempt.errors());
  });
  let timeout: NodeJS.Timeout | undefined;
  const exceeded = Symbol('stream-cleanup-budget-exceeded');
  try {
    const result = await Promise.race([
      outcome,
      new Promise<typeof exceeded>((resolve) => {
        timeout = setTimeout(() => {
          resolve(exceeded);
        }, budgetMs);
        timeout.unref();
      }),
    ]);
    if (result !== exceeded) return;
    const deadlineFailure = new Error(
      `Workflow event stream cleanup exceeded ${String(budgetMs)}ms`,
    );
    throw new StreamCleanupIncompleteError(
      [
        ...(primary.failed ? [primary.error] : []),
        ...attempt.errors(),
        deadlineFailure,
      ],
      outcome,
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function streamCleanupCompletion(
  error: unknown,
): Promise<void> | undefined {
  try {
    return error instanceof StreamCleanupIncompleteError
      ? error.completion
      : undefined;
  } catch {
    return undefined;
  }
}
