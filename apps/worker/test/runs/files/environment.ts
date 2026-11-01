import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createInitialCheckpoint } from '@pertexo/core/execution';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';
import { createWorkerNodeRuntimeCapabilities } from '../../../src/attempts/execution/runtime-capabilities.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';
import { acceptManualFixtureRun } from '../../support/attempts/manual-start.js';
import { createTestArtifactScratch } from '../../support/infrastructure/artifact-scratch.js';

export async function fileEnvironment() {
  await fixture.setup();
  const scratch = await createTestArtifactScratch();
  const config = parseArtifactStoreConfig(process.env);
  const sourceScratch = await createTestArtifactScratch();
  const store = createArtifactStore(config);
  const pool = new Pool({
    connectionString: fixture.databaseUrl(
      process.env.DATABASE_MIGRATION_URL ??
        'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
    ),
    max: 1,
  });
  const capabilities = await createWorkerNodeRuntimeCapabilities({
    database: {
      connectionString: fixture.databaseUrl(fixture.workerUrl),
      max: 2,
      ownerRole: 'pertexo_owner',
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    },
    artifactStore: config,
    artifactScratchDirectory: sourceScratch.directory,
  });
  const workspaces: string[] = [fixture.workspaceId];
  async function query<Row extends Record<string, unknown>>(
    workspaceId: string,
    statement: string,
    values: readonly unknown[] = [],
  ) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      const result = await client.query<Row>(statement, [...values]);
      await client.query('commit');
      return result.rows;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    fixture,
    scratch,
    config,
    workspaces,
    query,
    async addWorkspace() {
      const id = randomUUID();
      await query(
        id,
        "insert into app.workspaces(id,name,slug,status,created_by) values($1,'File qualification',$2,'active',$3)",
        [id, `files-${id}`, fixture.actorId],
      );
      await query(
        id,
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')",
        [id, fixture.actorId],
      );
      workspaces.push(id);
      return id;
    },
    async upload(workspaceId: string, body: Buffer, mediaType: string) {
      const artifacts = capabilities.factories.artifacts?.({
        workspaceId,
        runId: randomUUID(),
        nodeRunId: randomUUID(),
        attemptId: randomUUID(),
        attemptNumber: 1,
        nodeId: 'source',
        invocationKey: 'root:source',
        workerId: 'file-qualification-source',
        artifactRetentionDeadline: new Date(Date.now() + 3600000),
      });
      if (artifacts === undefined)
        throw new Error('Missing real artifact capability');
      const reference = await artifacts.write({
        body: (async function* () {
          for (let offset = 0; offset < body.length; offset += 65536)
            yield await Promise.resolve(
              Buffer.from(body.subarray(offset, offset + 65536)),
            );
        })(),
        maxBytes: 10485760,
        mediaType,
        purpose: 'node-output',
        signal: new AbortController().signal,
      });
      return { kind: 'artifact' as const, ...reference };
    },
    async start(
      workspaceId: string,
      graph: WorkflowGraph,
      runInput: unknown = {},
    ) {
      const identity = {
        workflowId: randomUUID(),
        workflowVersionId: randomUUID(),
      };
      const executable = await insertCompiledWorkflow(
        (sql, params) => query(workspaceId, sql, params),
        {
          actorId: fixture.actorId,
          workspaceId,
          identity,
          graph,
          name: 'File qualification',
          catalog: PLATFORM_NODE_CATALOG,
        },
      );
      const initial = createInitialCheckpoint(
        {
          id: identity.workflowVersionId,
          workspaceId,
          workflowId: identity.workflowId,
          versionNumber: 1,
          checksum: executable.checksum,
          executableJson: executable.envelope,
        },
        { catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG) },
      );
      const accepted = await fixture.apiDatabase.withWorkspace(
        workspaceId,
        (transaction) =>
          acceptManualFixtureRun(transaction, {
            initialCheckpoint: initial.checkpoint,
            ...(initial.validateInput === undefined
              ? {}
              : { validateInput: initial.validateInput }),
            keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
            requestHash: createHash('sha256')
              .update(JSON.stringify(runInput))
              .digest('hex'),
            operation: 'workflow.run.accept',
            scope: `workflow:${identity.workflowId}:manual`,
            triggerType: 'manual',
            ...identity,
            runInput,
          }),
      );
      return { workspaceId, runId: accepted.runId, ...identity };
    },
    async close() {
      await capabilities.close();
      for (const workspaceId of workspaces) {
        const files = await query<{ id: string }>(
          workspaceId,
          'select id from app.artifacts where workspace_id=$1',
          [workspaceId],
        );
        for (const file of files)
          await store.delete({ workspaceId, artifactId: file.id });
      }
      store.close();
      await pool.end();
      await scratch.close();
      await sourceScratch.close();
      await fixture.restoreServicesAndClose();
    },
  };
}
