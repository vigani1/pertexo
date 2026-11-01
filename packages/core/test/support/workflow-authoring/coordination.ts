import { expect } from 'vitest';
import { Pool, type PoolClient } from 'pg';

import { adminUrl, databaseName } from './base.js';

export function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export async function waitForOperationEntry(
  entry: Promise<void>,
  operation: Promise<unknown>,
  label: string,
): Promise<void> {
  await Promise.race([
    entry,
    operation.then(
      () => {
        throw new Error(`${label} settled before its test hook`);
      },
      (error: unknown) => {
        throw error;
      },
    ),
  ]);
}

export async function finishControlledScenario(
  input: Readonly<{
    close: readonly (() => Promise<void>)[];
    label: string;
    operations: readonly (Promise<unknown> | undefined)[];
    primaryError: unknown;
    release: () => void;
  }>,
): Promise<void> {
  input.release();
  await Promise.allSettled(
    input.operations.filter(
      (operation): operation is Promise<unknown> => operation !== undefined,
    ),
  );
  const settled = await Promise.allSettled(input.close.map((close) => close()));
  const cleanupFailures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (input.primaryError !== undefined) {
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [input.primaryError, ...cleanupFailures],
        `${input.label} and cleanup failed`,
      );
    if (input.primaryError instanceof Error) throw input.primaryError;
    throw new Error(`${input.label} failed`, { cause: input.primaryError });
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1)
    throw new AggregateError(cleanupFailures, `${input.label} cleanup failed`);
}

export async function finishTransactionClient(
  client: PoolClient,
  input: Readonly<{
    label: string;
    primaryError: unknown;
    transactionOpen: boolean;
  }>,
): Promise<void> {
  const cleanupFailures: unknown[] = [];
  let disposalError: Error | undefined;
  if (input.transactionOpen) {
    try {
      await client.query('rollback');
    } catch (error: unknown) {
      disposalError = new Error(`${input.label} rollback failed`, {
        cause: error,
      });
      cleanupFailures.push(disposalError);
    }
  }
  try {
    client.release(disposalError);
  } catch (error: unknown) {
    cleanupFailures.push(error);
  }
  if (input.primaryError !== undefined) {
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [input.primaryError, ...cleanupFailures],
        `${input.label} and cleanup failed`,
      );
    if (input.primaryError instanceof Error) throw input.primaryError;
    throw new Error(`${input.label} failed`, { cause: input.primaryError });
  }
  if (cleanupFailures.length === 1) {
    const cleanupFailure = cleanupFailures[0];
    if (cleanupFailure instanceof Error) throw cleanupFailure;
    throw new Error(`${input.label} cleanup failed`, {
      cause: cleanupFailure,
    });
  }
  if (cleanupFailures.length > 1)
    throw new AggregateError(cleanupFailures, `${input.label} cleanup failed`);
}

export function withApplicationName(base: string, applicationName: string) {
  const url = new URL(base);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

export async function waitForPostgresLock(
  applicationName: string,
): Promise<void> {
  const monitor = new Pool({
    connectionString: adminUrl,
    connectionTimeoutMillis: 1_000,
    max: 1,
  });
  try {
    await expect
      .poll(
        async () => {
          const result = await monitor.query<{
            blockers: number[];
            pid: number;
          }>(
            `select pid, pg_blocking_pids(pid) blockers
           from pg_stat_activity
          where datname = $1 and application_name = $2
            and wait_event_type = 'Lock'`,
            [databaseName, applicationName],
          );
          return (
            result.rows.length === 1 &&
            (result.rows[0]?.blockers.length ?? 0) > 0
          );
        },
        { timeout: 5_000, interval: 10 },
      )
      .toBe(true);
  } finally {
    await monitor.end();
  }
}
