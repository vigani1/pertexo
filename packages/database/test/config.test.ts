import { describe, expect, it } from 'vitest';

import {
  parseDatabaseConfig,
  parseMaintenanceDatabaseConfig,
  parseMigrationConfig,
  parseOperatorDatabaseConfig,
  parseOutboxDispatcherConfig,
} from '../src/config.js';
import { parseWorkspaceId } from '../src/tenant-access/transactions.js';

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
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('rejects non-PostgreSQL URLs and invalid workspace IDs', () => {
    expect(() =>
      parseDatabaseConfig({ connectionString: 'https://example.com' }),
    ).toThrow();
    expect(() => parseWorkspaceId('not-a-workspace-id')).toThrow();
  });

  it.each([
    { connectionTimeoutMillis: 0 },
    { connectionTimeoutMillis: 1.5 },
    { connectionTimeoutMillis: 2_147_483_648 },
    { idleTimeoutMillis: 0 },
    { idleTimeoutMillis: 1.5 },
    { idleTimeoutMillis: 2_147_483_648 },
    { max: 0 },
    { max: 101 },
    { ownerRole: 'invalid-role' },
    { ownerRole: '1invalid' },
  ])('rejects invalid direct runtime boundary %#', (override) => {
    expect(() =>
      parseDatabaseConfig({
        connectionString: 'postgresql://runtime:secret@localhost/pertexo',
        ...override,
      }),
    ).toThrow();
  });

  it.each([
    ['DATABASE_CONNECTION_TIMEOUT_MILLIS', '0'],
    ['DATABASE_CONNECTION_TIMEOUT_MILLIS', '1.5'],
    ['DATABASE_CONNECTION_TIMEOUT_MILLIS', '2147483648'],
    ['DATABASE_IDLE_TIMEOUT_MILLIS', '0'],
    ['DATABASE_IDLE_TIMEOUT_MILLIS', 'not-a-number'],
    ['DATABASE_IDLE_TIMEOUT_MILLIS', '2147483648'],
    ['DATABASE_MAINTENANCE_POOL_MAX', '0'],
    ['DATABASE_MAINTENANCE_POOL_MAX', '11'],
    ['POSTGRES_OWNER_USER', 'invalid-role'],
  ] as const)('rejects invalid maintenance environment %s=%s', (key, value) => {
    expect(() =>
      parseMaintenanceDatabaseConfig({
        DATABASE_MAINTENANCE_URL:
          'postgresql://runtime:secret@localhost/pertexo',
        [key]: value,
      }),
    ).toThrow();
  });

  it('parses the migration role boundary', () => {
    expect(
      parseMigrationConfig({
        DATABASE_MIGRATION_URL:
          'postgresql://pertexo_migration:secret@localhost:5432/pertexo',
        POSTGRES_APP_USER: 'app_role',
        POSTGRES_MAINTENANCE_USER: 'maintenance_role',
        POSTGRES_OWNER_USER: 'pertexo_owner',
      }),
    ).toEqual({
      appRole: 'app_role',
      connectionString:
        'postgresql://pertexo_migration:secret@localhost:5432/pertexo',
      maintenanceRole: 'maintenance_role',
      ownerRole: 'pertexo_owner',
    });
  });

  it.each([
    ['DATABASE_MIGRATION_URL', 'https://example.test/pertexo'],
    ['POSTGRES_APP_USER', 'invalid-role'],
    ['POSTGRES_MAINTENANCE_USER', 'invalid role'],
    ['POSTGRES_MAINTENANCE_USER', '1maintenance'],
    ['POSTGRES_OWNER_USER', 'owner-role'],
  ] as const)('rejects invalid migration environment %s=%s', (key, value) => {
    expect(() =>
      parseMigrationConfig({
        DATABASE_MIGRATION_URL:
          'postgresql://migration:secret@localhost/pertexo',
        [key]: value,
      }),
    ).toThrow();
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
    });
  });

  it('parses a one-connection ops pool on the maintenance login', () => {
    expect(
      parseOperatorDatabaseConfig({
        DATABASE_MAINTENANCE_URL:
          'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
      }),
    ).toEqual({
      connectionString:
        'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 1,
      ownerRole: 'pertexo_owner',
    });
  });

  it('parses a conservative dispatcher pool on the maintenance login', () => {
    expect(
      parseOutboxDispatcherConfig({
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
    });
  });

  it.each([
    [
      'dispatcher',
      parseOutboxDispatcherConfig,
      'DATABASE_MAINTENANCE_URL',
      'DATABASE_DISPATCHER_POOL_MAX',
    ],
    [
      'maintenance',
      parseMaintenanceDatabaseConfig,
      'DATABASE_MAINTENANCE_URL',
      'DATABASE_MAINTENANCE_POOL_MAX',
    ],
  ] as const)(
    'preserves shared pool settings for the %s pool',
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
