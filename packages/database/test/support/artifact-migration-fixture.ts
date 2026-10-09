import type { MigrationConfig } from '../../src/config.js';

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
