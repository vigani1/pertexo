import type { MigrationConfig } from '../../../src/config.js';

export function createArtifactMigrationConfig(
  connectionString: string,
): MigrationConfig {
  return {
    appRole: 'pertexo_app',
    connectionString,
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
  };
}
