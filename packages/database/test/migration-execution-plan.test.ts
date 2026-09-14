import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MIGRATION_EXECUTION_PLAN_FILE,
  loadMigrationExecutionPlan,
} from '../src/migration-execution-plan.js';

const directories = new Set<string>();

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-plan-'));
  directories.add(directory);
  return directory;
}

async function plan(raw: unknown, names: readonly string[]) {
  const directory = await temporaryDirectory();
  await writeFile(
    path.join(directory, MIGRATION_EXECUTION_PLAN_FILE),
    JSON.stringify(raw),
  );
  return loadMigrationExecutionPlan(directory, names, { required: true });
}

afterEach(async () => {
  const results = await Promise.allSettled(
    [...directories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  directories.clear();
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(failures, 'Migration plan fixture cleanup failed');
});

describe('migration execution plan', () => {
  it('keeps the published range transactional and requires future declarations', async () => {
    const loaded = await plan(
      {
        migrations: {},
        schemaVersion: 1,
        transactionalThrough: '0001_initial.sql',
      },
      ['0001_initial.sql'],
    );
    expect(loaded.executionFor('0001_initial.sql')).toEqual({
      mode: 'transactional',
    });

    await expect(
      plan(
        {
          migrations: {},
          schemaVersion: 1,
          transactionalThrough: '0001_initial.sql',
        },
        ['0001_initial.sql', '0002_online.sql'],
      ),
    ).rejects.toThrow('execution mode is undeclared');
  });

  it('requires restart safety, a size bound, and a prior rollback window', async () => {
    await expect(
      plan(
        {
          migrations: {
            '0002_online.sql': {
              maximumDatabaseBytes: 1_000,
              mode: 'online',
              restartSafe: true,
              rollbackCompatibleThrough: '0002_online.sql',
            },
          },
          schemaVersion: 1,
          transactionalThrough: '0001_initial.sql',
        },
        ['0001_initial.sql', '0002_online.sql'],
      ),
    ).rejects.toThrow('rollback window must precede');
  });

  it.each([
    [
      'missing restart safety',
      {
        maximumDatabaseBytes: 1_000,
        mode: 'online',
        rollbackCompatibleThrough: '0001_initial.sql',
      },
    ],
    [
      'false restart safety',
      {
        maximumDatabaseBytes: 1_000,
        mode: 'online',
        restartSafe: false,
        rollbackCompatibleThrough: '0001_initial.sql',
      },
    ],
    [
      'nonpositive size',
      {
        maximumDatabaseBytes: 0,
        mode: 'online',
        restartSafe: true,
        rollbackCompatibleThrough: '0001_initial.sql',
      },
    ],
    [
      'zero batch bound',
      {
        batchLimit: 0,
        maximumDatabaseBytes: 1_000,
        mode: 'resumable',
        restartSafe: true,
        rollbackCompatibleThrough: '0001_initial.sql',
      },
    ],
    [
      'excessive batch bound',
      {
        batchLimit: 10_001,
        maximumDatabaseBytes: 1_000,
        mode: 'resumable',
        restartSafe: true,
        rollbackCompatibleThrough: '0001_initial.sql',
      },
    ],
  ] as const)('rejects %s', async (_label, execution) => {
    await expect(
      plan(
        {
          migrations: { '0002_future.sql': execution },
          schemaVersion: 1,
          transactionalThrough: '0001_initial.sql',
        },
        ['0001_initial.sql', '0002_future.sql'],
      ),
    ).rejects.toBeDefined();
  });

  it('rejects unknown plan files, boundaries, rollback anchors and mode changes', async () => {
    const validExecution = {
      maximumDatabaseBytes: 1_000,
      mode: 'online',
      restartSafe: true,
      rollbackCompatibleThrough: '0001_initial.sql',
    } as const;
    await expect(
      plan(
        {
          migrations: { '0003_unknown.sql': validExecution },
          schemaVersion: 1,
          transactionalThrough: '0001_initial.sql',
        },
        ['0001_initial.sql', '0002_future.sql'],
      ),
    ).rejects.toThrow('references unknown file');
    await expect(
      plan(
        {
          migrations: {},
          schemaVersion: 1,
          transactionalThrough: '0000_unknown.sql',
        },
        ['0001_initial.sql'],
      ),
    ).rejects.toThrow('transactional boundary is unknown');
    await expect(
      plan(
        {
          migrations: {
            '0002_future.sql': {
              ...validExecution,
              rollbackCompatibleThrough: '0000_unknown.sql',
            },
          },
          schemaVersion: 1,
          transactionalThrough: '0001_initial.sql',
        },
        ['0001_initial.sql', '0002_future.sql'],
      ),
    ).rejects.toThrow('rollback window references unknown file');
    await expect(
      plan(
        {
          migrations: { '0001_initial.sql': validExecution },
          schemaVersion: 1,
          transactionalThrough: '0001_initial.sql',
        },
        ['0001_initial.sql'],
      ),
    ).rejects.toThrow('cannot change mode');
  });

  it('rejects missing, invalid JSON and invalid schema for a required plan', async () => {
    const missing = await temporaryDirectory();
    await expect(
      loadMigrationExecutionPlan(missing, ['0001_initial.sql'], {
        required: true,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const invalidJson = await temporaryDirectory();
    await writeFile(
      path.join(invalidJson, MIGRATION_EXECUTION_PLAN_FILE),
      '{invalid',
    );
    await expect(
      loadMigrationExecutionPlan(invalidJson, ['0001_initial.sql'], {
        required: true,
      }),
    ).rejects.toBeInstanceOf(SyntaxError);

    await expect(
      plan(
        {
          migrations: {},
          schemaVersion: 2,
          transactionalThrough: '0001_initial.sql',
        },
        ['0001_initial.sql'],
      ),
    ).rejects.toBeDefined();
  });

  it('rejects execution lookup outside the loaded file set', async () => {
    const loaded = await plan(
      {
        migrations: {},
        schemaVersion: 1,
        transactionalThrough: '0001_initial.sql',
      },
      ['0001_initial.sql'],
    );
    expect(() => loaded.executionFor('0000_unknown.sql')).toThrow(
      'file is unknown',
    );
  });

  it('allows fixture directories to default to transactional execution', async () => {
    const directory = await temporaryDirectory();
    const loaded = await loadMigrationExecutionPlan(
      directory,
      ['0001_fixture.sql'],
      { required: false },
    );
    expect(loaded.executionFor('0001_fixture.sql')).toEqual({
      mode: 'transactional',
    });
  });
});
