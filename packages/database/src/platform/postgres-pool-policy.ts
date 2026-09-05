import type { PoolConfig } from 'pg';

export type DatabasePoolRole =
  | 'api'
  | 'dispatcher'
  | 'lifecycle_command'
  | 'maintenance'
  | 'operator'
  | 'other'
  | 'worker';

const databaseDeadlineBudget: Readonly<
  Record<
    DatabasePoolRole,
    Readonly<{
      idleTransactionMs: number;
      lockMs: number;
      queryMs: number;
      statementMs: number;
    }>
  >
> = Object.freeze({
  api: Object.freeze({
    idleTransactionMs: 35_000,
    lockMs: 5_000,
    queryMs: 35_000,
    statementMs: 30_000,
  }),
  dispatcher: Object.freeze({
    idleTransactionMs: 125_000,
    lockMs: 10_000,
    queryMs: 125_000,
    statementMs: 120_000,
  }),
  lifecycle_command: Object.freeze({
    idleTransactionMs: 305_000,
    lockMs: 15_000,
    queryMs: 305_000,
    statementMs: 300_000,
  }),
  maintenance: Object.freeze({
    idleTransactionMs: 305_000,
    lockMs: 15_000,
    queryMs: 305_000,
    statementMs: 300_000,
  }),
  operator: Object.freeze({
    idleTransactionMs: 305_000,
    lockMs: 15_000,
    queryMs: 305_000,
    statementMs: 300_000,
  }),
  other: Object.freeze({
    idleTransactionMs: 35_000,
    lockMs: 5_000,
    queryMs: 35_000,
    statementMs: 30_000,
  }),
  worker: Object.freeze({
    idleTransactionMs: 125_000,
    lockMs: 10_000,
    queryMs: 125_000,
    statementMs: 120_000,
  }),
});

function positiveTimeout(
  value: unknown,
  fallback: number,
  name: string,
): number {
  const selected = value === undefined ? fallback : value;
  if (
    typeof selected !== 'number' ||
    !Number.isSafeInteger(selected) ||
    selected <= 0
  )
    throw new RangeError(`${name} must be a positive safe integer`);
  return selected;
}

export function withDatabaseDeadlineBudget(
  config: PoolConfig,
  role: DatabasePoolRole,
): PoolConfig {
  const budget = databaseDeadlineBudget[role];
  return {
    ...config,
    idle_in_transaction_session_timeout: positiveTimeout(
      config.idle_in_transaction_session_timeout,
      budget.idleTransactionMs,
      'idle_in_transaction_session_timeout',
    ),
    lock_timeout: positiveTimeout(
      config.lock_timeout,
      budget.lockMs,
      'lock_timeout',
    ),
    query_timeout: positiveTimeout(
      config.query_timeout,
      budget.queryMs,
      'query_timeout',
    ),
    statement_timeout: positiveTimeout(
      config.statement_timeout,
      budget.statementMs,
      'statement_timeout',
    ),
  };
}
