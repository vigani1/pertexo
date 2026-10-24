import { vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';

import { adminDatabaseUrl } from './base.js';

/** A row write a command makes; tests hold or fail the command there. */
export type WritePoint = Readonly<{
  table: string;
  operation: 'insert' | 'update' | 'insert or update';
  /** Trigger condition on the written row, e.g. `NEW.workflow_id = '…'`. */
  when?: string;
}>;

let writePointSequence = 0;

async function asAdmin<T>(work: (client: PoolClient) => Promise<T>) {
  const pool = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
  try {
    const client = await pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/**
 * Installs an AFTER ROW trigger at the write in this disposable database, so
 * tests reach inside a command's transaction without hooks in the code under
 * test. Returns the trigger's removal.
 */
async function installWritePoint(
  point: WritePoint,
  body: string,
): Promise<() => Promise<void>> {
  writePointSequence += 1;
  const name = `test_write_point_${String(writePointSequence)}`;
  await asAdmin(async (client) => {
    await client.query(
      `create function app.${name}() returns trigger language plpgsql
       as $$ begin ${body} return null; end $$`,
    );
    await client.query(
      `create trigger ${name} after ${point.operation} on app.${point.table}
       for each row ${point.when === undefined ? '' : `when (${point.when})`}
       execute function app.${name}()`,
    );
  });
  return () =>
    asAdmin(async (client) => {
      await client.query(
        `drop trigger if exists ${name} on app.${point.table}`,
      );
      await client.query(`drop function if exists app.${name}()`);
    });
}

/** Fails the command at this write, so its transaction rolls back. */
export async function failAtWrite(
  point: WritePoint,
): Promise<Readonly<{ message: string; remove: () => Promise<void> }>> {
  const message = `injected failure at ${point.table} ${point.operation}`;
  const remove = await installWritePoint(
    point,
    `raise exception '${message}';`,
  );
  return { message, remove };
}

/**
 * Holds the command just after this write, with every lock it has taken,
 * until released. Later writes at the point pass once it is released.
 */
export async function holdAtWrite(point: WritePoint): Promise<
  Readonly<{
    /** Resolves once a command waits at the point. */
    reached: () => Promise<void>;
    release: () => Promise<void>;
    remove: () => Promise<void>;
  }>
> {
  const key = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
  const holder = new Pool({ connectionString: adminDatabaseUrl, max: 2 });
  const client = await holder.connect();
  await client.query('select pg_advisory_lock($1)', [key]);
  const remove = await installWritePoint(
    point,
    `perform pg_advisory_xact_lock(${String(key)});`,
  );
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      await client.query('select pg_advisory_unlock($1)', [key]);
    } finally {
      client.release();
      await holder.end();
    }
  };
  return {
    reached: async () => {
      await vi.waitUntil(
        async () => {
          const waiting = await holder.query(
            `select 1 from pg_locks where locktype = 'advisory'
             and objid = $1 and not granted`,
            [key],
          );
          return waiting.rowCount !== 0;
        },
        { timeout: 5_000, interval: 10 },
      );
    },
    release,
    remove: async () => {
      await release();
      await remove();
    },
  };
}
