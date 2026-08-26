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
import { createCompatibilityReleaseMaintenance } from '../src/compatibility-release-maintenance.js';
import { parseDatabaseConfig } from '../src/config.js';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';
import {
  checkDatabasePreactivationReadiness,
  checkDatabaseReadiness,
} from '../src/readiness.js';
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
const rolloutDatabaseName = `pertexo_test_compatibility_rollout_${randomUUID().replaceAll('-', '')}`;
const databaseNames = [
  databaseName,
  upgradeDatabaseName,
  rolloutDatabaseName,
] as const;
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
    await dropDisconnectedDatabase(admin, name);
  } finally {
    await admin.end();
  }
}

function migrationConfig(name: string) {
  return {
    apiRuntimeRole: 'pertexo_api',
    connectionString: databaseUrl(migrationBaseUrl, name),
    dispatcherRole: 'pertexo_dispatcher',
    maintenanceRole: 'pertexo_maintenance',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
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
  for (const name of databaseNames) await createDatabase(name);
  await migrateDatabase({
    apiRuntimeRole: 'pertexo_api',
    connectionString: databaseUrl(migrationBaseUrl),
    dispatcherRole: 'pertexo_dispatcher',
    maintenanceRole: 'pertexo_maintenance',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  });
  await migrateDatabase(migrationConfig(rolloutDatabaseName));
  await migrateThrough0018(upgradeDatabaseName);
  await migrateDatabase(migrationConfig(upgradeDatabaseName));
}, 60_000);

afterAll(async () => {
  for (const name of databaseNames) await dropDatabase(name);
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
    const targetFingerprint = PHASE3_COMPATIBILITY_EXPECTATION.fingerprint;
    const deploymentId = `phase3-rollout-${randomUUID()}`;
    const approvalId = randomUUID();
    const activationId = randomUUID();
    const apiArtifactIds = ['api-a', 'api-b'] as const;
    const workerArtifactIds = ['worker-a', 'worker-b'] as const;
    const targetExpectation = {
      ...PHASE3_COMPATIBILITY_EXPECTATION,
      epoch: targetEpoch,
    };
    const rollingExpectations = [
      PHASE3_COMPATIBILITY_EXPECTATION,
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
          PHASE3_COMPATIBILITY_EXPECTATION.catalogJson,
          PHASE3_COMPATIBILITY_EXPECTATION.fingerprint,
          'phase3-rollout-controller',
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
        migrationHead: '0048_workspace_lifecycle_command_hardening.sql',
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
            PHASE3_COMPATIBILITY_EXPECTATION.catalogJson,
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
            'phase3-rollout-controller',
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
            PHASE3_COMPATIBILITY_EXPECTATION.catalogJson,
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
          'phase3-rollout-controller',
          'Approve the fully ready rolling cohort',
        ],
      );
      await owner.query(
        `select app.activate_node_compatibility_release(
           $1, 1, $2, $3, $4, $5, $6
         )`,
        [
          activationId,
          PHASE3_COMPATIBILITY_EXPECTATION.fingerprint,
          approvalId,
          'deployment',
          'phase3-rollout-controller',
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
        migrationHead: '0048_workspace_lifecycle_command_hardening.sql',
      });
      await expect(
        checkDatabaseReadiness(api, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
          expectedCompatibilityRelease: PHASE3_COMPATIBILITY_EXPECTATION,
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
        connectionString: databaseUrl(migrationBaseUrl, rolloutDatabaseName),
        max: 1,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    const predecessor = {
      ...PHASE3_COMPATIBILITY_EXPECTATION,
      epoch: 2,
    };
    const target = { ...predecessor, epoch: 3 };
    const deploymentId = `phase3-maintenance-${randomUUID()}`;
    const approvalId = randomUUID();
    try {
      const preparation = {
        actorId: 'phase3-rollout-controller',
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
        actorId: 'phase3-rollout-controller',
        approvalId,
        deploymentId,
        reason: 'Approve the exact API and worker artifacts',
        requiredApiArtifacts: ['api-maintenance'],
        requiredWorkerArtifacts: ['worker-maintenance'],
        target,
      });
      await maintenance.approve({
        actorId: 'phase3-rollout-controller',
        approvalId,
        deploymentId,
        reason: 'Approve the exact API and worker artifacts',
        requiredApiArtifacts: ['api-maintenance'],
        requiredWorkerArtifacts: ['worker-maintenance'],
        target,
      });
      const activation = {
        activationId: randomUUID(),
        actorId: 'phase3-rollout-controller',
        actorKind: 'deployment',
        approvalId,
        expectedPredecessor: predecessor,
        reason: 'Activate through the audited maintenance boundary',
      } as const;
      await maintenance.activate(activation);
      await maintenance.activate(activation);

      const api = new Pool({
        connectionString: databaseUrl(apiBaseUrl, rolloutDatabaseName),
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
          migrationHead: '0048_workspace_lifecycle_command_hardening.sql',
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

  it('upgrades the completed 0018 head without rewriting prior state', async () => {
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
        migrationHead: '0048_workspace_lifecycle_command_hardening.sql',
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
              PHASE3_COMPATIBILITY_EXPECTATION.fingerprint,
              PHASE3_COMPATIBILITY_EXPECTATION.catalogJson,
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

      for (const lifecycle of ['staged', 'retirement_blocked', 'retired']) {
        const unavailable = structuredClone(retained);
        const unavailableSet = unavailable.executors.find(
          ({ executor }) => executor.key === 'core.set',
        );
        if (unavailableSet === undefined)
          throw new Error('core Set fixture missing');
        unavailableSet.lifecycle = lifecycle;
        await expect(insertCandidate(3, unavailable)).rejects.toSatisfy(
          pgCode('23514'),
        );
      }

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
          expectedCompatibilityRelease: PHASE3_COMPATIBILITY_EXPECTATION,
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
