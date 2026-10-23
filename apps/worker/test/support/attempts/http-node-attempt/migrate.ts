import {
  migrateDatabase as migrateSchema,
  parseMigrationConfig,
} from '@pertexo/database/testing';

import { migrationUrl, databaseUrl } from './environment.js';

export async function migrateDatabase(): Promise<void> {
  await migrateSchema(
    parseMigrationConfig({
      ...process.env,
      DATABASE_MIGRATION_URL: databaseUrl(migrationUrl),
      NODE_ENV: 'test',
    }),
  );
}
