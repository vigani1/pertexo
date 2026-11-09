import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { withUpgradeDatabase } from '../platform/migrations/upgrade-fixture.js';
import { withPlatformTransaction } from '../../src/tenant-access/transactions.js';
import {
  withWorkspaceScope,
  setOrganizationContext,
} from '../../src/primitives.js';

it('validates organization IDs and contains organization context within a transaction and its workspace projections', async () => {
  await withUpgradeDatabase(117, async ({ config }) => {
    const url = new URL(
      process.env.DATABASE_URL ??
        'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
    );
    url.pathname = new URL(config.connectionString).pathname;
    const pool = new Pool({ connectionString: url.toString(), max: 1 });
    const organization = '11111111-1111-4111-8111-111111111111',
      workspace = '22222222-2222-4222-8222-222222222222';
    try {
      await expect(
        withPlatformTransaction(pool, async (client) => {
          await expect(
            setOrganizationContext(client, 'malformed'),
          ).rejects.toThrow();
          await setOrganizationContext(client, organization);
          await withWorkspaceScope(
            client,
            { workspaceId: workspace },
            async (scoped) => {
              expect(
                (
                  await scoped.query(
                    "select current_setting('app.organization_id',true) organization, current_setting('app.workspace_id',true) workspace",
                  )
                ).rows,
              ).toEqual([{ organization, workspace }]);
            },
          );
          expect(
            (
              await client.query(
                "select current_setting('app.organization_id',true) organization",
              )
            ).rows,
          ).toEqual([{ organization }]);
          throw new Error('roll back organization work');
        }),
      ).rejects.toThrow('roll back organization work');
      await withPlatformTransaction(pool, async (client) => {
        expect(
          (
            await client.query(
              "select nullif(current_setting('app.organization_id',true),'') organization",
            )
          ).rows,
        ).toEqual([{ organization: null }]);
        await setOrganizationContext(client, organization);
        await setOrganizationContext(client, undefined);
        expect(
          (
            await client.query(
              "select current_setting('app.organization_id',true) organization",
            )
          ).rows,
        ).toEqual([{ organization: '' }]);
      });
      const dirty = await pool.connect();
      await dirty.query("select set_config('app.organization_id',$1,false)", [
        organization,
      ]);
      dirty.release();
      await expect(
        withPlatformTransaction(pool, () => Promise.resolve(true)),
      ).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });
}, 120_000);
