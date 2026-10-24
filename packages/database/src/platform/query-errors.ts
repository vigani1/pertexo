import { DrizzleQueryError } from 'drizzle-orm';

/** Keep the database failure that raw PostgreSQL commands exposed. */
export function queryFailure(error: unknown): unknown {
  return error instanceof DrizzleQueryError ? (error.cause ?? error) : error;
}

export function rethrowQueryFailure(error: unknown): never {
  throw queryFailure(error);
}

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
