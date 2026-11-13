import { Pool } from 'pg';
import { expect, it } from 'vitest';
import {
  setOrganizationContext,
  withWorkspaceScope,
} from '../../src/primitives.js';
import { withPlatformTransaction } from '../../src/tenant-access/transactions.js';
import { withDatabase } from '../platform/migrations/upgrade-fixture.js';

it('validates organization IDs and contains organization context within a transaction and its workspace projections', async () => {
  await withDatabase(async ({ config }) => {
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
    } finally {
      await pool.end();
    }
  });
}, 120_000);
