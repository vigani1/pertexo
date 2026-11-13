import type { Pool, PoolClient } from 'pg';

import { APP_SETTING_NAMES } from '../../tenant-access/app-settings.js';
import type { DatabasePoolRole } from './policy.js';

/**
 * A fresh connection already carried app.* settings, so every transaction on
 * the pool would inherit them. Platform and multi-workspace transactions set
 * no tenant context of their own, so they would run inside it.
 */
export class InheritedSessionContextError extends Error {
  public override readonly name = 'InheritedSessionContextError';

  public constructor(
    public readonly role: DatabasePoolRole,
    public readonly settings: readonly string[],
  ) {
    super(
      `PostgreSQL ${role} pool refused: a fresh connection already carries ${settings.join(', ')}. ` +
        'Remove it from PGOPTIONS, the connection string options, or the role or database defaults.',
    );
  }
}

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  release: (destroy?: boolean | Error) => void,
) => void;

/**
 * Proves, once per pool, that a fresh connection carries no app.* setting
 * before the pool hands out any client. The proof runs one query on the
 * first client a caller checks out, before that caller gets it: the pool
 * takes no extra checkout, so its acquire and release events, and where a
 * cancellation lands, stay as they would be without the check. A refusal
 * destroys that client and is permanent; a failure to read the settings
 * destroys only that client, and the next checkout tries again. Startup
 * options, role defaults and database defaults apply to every connection a
 * pool opens, so the first one stands for all of them.
 */
export function refuseInheritedSessionContext(
  pool: Pool,
  role: DatabasePoolRole,
): void {
  // pg's two overloads of the same checkout, captured before it is wrapped.
  const bound = pool.connect.bind(pool);
  const connect = bound as () => Promise<PoolClient>;
  const connectWith = bound as (callback: ConnectCallback) => void;
  let clean = false;
  let refusal: InheritedSessionContextError | undefined;
  let inspection: Promise<void> | undefined;
  /** Settles once the pool is proven clean, inspecting this client when no other inspection runs. */
  const prove = async (client: PoolClient): Promise<void> => {
    while (!clean) {
      if (refusal !== undefined) throw refusal;
      if (inspection === undefined) {
        inspection = inspectFreshSession(client, role).then(
          () => {
            clean = true;
          },
          (error: unknown) => {
            if (error instanceof InheritedSessionContextError) refusal = error;
            inspection = undefined;
            throw error;
          },
        );
        await inspection;
        return;
      }
      // Another checkout's client is being inspected. A refusal applies to
      // this client too; any other failure leaves the proof to this one.
      await inspection.catch((error: unknown) => {
        if (error instanceof InheritedSessionContextError) throw error;
      });
    }
  };
  const proven = async (client: PoolClient): Promise<PoolClient> => {
    if (clean) return client;
    try {
      await prove(client);
    } catch (error: unknown) {
      client.release(true);
      throw error;
    }
    return client;
  };
  pool.connect = ((callback?: ConnectCallback): unknown => {
    if (callback === undefined) {
      if (refusal !== undefined) return Promise.reject(refusal);
      return connect().then(proven);
    }
    if (refusal !== undefined) {
      const refused = refusal;
      queueMicrotask(() => {
        callback(refused, undefined, () => undefined);
      });
      return undefined;
    }
    connectWith((error, client, release) => {
      if (error !== undefined || client === undefined || clean) {
        callback(error, client, release);
        return;
      }
      prove(client).then(
        () => {
          callback(undefined, client, release);
        },
        (failure: unknown) => {
          release(true);
          callback(
            failure instanceof Error ? failure : new Error(String(failure)),
            undefined,
            () => undefined,
          );
        },
      );
    });
    return undefined;
  }) as Pool['connect'];
}

/**
 * The app.* settings a connection carries, by name. PostgreSQL lists no
 * placeholder settings in pg_settings, so the names come from
 * APP_SETTING_NAMES. Reading current_setting takes no lock and scans no
 * catalog, so a new pool's first connection never waits behind DDL or a
 * maintenance lock.
 */
const CARRIED_APP_SETTINGS = `
  select name from unnest($1::text[]) name
   where coalesce(current_setting(name, true), '') <> ''
   order by name`;

/** Reads the settings a fresh client carries; the caller destroys the client if this throws. */
async function inspectFreshSession(
  client: PoolClient,
  role: DatabasePoolRole,
): Promise<void> {
  const result = await client.query<{ name: string }>(CARRIED_APP_SETTINGS, [
    APP_SETTING_NAMES,
  ]);
  const settings = result.rows.map((row) => row.name);
  if (settings.length > 0)
    throw new InheritedSessionContextError(role, settings);
}
