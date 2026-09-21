import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  checkExpectedCompatibilityRelease,
  CompatibilityReleaseMismatchError,
} from '../src/compatibility/compatibility-release.js';
import { createCompatibilityReleaseMaintenance } from '../src/compatibility/compatibility-release-maintenance.js';
import { parseDatabaseConfig } from '../src/config.js';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import {
  acquireDatabasePool,
  createDatabaseRuntime,
} from '../src/platform/database-runtime.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';
import {
  checkDatabasePreactivationReadiness,
  checkDatabaseReadiness,
} from '../src/platform/readiness.js';
import { BASELINE_COMPATIBILITY_EXPECTATION } from './baseline-compatibility-fixture.js';

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
const uniqueSuffix = randomUUID().replaceAll('-', '').slice(0, 20);
const databaseName = `pertexo_test_compat_${uniqueSuffix}`;
const upgradeDatabaseName = `pertexo_test_compat_up_${uniqueSuffix}`;
const rolloutDatabaseName = `pertexo_test_compat_roll_${uniqueSuffix}`;
const maintenanceDatabaseName = `pertexo_test_compat_maint_${uniqueSuffix}`;
const databaseFixtures = [
  databaseName,
  upgradeDatabaseName,
  rolloutDatabaseName,
  maintenanceDatabaseName,
].map((name) =>
  createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: [
      'pertexo_migration',
      'pertexo_api',
      'pertexo_worker',
      'pertexo_dispatcher',
    ],
    databaseName: name,
    ownerRole: 'pertexo_owner',
  }),
);
const createdDatabaseFixtures: (typeof databaseFixtures)[number][] = [];
let upgradeBaselineState: string | undefined;
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

function pgDiagnostic(
  expected: Readonly<{
    code: string;
    message?: string;
  }>,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    const visited = new WeakSet<object>();
    for (let depth = 0; depth < 8; depth += 1) {
      if (current === null || typeof current !== 'object') return false;
      if (visited.has(current)) return false;
      visited.add(current);
      try {
        const code: unknown = Reflect.get(current, 'code');
        const message: unknown = Reflect.get(current, 'message');
        if (
          code === expected.code &&
          (expected.message === undefined ||
            (typeof message === 'string' &&
              message.length <= 1_000 &&
              message.includes(expected.message)))
        )
          return true;
        current = Reflect.get(current, 'cause');
      } catch {
        return false;
      }
    }
    return false;
  };
}

function pgCode(code: string): (error: unknown) => boolean {
  return pgDiagnostic({ code });
}

async function captureCompatibilityState(name: string): Promise<string> {
  const pool = new Pool({
    connectionString: databaseUrl(migrationBaseUrl, name),
    max: 1,
  });
  const client = await pool.connect();
  let transactionOpen = false;
  let disposalError: Error | undefined;
  try {
    await client.query('begin');
    transactionOpen = true;
    await client.query('set local role pertexo_owner');
    const releases = await client.query(
      `select epoch, schema_version, fingerprint, catalog_json,
              predecessor_epoch, prepared_by_kind, prepared_by, reason,
              created_at
         from app.node_compatibility_releases order by epoch`,
    );
    const current = await client.query(
      `select singleton, epoch, fingerprint, activated_by_kind, activated_by,
              activated_at
         from app.node_compatibility_current order by singleton`,
    );
    await client.query('rollback');
    transactionOpen = false;
    return JSON.stringify({ current: current.rows, releases: releases.rows });
  } catch (error: unknown) {
    if (transactionOpen) {
      try {
        await client.query('rollback');
      } catch (rollbackError: unknown) {
        disposalError = new Error(
          'Compatibility state capture rollback failed; discard the client',
          { cause: rollbackError },
        );
      }
    }
    throw error;
  } finally {
    client.release(disposalError);
    await pool.end();
  }
}

async function cleanupCreatedDatabases(): Promise<unknown[]> {
  const fixtures = createdDatabaseFixtures.splice(0).reverse();
  const settled = await Promise.allSettled(fixtures.map(({ drop }) => drop()));
  return settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
}

function migrationConfig(name: string) {
  return {
    apiRuntimeRole: 'pertexo_api',
    connectionString: databaseUrl(migrationBaseUrl, name),
    dispatcherRole: 'pertexo_dispatcher',
    maintenanceRole: 'pertexo_maintenance',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    operatorRole: 'pertexo_operator',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  } as const;
}

async function migrateThrough0018(name: string): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-0018-'));
  try {
    const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
      (migration) => /^\d{4}_.+\.sql$/u.test(migration) && migration < '0019_',
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
  try {
    for (const fixture of databaseFixtures) {
      await fixture.create();
      createdDatabaseFixtures.push(fixture);
    }
    await migrateDatabase(migrationConfig(databaseName));
    await migrateDatabase(migrationConfig(rolloutDatabaseName));
    await migrateDatabase(migrationConfig(maintenanceDatabaseName));
    await migrateThrough0018(upgradeDatabaseName);
    upgradeBaselineState = await captureCompatibilityState(upgradeDatabaseName);
    await migrateDatabase(migrationConfig(upgradeDatabaseName));
  } catch (error: unknown) {
    const cleanupFailures = await cleanupCreatedDatabases();
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Compatibility fixture setup and cleanup failed',
      );
    throw error;
  }
}, 60_000);

afterAll(async () => {
  const failures = await cleanupCreatedDatabases();
  if (failures.length > 0)
    throw new AggregateError(failures, 'Compatibility fixture cleanup failed');
});

describe('durable node compatibility release authority', () => {
  it('requires exact API and worker preactivation cohorts before activation', async () => {
    const owner = new Pool({
      connectionString: databaseUrl(migrationBaseUrl, rolloutDatabaseName),
      max: 1,
    });
    const api = new Pool({
      connectionString: databaseUrl(apiBaseUrl, rolloutDatabaseName),
      max: 1,
    });
    const targetEpoch = 2;
    const targetFingerprint = BASELINE_COMPATIBILITY_EXPECTATION.fingerprint;
    const deploymentId = `compatibility-rollout-${randomUUID()}`;
    const approvalId = randomUUID();
    const activationId = randomUUID();
    const apiArtifactIds = ['api-a', 'api-b'] as const;
    const workerArtifactIds = ['worker-a', 'worker-b'] as const;
    const targetExpectation = {
      ...BASELINE_COMPATIBILITY_EXPECTATION,
      epoch: targetEpoch,
    };
    const rollingExpectations = [
      BASELINE_COMPATIBILITY_EXPECTATION,
      targetExpectation,
    ] as const;
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(
        `select app.prepare_node_compatibility_release(
           $1, $2, $3::jsonb, 1, $4, 'deployment', $5, $6
         )`,
        [
          targetEpoch,
          targetFingerprint,
          BASELINE_COMPATIBILITY_EXPECTATION.catalogJson,
          BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
          'compatibility-rollout-controller',
          'Prepare an additive rolling-overlap release',
        ],
      );
      await owner.query('commit');

      await expect(
        checkDatabasePreactivationReadiness(api, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
          expectedCompatibilityReleases: rollingExpectations,
          preactivationTarget: targetExpectation,
        }),
      ).resolves.toMatchObject({
        migrationHead: '0099_workflow_recent_list.sql',
      });

      for (const [roleKind, artifactId] of [
        ['api', apiArtifactIds[0]],
        ['worker', workerArtifactIds[0]],
      ] as const) {
        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query(
          `select app.record_node_compatibility_preactivation(
             $1, $2, $3, $4, $5, $6, $7::jsonb
           )`,
          [
            randomUUID(),
            deploymentId,
            targetEpoch,
            targetFingerprint,
            roleKind,
            artifactId,
            BASELINE_COMPATIBILITY_EXPECTATION.catalogJson,
          ],
        );
        await owner.query('commit');
      }

      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await expect(
        owner.query(
          `select app.approve_node_compatibility_activation(
             $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8
           )`,
          [
            approvalId,
            deploymentId,
            targetEpoch,
            targetFingerprint,
            JSON.stringify(apiArtifactIds),
            JSON.stringify(workerArtifactIds),
            'compatibility-rollout-controller',
            'Approve only after the complete named cohorts report ready',
          ],
        ),
      ).rejects.toSatisfy(pgCode('P0001'));
      await owner.query('rollback');

      for (const [roleKind, artifactId] of [
        ['api', apiArtifactIds[1]],
        ['worker', workerArtifactIds[1]],
      ] as const) {
        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query(
          `select app.record_node_compatibility_preactivation(
             $1, $2, $3, $4, $5, $6, $7::jsonb
           )`,
          [
            randomUUID(),
            deploymentId,
            targetEpoch,
            targetFingerprint,
            roleKind,
            artifactId,
            BASELINE_COMPATIBILITY_EXPECTATION.catalogJson,
          ],
        );
        await owner.query('commit');
      }

      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(
        `select app.approve_node_compatibility_activation(
           $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8
         )`,
        [
          approvalId,
          deploymentId,
          targetEpoch,
          targetFingerprint,
          JSON.stringify(apiArtifactIds),
          JSON.stringify(workerArtifactIds),
          'compatibility-rollout-controller',
          'Approve the fully ready rolling cohort',
        ],
      );
      await owner.query(
        `select app.activate_node_compatibility_release(
           $1, 1, $2, $3, $4, $5, $6
         )`,
        [
          activationId,
          BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
          approvalId,
          'deployment',
          'compatibility-rollout-controller',
          'Activate the prevalidated additive release',
        ],
      );
      await owner.query('commit');

      await expect(
        api.query(
          `select epoch, fingerprint, activation_approval_id
             from app.node_compatibility_current`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            activation_approval_id: approvalId,
            epoch: targetEpoch,
            fingerprint: targetFingerprint,
          },
        ],
      });
      await expect(
        checkDatabaseReadiness(api, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
          expectedCompatibilityReleases: rollingExpectations,
        }),
      ).resolves.toMatchObject({
        migrationHead: '0099_workflow_recent_list.sql',
      });
      await expect(
        checkDatabaseReadiness(api, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
          expectedCompatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
        }),
      ).rejects.toBeInstanceOf(CompatibilityReleaseMismatchError);
    } finally {
      await owner.end();
      await api.end();
    }
  });

  it('exposes one transaction-owning maintenance seam for the deployment controller', async () => {
    const maintenance = createCompatibilityReleaseMaintenance(
      parseDatabaseConfig({
        connectionString: databaseUrl(
          migrationBaseUrl,
          maintenanceDatabaseName,
        ),
        max: 1,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    const predecessor = BASELINE_COMPATIBILITY_EXPECTATION;
    const target = { ...predecessor, epoch: 2 };
    const deploymentId = `compatibility-maintenance-${randomUUID()}`;
    const approvalId = randomUUID();
    try {
      const preparation = {
        actorId: 'compatibility-rollout-controller',
        actorKind: 'deployment',
        expectedPredecessor: predecessor,
        reason: 'Prepare through the behavior-named maintenance boundary',
        target,
      } as const;
      await maintenance.prepare(preparation);
      await maintenance.prepare(preparation);
      await Promise.all(
        (
          [
            ['api', 'api-maintenance'],
            ['worker', 'worker-maintenance'],
          ] as const
        ).map(async ([roleKind, artifactId]) =>
          maintenance.recordPreactivation({
            artifactId,
            checkId: randomUUID(),
            deploymentId,
            roleKind,
            target,
          }),
        ),
      );
      await maintenance.approve({
        actorId: 'compatibility-rollout-controller',
        approvalId,
        deploymentId,
        reason: 'Approve the exact API and worker artifacts',
        requiredApiArtifacts: ['api-maintenance'],
        requiredWorkerArtifacts: ['worker-maintenance'],
        target,
      });
      await maintenance.approve({
        actorId: 'compatibility-rollout-controller',
        approvalId,
        deploymentId,
        reason: 'Approve the exact API and worker artifacts',
        requiredApiArtifacts: ['api-maintenance'],
        requiredWorkerArtifacts: ['worker-maintenance'],
        target,
      });
      const activation = {
        activationId: randomUUID(),
        actorId: 'compatibility-rollout-controller',
        actorKind: 'deployment',
        approvalId,
        expectedPredecessor: predecessor,
        reason: 'Activate through the audited maintenance boundary',
      } as const;
      await maintenance.activate(activation);
      await maintenance.activate(activation);

      const api = new Pool({
        connectionString: databaseUrl(apiBaseUrl, maintenanceDatabaseName),
        max: 1,
      });
      try {
        await expect(
          checkExpectedCompatibilityRelease(api, target),
        ).resolves.toBeUndefined();
      } finally {
        await api.end();
      }
    } finally {
      await maintenance.close();
    }
  });

  it('replaces a max-one pool client after an uncertain maintenance rollback', async () => {
    const config = parseDatabaseConfig({
      connectionString: databaseUrl(migrationBaseUrl, maintenanceDatabaseName),
      max: 1,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
    const runtime = createDatabaseRuntime(config, { monitorLockWaits: false });
    const pool = acquireDatabasePool(config, runtime).pool;
    const client = await pool.connect();
    const firstBackend = await client.query<{ pid: number }>(
      'select pg_backend_pid()::int pid',
    );
    const firstPid = firstBackend.rows[0]?.pid;
    if (firstPid === undefined) throw new Error('first backend PID missing');
    const originalQuery = client.query.bind(client) as (
      text: string,
      values?: unknown[],
    ) => Promise<unknown>;
    const originalConnect = pool.connect.bind(pool);
    const operationFailure = new Error('injected maintenance failure');
    const rollbackFailure = new Error('injected rollback failure');
    client.query = ((text: string, values?: unknown[]): Promise<unknown> => {
      if (text.includes('app.prepare_node_compatibility_release'))
        return Promise.reject(operationFailure);
      if (text === 'rollback') return Promise.reject(rollbackFailure);
      return originalQuery(text, values);
    }) as typeof client.query;
    pool.connect = (() => Promise.resolve(client)) as typeof pool.connect;
    const maintenance = createCompatibilityReleaseMaintenance(config, runtime);
    try {
      await expect(
        maintenance.prepare({
          actorId: 'compatibility-rollback-test',
          actorKind: 'deployment',
          expectedPredecessor: BASELINE_COMPATIBILITY_EXPECTATION,
          reason: 'Exercise uncertain rollback disposal',
          target: { ...BASELINE_COMPATIBILITY_EXPECTATION, epoch: 2 },
        }),
      ).rejects.toBe(operationFailure);
      pool.connect = originalConnect;
      const replacement = await pool.query<{ pid: number }>(
        'select pg_backend_pid()::int pid',
      );
      expect(replacement.rows[0]?.pid).not.toBe(firstPid);
    } finally {
      pool.connect = originalConnect;
      await maintenance.close();
      await runtime.close();
    }
  });

  it('matches the local API and worker artifacts and fails closed on drift', async () => {
    for (const base of [apiBaseUrl, workerBaseUrl]) {
      const pool = new Pool({ connectionString: databaseUrl(base), max: 1 });
      try {
        await expect(
          checkDatabaseReadiness(pool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
            expectedCompatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
          }),
        ).resolves.toMatchObject({
          migrationHead: '0099_workflow_recent_list.sql',
        });
        await expect(
          checkExpectedCompatibilityRelease(pool, {
            ...BASELINE_COMPATIBILITY_EXPECTATION,
            fingerprint:
              'node-compat:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          }),
        ).rejects.toBeInstanceOf(CompatibilityReleaseMismatchError);
      } finally {
        await pool.end();
      }
    }
  });

  it('upgrades the completed 0018 head without rewriting prior state', async () => {
    const pool = new Pool({
      connectionString: databaseUrl(apiBaseUrl, upgradeDatabaseName),
      max: 1,
    });
    try {
      expect(upgradeBaselineState).toBeDefined();
      await expect(
        captureCompatibilityState(upgradeDatabaseName),
      ).resolves.toBe(upgradeBaselineState);
      await expect(
        checkDatabaseReadiness(pool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
          expectedCompatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
        }),
      ).resolves.toMatchObject({
        migrationHead: '0099_workflow_recent_list.sql',
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
        await expect(
          pool.query(
            'select * from app.node_compatibility_preactivation_checks',
          ),
        ).rejects.toSatisfy(pgCode('42501'));
        await expect(
          pool.query(
            `select app.prepare_node_compatibility_release(
               2, $1, $2::jsonb, 1, $1, 'deployment', 'forbidden', 'forbidden'
             )`,
            [
              BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
              BASELINE_COMPATIBILITY_EXPECTATION.catalogJson,
            ],
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
      fingerprint = `node-compat:v1:sha256:${createHash('sha256').update(JSON.stringify(catalog)).digest('hex')}`,
    ): Promise<void> => {
      await owner.query('begin');
      try {
        await owner.query('set local role pertexo_owner');
        await owner.query(
          `insert into app.node_compatibility_releases
             (epoch, schema_version, fingerprint, catalog_json,
              predecessor_epoch, prepared_by_kind, prepared_by, reason)
           values ($1, 1, $2, $3::jsonb, 1, 'deployment',
                   'baseline-non-removal-test', 'candidate')`,
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
        JSON.parse(BASELINE_COMPATIBILITY_EXPECTATION.catalogJson) as unknown,
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
        pgDiagnostic({
          code: '23514',
          message: 'must retain core executor core.set',
        }),
      );

      for (const lifecycle of ['staged', 'retirement_blocked', 'retired']) {
        const unavailable = structuredClone(retained);
        const unavailableSet = unavailable.executors.find(
          ({ executor }) => executor.key === 'core.set',
        );
        if (unavailableSet === undefined)
          throw new Error('core Set fixture missing');
        unavailableSet.lifecycle = lifecycle;
        await expect(insertCandidate(3, unavailable)).rejects.toSatisfy(
          pgDiagnostic({
            code: '23514',
            message: 'must retain core executor core.set',
          }),
        );
      }

      const duplicated = structuredClone(retained);
      const manual = duplicated.executors.find(
        ({ executor }) => executor.key === 'core.manual',
      );
      if (manual === undefined) throw new Error('core Manual fixture missing');
      duplicated.executors.push(structuredClone(manual));
      await expect(insertCandidate(3, duplicated)).rejects.toSatisfy(
        pgDiagnostic({
          code: '23514',
          message: 'must retain core executor core.manual',
        }),
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
          expectedCompatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
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
          expectedCompatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
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
          expectedCompatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
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

  it('fails readiness on preactivation evidence grant drift', async () => {
    const owner = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
      max: 1,
    });
    const api = new Pool({ connectionString: databaseUrl(apiBaseUrl), max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(
        'grant select on app.node_compatibility_preactivation_checks to pertexo_api',
      );
      await owner.query('commit');
      await expect(
        checkDatabaseReadiness(api, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
          expectedCompatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
        }),
      ).rejects.toThrow('preactivation authority');
    } finally {
      await owner.query('begin').catch(() => undefined);
      await owner.query('set local role pertexo_owner').catch(() => undefined);
      await owner
        .query(
          'revoke select on app.node_compatibility_preactivation_checks from pertexo_api',
        )
        .catch(() => undefined);
      await owner.query('commit').catch(() => undefined);
      await owner.end();
      await api.end();
    }
  });
});
