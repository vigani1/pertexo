import type { Pool, PoolClient, QueryResult } from 'pg';

import { destroyCanceledPoolClient } from '../platform/pool-client-disposal.js';

type OperatorPool = Pick<Pool, 'connect'>;

export type OperatorTransactionTimeouts = Readonly<{
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}>;

type TransactionOutcome<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>;

function safeError(error: unknown, message: string): Error {
  try {
    if (error instanceof Error) return error;
  } catch {
    // A hostile rejection cannot prevent disposal of its checked-out client.
  }
  return new Error(message, { cause: error });
}

async function acquireOperatorClient(
  pool: OperatorPool,
  signal?: AbortSignal,
): Promise<PoolClient> {
  signal?.throwIfAborted();
  const pending = pool.connect();
  if (signal === undefined) return pending;

  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => {
      try {
        signal.throwIfAborted();
      } catch (error: unknown) {
        reject(safeError(error, 'Operator client checkout aborted'));
      }
    };
  });
  const onAbort = (): void => rejectAbort?.();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([pending, aborted]);
  } catch (error: unknown) {
    if (signal.aborted) {
      void pending.then(
        (client) => {
          client.release();
        },
        () => undefined,
      );
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function query<Row extends Record<string, unknown>>(
  client: PoolClient,
  text: string,
  values: readonly unknown[],
  signal?: AbortSignal,
): Promise<QueryResult<Row>> {
  signal?.throwIfAborted();
  try {
    const result = await client.query<Row>({ text, values: [...values] });
    signal?.throwIfAborted();
    return result;
  } catch (error: unknown) {
    signal?.throwIfAborted();
    throw error;
  }
}

function releaseClient(
  client: PoolClient,
  poison: boolean,
  outcome: TransactionOutcome<unknown>,
): void {
  try {
    client.release(poison ? true : undefined);
  } catch (releaseError: unknown) {
    if (!outcome.ok)
      throw new AggregateError(
        [outcome.error, releaseError],
        'Operator command client release failed',
      );
    throw releaseError;
  }
}

/** Owns checkout, cancellation, transaction settlement, and client disposal. */
export async function runOperatorTransaction<
  Row extends Record<string, unknown>,
  Result = QueryResult<Row>,
>(
  pool: OperatorPool,
  timeouts: OperatorTransactionTimeouts,
  text: string,
  values: readonly unknown[],
  signal?: AbortSignal,
  decode: (result: QueryResult<Row>) => Result = (result) => result as Result,
): Promise<Result> {
  const client = await acquireOperatorClient(pool, signal);
  let state: 'not_started' | 'open' | 'committing' | 'closed' = 'not_started';
  let released = false;
  let poison = false;
  const ownsClient = (): boolean => !released;

  const destroyForAbort = (): void => {
    if (released || signal === undefined) return;
    released = true;
    try {
      destroyCanceledPoolClient(
        client,
        safeError(signal.reason, 'Operator command aborted'),
      );
    } catch {
      // Caller cancellation remains authoritative after socket disposal starts.
    }
  };
  signal?.addEventListener('abort', destroyForAbort, { once: true });
  if (signal?.aborted === true) destroyForAbort();

  let outcome: TransactionOutcome<Result>;
  try {
    signal?.throwIfAborted();
    await query(client, 'begin', [], signal);
    state = 'open';
    await query(
      client,
      "select set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
      [String(timeouts.lockTimeoutMs), String(timeouts.statementTimeoutMs)],
      signal,
    );
    const result = await query<Row>(client, text, values, signal);
    const decoded = decode(result);
    state = 'committing';
    await query(client, 'commit', [], signal);
    state = 'closed';
    outcome = { ok: true, value: decoded };
  } catch (error: unknown) {
    let primary = error;
    if (ownsClient() && state === 'open') {
      try {
        await client.query('rollback');
        state = 'closed';
      } catch (rollbackError: unknown) {
        poison = true;
        primary = new AggregateError(
          [error, rollbackError],
          'Operator command transaction rollback failed',
        );
      }
    } else if (ownsClient() && state === 'committing') {
      // A missing COMMIT acknowledgement is an uncertain durable outcome.
      poison = true;
    }
    outcome = { ok: false, error: primary };
  }

  signal?.removeEventListener('abort', destroyForAbort);
  if (ownsClient()) releaseClient(client, poison, outcome);
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}
