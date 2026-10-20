import {
  PostgresDialect,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import type { Pool, PoolClient } from 'pg';
import type { AuthenticationTransactions } from './context.js';

/** Kysely compiles normal PostgreSQL; the caller owns this connection's lifetime. */
export class AuthenticationTransactionDialect extends PostgresDialect {
  readonly #transactions: AuthenticationTransactions;
  constructor(pool: Pool, transactions: AuthenticationTransactions) {
    super({ pool });
    this.#transactions = transactions;
  }
  override createDriver(): Driver {
    const transactions = this.#transactions;
    return {
      init: () => Promise.resolve(),
      acquireConnection: () =>
        Promise.resolve(
          new TransactionConnection(transactions.require().client),
        ),
      releaseConnection: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
      beginTransaction: rejectNestedTransaction,
      commitTransaction: rejectNestedTransaction,
      rollbackTransaction: rejectNestedTransaction,
    };
  }
}
function rejectNestedTransaction(): Promise<void> {
  throw new Error('Authentication transaction is owned by the request');
}
class TransactionConnection implements DatabaseConnection {
  readonly #client: PoolClient;
  constructor(client: PoolClient) {
    this.#client = client;
  }
  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.#client.query(query.sql, [...query.parameters]);
    return {
      rows: result.rows as R[],
      ...(result.rowCount !== null &&
      ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(result.command)
        ? { numAffectedRows: BigInt(result.rowCount) }
        : {}),
    };
  }
  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Authentication queries do not stream');
  }
}
