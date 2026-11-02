import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  createDisposableDatabaseFixture,
  migrateDatabase,
} from '@pertexo/database/testing';
import { Pool } from 'pg';
import type { DatabaseError } from 'pg';

import { createWorkflowRunDatabase } from '../../../src/runs/runs.repository.js';
import { createApiTokenStore } from '../../../src/tenant-access/index.js';
import { createIdentityWorkspaceStore } from '../../../src/tenant-access/store.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const appUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

const database = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName: `pertexo_test_access_${randomUUID().replaceAll('-', '')}`,
  ownerRole: 'pertexo_owner',
});

export const appDatabaseUrl = database.databaseUrl(appUrl);

/** Enough connections that nothing here ever queues for one rather than a lock. */
const config = parseDatabaseConfig({
  connectionString: appDatabaseUrl,
  max: 24,
});

/** Writes the facts a test starts from, past row security. */
export const admin = new Pool({
  connectionString: database.databaseUrl(adminUrl),
  max: 2,
});
export const pool = new Pool({ connectionString: appDatabaseUrl, max: 24 });

export let identities: ReturnType<typeof createIdentityWorkspaceStore>;
export let tokens: ReturnType<typeof createApiTokenStore>;
export let runs: ReturnType<typeof createWorkflowRunDatabase>;

export async function openWorld(): Promise<void> {
  await database.create();
  await migrateDatabase({
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
    connectionString: database.databaseUrl(migrationUrl),
  });
  identities = createIdentityWorkspaceStore(config);
  tokens = createApiTokenStore(config);
  runs = createWorkflowRunDatabase(config);
}

export async function closeWorld(): Promise<void> {
  await Promise.all([
    identities.close(),
    tokens.close(),
    runs.close(),
    pool.end(),
    admin.end(),
  ]);
  await database.drop();
}

export async function person(): Promise<string> {
  const user = await identities.createUser({
    email: `${randomUUID()}@example.test`,
    displayName: 'Someone',
  });
  return user.id;
}

export async function workspaceOwnedBy(ownerUserId: string): Promise<string> {
  const workspace = await identities.createWorkspaceWithOwner({
    name: 'A workspace',
    slug: `access-${randomUUID().slice(0, 12)}`,
    ownerUserId,
  });
  return workspace.id;
}

export async function join(
  workspaceId: string,
  role: string,
  status = 'active',
): Promise<string> {
  const userId = await person();
  await admin.query(
    'insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,$4)',
    [workspaceId, userId, role, status],
  );
  return userId;
}

/** A workspace with its owner, and someone holding each other role. */
export async function team(): Promise<
  Readonly<{
    workspaceId: string;
    owner: string;
    admin: string;
    builder: string;
    operator: string;
    viewer: string;
  }>
> {
  const owner = await person();
  const workspaceId = await workspaceOwnedBy(owner);
  return {
    workspaceId,
    owner,
    admin: await join(workspaceId, 'admin'),
    builder: await join(workspaceId, 'builder'),
    operator: await join(workspaceId, 'operator'),
    viewer: await join(workspaceId, 'viewer'),
  };
}

export type WorkspaceStatus =
  | 'active'
  | 'suspended'
  | 'pending_deletion'
  | 'purging'
  | 'deleted';

export async function setStatus(
  workspaceId: string,
  status: WorkspaceStatus,
): Promise<void> {
  if (status === 'active' || status === 'suspended') {
    await admin.query('update app.workspaces set status=$2 where id=$1', [
      workspaceId,
      status,
    ]);
    return;
  }
  if (status === 'deleted') {
    await admin.query(
      `update app.workspaces set status='deleted',created_by=null,name='Deleted workspace',slug='deleted-'||id::text,
       deletion_requested_at=clock_timestamp(),deletion_requested_by=null,deletion_reason='purged',
       purge_after=clock_timestamp()+interval '1 day' where id=$1`,
      [workspaceId],
    );
    return;
  }
  await admin.query(
    `update app.workspaces set status=$2,deletion_requested_at=clock_timestamp(),deletion_requested_by=created_by,
     deletion_reason='Access test',purge_after=clock_timestamp()+interval '30 days' where id=$1`,
    [workspaceId, status],
  );
}

export async function setMembership(
  workspaceId: string,
  userId: string,
  status: 'active' | 'suspended' | 'removed',
): Promise<void> {
  await admin.query(
    'update app.workspace_memberships set status=$3 where workspace_id=$1 and user_id=$2',
    [workspaceId, userId, status],
  );
}

export async function setUserStatus(
  userId: string,
  status: 'active' | 'suspended' | 'deleted',
): Promise<void> {
  await admin.query('update app.users set status=$2 where id=$1', [
    userId,
    status,
  ]);
}

export function sealedToken() {
  return {
    ciphertext: 'sealed-token',
    nonce: 'nonce',
    tag: 'tag',
    keyVersion: 'test-v1',
  };
}

export function invitation(
  workspaceId: string,
  actorUserId: string,
  email = `${randomUUID()}@example.test`,
) {
  return {
    workspaceId,
    actorUserId,
    email,
    role: 'viewer' as const,
    idempotencyKey: randomUUID(),
    tokenDigest: randomUUID().replaceAll('-', '').repeat(2),
    sealedToken: sealedToken(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
  };
}

/** The Postgres error code behind a failure, however it was wrapped. */
export function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as DatabaseError).code;
    if (code !== undefined) return code;
    current = current.cause;
  }
  return undefined;
}

/** What each of many concurrent commands ended in, to compare with what's owed. */
export async function outcomes(
  work: readonly (() => Promise<unknown>)[],
): Promise<readonly string[]> {
  const settled = await Promise.allSettled(work.map((run) => run()));
  return settled.map((result) =>
    result.status === 'fulfilled'
      ? 'done'
      : `${result.reason instanceof Error ? result.reason.constructor.name : 'unknown'} ${postgresCode(result.reason) ?? ''}: ${String(result.reason)}`,
  );
}

export function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}
