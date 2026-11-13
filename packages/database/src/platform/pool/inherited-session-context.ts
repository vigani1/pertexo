import type { Pool, PoolClient } from 'pg';

import { TENANT_SETTING_NAMES } from '../../tenant-access/transactions/scope.js';
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
 * before the pool hands out any client. The first checkout runs one query on
 * that first connection; a refusal is permanent, while a failure to reach the
 * database is retried by the next checkout. Startup options, role defaults
 * and database defaults apply to every connection a pool opens, so the first
 * one stands for all of them.
 */
export function refuseInheritedSessionContext(
  pool: Pool,
  role: DatabasePoolRole,
): void {
  // pg's two overloads of the same checkout, captured before it is wrapped.
  const bound = pool.connect.bind(pool);
  const connect = bound as () => Promise<PoolClient>;
  const connectWith = bound as (callback: ConnectCallback) => void;
  let proof: Promise<void> | undefined;
  const proven = (): Promise<void> => {
    proof ??= inspectFreshSession(connect, role).catch((error: unknown) => {
      if (!(error instanceof InheritedSessionContextError)) proof = undefined;
      throw error;
    });
    return proof;
  };
  pool.connect = ((callback?: ConnectCallback): unknown => {
    if (callback === undefined) return proven().then(connect);
    proven().then(
      () => {
        connectWith(callback);
      },
      (error: unknown) => {
        callback(
          error instanceof Error ? error : new Error(String(error)),
          undefined,
          () => undefined,
        );
      },
    );
    return undefined;
  }) as Pool['connect'];
}

/**
 * The app.* settings a connection carries, by name: PostgreSQL lists no
 * placeholder settings in pg_settings, so the names are every app.* setting
 * the schema's row-security policies and app functions read, plus the
 * tenant settings this package installs (so an unmigrated database is
 * checked too).
 */
const CARRIED_APP_SETTINGS = `
  with source(text) as (
    select pg_get_expr(pol.polqual, pol.polrelid) from pg_policy pol
    union all
    select pg_get_expr(pol.polwithcheck, pol.polrelid) from pg_policy pol
    union all
    select fn.prosrc from pg_proc fn
      join pg_namespace ns on ns.oid = fn.pronamespace
     where ns.nspname = 'app'
  ), setting(name) as (
    select (regexp_matches(text, 'current_setting\\(''(app\\.[a-z_]+)''', 'g'))[1]
      from source where text is not null
    union
    select unnest($1::text[])
  )
  select name from setting
   where coalesce(current_setting(name, true), '') <> ''
   order by name`;

async function inspectFreshSession(
  connect: () => Promise<PoolClient>,
  role: DatabasePoolRole,
): Promise<void> {
  const client = await connect();
  let settings: string[];
  try {
    const result = await client.query<{ name: string }>(CARRIED_APP_SETTINGS, [
      TENANT_SETTING_NAMES,
    ]);
    settings = result.rows.map((row) => row.name);
  } catch (error: unknown) {
    client.release(true);
    throw error;
  }
  if (settings.length > 0) {
    client.release(true);
    throw new InheritedSessionContextError(role, settings);
  }
  client.release();
}
