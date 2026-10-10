import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../../src/config.js';
import { createIdentityWorkspaceDatabase } from '../../src/tenant-access/database.js';
import { migrateDatabase } from '../../src/migrations.js';
import { createPublishedWorkflowReader } from '../../src/runs/published-workflow.js';
import { createWorkflowAuthoringFixtureDatabase as createWorkflowAuthoringDatabase } from '../support/workflow-authoring-admission.fixture.js';
import { createDisposableDatabaseFixture } from '../support/postgres/disposable-database.js';

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
);
const workerReader = createPublishedWorkflowReader(
  parseDatabaseConfig({ connectionString: workerUrl, max: 2 }),
);

const actorId = randomUUID();
let workspaceId = '';
let workflowId = '';
let versionId = '';

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
      emptyGraph: { edges: [], nodes: [], settings: {} },
      idempotencyKey: `published-reader-workflow-${actorId}`,
      name: 'Executable workflow',
      workspaceId,
    })
  ).workflowId;

  versionId = randomUUID();
  await executeAsOwner(
    `insert into app.workflow_versions (
       id, workspace_id, workflow_id, version_number,
       graph_json, checksum, executable_json, published_by
     ) values ($1, $2, $3, 2, $4::jsonb, $5, $6::jsonb, $7)`,
    [
      versionId,
      workspaceId,
      workflowId,
      JSON.stringify({ edges: [], nodes: [], settings: {} }),
      `wf:sha256:${'2'.repeat(64)}`,
      JSON.stringify({ nodes: [], edges: [] }),
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
  it('loads only a same-workspace published version for the worker', async () => {
    await expect(
      workerReader.readForExecution({
        workspaceId,
        workflowVersionId: versionId,
      }),
    ).resolves.toEqual({
      checksum: `wf:sha256:${'2'.repeat(64)}`,
      executableJson: { nodes: [], edges: [] },
      id: versionId,
      versionNumber: 2,
      workflowId,
      workspaceId,
    });
    await expect(
      workerReader.readForExecution({
        workspaceId: randomUUID(),
        workflowVersionId: versionId,
      }),
    ).resolves.toBeNull();
  });

  it('enforces forced RLS and denies version updates and deletes', async () => {
    await expect(
      queryAsWorker(
        `select id, workspace_id, workflow_id, version_number, checksum, executable_json
         from app.workflow_versions where id = $1`,
        [versionId],
        workspaceId,
      ),
    ).resolves.toHaveLength(1);
    await expect(
      queryAsWorker('select id from app.workflow_versions where id = $1', [
        versionId,
      ]),
    ).resolves.toEqual([]);
    for (const statement of [
      `update app.workflow_versions set version_number = 99 where id = '${versionId}'`,
      `delete from app.workflow_versions where id = '${versionId}'`,
    ]) {
      await expect(queryAsWorker(statement, [], workspaceId)).rejects.toSatisfy(
        expectPgCode('42501'),
      );
    }
  });

  it('rejects missing, malformed and oversized executable rows and keeps versions append-only', async () => {
    const insertPrefix = `insert into app.workflow_versions
      (id, workspace_id, workflow_id, version_number, graph_json, checksum, executable_json, published_by) values`;
    await expect(
      executeAsOwner(
        `${insertPrefix} ('${randomUUID()}', '${workspaceId}', '${workflowId}', 10,
          '{}', 'wf:sha256:${'a'.repeat(64)}', null, '${actorId}')`,
      ),
    ).rejects.toSatisfy(expectPgCode('23502'));
    const cases = [
      `${insertPrefix} ('${randomUUID()}', '${workspaceId}', '${workflowId}', 11,
        '{}', 'wf:sha256:${'b'.repeat(64)}', '[]', '${actorId}')`,
      `${insertPrefix} ('${randomUUID()}', '${workspaceId}', '${workflowId}', 12,
        '{}', 'wf:sha256:${'C'.repeat(64)}', '{}', '${actorId}')`,
    ];
    for (const statement of cases) {
      await expect(executeAsOwner(statement)).rejects.toSatisfy(
        expectPgCode('23514'),
      );
    }
    await expect(
      executeAsOwner(
        `${insertPrefix} ($1, $2, $3, 13, '{}', $4,
          jsonb_build_object('payload', $5::text), $6)`,
        [
          randomUUID(),
          workspaceId,
          workflowId,
          `wf:sha256:${'d'.repeat(64)}`,
          'x'.repeat(1_048_576),
          actorId,
        ],
      ),
    ).rejects.toSatisfy(expectPgCode('23514'));
    // Published versions are append-only for the app role.
    await expect(
      apiPool.query(
        `update app.workflow_versions set executable_json = '{}'
         where id = $1`,
        [versionId],
      ),
    ).rejects.toSatisfy(expectPgCode('42501'));
    await expect(
      apiPool.query('delete from app.workflow_versions where id = $1', [
        versionId,
      ]),
    ).rejects.toSatisfy(expectPgCode('42501'));
  });
});
