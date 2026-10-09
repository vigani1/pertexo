import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createIdentityWorkspaceDatabase } from '../src/tenant-access/identity-workspace.js';
import { migrateDatabase } from '../src/migrations.js';
import { createPublishedWorkflowReader } from '../src/execution/published-workflow-reader.js';
import { createWorkflowAuthoringFixtureDatabase as createWorkflowAuthoringDatabase } from './support/workflow-authoring-admission.fixture.js';
import { BASELINE_COMPATIBILITY_EXPECTATION } from './baseline-compatibility-fixture.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const databaseName = `pertexo_test_reader_${randomUUID().replaceAll('-', '')}`;
const disposableDatabase = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_app'],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const migrationUrl = disposableDatabase.databaseUrl(migrationBaseUrl);
const apiUrl = disposableDatabase.databaseUrl(apiBaseUrl);
const workerUrl = disposableDatabase.databaseUrl(workerBaseUrl);
const migrationConfig = {
  appRole: 'pertexo_app',
  connectionString: migrationUrl,
  maintenanceRole: 'pertexo_maintenance',
  ownerRole: 'pertexo_owner',
} as const;
const ownerPool = new Pool({ connectionString: migrationUrl, max: 2 });
const apiPool = new Pool({ connectionString: apiUrl, max: 1 });
const workerPool = new Pool({ connectionString: workerUrl, max: 1 });
const identity = createIdentityWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
);
const authoring = createWorkflowAuthoringDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
);
const apiReader = createPublishedWorkflowReader(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  BASELINE_COMPATIBILITY_EXPECTATION,
);
const workerReader = createPublishedWorkflowReader(
  parseDatabaseConfig({ connectionString: workerUrl, max: 2 }),
  BASELINE_COMPATIBILITY_EXPECTATION,
);

const actorId = randomUUID();
let workspaceId = '';
let workflowId = '';
let v1VersionId = '';
let v2VersionId = '';

function expectPgCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    while (current instanceof Error) {
      if ((current as DatabaseError).code === code) return true;
      current = current.cause;
    }
    return false;
  };
}

async function executeAsOwner(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    await client.query(statement, [...parameters]);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function queryAsWorker(
  statement: string,
  parameters: readonly unknown[] = [],
  scopedWorkspaceId?: string,
): Promise<readonly Record<string, unknown>[]> {
  const client = await workerPool.connect();
  try {
    await client.query('begin');
    if (scopedWorkspaceId !== undefined) {
      await client.query("select set_config('app.workspace_id', $1, true)", [
        scopedWorkspaceId,
      ]);
    }
    const result = await client.query<Record<string, unknown>>(statement, [
      ...parameters,
    ]);
    await client.query('commit');
    return result.rows;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await disposableDatabase.create();
  try {
    await migrateDatabase(migrationConfig);
  } catch (error: unknown) {
    await disposableDatabase.drop().catch(() => undefined);
    throw error;
  }
  await identity.createUser({
    id: actorId,
    email: `published-reader-${actorId}@example.test`,
    displayName: 'Published Reader',
  });
  workspaceId = (
    await identity.createWorkspaceWithOwner({
      id: randomUUID(),
      idempotencyKey: `published-reader-${actorId}`,
      name: 'Published Reader Proof',
      ownerUserId: actorId,
      slug: `published-reader-${actorId}`,
    })
  ).id;
  workflowId = (
    await authoring.createWorkflow({
      actorId,
      emptyGraph: { edges: [], nodes: [], schemaVersion: 1, settings: {} },
      idempotencyKey: `published-reader-workflow-${actorId}`,
      name: 'Executable workflow',
      workspaceId,
    })
  ).workflowId;

  v1VersionId = randomUUID();
  v2VersionId = randomUUID();
  await executeAsOwner(
    `insert into app.workflow_versions (
       id, workspace_id, workflow_id, version_number, schema_version,
       graph_json, checksum, executable_schema_version, executable_json,
       compatibility_release_epoch, published_by
     ) values
       ($1, $3, $4, 1, 1, $5::jsonb, $6, null, null, null, $9),
       ($2, $3, $4, 2, 1, $5::jsonb, $7, 2, $8::jsonb, 7, $9)`,
    [
      v1VersionId,
      v2VersionId,
      workspaceId,
      workflowId,
      JSON.stringify({ edges: [], nodes: [], schemaVersion: 1, settings: {} }),
      `wf:v1:sha256:${'1'.repeat(64)}`,
      `wf:v2:sha256:${'2'.repeat(64)}`,
      JSON.stringify({ schemaVersion: 2, nodes: [], edges: [] }),
      actorId,
    ],
  );
});

afterAll(async () => {
  const outcomes = await Promise.allSettled([
    workerReader.close(),
    apiReader.close(),
    authoring.close(),
    identity.close(),
    workerPool.end(),
    apiPool.end(),
    ownerPool.end(),
  ]);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
  );
  try {
    await disposableDatabase.drop();
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'Published-reader fixture cleanup failed',
    );
});

describe('PublishedWorkflowReader', () => {
  it('classifies a retained V1 row as non-executable for an authorized API reader', async () => {
    await expect(
      apiReader.readForExecution({
        workspaceId,
        workflowVersionId: v1VersionId,
      }),
    ).resolves.toMatchObject({
      kind: 'non_executable',
      workflowVersion: {
        id: v1VersionId,
        checksum: `wf:v1:sha256:${'1'.repeat(64)}`,
      },
    });
  });

  it('loads only a same-workspace V2 executable projection for the worker', async () => {
    await expect(
      workerReader.readForExecution({
        workspaceId,
        workflowVersionId: v2VersionId,
      }),
    ).resolves.toEqual({
      kind: 'v2_projection',
      workflowVersion: {
        checksum: `wf:v2:sha256:${'2'.repeat(64)}`,
        compatibilityReleaseEpoch: 7,
        currentCompatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
        executableJson: { schemaVersion: 2, nodes: [], edges: [] },
        executableSchemaVersion: 2,
        id: v2VersionId,
        schemaVersion: 1,
        versionNumber: 2,
        workflowId,
        workspaceId,
      },
    });
    await expect(
      workerReader.readForExecution({
        workspaceId: randomUUID(),
        workflowVersionId: v2VersionId,
      }),
    ).resolves.toEqual({ kind: 'not_found' });
    await expect(
      workerReader.readForExecution({
        workspaceId,
        workflowVersionId: v1VersionId,
      }),
    ).resolves.toMatchObject({ kind: 'non_executable' });
  });

  it('enforces forced RLS and denies version updates and deletes', async () => {
    await expect(
      queryAsWorker(
        `select id, workspace_id, workflow_id, version_number, schema_version,
                checksum, executable_schema_version, executable_json,
                compatibility_release_epoch
         from app.workflow_versions where id = $1`,
        [v2VersionId],
        workspaceId,
      ),
    ).resolves.toHaveLength(1);
    await expect(
      queryAsWorker('select id from app.workflow_versions where id = $1', [
        v2VersionId,
      ]),
    ).resolves.toEqual([]);
    for (const statement of [
      `update app.workflow_versions set version_number = 99 where id = '${v2VersionId}'`,
      `delete from app.workflow_versions where id = '${v2VersionId}'`,
    ]) {
      await expect(queryAsWorker(statement, [], workspaceId)).rejects.toSatisfy(
        expectPgCode('42501'),
      );
    }
  });

  it('rejects partial, malformed, oversized, and mutable executable rows', async () => {
    const insertPrefix = `insert into app.workflow_versions
      (id, workspace_id, workflow_id, version_number, schema_version,
       graph_json, checksum, executable_schema_version, executable_json,
       compatibility_release_epoch, published_by) values`;
    const cases = [
      `${insertPrefix} ('${randomUUID()}', '${workspaceId}', '${workflowId}', 10,
        1, '{}', 'wf:v2:sha256:${'a'.repeat(64)}', 2, '{}', null, '${actorId}')`,
      `${insertPrefix} ('${randomUUID()}', '${workspaceId}', '${workflowId}', 11,
        1, '{}', 'wf:v2:sha256:${'b'.repeat(64)}', 2, '[]', 1, '${actorId}')`,
      `${insertPrefix} ('${randomUUID()}', '${workspaceId}', '${workflowId}', 12,
        1, '{}', 'wf:v1:sha256:${'c'.repeat(64)}', 2, '{}', 1, '${actorId}')`,
    ];
    for (const statement of cases) {
      await expect(executeAsOwner(statement)).rejects.toSatisfy(
        expectPgCode('23514'),
      );
    }
    await expect(
      executeAsOwner(
        `${insertPrefix} ($1, $2, $3, 13, 1, '{}', $4, 2,
          jsonb_build_object('payload', $5::text), 1, $6)`,
        [
          randomUUID(),
          workspaceId,
          workflowId,
          `wf:v2:sha256:${'d'.repeat(64)}`,
          'x'.repeat(1_048_576),
          actorId,
        ],
      ),
    ).rejects.toSatisfy(expectPgCode('23514'));
    await expect(
      executeAsOwner(
        `update app.workflow_versions set executable_json = '{}'
         where id = $1`,
        [v1VersionId],
      ),
    ).rejects.toSatisfy(expectPgCode('55000'));
    await expect(
      executeAsOwner('delete from app.workflow_versions where id = $1', [
        v2VersionId,
      ]),
    ).rejects.toSatisfy(expectPgCode('55000'));
  });
});
