import type { PoolClient } from 'pg';

import type { MeterState } from './metrics.js';

type QueryOperation =
  | 'begin'
  | 'call'
  | 'commit'
  | 'copy'
  | 'delete'
  | 'insert'
  | 'other'
  | 'rollback'
  | 'select'
  | 'update';

const instrumentedClients = new WeakSet<PoolClient>();

const transactionStartedAtByClient = new WeakMap<PoolClient, number>();

function queryText(query: unknown): string | undefined {
  if (typeof query === 'string') return query;
  if (
    typeof query === 'object' &&
    query !== null &&
    'text' in query &&
    typeof query.text === 'string'
  )
    return query.text;
  return undefined;
}

function queryOperation(query: unknown): QueryOperation {
  const keyword = /^\s*([a-z]+)/i
    .exec(queryText(query) ?? '')?.[1]
    ?.toLowerCase();
  if (keyword === 'start') return 'begin';
  if (
    keyword === 'begin' ||
    keyword === 'call' ||
    keyword === 'commit' ||
    keyword === 'copy' ||
    keyword === 'delete' ||
    keyword === 'insert' ||
    keyword === 'rollback' ||
    keyword === 'select' ||
    keyword === 'update'
  )
    return keyword;
  return 'other';
}

export function instrumentClient(client: PoolClient, state: MeterState): void {
  if (instrumentedClients.has(client)) return;
  instrumentedClients.add(client);

  const originalQuery = client.query.bind(client);
  const finishTransaction = (
    outcome: 'abandoned' | 'committed' | 'connection_error' | 'rolled_back',
  ): void => {
    const transactionStartedAt = transactionStartedAtByClient.get(client);
    if (transactionStartedAt === undefined) return;
    state.transactionDuration.record(
      (performance.now() - transactionStartedAt) / 1_000,
      { outcome },
    );
    transactionStartedAtByClient.delete(client);
  };
  client.query = ((...args: unknown[]) => {
    const operation = queryOperation(args[0]);
    const startedAt = performance.now();
    let recorded = false;
    const finish = (outcome: 'error' | 'success'): void => {
      if (recorded) return;
      recorded = true;
      const finishedAt = performance.now();
      state.queryDuration.record((finishedAt - startedAt) / 1_000, {
        operation,
        outcome,
      });

      if (operation === 'begin' && outcome === 'success') {
        transactionStartedAtByClient.set(client, startedAt);
      } else if (
        transactionStartedAtByClient.has(client) &&
        (operation === 'commit' || operation === 'rollback')
      ) {
        finishTransaction(
          outcome === 'error'
            ? 'connection_error'
            : operation === 'commit'
              ? 'committed'
              : 'rolled_back',
        );
      }
    };

    const callbackIndex =
      typeof args.at(-1) === 'function' ? args.length - 1 : undefined;
    if (callbackIndex !== undefined) {
      const callback = args[callbackIndex] as (...values: unknown[]) => unknown;
      args[callbackIndex] = function (this: unknown, ...values: unknown[]) {
        finish(
          values[0] === null || values[0] === undefined ? 'success' : 'error',
        );
        return callback.apply(this, values);
      };
    }

    try {
      const result = (originalQuery as (...values: unknown[]) => unknown)(
        ...args,
      );
      if (callbackIndex !== undefined) return result;
      if (
        typeof result === 'object' &&
        result !== null &&
        'then' in result &&
        typeof result.then === 'function'
      ) {
        return Promise.resolve(result).then(
          (value: unknown) => {
            finish('success');
            return value;
          },
          (error: unknown) => {
            finish('error');
            throw error;
          },
        );
      }
      return result;
    } catch (error: unknown) {
      finish('error');
      throw error;
    }
  }) as typeof client.query;
  client.once('error', () => {
    finishTransaction('connection_error');
  });
  client.once('end', () => {
    finishTransaction('connection_error');
  });
}

export function instrumentClientRelease(
  client: PoolClient,
  state: MeterState,
): void {
  const originalRelease = client.release.bind(client);
  client.release = (destroy?: boolean | Error): void => {
    const transactionStartedAt = transactionStartedAtByClient.get(client);
    if (transactionStartedAt !== undefined) {
      state.transactionDuration.record(
        (performance.now() - transactionStartedAt) / 1_000,
        { outcome: destroy ? 'connection_error' : 'abandoned' },
      );
      transactionStartedAtByClient.delete(client);
    }
    originalRelease(destroy);
  };
}
