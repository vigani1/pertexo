import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';

type AuthenticationTransaction = Readonly<{
  client: PoolClient;
  afterCommit: (deliver: () => Promise<void>) => void;
}>;

/** One runtime's explicit transaction, isolated across concurrent requests. */
export class AuthenticationTransactions {
  readonly #current = new AsyncLocalStorage<AuthenticationTransaction>();

  current(): AuthenticationTransaction | undefined {
    return this.#current.getStore();
  }

  require(): AuthenticationTransaction {
    const transaction = this.current();
    if (transaction === undefined)
      throw new Error('Security changes require an authentication transaction');
    return transaction;
  }

  run<T>(transaction: AuthenticationTransaction, operation: () => T): T {
    return this.#current.run(transaction, operation);
  }
}
