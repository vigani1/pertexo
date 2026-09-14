import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MigrationConfig } from '../src/config.js';
import { migrateDatabase } from '../src/migrations.js';

const postgres = vi.hoisted(() => ({
  configs: [] as unknown[],
  connect: vi.fn(),
  end: vi.fn(),
}));
vi.mock('pg', () => ({
  Pool: class {
    constructor(config: unknown) {
      postgres.configs.push(config);
    }
    connect = postgres.connect;
    end = postgres.end;
  },
}));

const config: MigrationConfig = {
  connectionString: 'postgresql://migration@example.test/database',
  apiRuntimeRole: 'api',
  dispatcherRole: 'dispatcher',
  maintenanceRole: 'maintenance',
  lifecycleCommandRole: 'lifecycle',
  operatorRole: 'operator',
  ownerRole: 'owner',
  workerRuntimeRole: 'worker',
};
const temporaryDirectories = new Set<string>();

async function temporaryMigrationsDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-runner-'));
  temporaryDirectories.add(directory);
  return directory;
}

function successfulClient() {
  const query = vi.fn((sql: string) => {
    if (sql === 'select current_user')
      return Promise.resolve({ rows: [{ current_user: config.ownerRole }] });
    return Promise.resolve({ rows: [] });
  });
  const release = vi.fn();
  return { query, release };
}

describe('migration runner resource ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    postgres.configs.length = 0;
    postgres.connect.mockRejectedValue(new Error('database unavailable'));
    postgres.end.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const results = await Promise.allSettled(
      [...temporaryDirectories].map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
    temporaryDirectories.clear();
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, 'Temporary migration cleanup failed');
  });

  it.each([
    { connectionTimeoutMs: 99 },
    { connectionTimeoutMs: Number.NaN },
    { connectionTimeoutMs: 2_147_483_648 },
    { lockTimeoutMs: 99 },
    { lockTimeoutMs: Number.NaN },
    { lockTimeoutMs: 2_147_483_648 },
    { statementTimeoutMs: 999 },
    { statementTimeoutMs: 1_000.5 },
    { statementTimeoutMs: 2_147_483_648 },
  ])(
    'rejects invalid options before accessing PostgreSQL: %j',
    async (options) => {
      await expect(
        migrateDatabase(config, undefined, options),
      ).rejects.toBeInstanceOf(TypeError);
      expect(postgres.configs).toEqual([]);
      expect(postgres.connect).not.toHaveBeenCalled();
    },
  );

  it('closes its pool when PostgreSQL connection acquisition fails', async () => {
    const unavailable = new Error('database unavailable');
    postgres.connect.mockRejectedValue(unavailable);
    await expect(migrateDatabase(config)).rejects.toBe(unavailable);
    expect(postgres.end).toHaveBeenCalledOnce();
    expect(postgres.configs).toEqual([
      {
        connectionString: config.connectionString,
        connectionTimeoutMillis: 10_000,
        max: 1,
      },
    ]);
  });

  it.each([undefined, new Error('connection unavailable')] as const)(
    'preserves acquisition %s together with pool cleanup failure',
    async (acquisitionFailure) => {
      const cleanupFailure = new Error('pool cleanup failed');
      // Deliberately exercise legacy non-Error adapter rejection values.
      postgres.connect.mockRejectedValue(acquisitionFailure);
      postgres.end.mockRejectedValue(cleanupFailure);

      await expect(
        migrateDatabase(config, undefined, { connectionTimeoutMs: 321 }),
      ).rejects.toMatchObject({
        errors: [acquisitionFailure, cleanupFailure],
      });
      expect(postgres.configs).toEqual([
        {
          connectionString: config.connectionString,
          connectionTimeoutMillis: 321,
          max: 1,
        },
      ]);
      expect(postgres.end).toHaveBeenCalledOnce();
    },
  );

  it('applies the lock budget before waiting for migration serialization', async () => {
    const directory = await temporaryMigrationsDirectory();
    const client = successfulClient();
    postgres.connect.mockResolvedValue(client);

    await expect(
      migrateDatabase(config, directory, {
        lockTimeoutMs: 432,
        statementTimeoutMs: 1_234,
      }),
    ).resolves.toEqual([]);

    const statements = client.query.mock.calls.map(([sql]) => sql);
    expect(
      statements.indexOf("select set_config('statement_timeout',$1,false)"),
    ).toBeLessThan(
      statements.indexOf("select set_config('lock_timeout',$1,false)"),
    );
    expect(
      statements.indexOf("select set_config('lock_timeout',$1,false)"),
    ).toBeLessThan(statements.indexOf('select pg_advisory_lock($1)'));
    expect(client.query).toHaveBeenCalledWith(
      "select set_config('lock_timeout',$1,false)",
      ['432ms'],
    );
  });

  it('contains progress observer failure without changing a committed migration', async () => {
    const directory = await temporaryMigrationsDirectory();
    await writeFile(
      path.join(directory, '0001_probe.sql'),
      'select 1;\n',
      'utf8',
    );
    const client = successfulClient();
    postgres.connect.mockResolvedValue(client);
    const onProgress = vi.fn(() => {
      throw new Error('observer failed');
    });

    await expect(
      migrateDatabase(config, directory, { onProgress }),
    ).resolves.toEqual(['0001_probe.sql']);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledOnce();
    expect(postgres.end).toHaveBeenCalledOnce();
  });

  it('brackets published owner backfills without changing their SQL', async () => {
    const directory = await temporaryMigrationsDirectory();
    await Promise.all([
      writeFile(
        path.join(directory, '0006_execution_vocabulary.sql'),
        'select 6;\n',
        'utf8',
      ),
      writeFile(
        path.join(directory, '0007_execution_runtime.sql'),
        'select 7;\n',
        'utf8',
      ),
    ]);
    const client = successfulClient();
    postgres.connect.mockResolvedValue(client);

    await expect(migrateDatabase(config, directory)).resolves.toEqual([
      '0006_execution_vocabulary.sql',
      '0007_execution_runtime.sql',
    ]);

    const statements = client.query.mock.calls.map(([sql]) => sql);
    const relevant = statements.filter(
      (sql) =>
        sql === 'select 6;\n' ||
        sql === 'select 7;\n' ||
        sql.includes('force row level security'),
    );
    expect(relevant).toEqual([
      'alter table "app"."workflow_runs" no force row level security',
      'alter table "app"."idempotency_records" no force row level security',
      'select 6;\n',
      'alter table "app"."workflow_runs" force row level security',
      'alter table "app"."idempotency_records" force row level security',
      'alter table "app"."run_events" no force row level security',
      'select 7;\n',
      'alter table "app"."run_events" force row level security',
    ]);
  });

  it('contains hostile cleanup classification after successful migration work', async () => {
    const directory = await temporaryMigrationsDirectory();
    const client = successfulClient();
    const hostileCleanup = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('hostile cleanup prototype');
        },
      },
    );
    postgres.connect.mockResolvedValue(client);
    postgres.end.mockRejectedValue(hostileCleanup);

    const failure = await migrateDatabase(config, directory).catch(
      (error: unknown) => error,
    );
    expect((failure as { cause?: unknown }).cause).toBe(hostileCleanup);
    expect((failure as { message?: unknown }).message).toBe(
      'Migration database cleanup failed',
    );
    expect(client.release).toHaveBeenCalledOnce();
    expect(postgres.end).toHaveBeenCalledOnce();
  });

  it('preserves an undefined migration rejection together with release failure', async () => {
    const releaseError = new Error('client release failed');
    const query = (sql: string) => {
      if (sql === 'reset role' || sql.startsWith('select pg_advisory_unlock'))
        return Promise.resolve({ rows: [] });
      // Deliberately exercise a hostile non-Error adapter rejection.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(undefined);
    };
    postgres.connect.mockResolvedValue({
      query,
      release: () => {
        throw releaseError;
      },
    });

    const error = await migrateDatabase(config).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([undefined, releaseError]);
    expect(postgres.end).toHaveBeenCalledOnce();
  });

  it('preserves ordered reset, unlock, release, and pool cleanup failures', async () => {
    const migrationError = new Error('migration query failed');
    const resetError = new Error('reset role failed');
    const unlockError = new Error('advisory unlock failed');
    const releaseError = new Error('client release failed');
    const poolEndError = new Error('pool end failed');
    const query = vi.fn((sql: string) => {
      if (sql === 'reset role') return Promise.reject(resetError);
      if (sql.startsWith('select pg_advisory_unlock'))
        return Promise.reject(unlockError);
      return Promise.reject(migrationError);
    });
    postgres.connect.mockResolvedValue({
      query,
      release: () => {
        throw releaseError;
      },
    });
    postgres.end.mockRejectedValue(poolEndError);

    const error = await migrateDatabase(config).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      migrationError,
      resetError,
      unlockError,
      releaseError,
      poolEndError,
    ]);
    expect(query).toHaveBeenCalledWith('reset role');
    expect(query).toHaveBeenCalledWith('select pg_advisory_unlock($1)', [
      expect.any(Number),
    ]);
    expect(postgres.end).toHaveBeenCalledOnce();
  });
});
