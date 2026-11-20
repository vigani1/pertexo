import type { PostgresFailureCode } from '@pertexo/workflow-model';
import type { PostgresOutcome } from './secure-postgres-client.types.js';

export class PostgresError extends Error {
  constructor(public readonly code: PostgresFailureCode) {
    super(code);
  }
}

export function postgresFailure(
  error: unknown,
  stage: 'connect' | 'query' | 'commit',
): Extract<PostgresOutcome, { kind: 'failed' }> {
  if (error instanceof PostgresError)
    return failure(error.code, stage === 'commit');
  const code =
    error instanceof Error && 'code' in error ? error.code : undefined;
  if (code === 'ETIMEDOUT') return failure('timeout', stage === 'commit');
  const sqlFailure = classifySqlState(code);
  if (sqlFailure === undefined) return classifyTransport(error, code, stage);
  if (sqlFailure === 'syntax_error') {
    const position =
      error instanceof Error && 'position' in error
        ? Number(error.position)
        : NaN;
    return {
      ...failure('syntax_error'),
      ...(Number.isSafeInteger(position) && position > 0 ? { position } : {}),
    };
  }
  return failure(sqlFailure);
}

function failure(code: PostgresFailureCode, ambiguous = false) {
  return { kind: 'failed', code, ambiguous } as const;
}

const SQL_FAILURES: ReadonlyMap<string, PostgresFailureCode> = new Map([
  ['28P01', 'authentication_failed'],
  ['28000', 'authentication_failed'],
  ['57014', 'timeout'],
  ['40001', 'serialization'],
  ['40P01', 'serialization'],
  ['25006', 'read_only'],
  ['42601', 'syntax_error'],
]);

function classifySqlState(code: unknown): PostgresFailureCode | undefined {
  if (typeof code !== 'string') return undefined;
  return code.startsWith('23')
    ? 'constraint_violation'
    : SQL_FAILURES.get(code);
}

function classifyTransport(
  error: unknown,
  code: unknown,
  stage: 'connect' | 'query' | 'commit',
) {
  const message = error instanceof Error ? error.message : undefined;
  if (
    message === 'The server does not support SSL connections' ||
    (typeof code === 'string' &&
      /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_VERIFY_|UNABLE_TO_GET_ISSUER_)/u.test(
        code,
      ))
  )
    return failure('tls_failed', stage === 'commit');
  if (code === 'ECONNREFUSED') return failure('connection_refused');
  if (
    stage !== 'query' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === '57P01' ||
    (typeof code === 'string' && code.startsWith('08')) ||
    message === 'Connection terminated unexpectedly' ||
    message === 'Client has encountered a connection error and is not queryable'
  )
    return failure('connection_failed', stage === 'commit');
  return failure('query_failed');
}
