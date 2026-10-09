import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';

import {
  createIdentityWorkspaceDatabase,
  createWorkspaceDatabase,
  parseDatabaseConfig,
  workspaceMemberships,
} from '../../src/testing.js';
import { migrateDatabase } from '../../src/migrations.js';
import { createDisposableDatabaseFixture } from './disposable-database.js';

type Role = 'owner' | 'admin' | 'builder' | 'operator' | 'viewer';

export type IdentityCommandFixture = Readonly<{
  identity: () => ReturnType<typeof createIdentityWorkspaceDatabase>;
  /** Runs superuser SQL across tenant policies, for arrangement and inspection only. */
  asAdmin: <Row extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<Row[]>;
  user: (
    displayName: string,
  ) => Promise<Readonly<{ id: string; email: string }>>;
  workspace: (ownerUserId: string) => Promise<string>;
  member: (workspaceId: string, userId: string, role: Role) => Promise<void>;
  /** One Better Auth session for the user; returns its token. */
  sessions: (userId: string) => Promise<string>;
  liveSessions: (userId: string) => Promise<number>;
}>;

/**
 * A migrated disposable database with the real API runtime role for the
 * identity command suites, created before and dropped after the file.
 */
export function useIdentityCommandDatabase(
  suite: string,
): IdentityCommandFixture {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_app'],
    databaseName: `pertexo_test_${suite}_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  const migrationUrl = fixture.databaseUrl(
    process.env.DATABASE_MIGRATION_URL ??
      'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
  );
  const apiUrl = fixture.databaseUrl(
    process.env.DATABASE_URL ??
      'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
  );
  let identity: ReturnType<typeof createIdentityWorkspaceDatabase> | undefined;
  let tenant: ReturnType<typeof createWorkspaceDatabase> | undefined;
  let owner: Pool | undefined;
  let api: Pool | undefined;

  beforeAll(async () => {
    await fixture.create();
    await migrateDatabase({
      appRole: 'pertexo_app',
      connectionString: migrationUrl,
      maintenanceRole: 'pertexo_maintenance',
      ownerRole: 'pertexo_owner',
    });
    identity = createIdentityWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
    );
    tenant = createWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    );
    // Inspection and arrangement read across tenant policies.
    owner = new Pool({
      connectionString: fixture.databaseUrl(adminUrl),
      max: 1,
    });
    api = new Pool({ connectionString: apiUrl, max: 1 });
  }, 60_000);

  afterAll(async () => {
    const closing = await Promise.allSettled([
      identity?.close(),
      tenant?.close(),
      owner?.end(),
      api?.end(),
    ]);
    await fixture.drop();
    const failure = closing.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  });

  const required = <Value>(value: Value | undefined): Value => {
    if (value === undefined) throw new Error('Identity fixture is not ready');
    return value;
  };

  return Object.freeze({
    identity: () => required(identity),
    asAdmin: async <Row extends Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) => (await required(owner).query<Row>(text, values)).rows,
    user: async (displayName: string) => {
      const created = await required(identity).createUser({
        email: `${randomUUID()}@example.test`,
        displayName,
      });
      return { id: created.id, email: created.email };
    },
    workspace: async (ownerUserId: string) =>
      (
        await required(identity).createWorkspaceWithOwner({
          name: 'Identity command',
          slug: `identity-command-${randomUUID().slice(0, 8)}`,
          ownerUserId,
        })
      ).id,
    member: async (workspaceId: string, userId: string, role: Role) => {
      await required(tenant).withWorkspace(workspaceId, async ({ db }) => {
        await db
          .insert(workspaceMemberships)
          .values({ workspaceId, userId, role, status: 'active' });
      });
    },
    sessions: async (userId: string) => {
      const token = randomUUID();
      await required(api).query(
        `insert into app.auth_sessions(id,expires_at,token,user_id)
         values($1,clock_timestamp()+interval '1 hour',$2,$3)`,
        [randomUUID(), token, userId],
      );
      return token;
    },
    liveSessions: async (userId: string) => {
      const result = await required(owner).query<{ count: number }>(
        `select count(*)::int count from app.auth_sessions where user_id=$1`,
        [userId],
      );
      return required(result.rows[0]).count;
    },
  });
}
