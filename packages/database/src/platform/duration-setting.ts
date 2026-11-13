import type { PoolClient } from 'pg';

/**
 * Milliseconds from a duration setting as PostgreSQL shows it ('1500ms', '5s',
 * '2min', '1h', '1d'): read as an interval, every unit converts exactly.
 * `shown` is SQL that yields the shown value, such as current_setting(...) or
 * the set_config(...) that just changed it.
 */
export function durationSettingMillisSql(shown: string): string {
  return `(extract(epoch from (${shown})::interval)*1000)::bigint`;
}

/** A duration setting's current value in milliseconds; 0 means no limit, undefined that PostgreSQL returned none. */
export async function readDurationSettingMillis(
  client: Pick<PoolClient, 'query'>,
  name: string,
): Promise<number | undefined> {
  const result = await client.query<{ millis: string }>(
    `select ${durationSettingMillisSql('current_setting($1)')} millis`,
    [name],
  );
  const millis = result.rows[0]?.millis;
  return millis === undefined ? undefined : Number(millis);
}
