import type { Pool, PoolClient } from 'pg';

import { acquireAbortablePoolClient } from '../../platform/abortable-pool-checkout.js';
import { destroyCanceledPoolClient } from '../../platform/pool-client-disposal.js';

export type InboxWriteActivity = Readonly<{
  track<T>(promise: Promise<T>): Promise<T>;
  failDisposal(): void;
}>;

export type InboxWriteTransactionResult<T> =
  | Readonly<{ kind: 'committed'; value: T }>
  | Readonly<{ kind: 'rolled_back'; error: unknown }>
  | Readonly<{ kind: 'uncertain'; error: unknown }>;

/** Feature-owned transaction: rollback knowledge must not leak into callers. */
export async function runInboxWriteTransaction<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  activity: InboxWriteActivity,
  statement: string,
  values: readonly unknown[],
  decode: (value: unknown) => T,
  mode: 'capture' | 'projection',
): Promise<InboxWriteTransactionResult<T>> {
  const statementMillis = mode === 'capture' ? 5_000 : 2_000;
  const checkout = new AbortController();
  const checkoutTimer = setTimeout(() => {
    checkout.abort();
  }, 2_000);
  const checkoutSignal = AbortSignal.any([signal, checkout.signal]);
  let client: PoolClient;
  try {
    client = await acquireAbortablePoolClient(
      { connect: () => activity.track(pool.connect()) },
      checkoutSignal,
      () => new Error('Inbox capture checkout canceled'),
      (lateClient) => {
        try {
          lateClient.release();
        } catch {
          activity.failDisposal();
        }
      },
    );
  } catch (error: unknown) {
    return { kind: 'uncertain', error };
  } finally {
    clearTimeout(checkoutTimer);
  }
  let released = false;
  let disposal: Promise<void> | undefined;
  const ownsClient = (): boolean => !released;
  let state: 'starting' | 'open' | 'committing' | 'closed' = 'starting';
  const dispose = (): void => {
    if (released) return;
    released = true;
    // The pinned pg driver rejects local query promises before its socket-end
    // handler drains outstanding queries. Observe driver end BEFORE requesting
    // cancellation/removal; release(error) can itself wait for pipeline drain.
    // _ended covers a read timeout whose connection already ended before catch.
    const ended = (client as PoolClient & { readonly _ended?: boolean })._ended;
    disposal = activity.track(
      new Promise<void>((resolve) => {
        if (ended === true) resolve();
        else client.once('end', resolve);
      }),
    );
    try {
      destroyCanceledPoolClient(client, new Error('Inbox capture canceled'));
    } catch {
      activity.failDisposal();
    }
  };
  const query = async (text: string, parameters: readonly unknown[] = []) => {
    signal.throwIfAborted();
    const result = await activity.track(client.query(text, [...parameters]));
    signal.throwIfAborted();
    return result;
  };
  const verifyClean = async (): Promise<void> => {
    const result = await query(
      `select nullif(current_setting('app.workspace_id',true),'') workspace,
              nullif(current_setting('app.actor_id',true),'') actor,
              nullif(current_setting('app.discovery_scope',true),'') discovery`,
    );
    const row: unknown = result.rows[0];
    if (
      typeof row !== 'object' ||
      row === null ||
      !('workspace' in row) ||
      row.workspace !== null ||
      !('actor' in row) ||
      row.actor !== null ||
      !('discovery' in row) ||
      row.discovery !== null
    )
      throw new Error('Inbox capture client context is not clean');
  };
  signal.addEventListener('abort', dispose, { once: true });
  if (signal.aborted) dispose();
  try {
    await verifyClean();
    await query('begin');
    state = 'open';
    const settings = await query(
      `select set_config('app.workspace_id',$1,true) workspace,
              set_config('lock_timeout','1000ms',true) lock_timeout,
              set_config('statement_timeout',$2,true) statement_timeout`,
      [workspaceId, `${String(statementMillis)}ms`],
    );
    const row: unknown = settings.rows[0];
    if (
      typeof row !== 'object' ||
      row === null ||
      !('workspace' in row) ||
      row.workspace !== workspaceId
    )
      throw new Error('Inbox capture context verification failed');
    const configured =
      await query(`select current_setting('app.workspace_id',true) workspace,
      (select setting::bigint from pg_settings where name='lock_timeout') lock_millis,
      (select setting::bigint from pg_settings where name='statement_timeout') statement_millis`);
    const actual: unknown = configured.rows[0];
    if (
      typeof actual !== 'object' ||
      actual === null ||
      !('workspace' in actual) ||
      actual.workspace !== workspaceId ||
      !('lock_millis' in actual) ||
      Number(actual.lock_millis) !== 1_000 ||
      !('statement_millis' in actual) ||
      Number(actual.statement_millis) !== statementMillis
    )
      throw new Error('Inbox capture transaction budgets are incompatible');
    const result = await query(statement, values);
    const value = decode(result.rows[0]);
    state = 'committing';
    await query('commit');
    state = 'closed';
    await verifyClean();
    try {
      client.release();
      released = true;
    } catch {
      released = true;
      activity.failDisposal();
      throw new Error('Inbox capture client release failed');
    }
    return { kind: 'committed', value };
  } catch (error: unknown) {
    let rollbackKnown = false;
    if (ownsClient() && state === 'open' && !signal.aborted) {
      try {
        await activity.track(client.query('rollback'));
        state = 'closed';
        rollbackKnown = true;
      } catch {
        // A rejected rollback is not evidence that this write was undone.
      }
    }
    dispose();
    // Confirmed rollback permits failure accounting, but never on a still-owned
    // connection. Uncertain outcomes return promptly while activity retains
    // admission until both query settlement and driver end are observed.
    if (rollbackKnown) await disposal;
    return { kind: rollbackKnown ? 'rolled_back' : 'uncertain', error };
  } finally {
    signal.removeEventListener('abort', dispose);
  }
}
