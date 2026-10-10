import { DrizzleQueryError } from 'drizzle-orm';

/** Keep the database failure that raw authentication commands exposed. */
export function identityQueryFailure(error: unknown): unknown {
  return error instanceof DrizzleQueryError ? (error.cause ?? error) : error;
}

export function rethrowIdentityQueryFailure(error: unknown): never {
  throw identityQueryFailure(error);
}
