import { describe, expect, it } from 'vitest';

import {
  parseDatabaseConfig,
  parseLifecycleCommandDatabaseConfig,
  parseMaintenanceDatabaseConfig,
  parseMigrationConfig,
  parseOperatorDatabaseConfig,
  parseOutboxDispatcherConfig,
} from '../src/config.js';
import { parseWorkspaceId } from '../src/tenant-access/workspace.js';

describe('database configuration', () => {
  it('parses immutable pool settings', () => {
    const config = parseDatabaseConfig({
      connectionString: 'postgresql://runtime:secret@localhost:5432/pertexo',
    });

    expect(config).toEqual({
      connectionString: 'postgresql://runtime:secret@localhost:5432/pertexo',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 10,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('rejects non-PostgreSQL URLs and invalid workspace IDs', () => {
    expect(() =>
      parseDatabaseConfig({ connectionString: 'https://example.com' }),
    ).toThrow();
    expect(() => parseWorkspaceId('not-a-workspace-id')).toThrow();
  });

  it('parses the migration role boundary', () => {
    expect(
      parseMigrationConfig({
        DATABASE_MIGRATION_URL:
          'postgresql://pertexo_migration:secret@localhost:5432/pertexo',
        POSTGRES_API_RUNTIME_USER: 'api_role',
        POSTGRES_DISPATCHER_RUNTIME_USER: 'dispatcher_role',
        POSTGRES_MAINTENANCE_USER: 'maintenance_role',
        POSTGRES_OPERATOR_USER: 'operator_role',
        POSTGRES_LIFECYCLE_COMMAND_USER: 'lifecycle_role',
        POSTGRES_OWNER_USER: 'pertexo_owner',
        POSTGRES_WORKER_RUNTIME_USER: 'worker_role',
      }),
    ).toEqual({
      apiRuntimeRole: 'api_role',
      connectionString:
        'postgresql://pertexo_migration:secret@localhost:5432/pertexo',
      dispatcherRole: 'dispatcher_role',
      maintenanceRole: 'maintenance_role',
      lifecycleCommandRole: 'lifecycle_role',
      operatorRole: 'operator_role',
      ownerRole: 'pertexo_owner',
      regionalWriteAdmissionEnforced: false,
      workerRuntimeRole: 'worker_role',
    });
  });

  it('requires the regional write fence for production migrations', () => {
    expect(() =>
      parseMigrationConfig({
        DATABASE_MIGRATION_URL:
          'postgresql://migration:secret@localhost:5432/pertexo',
        NODE_ENV: 'production',
      }),
    ).toThrow('regional write admission enforcement');
    expect(
      parseMigrationConfig({
        DATABASE_MIGRATION_URL:
          'postgresql://migration:secret@localhost:5432/pertexo',
        NODE_ENV: 'production',
        REGIONAL_WRITE_ADMISSION_ENFORCED: 'true',
      }).regionalWriteAdmissionEnforced,
    ).toBe(true);
  });

  it('parses a dedicated conservative maintenance pool', () => {
    expect(
      parseMaintenanceDatabaseConfig({
        DATABASE_MAINTENANCE_URL:
          'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
      }),
    ).toEqual({
      connectionString:
        'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 2,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
  });

  it('parses a dedicated lifecycle command pool', () => {
    expect(
      parseLifecycleCommandDatabaseConfig({
        DATABASE_LIFECYCLE_COMMAND_URL:
          'postgresql://pertexo_lifecycle_command:secret@localhost:5432/pertexo',
      }),
    ).toEqual({
      connectionString:
        'postgresql://pertexo_lifecycle_command:secret@localhost:5432/pertexo',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 2,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
  });

  it('parses a one-connection operator-only pool', () => {
    expect(
      parseOperatorDatabaseConfig({
        DATABASE_OPERATOR_URL:
          'postgresql://pertexo_operator:secret@localhost:5432/pertexo',
      }),
    ).toEqual({
      connectionString:
        'postgresql://pertexo_operator:secret@localhost:5432/pertexo',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 1,
      operatorRole: 'pertexo_operator',
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
  });

  it('parses a conservative dispatcher-only pool', () => {
    expect(
      parseOutboxDispatcherConfig({
        DATABASE_DISPATCHER_URL:
          'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
      }),
    ).toEqual({
      connectionString:
        'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 2,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
  });

  it.each([
    [
      'dispatcher',
      parseOutboxDispatcherConfig,
      'DATABASE_DISPATCHER_URL',
      'DATABASE_DISPATCHER_POOL_MAX',
    ],
    [
      'maintenance',
      parseMaintenanceDatabaseConfig,
      'DATABASE_MAINTENANCE_URL',
      'DATABASE_MAINTENANCE_POOL_MAX',
    ],
    [
      'lifecycle command',
      parseLifecycleCommandDatabaseConfig,
      'DATABASE_LIFECYCLE_COMMAND_URL',
      'DATABASE_LIFECYCLE_COMMAND_POOL_MAX',
    ],
  ] as const)(
    'preserves shared pool boundaries for the %s role',
    (_name, parser, urlKey, poolKey) => {
      const environment = {
        [urlKey]: 'postgresql://runtime:secret@localhost:5432/pertexo',
        [poolKey]: '3',
        DATABASE_CONNECTION_TIMEOUT_MILLIS: '1234',
        DATABASE_IDLE_TIMEOUT_MILLIS: '4567',
      };
      expect(parser(environment)).toMatchObject({
        connectionTimeoutMillis: 1234,
        idleTimeoutMillis: 4567,
        max: 3,
      });
      expect(() => parser({ ...environment, [poolKey]: '11' })).toThrow();
    },
  );
});
