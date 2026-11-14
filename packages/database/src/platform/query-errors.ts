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

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * Shutting down, starting up, too many connections, out of time on a busy
 * server: all clear up by themselves.
 */
const TRANSIENT_POSTGRES_CODES = new Set([
  '57014',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '40001',
  '40P01',
  '55P03',
]);

/** The server ended the session: an administrator, a shutdown, a crash. */
const SESSION_ENDED_CODES = new Set(['57P01', '57P02', '57P03']);
const CONNECTION_LOST_MESSAGE =
  /^(?:Connection terminated|Connection ended unexpectedly|Client has encountered a connection error)/u;

/**
 * True when the connection itself is gone, so PostgreSQL has already ended
 * any transaction on it and nothing more can be sent there.
 */
export function isConnectionLost(error: unknown): boolean {
  const failure = queryFailure(error);
  if (!(failure instanceof Error)) return false;
  const { code } = postgresFailure(failure);
  if (code !== undefined)
    return SESSION_ENDED_CODES.has(code) || code.startsWith('08');
  return CONNECTION_LOST_MESSAGE.test(failure.message);
}

const TRANSIENT_CLIENT_MESSAGE =
  /^(?:Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|Connection ended unexpectedly|Query read timeout)/u;

/**
 * True when Postgres was unreachable, slow or briefly refused, so the same call
 * can work moments later. Anything else keeps its meaning and is never retried.
 */
export function isTransientDatabaseFailure(error: unknown): boolean {
  try {
    const failure = queryFailure(error);
    // A failure and the cleanup it broke arrive together; both must pass.
    if (failure instanceof AggregateError)
      return (
        failure.errors.length > 0 &&
        failure.errors.every(isTransientDatabaseFailure)
      );
    if (!(failure instanceof Error)) return false;
    const { code } = postgresFailure(failure);
    if (code !== undefined) {
      if (TRANSIENT_NETWORK_CODES.has(code)) return true;
      if (TRANSIENT_POSTGRES_CODES.has(code) || code.startsWith('08'))
        return true;
    }
    return TRANSIENT_CLIENT_MESSAGE.test(failure.message);
  } catch {
    // A thrown value that resists inspection is no proof of a passing outage.
    return false;
  }
}
