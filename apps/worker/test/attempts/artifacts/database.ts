import { createTestArtifactScratch } from '../../support/infrastructure/artifact-scratch.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  migrateDatabase,
  parseDatabaseConfig,
  parseMigrationConfig,
} from '@pertexo/database/testing';
import { dropDisconnectedDatabase } from '../../support/infrastructure/disposable-database.js';

const adminDatabaseUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationDatabaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiDatabaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const workerDatabaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

function databaseUrl(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function createArtifactDatabaseEnvironment() {
  const databaseName = `pertexo_test_artifact_reference_${randomUUID().replaceAll('-', '')}`;
  const apiConfig = parseDatabaseConfig({
    connectionString: databaseUrl(apiDatabaseUrl, databaseName),
    max: 2,
  });
  const workerConfig = parseDatabaseConfig({
    connectionString: databaseUrl(workerDatabaseUrl, databaseName),
    max: 2,
  });
  let scratch:
    Awaited<ReturnType<typeof createTestArtifactScratch>> | undefined;
  let databaseCreated = false;
  let initializePromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    apiConfig,
    workerConfig,
    get artifactScratchDirectory() {
      if (scratch === undefined)
        throw new Error('Artifact environment not initialized');
      return scratch.directory;
    },
    initialize(): Promise<void> {
      initializePromise ??= (async () => {
        scratch = await createTestArtifactScratch();
        const admin = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
        let setupError: unknown;
        try {
          await admin.query(
            `create database ${quoteIdentifier(databaseName)} owner ${quoteIdentifier(process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner')}`,
          );
          databaseCreated = true;
          await admin.query(
            `revoke all on database ${quoteIdentifier(databaseName)} from public`,
          );
          await admin.query(
            `grant connect on database ${quoteIdentifier(databaseName)} to ${[
              process.env.POSTGRES_MIGRATION_USER ?? 'pertexo_migration',
              process.env.POSTGRES_APP_USER ?? 'pertexo_app',
              process.env.POSTGRES_MAINTENANCE_USER ?? 'pertexo_maintenance',
              process.env.POSTGRES_MAINTENANCE_USER ?? 'pertexo_maintenance',
            ]
              .map(quoteIdentifier)
              .join(',')}`,
          );
        } catch (error: unknown) {
          setupError = error;
        }
        await admin.end().catch((error: unknown) => {
          setupError =
            setupError === undefined
              ? error
              : new AggregateError(
                  [setupError, error],
                  'Artifact reference database setup failed',
                );
        });
        if (setupError !== undefined)
          throw setupError instanceof Error
            ? setupError
            : new Error('Artifact reference database setup failed', {
                cause: setupError,
              });
        await migrateDatabase(
          parseMigrationConfig({
            ...process.env,
            DATABASE_MIGRATION_URL: databaseUrl(
              migrationDatabaseUrl,
              databaseName,
            ),
            NODE_ENV: 'test',
          }),
        );
      })();
      return initializePromise;
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        await scratch?.close();
        if (!databaseCreated) return;
        const admin = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
        const errors: unknown[] = [];
        await dropDisconnectedDatabase(admin, databaseName).catch(
          (error: unknown) => errors.push(error),
        );
        await admin.end().catch((error: unknown) => errors.push(error));
        if (errors.length > 0)
          throw new AggregateError(
            errors,
            'Artifact reference database cleanup failed',
          );
        databaseCreated = false;
      })();
      return closePromise;
    },
  });
}
