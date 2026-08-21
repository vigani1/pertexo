import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import type { DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  checkExpectedCompatibilityRelease,
  CompatibilityReleaseMismatchError,
} from '../src/compatibility-release.js';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { checkDatabaseReadiness } from '../src/readiness.js';
import { PHASE3_COMPATIBILITY_EXPECTATION } from './phase3-compatibility-fixture.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const dispatcherBaseUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';
const databaseName = `pertexo_test_compatibility_${randomUUID().replaceAll('-', '')}`;
const upgradeDatabaseName = `pertexo_test_compatibility_upgrade_${randomUUID().replaceAll('-', '')}`;
const databaseNames = [databaseName, upgradeDatabaseName] as const;
const catalogSchema = z.looseObject({
  executors: z.array(
    z.looseObject({
      executor: z
        .object({
          key: z.string(),
          version: z.number().int().positive(),
        })
        .strict(),
      lifecycle: z.string(),
    }),
  ),
});

function databaseUrl(base: string, name = databaseName): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function pgCode(expected: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    while (current instanceof Error) {
      if ((current as DatabaseError).code === expected) return true;
      current = current.cause;
    }
    return false;
  };
}

async function createDatabase(name: string): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.query(`create database "${name}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${name}" from public`);
    await admin.query(
      `grant connect on database "${name}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
    );
  } finally {
    await admin.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end();
  }
}

function migrationConfig(name: string) {
  return {
    apiRuntimeRole: 'pertexo_api',
    connectionString: databaseUrl(migrationBaseUrl, name),
    dispatcherRole: 'pertexo_dispatcher',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  } as const;
}

async function migrateThrough0017(name: string): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-0017-'));
  try {
    const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
      (migration) => /^\d{4}_.+\.sql$/u.test(migration) && migration < '0018_',
    );
    await Promise.all(
      migrations.map((migration) =>
        copyFile(
          path.join(MIGRATIONS_DIRECTORY, migration),
          path.join(directory, migration),
        ),
      ),
    );
    await migrateDatabase(migrationConfig(name), directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

beforeAll(async () => {
  for (const name of databaseNames) await createDatabase(name);
  await migrateDatabase({
    apiRuntimeRole: 'pertexo_api',
    connectionString: databaseUrl(migrationBaseUrl),
    dispatcherRole: 'pertexo_dispatcher',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  });
  await migrateThrough0017(upgradeDatabaseName);
  await migrateDatabase(migrationConfig(upgradeDatabaseName));
}, 60_000);

afterAll(async () => {
  for (const name of databaseNames) await dropDatabase(name);
});

describe('durable node compatibility release authority', () => {
  it('matches the local API and worker artifacts and fails closed on drift', async () => {
    for (const base of [apiBaseUrl, workerBaseUrl]) {
      const pool = new Pool({ connectionString: databaseUrl(base), max: 1 });
      try {
        await expect(
          checkDatabaseReadiness(pool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
            expectedCompatibilityRelease: PHASE3_COMPATIBILITY_EXPECTATION,
          }),
        ).resolves.toMatchObject({
          migrationHead: '0018_phase3_core_executor_non_removal.sql',
        });
        await expect(
          checkExpectedCompatibilityRelease(pool, {
            ...PHASE3_COMPATIBILITY_EXPECTATION,
            fingerprint:
              'node-compat:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          }),
        ).rejects.toBeInstanceOf(CompatibilityReleaseMismatchError);
      } finally {
        await pool.end();
      }
    }
  });

  it('upgrades the completed 0017 head without rewriting prior state', async () => {
    const pool = new Pool({
      connectionString: databaseUrl(apiBaseUrl, upgradeDatabaseName),
      max: 1,
    });
    try {
      await expect(
        checkDatabaseReadiness(pool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
          expectedCompatibilityRelease: PHASE3_COMPATIBILITY_EXPECTATION,
        }),
      ).resolves.toMatchObject({
        migrationHead: '0018_phase3_core_executor_non_removal.sql',
      });
    } finally {
      await pool.end();
    }
  });

  it('keeps serving roles read-only and the dispatcher outside the authority', async () => {
    for (const base of [apiBaseUrl, workerBaseUrl, dispatcherBaseUrl]) {
      const pool = new Pool({ connectionString: databaseUrl(base), max: 1 });
      try {
        await expect(
          pool.query(
            `update app.node_compatibility_current set activated_at = clock_timestamp()`,
          ),
        ).rejects.toSatisfy(pgCode('42501'));
        if (base === dispatcherBaseUrl) {
          await expect(
            pool.query('select * from app.node_compatibility_current'),
          ).rejects.toSatisfy(pgCode('42501'));
        }
      } finally {
        await pool.end();
      }
    }
  });

  it('permits additive releases while rejecting removal or retirement of a Phase 3 core executor', async () => {
    const owner = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
      max: 1,
    });
    const insertCandidate = async (
      epoch: number,
      catalog: z.infer<typeof catalogSchema>,
      fingerprint = `node-compat:v1:sha256:${epoch.toString(16).padStart(64, '0')}`,
    ): Promise<void> => {
      await owner.query('begin');
      try {
        await owner.query('set local role pertexo_owner');
        await owner.query(
          `insert into app.node_compatibility_releases
             (epoch, schema_version, fingerprint, catalog_json,
              predecessor_epoch, prepared_by_kind, prepared_by, reason)
           values ($1, 1, $2, $3::jsonb, 1, 'deployment',
                   'phase3-non-removal-test', 'candidate')`,
          [epoch, fingerprint, JSON.stringify(catalog)],
        );
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback');
        throw error;
      }
    };
    try {
      const retained = catalogSchema.parse(
        JSON.parse(PHASE3_COMPATIBILITY_EXPECTATION.catalogJson) as unknown,
      );
      retained.executors = retained.executors.map((executor) => ({
        ...executor,
        lifecycle: 'retained',
      }));
      await expect(
        insertCandidate(
          2,
          retained,
          'node-compat:v1:sha256:abd8982d5a455a45651201bee0582a3a08d87c2b856344c62951e6a0048958cf',
        ),
      ).resolves.toBeUndefined();

      const omitted = structuredClone(retained);
      omitted.executors = omitted.executors.filter(
        ({ executor }) => executor.key !== 'core.set',
      );
      await expect(insertCandidate(3, omitted)).rejects.toSatisfy(
        pgCode('23514'),
      );

      const blocked = structuredClone(retained);
      const blockedSet = blocked.executors.find(
        ({ executor }) => executor.key === 'core.set',
      );
      if (blockedSet === undefined) throw new Error('core Set fixture missing');
      blockedSet.lifecycle = 'retirement_blocked';
      await expect(insertCandidate(3, blocked)).rejects.toSatisfy(
        pgCode('23514'),
      );

      const duplicated = structuredClone(retained);
      const manual = duplicated.executors.find(
        ({ executor }) => executor.key === 'core.manual',
      );
      if (manual === undefined) throw new Error('core Manual fixture missing');
      duplicated.executors.push(structuredClone(manual));
      await expect(insertCandidate(3, duplicated)).rejects.toSatisfy(
        pgCode('23514'),
      );
    } finally {
      await owner.end();
    }
  });

  it('rejects release mutation and detects disabled immutability protection', async () => {
    const owner = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
      max: 1,
    });
    const api = new Pool({ connectionString: databaseUrl(apiBaseUrl), max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await expect(
        owner.query(
          `update app.node_compatibility_releases set reason = 'changed' where epoch = 1`,
        ),
      ).rejects.toSatisfy(pgCode('55000'));
      await owner.query('rollback');

      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(
        'alter table app.node_compatibility_releases disable trigger node_compatibility_releases_immutable',
      );
      await owner.query('commit');
      await expect(
        checkDatabaseReadiness(api, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
          expectedCompatibilityRelease: PHASE3_COMPATIBILITY_EXPECTATION,
        }),
      ).rejects.toThrow('compatibility release authority');
    } finally {
      await owner.query('begin').catch(() => undefined);
      await owner.query('set local role pertexo_owner').catch(() => undefined);
      await owner
        .query(
          'alter table app.node_compatibility_releases enable trigger node_compatibility_releases_immutable',
        )
        .catch(() => undefined);
      await owner.query('commit').catch(() => undefined);
      await owner.end();
      await api.end();
    }
  });

  it('fails readiness when the Phase 3 non-removal guard is disabled', async () => {
    const owner = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
      max: 1,
    });
    const api = new Pool({ connectionString: databaseUrl(apiBaseUrl), max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(
        'alter table app.node_compatibility_releases disable trigger node_compatibility_releases_phase3_core_non_removal',
      );
      await owner.query('commit');
      await expect(
        checkDatabaseReadiness(api, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
          expectedCompatibilityRelease: PHASE3_COMPATIBILITY_EXPECTATION,
        }),
      ).rejects.toThrow('compatibility release authority');
    } finally {
      await owner.query('begin').catch(() => undefined);
      await owner.query('set local role pertexo_owner').catch(() => undefined);
      await owner
        .query(
          'alter table app.node_compatibility_releases enable trigger node_compatibility_releases_phase3_core_non_removal',
        )
        .catch(() => undefined);
      await owner.query('commit').catch(() => undefined);
      await owner.end();
      await api.end();
    }
  });

  it('fails readiness when the Phase 3 non-removal function body drifts', async () => {
    const owner = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
      max: 1,
    });
    const api = new Pool({ connectionString: databaseUrl(apiBaseUrl), max: 1 });
    await owner.query('begin');
    await owner.query('set local role pertexo_owner');
    const original = await owner.query<{ definition: string }>(
      `select pg_get_functiondef('app.enforce_phase3_core_executor_non_removal()'::regprocedure) as definition`,
    );
    await owner.query('rollback');
    const originalDefinition = original.rows[0]?.definition;
    if (originalDefinition === undefined)
      throw new Error('non-removal function definition missing');
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(`
        create or replace function app.enforce_phase3_core_executor_non_removal()
        returns trigger language plpgsql set search_path = pg_catalog, app
        as $function$ begin return new; end; $function$
      `);
      await owner.query('commit');
      await expect(
        checkDatabaseReadiness(api, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
          expectedCompatibilityRelease: PHASE3_COMPATIBILITY_EXPECTATION,
        }),
      ).rejects.toThrow('compatibility release authority');
    } finally {
      await owner.query('begin').catch(() => undefined);
      await owner.query('set local role pertexo_owner').catch(() => undefined);
      await owner.query(originalDefinition).catch(() => undefined);
      await owner.query('commit').catch(() => undefined);
      await owner.end();
      await api.end();
    }
  });
});
