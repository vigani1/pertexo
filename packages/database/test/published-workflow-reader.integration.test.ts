import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createIdentityWorkspaceDatabase } from '../src/identity-workspace.js';
import { migrateDatabase } from '../src/migrations.js';
import { createPublishedWorkflowReader } from '../src/published-workflow-reader.js';
import { checkDatabaseReadiness } from '../src/readiness.js';
import { createWorkflowAuthoringDatabase } from '../src/workflow-authoring.js';

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
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
let v1VersionId = '';
let v2VersionId = '';
const readinessDriftLockId = 7_166_118_813;

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

async function withReadinessDriftLock(
  operation: () => Promise<void>,
): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [readinessDriftLockId]);
    await operation();
  } finally {
    await client
      .query('select pg_advisory_unlock($1)', [readinessDriftLockId])
      .catch(() => undefined);
    client.release();
  }
}

beforeAll(async () => {
  await migrateDatabase(migrationConfig);
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
  await workerReader.close();
  await apiReader.close();
  await authoring.close();
  await identity.close();
  await workerPool.end();
  await apiPool.end();
  await ownerPool.end();
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
    ).resolves.toEqual({ kind: 'not_found' });
  });

  it('enforces exact worker columns, forced RLS, and mutation denial', async () => {
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
    await expect(
      queryAsWorker('select * from app.workflow_versions', [], workspaceId),
    ).rejects.toSatisfy(expectPgCode('42501'));
    await expect(
      queryAsWorker(
        'select graph_json from app.workflow_versions',
        [],
        workspaceId,
      ),
    ).rejects.toSatisfy(expectPgCode('42501'));
    await expect(
      queryAsWorker(
        'select published_by, published_at from app.workflow_versions',
        [],
        workspaceId,
      ),
    ).rejects.toSatisfy(expectPgCode('42501'));
    for (const statement of [
      `insert into app.workflow_versions
         (id, workspace_id, workflow_id, version_number, schema_version,
          graph_json, checksum, published_by)
       values ('00000000-0000-4000-8000-000000000001',
               '${workspaceId}', '${workflowId}', 99, 1, '{}',
               'wf:v1:sha256:${'9'.repeat(64)}', '${actorId}')`,
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

  it('fails readiness on weakened execution constraints, policy, or worker grants', async () => {
    await withReadinessDriftLock(async () => {
      await executeAsOwner(`alter table app.workflow_versions
        drop constraint workflow_versions_checksum_format,
        add constraint workflow_versions_checksum_format check (true)`);
      try {
        await expect(checkDatabaseReadiness(apiPool)).rejects.toThrow(
          'Published workflow execution schema is incompatible',
        );
      } finally {
        await executeAsOwner(`alter table app.workflow_versions
          drop constraint workflow_versions_checksum_format,
          add constraint workflow_versions_checksum_format check ((
            (checksum ~ '^wf:v1:sha256:[0-9a-f]{64}$'
             and executable_schema_version is null
             and executable_json is null
             and compatibility_release_epoch is null)
            or
            (checksum ~ '^wf:v2:sha256:[0-9a-f]{64}$'
             and executable_schema_version is not null
             and executable_schema_version = 2
             and executable_json is not null
             and jsonb_typeof(executable_json) = 'object'
             and compatibility_release_epoch is not null
             and compatibility_release_epoch > 0)
          ) is true)`);
      }

      await executeAsOwner(`alter policy workflow_versions_worker_execution_read
        on app.workflow_versions to pertexo_dispatcher`);
      try {
        await expect(checkDatabaseReadiness(apiPool)).rejects.toThrow(
          'Published workflow execution row-level security is incompatible',
        );
      } finally {
        await executeAsOwner(`alter policy workflow_versions_worker_execution_read
          on app.workflow_versions to pertexo_worker`);
      }

      await executeAsOwner(`alter policy workflow_versions_worker_execution_read
        on app.workflow_versions using (true)`);
      try {
        await expect(checkDatabaseReadiness(apiPool)).rejects.toThrow(
          'Published workflow execution row-level security is incompatible',
        );
      } finally {
        await executeAsOwner(`alter policy workflow_versions_worker_execution_read
          on app.workflow_versions using (
            workspace_id::text = nullif(current_setting('app.workspace_id', true), '')
            and checksum like 'wf:v2:sha256:%'
            and executable_schema_version = 2
            and executable_json is not null
            and compatibility_release_epoch > 0
          )`);
      }

      await executeAsOwner(
        'grant select (graph_json) on app.workflow_versions to pertexo_worker',
      );
      try {
        await expect(checkDatabaseReadiness(apiPool)).rejects.toThrow(
          'Published workflow execution grants are incompatible',
        );
      } finally {
        await executeAsOwner(
          'revoke select (graph_json) on app.workflow_versions from pertexo_worker',
        );
      }
    });
  });
});
