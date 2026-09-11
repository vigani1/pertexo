import { copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { MigrationConfig } from '../../src/config.js';
import { MIGRATIONS_DIRECTORY } from '../../src/migrations.js';

export function createArtifactMigrationConfig(
  connectionString: string,
): MigrationConfig {
  return {
    apiRuntimeRole: 'pertexo_api',
    connectionString,
    dispatcherRole: 'pertexo_dispatcher',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    maintenanceRole: 'pertexo_maintenance',
    operatorRole: 'pertexo_operator',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  };
}

export async function copyMigrationsBefore(
  destination: string,
  exclusiveCutoff: string,
): Promise<void> {
  const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
    (name) => /^\d{4}_.+\.sql$/u.test(name) && name < exclusiveCutoff,
  );
  await Promise.all(
    migrations.map((name) =>
      copyFile(
        path.join(MIGRATIONS_DIRECTORY, name),
        path.join(destination, name),
      ),
    ),
  );
}
