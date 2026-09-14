import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0089_oidc_capacity_lock_time.sql',
  import.meta.url,
);

function assertOidcCapacityContract(sql: string): void {
  const normalized = sql.replaceAll(/\s+/gu, ' ').trim();
  const lock = normalized.indexOf('PERFORM pg_advisory_xact_lock(7166118815)');
  const timestamp = normalized.indexOf('admission_time := clock_timestamp()');
  const activeCount = normalized.indexOf('INTO active_count');
  if (lock < 0 || timestamp <= lock || activeCount <= timestamp)
    throw new Error(
      'OIDC admission timestamp is not owned by the acquired lock',
    );
  if (!normalized.includes('IF active_count >= 10000 THEN'))
    throw new Error('OIDC active capacity changed');
  if (!normalized.includes('IF total_count >= 20000 THEN'))
    throw new Error('OIDC retained capacity changed');
  if (
    !normalized.includes('LANGUAGE plpgsql SECURITY DEFINER') ||
    !normalized.includes('SET search_path = pg_catalog, pg_temp')
  )
    throw new Error('OIDC definer boundary changed');
  if (
    !normalized.includes(
      'REVOKE ALL ON FUNCTION app.enforce_oidc_login_transaction_capacity() FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};',
    )
  )
    throw new Error('OIDC function execution boundary changed');
}

describe('OIDC capacity lock-time migration', () => {
  it('captures time after the lock without changing capacity or authority', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(() => {
      assertOidcCapacityContract(sql);
    }).not.toThrow();
  });

  it.each([
    [
      'stale timestamp order',
      (sql: string) =>
        sql.replace(
          'PERFORM pg_advisory_xact_lock(7166118815);\n  admission_time := clock_timestamp();',
          'admission_time := clock_timestamp();\n  PERFORM pg_advisory_xact_lock(7166118815);',
        ),
    ],
    [
      'weakened active bound',
      (sql: string) =>
        sql.replace('active_count >= 10000', 'active_count >= 10001'),
    ],
    [
      'invoker authority',
      (sql: string) => sql.replace('SECURITY DEFINER', 'SECURITY INVOKER'),
    ],
    [
      'public execution',
      (sql: string) =>
        sql.replace('FROM PUBLIC,', 'FROM {{api_runtime_role}},'),
    ],
  ])('detects the %s mutation', async (_label, mutate) => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(() => {
      assertOidcCapacityContract(mutate(sql));
    }).toThrow();
  });
});
