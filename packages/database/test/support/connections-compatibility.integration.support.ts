import { afterAll, beforeAll } from 'vitest';

import {
  createDatabase,
  dropDatabase,
  migrateBefore,
  migrationConfig,
  priorDatabaseName,
  seedPriorNotificationRows,
  upgradeDatabaseName,
} from './connections.integration.support.js';
import { migrateDatabase } from '../../src/migrations.js';

export let upgradeApplied: readonly string[] = [];
export let priorApplied: readonly string[] = [];

beforeAll(async () => {
  await Promise.all([
    createDatabase(upgradeDatabaseName),
    createDatabase(priorDatabaseName),
  ]);
  await migrateBefore(upgradeDatabaseName, '0021_');
  upgradeApplied = await migrateDatabase(migrationConfig(upgradeDatabaseName));
  await migrateBefore(priorDatabaseName, '0037_');
  await seedPriorNotificationRows();
  priorApplied = await migrateDatabase(migrationConfig(priorDatabaseName));
});

afterAll(async () => {
  const settled = await Promise.allSettled([
    dropDatabase(upgradeDatabaseName),
    dropDatabase(priorDatabaseName),
  ]);
  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'Connection compatibility fixture cleanup failed',
    );
});
