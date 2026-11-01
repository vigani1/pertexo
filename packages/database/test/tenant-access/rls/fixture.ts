import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { DatabaseError } from 'pg';

import { parseDatabaseConfig } from '../../../src/config.js';
import { createWorkspaceDatabase } from '../../../src/database.js';
import type { WorkspaceDatabase } from '../../../src/database.js';
import { migrateDatabase } from '../../../src/migrations.js';

import { rlsProbeRecords } from '../../../src/schema.js';
import { createDisposableDatabaseFixture } from '../../../src/testing/postgres/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

const workerBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

const databaseName = `pertexo_test_rls_${randomUUID().replaceAll('-', '')}`;

const inheritedRole = `pertexo_test_inherited_${randomUUID().replaceAll('-', '')}`;

const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: [
    new URL(adminUrl).username,
    'pertexo_migration',
    'pertexo_app',
  ],
  databaseName,
  ownerRole: 'pertexo_owner',
});

const migrationUrl = fixture.databaseUrl(migrationBaseUrl);

export const apiUrl = fixture.databaseUrl(apiBaseUrl);

export const workerUrl = fixture.databaseUrl(workerBaseUrl);

const adminPool = new Pool({ connectionString: adminUrl, max: 1 });

const databaseAdminPool = new Pool({
  connectionString: fixture.databaseUrl(adminUrl),
  max: 1,
});

export const workspaceA = randomUUID();

export const workspaceB = randomUUID();

export const recordA = randomUUID();

export const recordB = randomUUID();

export let database: WorkspaceDatabase;

let ownerPool: Pool;

export const migrationConfig = {
  appRole: 'pertexo_app',
  connectionString: migrationUrl,
  maintenanceRole: 'pertexo_maintenance',
  ownerRole: 'pertexo_owner',
} as const;

export function expectPgCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    const visited = new WeakSet<object>();
    for (let depth = 0; depth < 32 && current instanceof Error; depth += 1) {
      if (visited.has(current)) return false;
      visited.add(current);
      if ((current as DatabaseError).code === code) {
        return true;
      }
      current = current.cause;
    }
    return false;
  };
}

export async function executeAsOwner(statement: string): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(statement);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function beforeAllFixture1() {
  await fixture.create();
  await migrateDatabase(migrationConfig);
  ownerPool = new Pool({ connectionString: migrationUrl, max: 1 });
  database = createWorkspaceDatabase(
    parseDatabaseConfig({
      connectionString: apiUrl,
      max: 1,
      ownerRole: 'pertexo_owner',
    }),
  );
  await database.withWorkspace(workspaceA, async ({ db, workspaceId }) => {
    await db.insert(rlsProbeRecords).values({
      id: recordA,
      workspaceId,
      label: 'workspace-a',
    });
  });
  await database.withWorkspace(workspaceB, async ({ db, workspaceId }) => {
    await db.insert(rlsProbeRecords).values({
      id: recordB,
      workspaceId,
      label: 'workspace-b',
    });
  });
}

export async function afterAllFixture2() {
  const failures: unknown[] = [];
  const cleanup: (() => Promise<void>)[] = [];
  // beforeAll can fail before these runtime owners are assigned.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (database !== undefined) cleanup.push(() => database.close());
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (ownerPool !== undefined) cleanup.push(() => ownerPool.end());
  cleanup.push(() => databaseAdminPool.end());
  cleanup.push(() => fixture.drop());
  cleanup.push(async () => {
    await adminPool.query(`drop role if exists "${inheritedRole}"`);
  });
  cleanup.push(() => adminPool.end());
  for (const close of cleanup) {
    try {
      await close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'RLS fixture cleanup failed');
}
