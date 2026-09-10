export type StreamFailure = Readonly<{
  error: unknown;
  failed: boolean;
}>;

export const NO_STREAM_FAILURE: StreamFailure = Object.freeze({
  error: undefined,
  failed: false,
});

export async function preserveFailureDuringStreamCleanup(
  primary: StreamFailure,
  cleanups: readonly (() => void | Promise<void>)[],
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 0) return;
  if (primary.failed)
    throw new AggregateError(
      [primary.error, ...cleanupErrors],
      'Workflow event stream failed and its cleanup was incomplete',
    );
  if (cleanupErrors.length === 1) {
    const [cleanupError] = cleanupErrors;
    throw cleanupError instanceof Error
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
