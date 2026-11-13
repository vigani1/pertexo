import type { Pool, PoolClient, QueryResult } from 'pg';

export const workspaceId = '11111111-1111-4111-8111-111111111111';

export const actorId = '22222222-2222-4222-8222-222222222222';

export function result(
  rows: readonly Record<string, unknown>[] = [],
): QueryResult {
  return { rows } as unknown as QueryResult;
}

export function poolWith(
  client: Readonly<Record<'query' | 'release', unknown>>,
): Pool {
  return {
    connect: () => Promise.resolve(client as PoolClient),
  } as unknown as Pool;
}

type Statement = 'begin' | 'commit' | 'rollback' | 'set_config';

/**
 * A stand-in for one PostgreSQL connection: transaction-local settings end
 * with the transaction, and set_config returns each new value under its
 * column alias. A test can fail a statement, or report a value other than
 * the one set, to reach failures a healthy server never produces.
 */
export function postgresConnection(
  options: Readonly<{
    fail?: Partial<Record<Statement, Error>>;
    onStatement?: (statement: Statement) => void;
    reported?: Readonly<Record<string, unknown>> | 'no row';
  }> = {},
) {
  const statements: string[] = [];
  let local = new Map<string, string>();
  let transactionActive = false;
  const query = (statement: string, values: readonly unknown[] = []) => {
    statements.push(statement);
    const kind = statementKind(statement);
    if (kind === undefined) return Promise.resolve(result());
    options.onStatement?.(kind);
    const failure = options.fail?.[kind];
    if (failure !== undefined) return Promise.reject(failure);
    if (kind === 'begin') transactionActive = true;
    if (kind === 'commit' || kind === 'rollback') {
      transactionActive = false;
      local = new Map();
    }
    if (kind !== 'set_config') return Promise.resolve(result());
    const row: Record<string, unknown> = {};
    for (const [, name, parameter, alias] of statement.matchAll(
      /set_config\('([^']+)',\$(\d+),true\)(?:::interval\)\*1000\)::bigint)? "(\w+)"/gu,
    )) {
      const value = String(values[Number(parameter) - 1]);
      if (transactionActive && name !== undefined) local.set(name, value);
      if (alias !== undefined)
        row[alias] =
          name === 'statement_timeout' ? String(Number.parseInt(value)) : value;
    }
    if (options.reported === 'no row') return Promise.resolve(result());
    return Promise.resolve(result([{ ...row, ...options.reported }]));
  };
  return {
    query,
    statements,
    /** The settings a statement would see now. */
    settings: (): Readonly<Record<string, string>> => Object.fromEntries(local),
    get transactionActive() {
      return transactionActive;
    },
  };
}

function statementKind(statement: string): Statement | undefined {
  if (statement.startsWith('begin')) return 'begin';
  if (statement === 'commit' || statement === 'rollback') return statement;
  if (statement.startsWith('select ') && statement.includes('set_config('))
    return 'set_config';
  return undefined;
}
