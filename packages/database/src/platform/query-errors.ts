import { DrizzleQueryError } from 'drizzle-orm';

/** Keep the database failure that raw PostgreSQL commands exposed. */
export function queryFailure(error: unknown): unknown {
  return error instanceof DrizzleQueryError ? (error.cause ?? error) : error;
}

export function rethrowQueryFailure(error: unknown): never {
  throw queryFailure(error);
}

export type PostgresFailure = Readonly<{
  code?: string;
  constraint?: string;
  detail?: string;
}>;

/**
 * The PostgreSQL fields a rule may branch on. Every reader goes through here,
 * so a query wrapper is unwrapped in one place and nothing else parses errors.
 */
export function postgresFailure(error: unknown): PostgresFailure {
  const failure = queryFailure(error);
  if (typeof failure !== 'object' || failure === null) return {};
  const { code, constraint, detail } = failure as Record<string, unknown>;
  return {
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof constraint === 'string' ? { constraint } : {}),
    ...(typeof detail === 'string' ? { detail } : {}),
  };
}

export function isUniqueConstraintFailure(error: unknown): boolean {
  return postgresFailure(error).code === '23505';
}
