import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { readDurationSettingMillis } from '../../src/primitives.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const pool = new Pool({ connectionString: adminUrl, max: 1 });

afterAll(() => pool.end());

/** Sets a duration transaction-locally, then reads it back the shared way. */
async function readBack(setting: string, value: string) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const shown = await client.query<{ shown: string }>(
      'select set_config($1, $2, true) shown',
      [setting, value],
    );
    const millis = await readDurationSettingMillis(client, setting);
    return { shown: shown.rows[0]?.shown, millis };
  } finally {
    await client.query('rollback');
    client.release();
  }
}

describe('reading a duration setting', () => {
  it.each([
    ['1500ms', '1500ms', 1_500],
    ['5000ms', '5s', 5_000],
    ['120000ms', '2min', 120_000],
    ['3600000ms', '1h', 3_600_000],
    ['86400000ms', '1d', 86_400_000],
    ['2147483647ms', '2147483647ms', 2_147_483_647],
    ['0', '0', 0],
  ])(
    'reads %s, which PostgreSQL shows as %s, as %s ms',
    async (value, shown, millis) => {
      for (const setting of [
        'statement_timeout',
        'idle_in_transaction_session_timeout',
      ])
        await expect(readBack(setting, value)).resolves.toEqual({
          shown,
          millis,
        });
    },
  );
});
