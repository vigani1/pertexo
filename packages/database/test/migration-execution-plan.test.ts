import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MIGRATION_EXECUTION_PLAN_FILE,
  loadMigrationExecutionPlan,
} from '../src/migration-execution-plan.js';

async function plan(raw: unknown, names: readonly string[]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-plan-'));
  await writeFile(
    path.join(directory, MIGRATION_EXECUTION_PLAN_FILE),
    JSON.stringify(raw),
  );
  return loadMigrationExecutionPlan(directory, names, { required: true });
}

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

  it('allows fixture directories to default to transactional execution', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-plan-'));
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
