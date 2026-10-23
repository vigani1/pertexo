/** Inspect the selected PostgreSQL cause without changing its error boundary. */
export function isUniqueConstraintFailure(
  error: unknown,
): error is Readonly<{ code: '23505'; constraint?: unknown }> {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}
