import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import {
  createDisposableDatabaseFixture,
  migrateDatabase,
  parseMigrationConfig,
} from '../../packages/database/dist/testing.js';

const config = parseMigrationConfig();
const databaseName = `pertexo_test_catalog_${randomUUID().replaceAll('-', '')}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl: process.env.DATABASE_ADMIN_URL,
  databaseName,
  ownerRole: config.ownerRole,
  connectRoles: [
    new URL(config.connectionString).username,
    config.appRole,
    config.maintenanceRole,
  ],
});
const snapshot = new URL('../../packages/database/schema.sql', import.meta.url);
await fixture.create();
try {
  await migrateDatabase({
    ...config,
    connectionString: fixture.databaseUrl(config.connectionString),
  });
  const dump = execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '-U',
      process.env.POSTGRES_SUPERUSER ?? 'postgres',
      '-d',
      databaseName,
      '--schema-only',
      '--schema=app',
      '--schema=pertexo_internal',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  // pg_dump emits random restrict tokens and patch-version banners, never catalog state.
  const canonical = dump
    .split('\n')
    .filter(
      (line) =>
        !line.startsWith('-- Dumped ') &&
        !line.startsWith('\\restrict ') &&
        !line.startsWith('\\unrestrict '),
    )
    .join('\n');
  if (process.argv.includes('--write')) await writeFile(snapshot, canonical);
  else if ((await readFile(snapshot, 'utf8')) !== canonical)
    throw new Error(
      'Database catalog differs from packages/database/schema.sql; regenerate it with node infrastructure/checks/database-catalog.mjs --write',
    );
} finally {
  await fixture.drop();
}
