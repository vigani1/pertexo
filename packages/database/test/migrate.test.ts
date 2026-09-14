import { describe, expect, it, vi } from 'vitest';

import type { MigrationConfig } from '../src/config.js';
import { runMigrationCli } from '../src/migrate.js';

const config: MigrationConfig = {
  apiRuntimeRole: 'api',
  connectionString: 'postgresql://migration@example.test/database',
  dispatcherRole: 'dispatcher',
  lifecycleCommandRole: 'lifecycle',
  maintenanceRole: 'maintenance',
  operatorRole: 'operator',
  ownerRole: 'owner',
  workerRuntimeRole: 'worker',
};

describe('migration CLI', () => {
  it.each([
    [[], 'Database already at migration head.\n'],
    [
      ['0087_first.sql', '0088_second.sql'],
      'Applied migrations: 0087_first.sql, 0088_second.sql\n',
    ],
  ] as const)(
    'reports successful migration output %#',
    async (applied, output) => {
      const writeOutput = vi.fn();
      const writeError = vi.fn();
      const migrate = vi.fn().mockResolvedValue(applied);

      await expect(
        runMigrationCli({
          loadConfig: () => config,
          migrate,
          writeError,
          writeOutput,
        }),
      ).resolves.toBe(0);
      expect(migrate).toHaveBeenCalledWith(config);
      expect(writeOutput).toHaveBeenCalledWith(output);
      expect(writeError).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['ordinary error', new Error('password=secret'), 'Error'],
    ['primitive', 'password=secret', 'NonError'],
    [
      'hostile prototype',
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('password=secret');
          },
        },
      ),
      'NonError',
    ],
  ] as const)(
    'reports a bounded %s without raw failure details',
    async (_label, failure, errorType) => {
      const writeOutput = vi.fn();
      const writeError = vi.fn();
      const migrate = vi.fn().mockRejectedValue(failure);

      await expect(
        runMigrationCli({
          loadConfig: () => config,
          migrate,
          writeError,
          writeOutput,
        }),
      ).resolves.toBe(1);
      expect(writeOutput).not.toHaveBeenCalled();
      expect(writeError).toHaveBeenCalledWith(
        `${JSON.stringify({
          event: 'database.migration_failed',
          errorType,
          level: 'fatal',
        })}\n`,
      );
      expect(JSON.stringify(writeError.mock.calls)).not.toContain('secret');
    },
  );

  it('contains output failures while preserving the migration exit result', async () => {
    await expect(
      runMigrationCli({
        loadConfig: () => config,
        migrate: vi.fn().mockResolvedValue([]),
        writeOutput: () => {
          throw new Error('stdout unavailable');
        },
      }),
    ).resolves.toBe(0);
    await expect(
      runMigrationCli({
        loadConfig: () => {
          throw new Error('configuration failed');
        },
        writeError: () => {
          throw new Error('stderr unavailable');
        },
      }),
    ).resolves.toBe(1);
  });
});
