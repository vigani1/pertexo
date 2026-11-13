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
 * with the transaction, and a plain set_config column returns the value it
 * set under its alias. It evaluates no other SQL: a computed column, such as
 * the statement timeout in milliseconds, comes only from `computed`, which
 * stands for what PostgreSQL would compute (the database integration tests
 * check PostgreSQL's own conversion). A test can fail a statement, or report
 * a value other than the one set, to reach failures a healthy server never
 * produces.
 */
export function postgresConnection(
  options: Readonly<{
    fail?: Partial<Record<Statement, Error>>;
    onStatement?: (statement: Statement) => void;
    computed?: Readonly<Record<string, unknown>>;
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
    const argument = (parameter: string) =>
      String(values[Number(parameter) - 1]);
    for (const [, name, parameter] of statement.matchAll(
      /set_config\('([^']+)',\$(\d+),true\)/gu,
    ))
      if (transactionActive && name !== undefined && parameter !== undefined)
        local.set(name, argument(parameter));
    const row: Record<string, unknown> = { ...options.computed };
    for (const [, , parameter, alias] of statement.matchAll(
      /(?:^select |,)set_config\('([^']+)',\$(\d+),true\) "(\w+)"/gu,
    ))
      if (alias !== undefined && parameter !== undefined)
        row[alias] = argument(parameter);
    if (options.reported === 'no row') return Promise.resolve(result());
    return Promise.resolve(result([{ ...row, ...options.reported }]));
  };
  return {
    query,
    statements,
    /** The settings a statement would see now, as they were set. */
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
