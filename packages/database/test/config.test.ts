import { describe, expect, it } from 'vitest';

import { parseDatabaseConfig, parseMigrationConfig } from '../src/config.js';
import { parseWorkspaceId } from '../src/workspace.js';

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

  it('parses the migration role boundary', () => {
    expect(
      parseMigrationConfig({
        DATABASE_MIGRATION_URL:
          'postgresql://pertexo_migration:secret@localhost:5432/pertexo',
        POSTGRES_API_RUNTIME_USER: 'api_role',
        POSTGRES_OWNER_USER: 'pertexo_owner',
        POSTGRES_WORKER_RUNTIME_USER: 'worker_role',
      }),
    ).toEqual({
      apiRuntimeRole: 'api_role',
      connectionString:
        'postgresql://pertexo_migration:secret@localhost:5432/pertexo',
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'worker_role',
    });
  });
});
