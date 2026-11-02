import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { apiTokenCreateRequestSchema } from '@pertexo/contracts';
import {
  createApiTokenDatabase,
  parseApiTokenCredential,
} from '../../../../src/tenant-access/index.js';
import { createIdentityWorkspaceDatabase } from '../../../../src/tenant-access/store.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  migrateDatabase,
  createDisposableDatabaseFixture,
} from '@pertexo/database/testing';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

export const appUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

export const maintenanceUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

export const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName: `pertexo_test_tokens_${randomUUID().replaceAll('-', '')}`,
  ownerRole: 'pertexo_owner',
});

const config = parseDatabaseConfig({
  connectionString: fixture.databaseUrl(appUrl),
  max: 4,
});

export const admin = new Pool({
  connectionString: fixture.databaseUrl(adminUrl),
  max: 1,
});

export let identities: ReturnType<typeof createIdentityWorkspaceDatabase>;

export let tokens: ReturnType<typeof createApiTokenDatabase>;

export let workspaceId: string;

export let ownerUserId: string;

export let builderUserId: string;

export const input = () =>
  apiTokenCreateRequestSchema.parse({
    name: 'Build runner',
    scopes: ['workflow:read', 'run:read'],
  });

export function parsed(secret: string) {
  const value = parseApiTokenCredential(secret);
  if (value === undefined) throw new Error('Issued credential was invalid');
  return value;
}

export async function createOwner() {
  const user = await identities.createUser({
    email: `${randomUUID()}@example.test`,
    displayName: 'Token owner',
  });
  const workspace = await identities.createWorkspaceWithOwner({
    name: 'Automation workspace',
    slug: `tokens-${randomUUID().slice(0, 12)}`,
    ownerUserId: user.id,
  });
  return { workspaceId: workspace.id, ownerUserId: user.id };
}

export async function beforeAllFixture1() {
  await fixture.create();
  await migrateDatabase({
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
    connectionString: fixture.databaseUrl(migrationUrl),
  });
  identities = createIdentityWorkspaceDatabase(config);
  tokens = createApiTokenDatabase(config);
  ({ workspaceId, ownerUserId } = await createOwner());
  builderUserId = (
    await identities.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Builder',
    })
  ).id;
  await admin.query(
    "insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$2,'builder')",
    [workspaceId, builderUserId],
  );
}

export async function afterAllFixture2() {
  const results = await Promise.allSettled(
    [() => tokens.close(), () => identities.close(), () => admin.end()].map(
      (close) => Promise.resolve().then(close),
    ),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  try {
    await fixture.drop();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Token fixture cleanup failed');
}

export async function restartTokenRepository(): Promise<void> {
  await tokens.close();
  tokens = createApiTokenDatabase(config);
}
