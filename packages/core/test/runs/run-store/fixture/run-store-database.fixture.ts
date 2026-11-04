import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';

import { createNodeAttemptRunStore } from '../../../../src/testing.js';
import {
  parseDatabaseConfig,
  migrateDatabase,
  dropDisconnectedDatabase,
} from '@pertexo/database/testing';
import {
  createTestRunStore,
  type TestCommitInput as CommitInput,
  type TestRunStore,
} from '../../../support/run-advance-store.js';
import {
  adminBaseUrl,
  workerBaseUrl,
  runnerOwnsDatabase,
  databaseName,
  coordinatorStoreApplicationName,
  databaseUrlWithApplicationName,
  migrationConfig,
} from './context.js';
import { seedIdentityAndExecutables } from './identity.js';

export let rawStore: TestRunStore;

export let nodeAttemptStore: ReturnType<typeof createNodeAttemptRunStore>;

const storesToClose: { close(): Promise<void> }[] = [];

function createStores(): void {
  const config = parseDatabaseConfig({
    connectionString: databaseUrlWithApplicationName(
      workerBaseUrl,
      coordinatorStoreApplicationName,
    ),
    max: 6,
    ownerRole: 'pertexo_owner',
  });
  rawStore = createTestRunStore(config);
  storesToClose.push(rawStore);
  nodeAttemptStore = createNodeAttemptRunStore(config);
  storesToClose.push(nodeAttemptStore);
}

export async function createDatabase(): Promise<void> {
  if (runnerOwnsDatabase) return;
  const admin = new Pool({ connectionString: adminBaseUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,
       pertexo_app,pertexo_app,pertexo_maintenance,pertexo_maintenance,
       pertexo_maintenance,pertexo_maintenance`,
    );
  } finally {
    await admin.end();
  }
}

export async function dropDatabase(): Promise<void> {
  const failures: unknown[] = [];
  const closed = await Promise.allSettled(
    storesToClose.splice(0).map(async (store) => store.close()),
  );
  for (const result of closed)
    if (result.status === 'rejected') failures.push(result.reason);
  testDeliveries.clear();
  if (runnerOwnsDatabase) {
    if (failures.length > 0)
      throw new AggregateError(failures, 'Coordinator fixture cleanup failed');
    return;
  }
  const admin = new Pool({ connectionString: adminBaseUrl, max: 1 });
  try {
    try {
      await dropDisconnectedDatabase(admin, databaseName);
    } catch (error: unknown) {
      failures.push(error);
    }
  } finally {
    try {
      await admin.end();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Coordinator fixture cleanup failed');
}

export const testDeliveries = new Map<
  string,
  Promise<CommitInput['delivery']>
>();

beforeAll(async () => {
  await createDatabase();
  await migrateDatabase(migrationConfig);
  await seedIdentityAndExecutables();
  createStores();
}, 60_000);

afterAll(dropDatabase);
