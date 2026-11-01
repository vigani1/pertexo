import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { DatabaseError } from 'pg';

import { createIdentityWorkspaceDatabase } from '../../../src/testing.js';
import {
  createWorkspaceDatabase,
  parseDatabaseConfig,
  migrateDatabase,
  createDisposableDatabaseFixture,
} from '@pertexo/database/testing';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

const maintenanceBaseUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

const workerBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

const databaseName = `pertexo_test_identity_${randomUUID().replaceAll('-', '')}`;

export const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName,
  ownerRole: 'pertexo_owner',
});

export const adminDatabaseUrl = fixture.databaseUrl(adminUrl);

export const migrationUrl = fixture.databaseUrl(migrationBaseUrl);

export const apiUrl = fixture.databaseUrl(apiBaseUrl);

export const workerUrl = fixture.databaseUrl(workerBaseUrl);

export const maintenanceUrl = fixture.databaseUrl(maintenanceBaseUrl);

const migrationConfig = {
  appRole: 'pertexo_app',
  connectionString: migrationUrl,
  maintenanceRole: 'pertexo_maintenance',
  ownerRole: 'pertexo_owner',
} as const;

export let identityDatabase: ReturnType<typeof createIdentityWorkspaceDatabase>;

export let tenantDatabase: ReturnType<typeof createWorkspaceDatabase>;

const identityResources: { close(): Promise<void> }[] = [];

export let ownerUserId: string;

export let workspaceId: string;

export function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as DatabaseError).code;
    if (code !== undefined) return code;
    current = current.cause;
  }
  return undefined;
}

export async function createAuthenticationSession(
  userId: string,
): Promise<string> {
  const pool = new Pool({ connectionString: apiUrl, max: 1 });
  try {
    const token = randomUUID();
    await pool.query(
      `insert into app.auth_sessions(id,user_id,token,expires_at)
       values($1,$2,$3,clock_timestamp()+interval '1 hour')`,
      [randomUUID(), userId, token],
    );
    return token;
  } finally {
    await pool.end();
  }
}

export async function findActiveAuthenticationSession(token: string) {
  const pool = new Pool({ connectionString: apiUrl, max: 1 });
  try {
    const result = await pool.query<{ user_id: string }>(
      `select user_id
         from app.auth_sessions
        where token=$1 and expires_at > clock_timestamp()`,
      [token],
    );
    return result.rows[0] ?? null;
  } finally {
    await pool.end();
  }
}

export function testSealedToken() {
  return {
    ciphertext: 'sealed-token',
    nonce: 'nonce',
    tag: 'tag',
    keyVersion: 'test-v1',
  };
}

export function invitationTokenDigest(invitationId: string) {
  return createHash('sha256').update(invitationId).digest('hex');
}

export function invitationCreateCommand(
  commandWorkspaceId: string,
  actorUserId: string,
  email: string,
) {
  return {
    workspaceId: commandWorkspaceId,
    actorUserId,
    email,
    role: 'viewer' as const,
    idempotencyKey: randomUUID(),
    tokenDigest: invitationTokenDigest(randomUUID()),
    sealedToken: testSealedToken(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
  };
}

export async function createInvitationProofSession(
  userId: string,
): Promise<string> {
  const pool = new Pool({ connectionString: apiUrl, max: 1 });
  try {
    const existing = (
      await pool.query<{ id: string }>(
        'select id from app.auth_sessions where user_id=$1 and expires_at>clock_timestamp() order by created_at desc,id limit 1',
        [userId],
      )
    ).rows[0];
    if (existing !== undefined) return existing.id;
    const id = randomUUID();
    await pool.query(
      "insert into app.auth_sessions(id,user_id,token,expires_at) values($1,$2,$3,clock_timestamp()+interval '1 hour')",
      [id, userId, randomUUID()],
    );
    return id;
  } finally {
    await pool.end();
  }
}

export async function beforeAllFixture1() {
  await fixture.create();
  await migrateDatabase(migrationConfig);
  identityDatabase = createIdentityWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 3 }),
  );
  identityResources.push(identityDatabase);
  tenantDatabase = createWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 3 }),
  );
  identityResources.push(tenantDatabase);
  const user = await identityDatabase.createUser({
    id: '00000000-0000-4000-8000-000000000001',
    email: `${randomUUID()}@example.test`,
    displayName: 'Phase One Owner',
  });
  ownerUserId = user.id;
  const workspace = await identityDatabase.createWorkspaceWithOwner({
    name: 'Identity Workspace',
    slug: `identity-${randomUUID().slice(0, 12)}`,
    ownerUserId,
    requestId: 'request-phase1',
  });
  workspaceId = workspace.id;
}

export async function afterAllFixture2() {
  const closeResults = await Promise.allSettled(
    identityResources.map((resource) => resource.close()),
  );
  const failures = closeResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  try {
    await fixture.drop();
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Identity fixture cleanup failed');
}
