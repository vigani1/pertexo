import { randomBytes, randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createEncryptionKeyRepository } from '@pertexo/secrets/server';
import {
  migrateDatabase,
  createDisposableDatabaseFixture,
  OAUTH2_TABLES,
  insertTokenRow,
  rowCounts,
  seedOAuth2Connection,
  seedWorkspace,
  type StoredConnection,
} from '@pertexo/database/testing';
import { purgeWorkspace } from '../../support/workspace-purge.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const appUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const maintenanceUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

const fixture = createDisposableDatabaseFixture({
  adminUrl,
  databaseName: `pertexo_test_oauth2_${randomUUID().replaceAll('-', '')}`,
  ownerRole: 'pertexo_owner',
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
});

describe('OAuth2 connection storage', () => {
  let admin: Pool;
  let app: Pool;

  beforeAll(async () => {
    await fixture.create();
    await migrateDatabase({
      connectionString: fixture.databaseUrl(migrationUrl),
      ownerRole: 'pertexo_owner',
      appRole: 'pertexo_app',
      maintenanceRole: 'pertexo_maintenance',
    });
    admin = new Pool({
      connectionString: fixture.databaseUrl(adminUrl),
      max: 3,
    });
    app = new Pool({ connectionString: fixture.databaseUrl(appUrl), max: 2 });
  }, 60_000);

  afterAll(async () => {
    await app.end();
    await admin.end();
    await fixture.drop();
  }, 30_000);

  /** Runs in one workspace, as the application's database role does. */
  const inWorkspace = async <Result>(
    workspaceId: string,
    work: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> => {
    const client = await app.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      return await work(client);
    } finally {
      await client.query('rollback');
      client.release();
    }
  };

  const seedTwoWorkspaces = async (): Promise<
    readonly [StoredConnection, StoredConnection]
  > => {
    const a = await seedOAuth2Connection(admin, await seedWorkspace(admin));
    const b = await seedOAuth2Connection(admin, await seedWorkspace(admin));
    return [a, b];
  };

  // S28, D3: forced row security with the three policies of migration 0051.
  it.each(OAUTH2_TABLES)('S28 %s forces row security', async (table) => {
    const { rows } = await admin.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select c.relrowsecurity, c.relforcerowsecurity
         from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='app' and c.relname=$1`,
      [table],
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  // S28, D3: one workspace-scoped policy each for app, owner and maintenance.
  it.each(OAUTH2_TABLES)('S28 %s has the three policies', async (table) => {
    const { rows } = await admin.query<{ roles: string[] }>(
      `select roles::text[] as roles from pg_policies
          where schemaname='app' and tablename=$1 order by policyname`,
      [table],
    );
    expect(rows.flatMap(({ roles }) => roles).sort()).toEqual([
      'pertexo_app',
      'pertexo_maintenance',
      'pertexo_owner',
    ]);
  });

  // D3: app role reads and writes; maintenance only reads and deletes.
  it.each(OAUTH2_TABLES)('D3 %s grants', async (table) => {
    const allowed = async (role: string, privilege: string) =>
      (
        await admin.query<{ allowed: boolean }>(
          'select has_table_privilege($1,$2,$3) as allowed',
          [role, `app.${table}`, privilege],
        )
      ).rows[0]?.allowed;
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      expect(await allowed('pertexo_app', privilege)).toBe(true);
    for (const privilege of ['SELECT', 'DELETE'])
      expect(await allowed('pertexo_maintenance', privilege)).toBe(true);
    for (const privilege of ['INSERT', 'UPDATE'])
      expect(await allowed('pertexo_maintenance', privilege)).toBe(false);
  });

  // S28: the app role with A's workspace sees none of B's rows.
  it.each(OAUTH2_TABLES)(
    'S28 the app role in workspace A reads nothing of B in %s',
    async (table) => {
      const [a, b] = await seedTwoWorkspaces();
      const visible = await inWorkspace(a.workspaceId, async (client) => {
        const { rows } = await client.query<{ workspace_id: string }>(
          `select workspace_id from app.${table}`,
        );
        return rows.map(({ workspace_id: id }) => id);
      });
      expect(visible).toEqual([a.workspaceId]);
      expect(visible).not.toContain(b.workspaceId);
    },
  );

  // S28: with no workspace set there is nothing to read at all.
  it.each(OAUTH2_TABLES)(
    'S28 the app role with no workspace reads nothing in %s',
    async (table) => {
      await seedTwoWorkspaces();
      const { rows } = await app.query(`select 1 from app.${table}`);
      expect(rows).toEqual([]);
    },
  );

  // S28: updates and deletes of another workspace's rows reach no row.
  it.each(OAUTH2_TABLES)(
    'S28 the app role in workspace A changes nothing of B in %s',
    async (table) => {
      const [a, b] = await seedTwoWorkspaces();
      const changed = await inWorkspace(a.workspaceId, async (client) => {
        const updated = await client.query(
          `update app.${table} set connection_id=connection_id where workspace_id=$1`,
          [b.workspaceId],
        );
        const deleted = await client.query(
          `delete from app.${table} where workspace_id=$1`,
          [b.workspaceId],
        );
        return { updated: updated.rowCount, deleted: deleted.rowCount };
      });
      expect(changed).toEqual({ updated: 0, deleted: 0 });
      expect(await rowCounts(admin, b.workspaceId)).toEqual({
        connection_oauth2_clients: 1,
        connection_oauth2_tokens: 1,
        connection_oauth2_authorizations: 1,
      });
    },
  );

  // S28: inserting into another workspace is refused by the policy, code 42501.
  it('S28 the app role in workspace A can’t add a token to B', async () => {
    const [a, b] = await seedTwoWorkspaces();
    await admin.query(
      'delete from app.connection_oauth2_tokens where workspace_id=$1',
      [b.workspaceId],
    );
    await inWorkspace(a.workspaceId, async (client) => {
      await expect(
        insertTokenRow(client, {
          tokenId: randomUUID(),
          workspaceId: b.workspaceId,
          connectionId: b.connectionId,
          secretVersionId: b.secretVersionId,
          tokenKeyReference: 'alias/oauth2-token',
        }),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  // Plan, Storage: "at most one pending per connection", digests exactly 32 bytes.
  it('keeps one token row and one pending consent per connection', async () => {
    const stored = await seedOAuth2Connection(
      admin,
      await seedWorkspace(admin),
    );
    await expect(
      insertTokenRow(admin, {
        tokenId: randomUUID(),
        workspaceId: stored.workspaceId,
        connectionId: stored.connectionId,
        secretVersionId: stored.secretVersionId,
        tokenKeyReference: 'alias/oauth2-token',
      }),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      admin.query(
        "insert into app.connection_oauth2_authorizations(workspace_id,connection_id,state_digest,binding_digest,started_by,secret_version_id,expires_at) values($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '600 seconds')",
        [
          stored.workspaceId,
          stored.connectionId,
          randomBytes(32),
          randomBytes(32),
          stored.ownerId,
          stored.secretVersionId,
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a digest that isn’t 32 bytes', async () => {
    const stored = await seedOAuth2Connection(
      admin,
      await seedWorkspace(admin),
    );
    await expect(
      admin.query(
        'update app.connection_oauth2_authorizations set state_digest=$2 where connection_id=$1',
        [stored.connectionId, randomBytes(31)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        'update app.connection_oauth2_authorizations set binding_digest=$2 where connection_id=$1',
        [stored.connectionId, randomBytes(33)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('bounds stored settings at 16,384 bytes', async () => {
    const stored = await seedOAuth2Connection(
      admin,
      await seedWorkspace(admin),
    );
    await expect(
      admin.query(
        'update app.connection_oauth2_clients set settings=$2 where connection_id=$1',
        [stored.connectionId, JSON.stringify({ padding: 'x'.repeat(16_384) })],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // D2: only transitions write an event, and the new type is allowed.
  it('D2 allows the new auth type and event, and no other', async () => {
    const stored = await seedOAuth2Connection(
      admin,
      await seedWorkspace(admin),
    );
    const event = (type: string) =>
      admin.query(
        `insert into app.connection_events(id,workspace_id,connection_id,event_type,actor_kind,actor_id)
         values($1,$2,$3,$4,'system','oauth2-test')`,
        [randomUUID(), stored.workspaceId, stored.connectionId, type],
      );
    await event('connection.oauth2_authorized');
    await expect(event('connection.oauth2_refreshed')).rejects.toMatchObject({
      code: '23514',
    });
  });

  // D8: workspace purge removes all three through the cascade.
  it('D8 a real workspace purge leaves no rows', async () => {
    const workspace = await seedWorkspace(admin);
    await seedOAuth2Connection(admin, workspace);
    const other = await seedOAuth2Connection(admin, await seedWorkspace(admin));
    await purgeWorkspace({
      adminUrl: fixture.databaseUrl(adminUrl),
      maintenanceUrl: fixture.databaseUrl(maintenanceUrl),
      workspaceId: workspace.workspaceId,
    });
    expect(await rowCounts(admin, workspace.workspaceId)).toEqual({
      connection_oauth2_clients: 0,
      connection_oauth2_tokens: 0,
      connection_oauth2_authorizations: 0,
    });
    // The purge touched only the workspace it was given.
    expect(await rowCounts(admin, other.workspaceId)).toEqual({
      connection_oauth2_clients: 1,
      connection_oauth2_tokens: 1,
      connection_oauth2_authorizations: 1,
    });
  }, 60_000);

  // D10: tokens join the key inventory as kind connection, keyed by the token row.
  it('D10 the key inventory counts a token’s key', async () => {
    const stored = await seedOAuth2Connection(
      admin,
      await seedWorkspace(admin),
      'alias/d10-token-key',
    );
    const repository = createEncryptionKeyRepository(
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(maintenanceUrl),
        max: 1,
      }),
    );
    try {
      const records = [];
      for await (const record of repository.read(AbortSignal.timeout(10_000)))
        records.push(record);
      expect(
        records.filter(
          ({ secretVersionId }) => secretVersionId === stored.tokenId,
        ),
      ).toEqual([
        expect.objectContaining({
          kind: 'connection',
          resourceId: stored.connectionId,
          secretVersionId: stored.tokenId,
          workspaceId: stored.workspaceId,
          keyReference: 'alias/d10-token-key',
        }),
      ]);
    } finally {
      await repository.close();
    }
  });
});
