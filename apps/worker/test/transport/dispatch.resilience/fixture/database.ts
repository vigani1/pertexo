import {
  migrateDatabase,
  parseMigrationConfig,
} from '@pertexo/database/testing';

import { Pool } from 'pg';

import { dropDisconnectedDatabase } from '../../../support/infrastructure/disposable-database.js';

import {
  ownerRole,
  databaseName,
  localAdminUrl,
  localMigrationUrl,
  localDispatcherUrl,
} from './environment.js';

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

let proofDatabaseCreated = false;

export async function createProofDatabase(): Promise<void> {
  const admin = new Pool({
    connectionString: localAdminUrl.toString(),
    max: 1,
  });
  let operationError: unknown;
  try {
    await admin.query(
      `create database ${quoteIdentifier(databaseName)} owner ${quoteIdentifier(ownerRole)}`,
    );
    proofDatabaseCreated = true;
    await admin.query(
      `revoke all on database ${quoteIdentifier(databaseName)} from public`,
    );
    await admin.query(
      `grant connect on database ${quoteIdentifier(databaseName)} to ${[
        process.env.POSTGRES_MIGRATION_USER ?? 'pertexo_migration',
        process.env.POSTGRES_APP_USER ?? 'pertexo_app',
        process.env.POSTGRES_MAINTENANCE_USER ?? 'pertexo_maintenance',
      ]
        .map(quoteIdentifier)
        .join(',')}`,
    );
  } catch (error: unknown) {
    operationError = error;
  }
  await admin.end().catch((error: unknown) => {
    operationError =
      operationError === undefined
        ? error
        : new AggregateError(
            [operationError, error],
            'Transport resilience database setup failed',
          );
  });
  if (operationError !== undefined)
    throw operationError instanceof Error
      ? operationError
      : new Error('Transport resilience database setup failed', {
          cause: operationError,
        });
  await migrateDatabase(
    parseMigrationConfig({
      ...process.env,
      DATABASE_MIGRATION_URL: localMigrationUrl.toString(),
      NODE_ENV: 'test',
    }),
  );
}

export async function dropProofDatabase(): Promise<void> {
  if (!proofDatabaseCreated) return;
  const admin = new Pool({
    connectionString: localAdminUrl.toString(),
    max: 1,
  });
  let operationError: unknown;
  await dropDisconnectedDatabase(admin, databaseName)
    .then(() => {
      proofDatabaseCreated = false;
    })
    .catch((error: unknown) => {
      operationError = error;
    });
  await admin.end().catch((error: unknown) => {
    operationError =
      operationError === undefined
        ? error
        : new AggregateError(
            [operationError, error],
            'Transport resilience database cleanup failed',
          );
  });
  if (operationError !== undefined)
    throw operationError instanceof Error
      ? operationError
      : new Error('Transport resilience database cleanup failed', {
          cause: operationError,
        });
}

export function dispatcherPool(): Pool {
  const pool = new Pool({
    connectionString: localDispatcherUrl.toString(),
    connectionTimeoutMillis: 1_000,
    max: 1,
  });
  pool.on('error', () => undefined);
  return pool;
}
