import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import {
  acceptWorkflowRun,
  canonicalOutboxPayloadChecksum,
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
  createCoordinatorRunStore,
  createDueNodeWakeupScanner,
  createFailureNotificationStore,
  createOutboxDispatcherDatabase,
  createWorkspaceDatabase,
  parseDatabaseConfig,
  requestWorkflowRunCancellation,
} from '@pertexo/database';
import {
  PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED,
  PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
  PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_FOR_EACH_STAGED,
  PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_MERGE_STAGED,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED,
  PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED,
} from '@pertexo/node-catalog';
import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '@pertexo/integrations/server';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import { CORE_REGISTRY_RELEASE_SUCCESSOR } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  createCheckpointV2,
  describeExecutableCompatibilityRelease,
  invocationKey,
  parseCheckpoint,
} from '@pertexo/workflow-engine';
import { createQueueProducer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { expect } from 'vitest';

import { createCoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import type { CoordinatorAdvanceEngine } from '../src/execution/coordinator-handler.js';
import { createProviderFailureNotificationDelivery } from '../src/execution/failure-notification-delivery.js';
import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';
import { createPreviewMaintenanceRuntime } from '../src/execution/preview-maintenance-runtime.js';
import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import { createDispatchConsumerCapabilityRegistry } from '../src/transport/dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from '../src/transport/outbox-dispatcher.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';

const enabled = process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const execFileAsync = promisify(execFile);
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const dispatcherUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
const databaseName = `pertexo_test_retained_core_${randomUUID().replaceAll('-', '')}`;
const repositoryRoot = new URL('../../../', import.meta.url).pathname;

async function compose(...arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('docker', ['compose', ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return result.stdout.trim();
}

async function stopService(service: 'postgres' | 'redis'): Promise<void> {
  await compose('stop', '--timeout', '10', service);
}

async function startService(service: 'postgres' | 'redis'): Promise<number> {
  const startedAt = performance.now();
  await compose('up', '-d', '--wait', service);
  return performance.now() - startedAt;
}

async function restoreServices(): Promise<void> {
  await compose('up', '-d', '--wait', 'postgres', 'redis');
}

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const redisUrl = (() => {
  const parsed = new URL(configuredRedisUrl);
  parsed.pathname = '/12';
  return parsed.toString();
})();

const actorId = randomUUID();
const workspaceId = randomUUID();
const workflowId = randomUUID();
const workflowVersionId = randomUUID();
const conditionWorkflowId = randomUUID();
const conditionWorkflowVersionId = randomUUID();
const switchWorkflowId = randomUUID();
const switchWorkflowVersionId = randomUUID();
const parallelWorkflowId = randomUUID();
const parallelWorkflowVersionId = randomUUID();
const forEachWorkflowId = randomUUID();
const forEachWorkflowVersionId = randomUUID();
const engineVersion = 'phase3-engine-v1';
const ownerPool = new Pool({
  connectionString: databaseUrl(migrationUrl),
  max: 1,
});
ownerPool.on('error', () => undefined);
const workerPool = new Pool({
  connectionString: databaseUrl(workerUrl),
  max: 2,
});
workerPool.on('error', () => undefined);
const apiDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: databaseUrl(apiUrl), max: 2 }),
);

async function createDatabase(): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await pool.query(`create database "${databaseName}" owner pertexo_owner`);
    await pool.query(`revoke all on database "${databaseName}" from public`);
    await pool.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
    );
  } finally {
    await pool.end();
  }
}

async function migrateDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['--filter', '@pertexo/database', 'exec', 'tsx', 'src/migrate.ts'],
      {
        cwd: new URL('../../../', import.meta.url).pathname,
        env: {
          ...process.env,
          DATABASE_MIGRATION_URL: databaseUrl(migrationUrl),
        },
        stdio: 'inherit',
      },
    );
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`retained core migration failed: ${String(code)}`));
    });
  });
}

async function dropDatabase(): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(pool, databaseName);
  } finally {
    await pool.end();
  }
}

function redisConnection(): {
  db: number;
  host: string;
  password?: string;
  port: number;
} {
  const parsed = new URL(redisUrl);
  return {
    db: Number(parsed.pathname.slice(1) || '0'),
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password === ''
      ? {}
      : { password: decodeURIComponent(parsed.password) }),
  };
}

async function ownerQuery<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await client.query<T>(statement, [...parameters]);
    await client.query('commit');
    return result.rows;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function workerQuery<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await workerPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await client.query<T>(statement, [...parameters]);
    await client.query('commit');
    return result.rows;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function apiQuery<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<readonly T[]> {
  const pool = new Pool({
    connectionString: databaseUrl(apiUrl),
    max: 1,
  });
  try {
    await pool.query('begin');
    await pool.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await pool.query<T>(statement, [...parameters]);
    await pool.query('commit');
    return result.rows;
  } catch (error: unknown) {
    await pool.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}

async function waitFor<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await operation();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    value = await operation();
  }
  if (!predicate(value)) {
    throw new Error(
      `coordinator proof timed out with ${JSON.stringify(value)}`,
    );
  }
  return value;
}

async function activateRelease(
  targetRelease: Parameters<typeof composeExecutableCompatibilityRelease>[0],
): Promise<void> {
  const target = describeExecutableCompatibilityRelease(
    composeExecutableCompatibilityRelease(targetRelease),
  );
  const currentRows = await ownerQuery<{
    catalog_json: unknown;
    epoch: number;
    fingerprint: string;
  }>(
    `select current.epoch,current.fingerprint,release.catalog_json
     from app.node_compatibility_current current
     join app.node_compatibility_releases release
       on release.epoch=current.epoch and release.fingerprint=current.fingerprint`,
  );
  const current = currentRows[0];
  if (current === undefined) throw new Error('compatibility pointer missing');
  const predecessor = {
    catalogJson:
      typeof current.catalog_json === 'string'
        ? current.catalog_json
        : JSON.stringify(current.catalog_json),
    epoch: current.epoch,
    fingerprint: current.fingerprint,
  };
  const supported = [predecessor, target];
  const maintenance = createCompatibilityReleaseMaintenance(
    parseDatabaseConfig({
      connectionString: databaseUrl(migrationUrl),
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    }),
  );
  const apiProbe = createCompatibilityReleaseReadinessProbe(
    parseDatabaseConfig({ connectionString: databaseUrl(apiUrl), max: 1 }),
    supported,
  );
  const workerProbe = createCompatibilityReleaseReadinessProbe(
    parseDatabaseConfig({ connectionString: databaseUrl(workerUrl), max: 1 }),
    supported,
  );
  const epoch = String(target.epoch);
  const deploymentId = `retained-core-${epoch}-${randomUUID()}`;
  const approvalId = randomUUID();
  try {
    await maintenance.prepare({
      actorId: 'retained-core-integration',
      actorKind: 'deployment',
      expectedPredecessor: predecessor,
      reason: 'Prepare retained core execution release',
      target,
    });
    await Promise.all([
      apiProbe.checkTarget(target),
      workerProbe.checkTarget(target),
    ]);
    for (const roleKind of ['api', 'worker'] as const)
      await maintenance.recordPreactivation({
        artifactId: `retained-core-${roleKind}-${epoch}`,
        checkId: randomUUID(),
        deploymentId,
        roleKind,
        target,
      });
    await maintenance.approve({
      actorId: 'retained-core-integration',
      approvalId,
      deploymentId,
      reason: 'Approve retained core execution release',
      requiredApiArtifacts: [`retained-core-api-${epoch}`],
      requiredWorkerArtifacts: [`retained-core-worker-${epoch}`],
      target,
    });
    await maintenance.activate({
      activationId: randomUUID(),
      actorId: 'retained-core-integration',
      actorKind: 'deployment',
      approvalId,
      expectedPredecessor: predecessor,
      reason: 'Activate retained core execution release',
    });
  } finally {
    await Promise.allSettled([
      maintenance.close(),
      apiProbe.close(),
      workerProbe.close(),
    ]);
  }
}

async function setupFixture(): Promise<void> {
  await createDatabase();
  await migrateDatabase();
  await activateRelease(CORE_REGISTRY_RELEASE_SUCCESSOR);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_HTTP_STAGED);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_MERGE_STAGED);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_FOR_EACH_STAGED);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE);
  const retained = JSON.parse(
    await readFile(
      new URL('./fixtures/retained-core-workflow-v2.json', import.meta.url),
      'utf8',
    ),
  ) as {
    checksum: string;
    executable: { compatibilityReleaseEpoch: number };
    graph: unknown;
  };
  await ownerQuery(
    `insert into app.users (id, email, display_name, status)
       values ($1, $2, 'Coordinator proof', 'active')`,
    [actorId, `coordinator-${actorId}@example.test`],
  );
  await ownerQuery(
    `insert into app.workspaces (id, name, slug, status, created_by)
       values ($1, 'Coordinator proof', $2, 'active', $3)`,
    [workspaceId, `coordinator-${workspaceId}`, actorId],
  );
  await ownerQuery(
    `insert into app.workflows (id, workspace_id, name, created_by)
       values ($1, $2, 'Coordinator proof', $3)`,
    [workflowId, workspaceId, actorId],
  );
  await ownerQuery(
    `insert into app.workflow_versions (
       id, workspace_id, workflow_id, version_number, schema_version,
       graph_json, checksum, executable_schema_version, executable_json,
       compatibility_release_epoch, published_by
     ) values ($1, $2, $3, 1, 1, $4::jsonb, $5, 2, $6::jsonb, $7, $8)`,
    [
      workflowVersionId,
      workspaceId,
      workflowId,
      JSON.stringify(retained.graph),
      retained.checksum,
      JSON.stringify(retained.executable),
      retained.executable.compatibilityReleaseEpoch,
      actorId,
    ],
  );
  const forEachRelease = composeExecutableCompatibilityRelease(
    PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
  );
  const forEachGraph = {
    schemaVersion: 1 as const,
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      {
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'for-each',
        definition: { key: 'core.foreach', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {
          items: {
            kind: 'literal' as const,
            value: [
              { id: 'alpha', value: 11 },
              { id: 'beta', value: 22 },
              { id: 'gamma', value: 33 },
            ],
          },
        },
        connectionRefs: {},
        structured: {
          kind: 'for_each' as const,
          maxIterations: 3,
          maxConcurrency: 2,
          body: {
            schemaVersion: 1 as const,
            settings: {},
            inputPorts: ['item', 'ordinal'],
            outputPorts: ['result'],
            nodes: [
              {
                id: 'body-map',
                definition: { key: 'core.set', version: 1 },
                position: { x: 0, y: 0 },
                configVersion: 1,
                config: {},
                inputMappings: {
                  item: {
                    kind: 'structured_input' as const,
                    port: 'item' as const,
                    path: '$',
                  },
                  ordinal: {
                    kind: 'structured_input' as const,
                    port: 'ordinal' as const,
                    path: '$',
                  },
                },
                connectionRefs: {},
              },
              {
                id: 'body-sink',
                definition: { key: 'core.set', version: 1 },
                position: { x: 10, y: 0 },
                configVersion: 1,
                config: {},
                inputMappings: {
                  result: {
                    kind: 'node_output' as const,
                    nodeId: 'body-map',
                    path: '$',
                  },
                },
                connectionRefs: {},
              },
            ],
            edges: [
              {
                id: 'body-map-sink',
                source: { nodeId: 'body-map', port: 'out' },
                target: { nodeId: 'body-sink', port: 'in' },
              },
            ],
          },
        },
      },
      {
        id: 'outer-successor',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 20, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {
          result: {
            kind: 'node_output' as const,
            nodeId: 'for-each',
            path: '$',
          },
        },
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'manual-for-each',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'for-each', port: 'in' },
      },
      {
        id: 'for-each-outer',
        source: { nodeId: 'for-each', port: 'out' },
        target: { nodeId: 'outer-successor', port: 'in' },
      },
    ],
  };
  const forEachExecutable = buildWorkflowExecutableV2({
    graph: forEachGraph,
    release: forEachRelease,
  });
  await ownerQuery(
    `insert into app.workflows (id, workspace_id, name, created_by)
       values ($1, $2, 'For Each recovery proof', $3)`,
    [forEachWorkflowId, workspaceId, actorId],
  );
  await ownerQuery(
    `insert into app.workflow_versions (
       id, workspace_id, workflow_id, version_number, schema_version,
       graph_json, checksum, executable_schema_version, executable_json,
       compatibility_release_epoch, published_by
     ) values ($1, $2, $3, 1, 1, $4::jsonb, $5, 2, $6::jsonb, $7, $8)`,
    [
      forEachWorkflowVersionId,
      workspaceId,
      forEachWorkflowId,
      JSON.stringify(forEachGraph),
      forEachExecutable.checksum,
      JSON.stringify(forEachExecutable.envelope),
      forEachExecutable.envelope.compatibilityReleaseEpoch,
      actorId,
    ],
  );
  const parallelRelease = composeExecutableCompatibilityRelease(
    PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
  );
  const parallelGraph = {
    schemaVersion: 1 as const,
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      {
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'parallel',
        definition: { key: 'core.parallel', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {
          branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
          maxConcurrency: 1,
        },
        inputMappings: {},
        connectionRefs: {},
      },
      ...['left', 'right'].map((id, index) => ({
        id,
        definition: { key: 'core.set', version: 1 },
        position: { x: 20, y: index === 0 ? -10 : 10 },
        configVersion: 1,
        config: {},
        inputMappings: {
          value: { kind: 'literal' as const, value: id },
        },
        connectionRefs: {},
      })),
      {
        id: 'merge',
        definition: { key: 'core.merge', version: 1 },
        position: { x: 30, y: 0 },
        configVersion: 1,
        config: {
          parallelNodeId: 'parallel',
          policy: { kind: 'all' as const },
        },
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'terminate',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 40, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'manual-parallel',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'parallel', port: 'in' },
      },
      {
        id: 'parallel-left',
        source: { nodeId: 'parallel', port: 'branch-01' },
        target: { nodeId: 'left', port: 'in' },
      },
      {
        id: 'parallel-right',
        source: { nodeId: 'parallel', port: 'branch-02' },
        target: { nodeId: 'right', port: 'in' },
      },
      {
        id: 'left-merge',
        source: { nodeId: 'left', port: 'out' },
        target: { nodeId: 'merge', port: 'branch-01' },
      },
      {
        id: 'right-merge',
        source: { nodeId: 'right', port: 'out' },
        target: { nodeId: 'merge', port: 'branch-02' },
      },
      {
        id: 'merge-terminate',
        source: { nodeId: 'merge', port: 'out' },
        target: { nodeId: 'terminate', port: 'in' },
      },
    ],
  };
  const parallelExecutable = buildWorkflowExecutableV2({
    graph: parallelGraph,
    release: parallelRelease,
  });
  await ownerQuery(
    `insert into app.workflows (id, workspace_id, name, created_by)
       values ($1, $2, 'Parallel Merge recovery proof', $3)`,
    [parallelWorkflowId, workspaceId, actorId],
  );
  await ownerQuery(
    `insert into app.workflow_versions (
       id, workspace_id, workflow_id, version_number, schema_version,
       graph_json, checksum, executable_schema_version, executable_json,
       compatibility_release_epoch, published_by
     ) values ($1, $2, $3, 1, 1, $4::jsonb, $5, 2, $6::jsonb, $7, $8)`,
    [
      parallelWorkflowVersionId,
      workspaceId,
      parallelWorkflowId,
      JSON.stringify(parallelGraph),
      parallelExecutable.checksum,
      JSON.stringify(parallelExecutable.envelope),
      parallelExecutable.envelope.compatibilityReleaseEpoch,
      actorId,
    ],
  );
  const switchRelease = composeExecutableCompatibilityRelease(
    PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
  );
  const switchGraph = {
    schemaVersion: 1 as const,
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      {
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'switch',
        definition: { key: 'core.switch', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: { cases: [{ id: 'case-01', equals: 'selected' }] },
        inputMappings: {
          value: { kind: 'literal' as const, value: 'selected' },
        },
        connectionRefs: {},
      },
      {
        id: 'selected',
        definition: { key: 'core.set', version: 1 },
        position: { x: 20, y: -10 },
        configVersion: 1,
        config: {},
        inputMappings: {
          value: { kind: 'literal' as const, value: 'selected' },
        },
        connectionRefs: {},
      },
      {
        id: 'unselected',
        definition: { key: 'core.set', version: 1 },
        position: { x: 20, y: 10 },
        configVersion: 1,
        config: {},
        inputMappings: {
          value: { kind: 'literal' as const, value: 'unselected' },
        },
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'manual-switch',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'switch', port: 'in' },
      },
      {
        id: 'switch-selected',
        source: { nodeId: 'switch', port: 'case-01' },
        target: { nodeId: 'selected', port: 'in' },
      },
      {
        id: 'switch-unselected',
        source: { nodeId: 'switch', port: 'default' },
        target: { nodeId: 'unselected', port: 'in' },
      },
    ],
  };
  const switchExecutable = buildWorkflowExecutableV2({
    graph: switchGraph,
    release: switchRelease,
  });
  await ownerQuery(
    `insert into app.workflows (id, workspace_id, name, created_by)
       values ($1, $2, 'Switch recovery proof', $3)`,
    [switchWorkflowId, workspaceId, actorId],
  );
  await ownerQuery(
    `insert into app.workflow_versions (
       id, workspace_id, workflow_id, version_number, schema_version,
       graph_json, checksum, executable_schema_version, executable_json,
       compatibility_release_epoch, published_by
     ) values ($1, $2, $3, 1, 1, $4::jsonb, $5, 2, $6::jsonb, $7, $8)`,
    [
      switchWorkflowVersionId,
      workspaceId,
      switchWorkflowId,
      JSON.stringify(switchGraph),
      switchExecutable.checksum,
      JSON.stringify(switchExecutable.envelope),
      switchExecutable.envelope.compatibilityReleaseEpoch,
      actorId,
    ],
  );
  const conditionRelease = composeExecutableCompatibilityRelease(
    PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
  );
  const conditionGraph = {
    schemaVersion: 1 as const,
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      {
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'condition',
        definition: { key: 'core.condition', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: { condition: { kind: 'literal' as const, value: true } },
        connectionRefs: {},
      },
      {
        id: 'selected',
        definition: { key: 'core.set', version: 1 },
        position: { x: 20, y: -10 },
        configVersion: 1,
        config: {},
        inputMappings: {
          value: { kind: 'literal' as const, value: 'selected' },
        },
        connectionRefs: {},
      },
      {
        id: 'unselected',
        definition: { key: 'core.set', version: 1 },
        position: { x: 20, y: 10 },
        configVersion: 1,
        config: {},
        inputMappings: {
          value: { kind: 'literal' as const, value: 'unselected' },
        },
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'manual-condition',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'condition', port: 'in' },
      },
      {
        id: 'condition-selected',
        source: { nodeId: 'condition', port: 'true' },
        target: { nodeId: 'selected', port: 'in' },
      },
      {
        id: 'condition-unselected',
        source: { nodeId: 'condition', port: 'false' },
        target: { nodeId: 'unselected', port: 'in' },
      },
    ],
  };
  const conditionExecutable = buildWorkflowExecutableV2({
    graph: conditionGraph,
    release: conditionRelease,
  });
  await ownerQuery(
    `insert into app.workflows (id, workspace_id, name, created_by)
       values ($1, $2, 'Condition recovery proof', $3)`,
    [conditionWorkflowId, workspaceId, actorId],
  );
  await ownerQuery(
    `insert into app.workflow_versions (
       id, workspace_id, workflow_id, version_number, schema_version,
       graph_json, checksum, executable_schema_version, executable_json,
       compatibility_release_epoch, published_by
     ) values ($1, $2, $3, 1, 1, $4::jsonb, $5, 2, $6::jsonb, $7, $8)`,
    [
      conditionWorkflowVersionId,
      workspaceId,
      conditionWorkflowId,
      JSON.stringify(conditionGraph),
      conditionExecutable.checksum,
      JSON.stringify(conditionExecutable.envelope),
      conditionExecutable.envelope.compatibilityReleaseEpoch,
      actorId,
    ],
  );
  const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
    connection: redisConnection(),
  });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
  const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
    connection: redisConnection(),
  });
  try {
    await attemptQueue.obliterate({ force: true });
  } finally {
    await attemptQueue.close();
  }
}

async function cleanupFixture(): Promise<void> {
  const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
    connection: redisConnection(),
  });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
    const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
      connection: redisConnection(),
    });
    try {
      await attemptQueue.obliterate({ force: true });
    } finally {
      await attemptQueue.close();
    }
    await apiDatabase.close();
    await ownerPool.end();
    await workerPool.end();
    await dropDatabase();
  }
}

async function acceptRun(): Promise<
  Readonly<{ outboxEventId: string; runId: string }>
> {
  const initialCheckpoint = createCheckpoint({
    engineVersion,
    workflowVersionId,
    iterationBudget: 0,
    nextEventSequence: 2,
  });
  return apiDatabase.withWorkspace(workspaceId, (transaction) =>
    acceptWorkflowRun(transaction, {
      engineVersion,
      initialCheckpoint,
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      operation: 'workflow.run.accept',
      runInput: { name: 'Ada' },
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      scope: `coordinator:${workflowId}`,
      triggerType: 'manual',
      workflowId,
      workflowVersionId,
    }),
  );
}

async function terminalizeFailedRun(
  accepted: Readonly<{
    outboxEventId: string;
    runId: string;
  }>,
): Promise<
  Readonly<{
    intentId: string;
    outboxEventId: string;
    payloadChecksum: string;
  }>
> {
  const { runId } = accepted;
  const failedInvocationKey = invocationKey({
    workflowVersionId,
    nodeId: 'set',
  });
  const nodeRunId = randomUUID();
  const attemptId = randomUUID();
  const running = {
    ...createCheckpoint({
      engineVersion,
      workflowVersionId,
      iterationBudget: 0,
      nextEventSequence: 2,
    }),
    runStatus: 'running' as const,
    admittedInvocationKeys: [failedInvocationKey],
    invocations: [
      {
        invocationKey: failedInvocationKey,
        nodeId: 'set',
        status: 'running',
        attemptNumber: 1,
      },
    ],
  };
  await workerQuery(
    `with updated_run as (
       update app.workflow_runs set status='running',started_at=clock_timestamp()
        where workspace_id=$1 and id=$2
     ), updated_checkpoint as (
       update app.run_checkpoints set scheduler_state=$3::jsonb
        where workspace_id=$1 and workflow_run_id=$2
     ), node as (
       insert into app.node_runs (
         id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
         status,side_effect_class,current_attempt_id,current_attempt_number
       ) values ($4,$1,$2,'set',$5,'{}','running','safe',$6,1)
     )
     insert into app.node_attempts (
       id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
       safe_error_code,executor_failure_kind,executor_error_kind,
       executor_possibly_dispatched,retry_decision
     ) values ($6,$1,$4,1,'failed','safe','provider.unavailable',
       'failed','provider',false,'pending')`,
    [
      workspaceId,
      runId,
      JSON.stringify(running),
      nodeRunId,
      failedInvocationKey,
      attemptId,
    ],
  );
  const store = createCoordinatorRunStore(
    parseDatabaseConfig({
      connectionString: databaseUrl(workerUrl),
      max: 2,
    }),
  );
  try {
    const acceptedOutbox = await workerQuery<{
      id: string;
      payload_checksum: string;
    }>(
      `select id,payload_checksum from app.outbox_events
        where workspace_id=$1 and id=$2`,
      [workspaceId, accepted.outboxEventId],
    );
    const acceptedDelivery = acceptedOutbox[0];
    if (acceptedDelivery === undefined)
      throw new Error('Accepted coordinator delivery is missing');
    await expect(
      store.commitAdvancePlan({
        delivery: {
          outboxEventId: acceptedDelivery.id,
          payloadChecksum: acceptedDelivery.payload_checksum,
        },
        workspaceId,
        runId,
        workflowVersionId,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: {
            ...createCheckpoint({
              engineVersion,
              workflowVersionId,
              iterationBudget: 0,
              nextEventSequence: 4,
            }),
            revision: 1,
            runStatus: 'failed' as const,
            admittedInvocationKeys: [failedInvocationKey],
            invocations: [
              {
                invocationKey: failedInvocationKey,
                nodeId: 'set',
                status: 'failed',
                attemptNumber: 1,
              },
            ],
          },
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'node.failed',
              occurredAt: '2026-08-24T10:01:00.000Z',
              invocationKey: failedInvocationKey,
              nodeId: 'set',
              attemptNumber: 1,
              reasonCode: 'provider.unavailable',
            },
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'run.failed',
              occurredAt: '2026-08-24T10:01:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
  } finally {
    await store.close();
  }
  const rows = await workerQuery<{
    intent_id: string;
    outbox_event_id: string;
    payload_checksum: string;
  }>(
    `select intent.id intent_id,outbox.id outbox_event_id,outbox.payload_checksum
       from app.run_failure_notification_intents intent
       join app.outbox_events outbox on outbox.aggregate_id=intent.id
      where intent.workspace_id=$1 and intent.workflow_run_id=$2
        and outbox.job_name='deliver-run-failure-notification'`,
    [workspaceId, runId],
  );
  const identity = rows[0];
  if (identity === undefined)
    throw new Error('Coordinator did not create a failure notification intent');
  return {
    intentId: identity.intent_id,
    outboxEventId: identity.outbox_event_id,
    payloadChecksum: identity.payload_checksum,
  };
}

async function acceptConditionRun(): Promise<
  Readonly<{ outboxEventId: string; runId: string }>
> {
  return apiDatabase.withWorkspace(workspaceId, (transaction) =>
    acceptWorkflowRun(transaction, {
      engineVersion,
      initialCheckpoint: createCheckpointV2({
        engineVersion,
        workflowVersionId: conditionWorkflowVersionId,
        iterationBudget: 1_000,
        nextEventSequence: 2,
      }),
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      operation: 'workflow.run.accept',
      runInput: {},
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      scope: `coordinator:${conditionWorkflowId}`,
      triggerType: 'manual',
      workflowId: conditionWorkflowId,
      workflowVersionId: conditionWorkflowVersionId,
    }),
  );
}

async function acceptSwitchRun(): Promise<
  Readonly<{ outboxEventId: string; runId: string }>
> {
  return apiDatabase.withWorkspace(workspaceId, (transaction) =>
    acceptWorkflowRun(transaction, {
      engineVersion,
      initialCheckpoint: createCheckpointV2({
        engineVersion,
        workflowVersionId: switchWorkflowVersionId,
        iterationBudget: 1_000,
        nextEventSequence: 2,
      }),
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      operation: 'workflow.run.accept',
      runInput: {},
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      scope: `coordinator:${switchWorkflowId}`,
      triggerType: 'manual',
      workflowId: switchWorkflowId,
      workflowVersionId: switchWorkflowVersionId,
    }),
  );
}

async function acceptParallelRun(): Promise<
  Readonly<{ outboxEventId: string; runId: string }>
> {
  return apiDatabase.withWorkspace(workspaceId, (transaction) =>
    acceptWorkflowRun(transaction, {
      engineVersion,
      initialCheckpoint: createCheckpointV2({
        engineVersion,
        workflowVersionId: parallelWorkflowVersionId,
        iterationBudget: 1_000,
        nextEventSequence: 2,
      }),
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      operation: 'workflow.run.accept',
      runInput: {},
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      scope: `coordinator:${parallelWorkflowId}`,
      triggerType: 'manual',
      workflowId: parallelWorkflowId,
      workflowVersionId: parallelWorkflowVersionId,
    }),
  );
}

async function acceptForEachRun(): Promise<
  Readonly<{ outboxEventId: string; runId: string }>
> {
  return apiDatabase.withWorkspace(workspaceId, (transaction) =>
    acceptWorkflowRun(transaction, {
      engineVersion,
      initialCheckpoint: createCheckpointV2({
        engineVersion,
        workflowVersionId: forEachWorkflowVersionId,
        iterationBudget: 1_000,
        nextEventSequence: 2,
      }),
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      operation: 'workflow.run.accept',
      runInput: {},
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      scope: `coordinator:${forEachWorkflowId}`,
      triggerType: 'manual',
      workflowId: forEachWorkflowId,
      workflowVersionId: forEachWorkflowVersionId,
    }),
  );
}

async function waitForAttemptOutbox(
  runId: string,
  excludedIds: readonly string[] = [],
): Promise<{
  attemptId: string;
  nodeRunId: string;
  outboxEventId: string;
}> {
  const rows = await waitFor(
    () =>
      workerQuery<{
        attempt_id: string;
        id: string;
        node_run_id: string;
      }>(
        `select outbox.id,attempt.id attempt_id,node.id node_run_id
         from app.outbox_events outbox
         join app.node_attempts attempt
           on attempt.workspace_id=outbox.workspace_id
          and attempt.id=outbox.aggregate_id
         join app.node_runs node
           on node.workspace_id=attempt.workspace_id
          and node.id=attempt.node_run_id
         where outbox.workspace_id=$1 and node.workflow_run_id=$2
           and outbox.job_name='execute-node-attempt'
           and not (outbox.id=any($3::uuid[]))
         order by outbox.created_at,outbox.id`,
        [workspaceId, runId, excludedIds],
      ),
    (value) => value.length > 0,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('attempt outbox missing');
  return {
    attemptId: row.attempt_id,
    nodeRunId: row.node_run_id,
    outboxEventId: row.id,
  };
}

async function waitForCoordinatorOutbox(
  runId: string,
  excludedIds: readonly string[],
): Promise<string> {
  const rows = await waitFor(
    () =>
      workerQuery<{ id: string }>(
        `select id from app.outbox_events
         where workspace_id=$1 and aggregate_id=$2
           and job_name='advance-workflow-run'
           and not (id=any($3::uuid[]))
         order by created_at,id`,
        [workspaceId, runId, excludedIds],
      ),
    (value) => value.length > 0,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('coordinator outbox missing');
  return row.id;
}

function createCoordinatorDispatcher(
  consumer: Awaited<ReturnType<typeof createCoordinatorRuntime>>['consumer'],
  dispatcherRedisUrl: string = redisUrl,
): OutboxDispatcher {
  return new OutboxDispatcher(
    createOutboxDispatcherDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(dispatcherUrl),
        max: 2,
      }),
    ),
    createQueueProducer({ redisUrl: dispatcherRedisUrl }),
    new WorkerDrainState(),
    {
      batchSize: 10,
      enabledJobNames: [JOB_NAME.advanceWorkflowRun],
      leaseDurationMillis: 1_000,
      leaseOwner: `due-wakeup-${randomUUID()}`,
      maxAttempts: 3,
      operationTimeoutMillis: 2_000,
      pollIntervalMillis: 25,
      retryDelayMillis: 25,
    },
    undefined,
    createDispatchConsumerCapabilityRegistry([
      { jobName: JOB_NAME.advanceWorkflowRun, consumer },
    ]),
  );
}

function createFailureNotificationDispatcher(
  consumer: Awaited<
    ReturnType<typeof createPreviewMaintenanceRuntime>
  >['consumer'],
  drainState: WorkerDrainState = new WorkerDrainState(),
): OutboxDispatcher {
  return new OutboxDispatcher(
    createOutboxDispatcherDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(dispatcherUrl),
        max: 2,
      }),
    ),
    createQueueProducer({ redisUrl }),
    drainState,
    {
      batchSize: 10,
      enabledJobNames: [JOB_NAME.deliverRunFailureNotification],
      leaseDurationMillis: 1_000,
      leaseOwner: `failure-notification-${randomUUID()}`,
      maxAttempts: 3,
      operationTimeoutMillis: 2_000,
      pollIntervalMillis: 25,
      retryDelayMillis: 25,
    },
    undefined,
    createDispatchConsumerCapabilityRegistry([
      { jobName: JOB_NAME.deliverRunFailureNotification, consumer },
    ]),
  );
}

async function dispatchFairRounds(
  dispatcher: OutboxDispatcher,
  expectedClaims: number,
): Promise<Readonly<{ claimed: number; failed: number; published: number }>> {
  const totals = { claimed: 0, failed: 0, published: 0 };
  const maximumRounds = expectedClaims + 2;
  for (let round = 0; round < maximumRounds; round += 1) {
    const result = await dispatcher.dispatchOnce();
    totals.claimed += result.claimed;
    totals.failed += result.failed;
    totals.published += result.published;
    if (totals.claimed >= expectedClaims) return totals;
  }
  throw new Error(
    `Fair dispatch did not claim ${String(expectedClaims)} events within ${String(maximumRounds)} rounds: ${JSON.stringify(totals)}`,
  );
}

export {
  CORE_REGISTRY_RELEASE_SUCCESSOR,
  JOB_NAME,
  OutboxDispatcher,
  PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED,
  PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_FOR_EACH_STAGED,
  PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
  PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_MERGE_STAGED,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED,
  PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED,
  Pool,
  QUEUE_NAME,
  Queue,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  WorkerDrainState,
  acceptConditionRun,
  acceptForEachRun,
  acceptParallelRun,
  acceptRun,
  acceptSwitchRun,
  acceptWorkflowRun,
  activateRelease,
  actorId,
  adminUrl,
  apiDatabase,
  apiQuery,
  apiUrl,
  buildWorkflowExecutableV2,
  canonicalOutboxPayloadChecksum,
  cleanupFixture,
  compose,
  composeExecutableCompatibilityRelease,
  conditionWorkflowId,
  conditionWorkflowVersionId,
  configuredRedisUrl,
  createCheckpoint,
  createCheckpointV2,
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
  createCoordinatorDispatcher,
  createCoordinatorRunStore,
  createCoordinatorRuntime,
  createDatabase,
  createDispatchConsumerCapabilityRegistry,
  createDueNodeWakeupScanner,
  createFailureNotificationDispatcher,
  createFailureNotificationStore,
  createHash,
  createNodeAttemptRuntime,
  createOutboxDispatcherDatabase,
  createPlatformNodeRegistryForRelease,
  createPreviewMaintenanceRuntime,
  createProviderFailureNotificationDelivery,
  createQueueProducer,
  createWorkspaceDatabase,
  databaseName,
  databaseUrl,
  describeExecutableCompatibilityRelease,
  dispatchFairRounds,
  dispatcherUrl,
  dropDatabase,
  dropDisconnectedDatabase,
  enabled,
  engineVersion,
  execFile,
  execFileAsync,
  forEachWorkflowId,
  forEachWorkflowVersionId,
  invocationKey,
  migrateDatabase,
  migrationUrl,
  ownerPool,
  ownerQuery,
  parallelWorkflowId,
  parallelWorkflowVersionId,
  parseCheckpoint,
  parseDatabaseConfig,
  performance,
  promisify,
  randomUUID,
  readFile,
  redisConnection,
  redisUrl,
  repositoryRoot,
  requestWorkflowRunCancellation,
  restoreServices,
  setupFixture,
  spawn,
  startService,
  stopService,
  switchWorkflowId,
  switchWorkflowVersionId,
  terminalizeFailedRun,
  waitFor,
  waitForAttemptOutbox,
  waitForCoordinatorOutbox,
  workerPool,
  workerQuery,
  workerUrl,
  workflowId,
  workflowVersionId,
  workspaceId,
};

export type { ChildProcess, CoordinatorAdvanceEngine };
