import { expect, it } from 'vitest';
import { withDatabase } from '../platform/migrations/upgrade-fixture.js';

it('retires the unreleased maintenance presence lookup without granting hash access', async () => {
  await withDatabase(async ({ admin }) => {
    expect(
      (
        await admin.query(
          "select to_regprocedure('app.password_credential_count(uuid)') lookup",
        )
      ).rows,
    ).toEqual([{ lookup: null }]);
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_maintenance');
      await expect(
        client.query('select password from app.auth_accounts'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
}, 120_000);
