import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { DatabaseError, PoolClient } from 'pg';
import { afterAll, beforeAll } from 'vitest';

import {
  migrateDatabase,
  dropDisconnectedDatabase,
} from '@pertexo/database/testing';

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

export const maintenanceBaseUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

const databaseName = `pertexo_test_preview_worker_${randomUUID().replaceAll('-', '')}`;

export const workspaceId = randomUUID();

export const actorUserId = randomUUID();

export const workflowId = randomUUID();

export function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export const apiPool = new Pool({
  connectionString: databaseUrl(apiBaseUrl),
  max: 4,
});

export const workerPool = new Pool({
  connectionString: databaseUrl(workerBaseUrl),
  max: 4,
});

// The migration/owner role is used only for platform-row seeding and lease
// expiry injection; serving roles exercise every behavior under forced RLS.
export const ownerPool = new Pool({
  connectionString: databaseUrl(migrationBaseUrl),
  max: 1,
});

export function expectPgCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    while (current instanceof Error) {
      if ((current as DatabaseError).code === code) return true;
      current = current.cause;
    }
    return false;
  };
}

export async function withOwnerRole<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function withAdmin<T>(
  work: (client: Pool) => Promise<T>,
): Promise<T> {
  const client = new Pool({
    connectionString: databaseUrl(adminUrl),
    max: 1,
  });
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function insertIdentity(): Promise<void> {
  return withOwnerRole(async (client) => {
    await client.query(
      `insert into app.users (id, email, display_name, status)
     values ($1, $2, $3, 'active')`,
      [actorUserId, 'preview-worker@example.test', 'Preview Worker'],
    );
    await client.query(
      `insert into app.workspaces (id, name, slug, status, created_by)
     values ($1, $2, $3, 'active', $4)`,
      [
        workspaceId,
        'Preview Worker',
        `preview-worker-${randomUUID().slice(0, 8)}`,
        actorUserId,
      ],
    );
    // Forced RLS applies to the table owner too, so every tenant-scoped
    // insert below requires explicit transaction-local tenant context.
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    await client.query(
      `insert into app.workflows (id, workspace_id, name, lifecycle_status,
       activation_status, created_by)
     values ($1, $2, $3, 'active', 'inactive', $4)`,
      [workflowId, workspaceId, 'Preview worker target', actorUserId],
    );
    await client.query(
      `insert into app.workflow_drafts
         (workflow_id, workspace_id, revision, graph_json,
          updated_by)
       values ($1, $2, 3, $3::jsonb, $4)`,
      [
        workflowId,
        workspaceId,
        '{"nodes":[],"edges":[],"settings":{}}',
        actorUserId,
      ],
    );
    await client.query(
      `insert into app.workspace_memberships
       (workspace_id, user_id, role, status)
     values ($1, $2, 'owner', 'active')`,
      [workspaceId, actorUserId],
    );
  });
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_app, pertexo_app, pertexo_maintenance, pertexo_maintenance`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    connectionString: databaseUrl(migrationBaseUrl),
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
  await insertIdentity();
}, 60_000);

afterAll(async () => {
  await Promise.all([apiPool.end(), workerPool.end(), ownerPool.end()]);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});
