import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import { Pool, type PoolClient } from 'pg';

import { createWorkflowAuthoringFixtureDatabase } from '../workflow-authoring-admission.fixture.js';
import { adminDatabaseUrl, apiUrl } from './base.js';
import { waitForPostgresLock, withApplicationName } from './coordination.js';

/** What a forced-order test opened, undone once it ends, however it ends. */
export function cleanups() {
  const steps: (() => Promise<unknown>)[] = [];
  return {
    add: (step: () => Promise<unknown>) => void steps.push(step),
    run: async () => {
      const failures = (
        await Promise.allSettled(
          steps
            .splice(0)
            .reverse()
            .map((one) => one()),
        )
      ).flatMap((result) => (result.status === 'rejected' ? [result] : []));
      if (failures.length > 0)
        throw new AggregateError(
          failures.map((failure) => failure.reason as unknown),
          'Forced-order cleanup failed',
        );
    },
  };
}

/**
 * Takes a row lock from a connection of the test's own and keeps it, so that a
 * flow stops at the statement that wants that row, with what it locked before it.
 */
export async function holdRow(lockStatement: string, id: string) {
  const pool = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
  const client: PoolClient = await pool.connect();
  await client.query('begin');
  const held = await client.query(lockStatement, [id]);
  if (held.rowCount !== 1) throw new Error(`No row to hold: ${lockStatement}`);
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await client.query('rollback');
      client.release();
      await pool.end();
    },
  };
}

/**
 * A store of its own on one named connection, so a test can see that this flow,
 * and no other, is the one waiting on a lock.
 */
export function namedStore() {
  const name = `forced-${randomUUID()}`;
  const store = createWorkflowAuthoringFixtureDatabase(
    parseDatabaseConfig({
      connectionString: withApplicationName(apiUrl, name),
      max: 1,
    }),
  );
  return { store, waiting: () => waitForPostgresLock(name) };
}

/** Postgres ends one side of a deadlock with 40P01, however the flow words it. */
export function isDeadlock(reason: unknown): boolean {
  for (let error = reason; error instanceof Object;) {
    if ('code' in error && error.code === '40P01') return true;
    error = 'cause' in error ? error.cause : undefined;
  }
  return false;
}
