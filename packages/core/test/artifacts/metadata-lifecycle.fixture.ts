import { testStackSetting } from '../../../../infrastructure/testing/test-stack.mjs';
import { randomUUID } from 'node:crypto';

import {
  parseDatabaseConfig,
  createWorkspaceDatabase,
} from '@pertexo/database/platform';
import {
  migrateDatabase,
  createDisposableDatabaseFixture,
} from '@pertexo/database/testing';

const adminUrl = testStackSetting('DATABASE_ADMIN_URL');

const migrationBaseUrl = testStackSetting('DATABASE_MIGRATION_URL');

const apiBaseUrl = testStackSetting('DATABASE_URL');

const workerBaseUrl = testStackSetting('DATABASE_URL');

const databaseName = `pertexo_test_artifacts_${randomUUID().replaceAll('-', '')}`;

const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName,
  ownerRole: 'pertexo_owner',
});

export const migrationUrl = fixture.databaseUrl(migrationBaseUrl);

export const apiUrl = fixture.databaseUrl(apiBaseUrl);

export const workerUrl = fixture.databaseUrl(workerBaseUrl);

export let database!: ReturnType<typeof createWorkspaceDatabase>;

let databaseCreated = false;

let databaseAcquired = false;

const migrationConfig = {
  appRole: 'pertexo_app',
  connectionString: migrationUrl,
  maintenanceRole: 'pertexo_maintenance',
  ownerRole: 'pertexo_owner',
} as const;

export let workspaceA = randomUUID();

export let workspaceB = randomUUID();

export function pendingInput(overrides: Record<string, unknown> = {}) {
  const artifactId = randomUUID();
  return {
    artifactId,
    byteLength: 27,
    expiresAt: new Date(Date.now() + 300_000),
    mediaType: 'application/octet-stream',
    purpose: 'workflow-input',
    sha256: 'a'.repeat(64),
    storageKey: `workspaces/${workspaceA}/artifacts/${artifactId}`,
    ...overrides,
  };
}

export async function beforeAllFixture1() {
  try {
    await fixture.create();
    databaseCreated = true;
    await migrateDatabase(migrationConfig);
    database = createWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
    );
    databaseAcquired = true;
  } catch (error: unknown) {
    const cleanup = await Promise.allSettled([
      ...(databaseAcquired ? [database.close()] : []),
      ...(databaseCreated ? [fixture.drop()] : []),
    ]);
    const failures: unknown[] = [error];
    for (const result of cleanup)
      if (result.status === 'rejected') failures.push(result.reason);
    throw new AggregateError(
      failures,
      'Artifact metadata fixture setup failed',
    );
  }
}

export function beforeEachFixture2() {
  workspaceA = randomUUID();
  workspaceB = randomUUID();
}

export async function afterAllFixture3() {
  const failures: unknown[] = [];
  try {
    if (databaseAcquired) await database.close();
  } catch (error: unknown) {
    failures.push(error);
  }
  if (databaseCreated) {
    try {
      await fixture.drop();
      databaseCreated = false;
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'Artifact metadata fixture cleanup failed',
    );
}
