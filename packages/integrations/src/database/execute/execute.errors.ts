import type { PostgresFailureCode } from '@pertexo/workflow-model';
import {
  NodeExecutorFailure,
  type NodeExecutorFailureKind,
  type NodeExecutorErrorKind,
} from '@pertexo/node-sdk/server';
import { providerFailure } from '../../providers/provider.errors.js';

import type { PostgresOutcome } from '../postgres-client.js';

const MESSAGES = {
  address_blocked:
    'The database destination is blocked by the outbound network policy.',
  tls_failed: 'The database TLS settings or certificate were rejected.',
  connection_refused: 'The database refused the connection.',
  connection_failed: 'The database connection failed.',
  authentication_failed: 'The database rejected the credentials.',
  timeout: 'The database operation timed out.',
  syntax_error: 'PostgreSQL reported a SQL syntax error.',
  constraint_violation: 'The operation violated a database constraint.',
  read_only: 'The operation is forbidden on a read-only connection.',
  serialization: 'PostgreSQL could not serialize the transaction.',
  query_failed: 'PostgreSQL could not execute the query.',
  row_limit: 'The database returned more rows than the step allows.',
  result_limit: 'The database result exceeds the step’s size limit.',
  invalid_columns: 'The table or mapped columns do not match the database.',
  key_not_unique: 'The selected key column needs a non-null unique index.',
  canceled: 'The database operation was canceled.',
} satisfies Record<PostgresFailureCode, string>;

export const databaseFailure = providerFailure(NodeExecutorFailure);

export function postgresExecutorFailure(
  outcome: Extract<PostgresOutcome, { kind: 'failed' }>,
) {
  const { code, position, ambiguous } = outcome;
  return new NodeExecutorFailure({
    kind: failureKind(code, ambiguous),
    errorKind: errorKind(code),
    possiblyDispatched: ambiguous,
    safeErrorCode: `database.${code}`,
    errorSummary:
      position === undefined
        ? MESSAGES[code]
        : `${MESSAGES[code]} Position ${String(position)}.`,
  });
}

function failureKind(
  code: PostgresFailureCode,
  ambiguous: boolean,
): NodeExecutorFailureKind {
  if (ambiguous) return 'outcome_unknown';
  if (code === 'canceled') return 'canceled';
  if (
    code === 'timeout' ||
    code === 'connection_refused' ||
    code === 'connection_failed' ||
    code === 'serialization'
  )
    return 'retry';
  return 'failed';
}

function errorKind(code: PostgresFailureCode): NodeExecutorErrorKind {
  switch (code) {
    case 'authentication_failed':
      return 'authentication';
    case 'timeout':
      return 'timeout';
    case 'canceled':
      return 'canceled';
    case 'connection_refused':
    case 'connection_failed':
      return 'network';
    case 'address_blocked':
    case 'constraint_violation':
    case 'invalid_columns':
    case 'key_not_unique':
    case 'query_failed':
    case 'read_only':
    case 'result_limit':
    case 'row_limit':
    case 'serialization':
    case 'syntax_error':
    case 'tls_failed':
      return 'provider';
  }
}
