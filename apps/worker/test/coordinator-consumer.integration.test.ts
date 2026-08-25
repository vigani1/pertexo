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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
const describeIntegration = enabled ? describe : describe.skip;
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

describeIntegration('Phase 3 coordinator consumer', () => {
  beforeAll(setupFixture, 60_000);
  afterAll(async () => {
    await restoreServices();
    await cleanupFixture();
  });

  it('advances an accepted V2 run once across exact BullMQ redelivery', async () => {
    const accepted = await acceptRun();
    const runtime = await createCoordinatorRuntime({
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 4,
      }),
      maximumAdmissions: 1,
      releaseCohort: 'for_each_activation',
      redisUrl,
    });
    const producer = createQueueProducer({ redisUrl });
    const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: redisConnection(),
    });
    const job = {
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 1 as const,
        workspaceId,
        runId: accepted.runId,
        outboxEventId: accepted.outboxEventId,
      },
    };

    try {
      await Promise.all([
        runtime.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      const published = await producer.publish(job);
      const firstTransition = await waitFor(
        async () => {
          const [rows, queuedJob] = await Promise.all([
            workerQuery<{ revision: number }>(
              `select revision from app.run_checkpoints
               where workspace_id = $1 and workflow_run_id = $2`,
              [workspaceId, accepted.runId],
            ),
            queue.getJob(published.jobId),
          ]);
          return {
            revision: rows[0]?.revision,
            failedReason: queuedJob?.failedReason,
            state: await queuedJob?.getState(),
          };
        },
        (value) => value.revision === 1 || value.state === 'failed',
      );
      if (firstTransition.revision !== 1)
        throw new Error(
          `coordinator job failed: ${firstTransition.failedReason ?? 'unknown'}`,
        );
      const facts = await workerQuery<{
        attempt_count: string;
        event_types: string[];
        node_count: string;
        pending_attempt_jobs: string;
      }>(
        `select
           (select count(*)::text from app.node_runs
             where workspace_id = $1 and workflow_run_id = $2) as node_count,
           (select count(*)::text from app.node_attempts attempt
             join app.node_runs node on node.workspace_id = attempt.workspace_id
              and node.id = attempt.node_run_id
             where node.workspace_id = $1 and node.workflow_run_id = $2) as attempt_count,
           (select array_agg(type order by sequence) from app.run_events
             where workspace_id = $1 and workflow_run_id = $2) as event_types,
           (select count(*)::text from app.outbox_events
             where workspace_id = $1 and payload->>'runId' = $2::text
               and job_name = 'execute-node-attempt'
               and published_at is null and failed_at is null) as pending_attempt_jobs`,
        [workspaceId, accepted.runId],
      );
      expect(facts).toEqual([
        {
          node_count: '1',
          attempt_count: '1',
          event_types: ['run.queued', 'run.started', 'node.ready'],
          pending_attempt_jobs: '1',
        },
      ]);

      const firstJob = await waitFor(
        () => queue.getJob(published.jobId),
        (value) => value !== undefined,
      );
      if (firstJob === undefined) throw new Error('first job disappeared');
      await waitFor(
        () => firstJob.getState(),
        (state) => state === 'completed',
      );
      await firstJob.remove();
      await producer.publish(job);
      const replay = await waitFor(
        () => queue.getJob(published.jobId),
        (value) => value !== undefined,
      );
      if (replay === undefined) throw new Error('replayed job disappeared');
      await waitFor(
        () => replay.getState(),
        (state) => state === 'completed',
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      await expect(
        workerQuery<{ attempts: string; events: string; revision: number }>(
          `select checkpoint.revision,
             (select count(*)::text from app.run_events event
               where event.workspace_id = checkpoint.workspace_id
                 and event.workflow_run_id = checkpoint.workflow_run_id) as events,
             (select count(*)::text from app.node_attempts attempt
               join app.node_runs node on node.workspace_id = attempt.workspace_id
                and node.id = attempt.node_run_id
               where node.workspace_id = checkpoint.workspace_id
                 and node.workflow_run_id = checkpoint.workflow_run_id) as attempts
           from app.run_checkpoints checkpoint
           where checkpoint.workspace_id = $1
             and checkpoint.workflow_run_id = $2`,
          [workspaceId, accepted.runId],
        ),
      ).resolves.toEqual([{ revision: 1, events: '3', attempts: '1' }]);
    } finally {
      await Promise.allSettled([
        producer.close(),
        runtime.close(),
        queue.close(),
      ]);
    }
  });

  it('recovers failure notification dispatch through PostgreSQL and BullMQ without changing run truth', async () => {
    const destinationId = randomUUID();
    const connectionId = randomUUID();
    const secretVersionId = randomUUID();
    const slackDestinationId = randomUUID();
    const slackConnectionId = randomUUID();
    const slackSecretVersionId = randomUUID();
    const fixturePool = new Pool({
      connectionString: databaseUrl(adminUrl),
      max: 1,
    });
    try {
      await fixturePool.query(
        `with connection_row as (
          insert into app.connections (
            id,workspace_id,provider_key,name,auth_type,status,
            current_secret_version_id,created_by
          ) values ($4,$1,'email','Failure notification email',
            'resend_api_key','active',$5,$6)
        ), secret_row as (
          insert into app.connection_secret_versions (
            id,workspace_id,connection_id,schema_version,kms_key_reference,
            encrypted_data_key,ciphertext,nonce,auth_tag,created_by
          ) values ($5,$1,$4,1,'kms','key','cipher','AAAAAAAAAAAAAAAA',
            'AAAAAAAAAAAAAAAAAAAAAA',$6)
        ), slack_connection_row as (
          insert into app.connections (
            id,workspace_id,provider_key,name,auth_type,status,
            current_secret_version_id,created_by
          ) values ($8,$1,'slack','Failure notification Slack',
            'slack_bot_token','active',$9,$6)
        ), slack_secret_row as (
          insert into app.connection_secret_versions (
            id,workspace_id,connection_id,schema_version,kms_key_reference,
            encrypted_data_key,ciphertext,nonce,auth_tag,created_by
          ) values ($9,$1,$8,1,'kms','slack-key','slack-cipher',
            'BBBBBBBBBBBBBBBB','BBBBBBBBBBBBBBBBBBBBBB',$6)
        ), destination_row as (
          insert into app.failure_notification_destinations
            (id,workspace_id,kind,status,current_config_version,created_by)
          values ($2,$1,'email','enabled',1,$6)
        ), destination_version as (
          insert into app.failure_notification_destination_versions
            (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
          values ($1,$2,1,'email','idempotent_with_key',$7::jsonb,$6)
        ), slack_destination_row as (
          insert into app.failure_notification_destinations
            (id,workspace_id,kind,status,current_config_version,created_by)
          values ($10,$1,'slack','enabled',1,$6)
        ), slack_destination_version as (
          insert into app.failure_notification_destination_versions
            (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
          values ($1,$10,1,'slack','unsafe',$11::jsonb,$6)
        )
        insert into app.workflow_failure_notification_policies
          (workspace_id,workflow_id,destination_id,updated_by)
        values ($1,$3,$2,$6)`,
        [
          workspaceId,
          destinationId,
          workflowId,
          connectionId,
          secretVersionId,
          actorId,
          JSON.stringify({
            connectionId,
            toEmail: 'failure-notification@example.test',
          }),
          slackConnectionId,
          slackSecretVersionId,
          slackDestinationId,
          JSON.stringify({
            connectionId: slackConnectionId,
            channelId: 'C12345',
          }),
        ],
      );
    } finally {
      await fixturePool.end();
    }
    const accepted = await acceptRun();
    const emailIdentity = await terminalizeFailedRun(accepted);
    await apiQuery(
      `update app.workflow_failure_notification_policies set destination_id=$3
        where workspace_id=$1 and workflow_id=$2`,
      [workspaceId, workflowId, slackDestinationId],
    );
    const slackAccepted = await acceptRun();
    const slackIdentity = await terminalizeFailedRun(slackAccepted);
    const intentId = emailIdentity.intentId;
    const initialOutboxEventId = emailIdentity.outboxEventId;
    const initialPayload = {
      schemaVersion: 1 as const,
      workspaceId,
      notificationIntentId: intentId,
      outboxEventId: initialOutboxEventId,
    };
    const slackIntentId = slackIdentity.intentId;
    const slackOutboxEventId = slackIdentity.outboxEventId;
    const slackPayload = {
      schemaVersion: 1 as const,
      workspaceId,
      notificationIntentId: slackIntentId,
      outboxEventId: slackOutboxEventId,
    };
    const initialTruth = await workerQuery<{
      event_count: string;
      revision: number;
      run_status: string;
    }>(
      `select run.status run_status,checkpoint.revision,
              (select count(*)::text from app.run_events event
                where event.workflow_run_id=run.id) event_count
         from app.workflow_runs run
         join app.run_checkpoints checkpoint on checkpoint.workflow_run_id=run.id
        where run.workspace_id=$1 and run.id=$2`,
      [workspaceId, accepted.runId],
    );
    const store = createFailureNotificationStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 2,
      }),
    );
    try {
      const initialClaim = await store.claimDelivery({
        workspaceId,
        intentId,
        delivery: {
          outboxEventId: initialOutboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(initialPayload),
        },
        recoverySeconds: 1,
        maxAttempts: 3,
      });
      expect(initialClaim).toMatchObject({ kind: 'ready', attemptNumber: 1 });
      const slackClaim = await store.claimDelivery({
        workspaceId,
        intentId: slackIntentId,
        delivery: {
          outboxEventId: slackOutboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(slackPayload),
        },
        recoverySeconds: 1,
        maxAttempts: 3,
      });
      expect(slackClaim).toMatchObject({ kind: 'ready', attemptNumber: 1 });
      const destinationProof = await workerQuery<{
        auth_type: string;
        connection_status: string;
        current_secret_version_id: string;
        destination_kind: string;
        intent_secret_version_id: string;
        provider_key: string;
        secret_id: string;
        version_kind: string;
      }>(
        `select destination.kind destination_kind,version.kind version_kind,
                connection.provider_key,connection.auth_type,
                connection.status connection_status,
                connection.current_secret_version_id,
                intent.connection_secret_version_id intent_secret_version_id,
                secret.id secret_id
           from app.run_failure_notification_intents intent
           join app.failure_notification_destinations destination
             on destination.workspace_id=intent.workspace_id
            and destination.id=intent.destination_id
           join app.failure_notification_destination_versions version
             on version.workspace_id=intent.workspace_id
            and version.destination_id=intent.destination_id
            and version.version=intent.destination_config_version
           join app.connections connection
             on connection.workspace_id=intent.workspace_id
            and connection.id=(version.config->>'connectionId')::uuid
           join app.connection_secret_versions secret
             on secret.workspace_id=connection.workspace_id
            and secret.connection_id=connection.id
            and secret.id=intent.connection_secret_version_id
          where intent.workspace_id=$1 and intent.id=$2`,
        [workspaceId, intentId],
      );
      expect(destinationProof).toEqual([
        {
          destination_kind: 'email',
          version_kind: 'email',
          provider_key: 'email',
          secret_id: secretVersionId,
          auth_type: 'resend_api_key',
          connection_status: 'active',
          current_secret_version_id: secretVersionId,
          intent_secret_version_id: secretVersionId,
        },
      ]);
      if (initialClaim.kind !== 'ready' || slackClaim.kind !== 'ready')
        throw new Error('destructive destination claims were not ready');
      const preFenceProviderCalls: string[] = [];
      const preFenceDelivery = createProviderFailureNotificationDelivery({
        store,
        encryption: {
          open: () =>
            Promise.reject(
              new Error('PostgreSQL loss must fail before credential opening'),
            ),
        },
        slack: {
          sendMessage: () => {
            preFenceProviderCalls.push('slack');
            return Promise.resolve({
              kind: 'succeeded',
              channelId: 'unexpected',
              messageTs: 'unexpected',
            });
          },
        },
        email: {
          sendNotification: () => {
            preFenceProviderCalls.push('email');
            return Promise.resolve({
              kind: 'succeeded',
              emailId: 'unexpected',
            });
          },
        },
        workerId: 'failure-notification-postgres-loss',
      });
      const readinessDatabase = createOutboxDispatcherDatabase(
        parseDatabaseConfig({
          connectionString: databaseUrl(dispatcherUrl),
          connectionTimeoutMillis: 1_000,
          max: 1,
        }),
      );
      try {
        await stopService('postgres');
        await expect(readinessDatabase.checkReadiness()).rejects.toThrow();
        for (const [claim, claimedIntentId] of [
          [initialClaim, intentId],
          [slackClaim, slackIntentId],
        ] as const) {
          await expect(
            preFenceDelivery.deliver({
              context: claim.context,
              workspaceId,
              intentId: claimedIntentId,
              attemptNumber: claim.attemptNumber,
              destinationId: claim.destinationId,
              destinationConfigVersion: claim.destinationConfigVersion,
              idempotencyKey: claim.idempotencyKey,
              sideEffectClass: claim.sideEffectClass,
              connectionSecretVersionId: claim.connectionSecretVersionId,
              deliveryUnresolved: claim.deliveryUnresolved,
              ...(claim.deliveryBinding === undefined
                ? {}
                : { deliveryBinding: claim.deliveryBinding }),
              signal: new AbortController().signal,
            }),
          ).resolves.toMatchObject({
            kind: 'retry',
            possiblyDispatched: false,
          });
        }
        expect(preFenceProviderCalls).toEqual([]);
      } finally {
        await startService('postgres');
        await readinessDatabase.close();
      }
      await workerQuery(
        `update app.run_failure_notification_intents
            set recovery_at=clock_timestamp()-interval '1 second'
          where workspace_id=$1 and id=any($2::uuid[])`,
        [workspaceId, [intentId, slackIntentId]],
      );
      await expect(store.recoverDue(10, 3)).resolves.toBe(2);
      await expect(
        workerQuery<{ possibly_dispatched: boolean; status: string }>(
          `select status,possibly_dispatched
             from app.run_failure_notification_intents
            where workspace_id=$1 and id=any($2::uuid[]) order by id`,
          [workspaceId, [intentId, slackIntentId]],
        ),
      ).resolves.toEqual([
        { status: 'retry', possibly_dispatched: false },
        { status: 'retry', possibly_dispatched: false },
      ]);

      const retryOutboxes = await workerQuery<{
        aggregate_id: string;
        id: string;
        payload_checksum: string;
      }>(
        `select distinct on (aggregate_id) aggregate_id,id,payload_checksum
           from app.outbox_events
          where workspace_id=$1 and aggregate_id=any($2::uuid[])
          order by aggregate_id,created_at desc,id desc`,
        [workspaceId, [intentId, slackIntentId]],
      );
      const blockedClaims = await Promise.all(
        retryOutboxes.map(async (outbox) => ({
          intentId: outbox.aggregate_id,
          claim: await store.claimDelivery({
            workspaceId,
            intentId: outbox.aggregate_id,
            delivery: {
              outboxEventId: outbox.id,
              payloadChecksum: outbox.payload_checksum,
            },
            recoverySeconds: 1,
            maxAttempts: 3,
          }),
        })),
      );
      expect(blockedClaims).toHaveLength(2);
      if (blockedClaims.some(({ claim }) => claim.kind !== 'ready'))
        throw new Error('blocked destination claims were not ready');

      const blockedProviderCalls: string[] = [];
      let enteredCount = 0;
      let resolveEntered: (() => void) | undefined;
      const allEntered = new Promise<void>((resolve) => {
        resolveEntered = resolve;
      });
      const blockAfterFence = async (
        provider: 'email' | 'slack',
        signal: AbortSignal,
      ): Promise<never> => {
        blockedProviderCalls.push(provider);
        enteredCount += 1;
        if (enteredCount === 2) resolveEntered?.();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
        });
        throw new SecureHttpError(
          SECURE_HTTP_ERROR_CODE.canceled,
          'ambiguous',
          true,
        );
      };
      const blockedDelivery = createProviderFailureNotificationDelivery({
        store,
        encryption: {
          open: (_sealed, encryptionContext) =>
            Promise.resolve(
              new TextEncoder().encode(
                JSON.stringify(
                  encryptionContext.connectionId === slackConnectionId
                    ? {
                        schemaVersion: 1,
                        type: 'slack_bot_token',
                        botToken: 'xoxb-integration-only',
                      }
                    : {
                        schemaVersion: 1,
                        type: 'resend_api_key',
                        apiKey: 're_integration_only',
                        fromEmail: 'sender@example.test',
                      },
                ),
              ),
            ),
        },
        slack: {
          sendMessage: async (input) => {
            await input.beforeDispatch();
            return blockAfterFence('slack', input.signal);
          },
        },
        email: {
          sendNotification: async (input) => {
            await input.beforeDispatch();
            expect(input.idempotencyKey).toBe(
              `failure-notification:v1:${intentId}`,
            );
            if (input.signal === undefined)
              throw new Error('blocked email dispatch signal missing');
            return blockAfterFence('email', input.signal);
          },
        },
        workerId: 'failure-notification-drain-worker',
      });
      const blockedControllers = blockedClaims.map(() => new AbortController());
      const blockedResults = blockedClaims.map(
        ({ claim, intentId: claimedId }, index) => {
          if (claim.kind !== 'ready')
            throw new Error('blocked claim changed kind');
          const controller = blockedControllers[index];
          if (controller === undefined)
            throw new Error('blocked controller missing');
          return blockedDelivery.deliver({
            context: claim.context,
            workspaceId,
            intentId: claimedId,
            attemptNumber: claim.attemptNumber,
            destinationId: claim.destinationId,
            destinationConfigVersion: claim.destinationConfigVersion,
            idempotencyKey: claim.idempotencyKey,
            sideEffectClass: claim.sideEffectClass,
            connectionSecretVersionId: claim.connectionSecretVersionId,
            deliveryUnresolved: claim.deliveryUnresolved,
            ...(claim.deliveryBinding === undefined
              ? {}
              : { deliveryBinding: claim.deliveryBinding }),
            signal: controller.signal,
          });
        },
      );
      await allEntered;
      const drainStartedAt = performance.now();
      for (const controller of blockedControllers) controller.abort();
      const settledBlockedResults = await Promise.all(blockedResults);
      expect(performance.now() - drainStartedAt).toBeLessThan(2_000);
      expect(blockedProviderCalls.sort()).toEqual(['email', 'slack']);

      for (const [index, blocked] of blockedClaims.entries()) {
        const result = settledBlockedResults[index];
        if (blocked.claim.kind !== 'ready' || result === undefined)
          throw new Error('blocked result identity missing');
        await expect(
          store.completeDelivery({
            workspaceId,
            intentId: blocked.intentId,
            attemptNumber: blocked.claim.attemptNumber,
            maxAttempts: 3,
            retryDelaySeconds: 0,
            result,
          }),
        ).resolves.toBe('completed');
      }
      const postDrain = await workerQuery<{
        delivery_binding: string | null;
        id: string;
        possibly_dispatched: boolean;
        status: string;
      }>(
        `select id,status,possibly_dispatched,delivery_binding
           from app.run_failure_notification_intents
          where workspace_id=$1 and id=any($2::uuid[])`,
        [workspaceId, [intentId, slackIntentId]],
      );
      expect(postDrain.find((row) => row.id === slackIntentId)).toMatchObject({
        status: 'outcome_unknown',
        possibly_dispatched: true,
      });
      const drainedEmail = postDrain.find((row) => row.id === intentId);
      expect(drainedEmail).toMatchObject({
        status: 'retry',
        possibly_dispatched: true,
      });
      expect(drainedEmail?.delivery_binding).toMatch(/^email:v1:sha256:/u);
    } finally {
      await store.close();
    }

    const deliveries: string[] = [];
    const slackDeliveries: string[] = [];
    const providerStore = createFailureNotificationStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 2,
      }),
    );
    const providerDelivery = createProviderFailureNotificationDelivery({
      store: providerStore,
      encryption: {
        open: (_sealed, encryptionContext) =>
          Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify(
                encryptionContext.connectionId === slackConnectionId
                  ? {
                      schemaVersion: 1,
                      type: 'slack_bot_token',
                      botToken: 'xoxb-integration-only',
                    }
                  : {
                      schemaVersion: 1,
                      type: 'resend_api_key',
                      apiKey: 're_integration_only',
                      fromEmail: 'sender@example.test',
                    },
              ),
            ),
          ),
      },
      slack: {
        sendMessage: async (input) => {
          await input.beforeDispatch();
          expect(input).toMatchObject({ channelId: 'C12345' });
          slackDeliveries.push(input.channelId);
          throw new Error('unexpected failure after dispatch fence');
        },
      },
      email: {
        sendNotification: async (input) => {
          await input.beforeDispatch();
          expect(input).toMatchObject({
            toEmail: 'failure-notification@example.test',
            idempotencyKey: `failure-notification:v1:${intentId}`,
          });
          deliveries.push(input.idempotencyKey);
          return { kind: 'succeeded', emailId: randomUUID() };
        },
      },
      workerId: 'failure-notification-integration-worker',
    });
    let runtime = await createPreviewMaintenanceRuntime({
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 4,
      }),
      redisUrl,
      failureNotificationDelivery: providerDelivery,
    });
    let drainState = new WorkerDrainState();
    let dispatcher = createFailureNotificationDispatcher(
      runtime.consumer,
      drainState,
    );
    let producer = createQueueProducer({ redisUrl });
    const queue = new Queue(QUEUE_NAME.maintenance, {
      connection: redisConnection(),
    });
    try {
      await stopService('redis');
      await expect(dispatcher.checkReadiness()).rejects.toThrow();
      await expect(dispatcher.dispatchOnce()).rejects.toThrow(
        /No ready composed consumer/u,
      );
      await expect(
        workerQuery<{ status: string }>(
          `select status from app.run_failure_notification_intents
            where workspace_id=$1 and id=any($2::uuid[]) order by id`,
          [workspaceId, [intentId, slackIntentId]],
        ),
      ).resolves.toEqual(
        expect.arrayContaining([
          { status: 'retry' },
          { status: 'outcome_unknown' },
        ]),
      );
      await startService('redis');
      await Promise.allSettled([
        dispatcher.close(),
        runtime.close(),
        producer.close(),
      ]);
      runtime = await createPreviewMaintenanceRuntime({
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 4,
        }),
        redisUrl,
        failureNotificationDelivery: providerDelivery,
      });
      drainState = new WorkerDrainState();
      dispatcher = createFailureNotificationDispatcher(
        runtime.consumer,
        drainState,
      );
      producer = createQueueProducer({ redisUrl });
      await Promise.all([
        runtime.consumer.waitUntilReady(5_000),
        dispatcher.checkReadiness(),
        producer.waitUntilReady(5_000),
      ]);
      const recovered = await waitFor(
        () =>
          workerQuery<{
            id: string;
            payload: typeof initialPayload;
          }>(
            `select id,payload from app.outbox_events
              where workspace_id=$1 and aggregate_id=$2
                and job_name='deliver-run-failure-notification'
                and id<>$3 order by created_at,id`,
            [workspaceId, intentId, initialOutboxEventId],
          ),
        (rows) => rows.length === 2,
      );
      await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
        claimed: 5,
        published: 5,
      });
      const emailTerminal = await waitFor(
        () =>
          workerQuery<{ safe_error_code: string | null; status: string }>(
            `select status,safe_error_code from app.run_failure_notification_intents
              where workspace_id=$1 and id=$2`,
            [workspaceId, intentId],
          ),
        (rows) =>
          ['delivered', 'dead_letter', 'outcome_unknown'].includes(
            rows[0]?.status ?? '',
          ),
      );
      expect(emailTerminal).toEqual([
        { status: 'delivered', safe_error_code: null },
      ]);
      expect(deliveries).toEqual([`failure-notification:v1:${intentId}`]);
      await waitFor(
        () =>
          workerQuery<{ status: string }>(
            `select status from app.run_failure_notification_intents
              where workspace_id=$1 and id=$2`,
            [workspaceId, slackIntentId],
          ),
        (rows) => rows[0]?.status === 'outcome_unknown',
      );
      expect(slackDeliveries).toEqual([]);

      const retry = recovered[0];
      if (retry === undefined) throw new Error('notification recovery missing');
      const completedJob = await queue.getJob(`outbox-${retry.id}`);
      await completedJob?.remove();
      await producer.publish({
        name: JOB_NAME.deliverRunFailureNotification,
        data: retry.payload,
      });
      await waitFor(
        async () => (await queue.getJob(`outbox-${retry.id}`))?.getState(),
        (state) => state === 'completed',
      );
      expect(deliveries).toHaveLength(1);
      const slackCompletedJob = await queue.getJob(
        `outbox-${slackOutboxEventId}`,
      );
      await slackCompletedJob?.remove();
      await producer.publish({
        name: JOB_NAME.deliverRunFailureNotification,
        data: slackPayload,
      });
      await waitFor(
        async () =>
          (await queue.getJob(`outbox-${slackOutboxEventId}`))?.getState(),
        (state) => state === 'completed',
      );
      expect(slackDeliveries).toHaveLength(0);
      drainState.beginDrain();
      await expect(dispatcher.checkReadiness()).rejects.toThrow(/draining/u);
      await expect(dispatcher.dispatchOnce()).resolves.toEqual({
        claimed: 0,
        failed: 0,
        published: 0,
        stale: 0,
      });
      const dispatcherCloseStartedAt = performance.now();
      await dispatcher.close();
      expect(performance.now() - dispatcherCloseStartedAt).toBeLessThan(2_000);
      await expect(
        workerQuery<{
          event_count: string;
          revision: number;
          run_status: string;
        }>(
          `select run.status run_status,checkpoint.revision,
                  (select count(*)::text from app.run_events event
                    where event.workflow_run_id=run.id) event_count
             from app.workflow_runs run
             join app.run_checkpoints checkpoint on checkpoint.workflow_run_id=run.id
            where run.workspace_id=$1 and run.id=$2`,
          [workspaceId, accepted.runId],
        ),
      ).resolves.toEqual(initialTruth);
      const persisted = await workerQuery<{
        audit: string;
        events: string;
        outbox: string;
      }>(
        `select
           coalesce((select string_agg(coalesce(safe_error_code,''),' ')
             from app.run_failure_notification_audit_facts
             where notification_intent_id=$2),'') audit,
           coalesce((select string_agg(payload::text,' ')
             from app.run_events where workflow_run_id=$3),'') events,
           coalesce((select string_agg(payload::text,' ')
             from app.outbox_events where aggregate_id=$2),'') outbox
         from app.workspaces where id=$1`,
        [workspaceId, intentId, accepted.runId],
      );
      expect(JSON.stringify(persisted)).not.toMatch(
        /failure-notification@example\.test|re_integration_only|sender@example\.test|xoxb-integration-only|C12345/i,
      );
    } finally {
      await startService('redis').catch(() => undefined);
      await Promise.allSettled([
        dispatcher.close(),
        runtime.close(),
        providerStore.close(),
        producer.close(),
      ]);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  }, 120_000);

  it('executes Manual through Set/Map to Terminate across durable coordinator continuations', async () => {
    const accepted = await acceptRun();
    const database = parseDatabaseConfig({
      connectionString: databaseUrl(workerUrl),
      max: 6,
    });
    const connectionResolve = vi.fn(() =>
      Promise.reject(new Error('core-only run must not resolve a connection')),
    );
    const artifactWrite = vi.fn(() =>
      Promise.reject(new Error('core-only run must not write an artifact')),
    );
    const httpRequest = vi.fn(() =>
      Promise.reject(
        new Error('core-only run must not contact HTTP transport'),
      ),
    );
    const coordinator = await createCoordinatorRuntime({
      database,
      maximumAdmissions: 1,
      releaseCohort: 'for_each_activation',
      redisUrl,
    });
    const attempts = await createNodeAttemptRuntime(
      {
        database,
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 10,
        releaseCohort: 'for_each_activation',
        redisUrl,
        workerId: `integration-${randomUUID()}`,
      },
      {
        registry: createPlatformNodeRegistryForRelease(
          PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
          { httpRequest: { httpClient: { executeStreaming: httpRequest } } },
        ),
        runtimeCapabilities: {
          connections: () => ({ resolve: connectionResolve }),
          artifacts: () => ({ write: artifactWrite }),
        },
      },
    );
    const producer = createQueueProducer({ redisUrl });
    const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
      connection: redisConnection(),
    });
    const coordinatorOutboxes = [accepted.outboxEventId];
    const attemptOutboxes: string[] = [];

    try {
      await Promise.all([
        coordinator.consumer.waitUntilReady(5_000),
        attempts.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      const initialJob = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: accepted.outboxEventId,
        },
      });
      const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
        connection: redisConnection(),
      });
      const initialTransition = await waitFor(
        async () => {
          const [rows, queued] = await Promise.all([
            workerQuery<{ revision: number }>(
              `select revision from app.run_checkpoints
               where workspace_id=$1 and workflow_run_id=$2`,
              [workspaceId, accepted.runId],
            ),
            coordinatorQueue.getJob(initialJob.jobId),
          ]);
          return {
            revision: rows[0]?.revision,
            state: await queued?.getState(),
            failedReason: queued?.failedReason,
          };
        },
        (value) => value.revision === 1 || value.state === 'failed',
      );
      await coordinatorQueue.close();
      if (initialTransition.revision !== 1)
        throw new Error(
          `initial coordinator failed: ${initialTransition.failedReason ?? 'unknown'}`,
        );

      for (const expectedNodeId of ['manual', 'set', 'terminate'] as const) {
        const attempt = await waitForAttemptOutbox(
          accepted.runId,
          attemptOutboxes,
        );
        attemptOutboxes.push(attempt.outboxEventId);
        await producer.publish({
          name: JOB_NAME.executeNodeAttempt,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: accepted.runId,
            nodeRunId: attempt.nodeRunId,
            attemptId: attempt.attemptId,
            outboxEventId: attempt.outboxEventId,
          },
        });
        await waitFor(
          () =>
            workerQuery<{ node_id: string; status: string }>(
              `select node_id,status from app.node_runs
               where workspace_id=$1 and id=$2`,
              [workspaceId, attempt.nodeRunId],
            ),
          (rows) =>
            rows[0]?.node_id === expectedNodeId &&
            rows[0].status === 'succeeded',
        );
        const completedJob = await waitFor(
          () => attemptQueue.getJob(`outbox-${attempt.outboxEventId}`),
          (job) => job !== undefined,
        );
        if (completedJob === undefined)
          throw new Error('completed attempt job disappeared');
        await waitFor(
          () => completedJob.getState(),
          (state) => state === 'completed',
        );
        await completedJob.remove();
        await producer.publish({
          name: JOB_NAME.executeNodeAttempt,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: accepted.runId,
            nodeRunId: attempt.nodeRunId,
            attemptId: attempt.attemptId,
            outboxEventId: attempt.outboxEventId,
          },
        });
        const replay = await waitFor(
          () => attemptQueue.getJob(`outbox-${attempt.outboxEventId}`),
          (job) => job !== undefined,
        );
        if (replay === undefined)
          throw new Error('replayed attempt job disappeared');
        await waitFor(
          () => replay.getState(),
          (state) => state === 'completed',
        );
        const continuation = await waitForCoordinatorOutbox(
          accepted.runId,
          coordinatorOutboxes,
        );
        coordinatorOutboxes.push(continuation);
        await producer.publish({
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: accepted.runId,
            outboxEventId: continuation,
          },
        });
      }

      const terminal = await waitFor(
        () =>
          workerQuery<{
            event_types: string[];
            revision: number;
            scheduler_state: unknown;
            status: string;
          }>(
            `select run.status,checkpoint.revision,checkpoint.scheduler_state,
                    array_agg(event.type order by event.sequence) event_types
             from app.workflow_runs run
             join app.run_checkpoints checkpoint
               on checkpoint.workspace_id=run.workspace_id
              and checkpoint.workflow_run_id=run.id
             join app.run_events event
               on event.workspace_id=run.workspace_id
              and event.workflow_run_id=run.id
             where run.workspace_id=$1 and run.id=$2
              group by run.status,checkpoint.revision,checkpoint.scheduler_state`,
            [workspaceId, accepted.runId],
          ),
        (rows) => rows[0]?.status === 'succeeded',
      );
      expect(terminal[0]?.revision).toBe(4);
      expect(terminal[0]?.event_types).toEqual([
        'run.queued',
        'run.started',
        'node.ready',
        'node.started',
        'node.succeeded',
        'node.ready',
        'node.started',
        'node.succeeded',
        'node.ready',
        'node.started',
        'node.succeeded',
        'run.succeeded',
      ]);
      expect(connectionResolve).not.toHaveBeenCalled();
      expect(artifactWrite).not.toHaveBeenCalled();
      expect(httpRequest).not.toHaveBeenCalled();
      const nodeFacts = await workerQuery<{
        attempt_id: string;
        attempt_status: string;
        node_id: string;
        node_status: string;
        output_ref: unknown;
      }>(
        `select node.node_id,node.status node_status,node.output_ref,
                attempt.id attempt_id,attempt.status attempt_status
         from app.node_runs node
         join app.node_attempts attempt
           on attempt.workspace_id=node.workspace_id
          and attempt.id=node.current_attempt_id
         where node.workspace_id=$1 and node.workflow_run_id=$2
         order by case node.node_id when 'manual' then 1 when 'set' then 2 else 3 end`,
        [workspaceId, accepted.runId],
      );
      expect(
        nodeFacts.map((fact) => ({
          attempt_status: fact.attempt_status,
          node_id: fact.node_id,
          node_status: fact.node_status,
          output_ref: fact.output_ref,
        })),
      ).toEqual([
        {
          attempt_status: 'succeeded',
          node_id: 'manual',
          node_status: 'succeeded',
          output_ref: {
            schemaVersion: 1,
            kind: 'inline',
            value: { name: 'Ada' },
          },
        },
        {
          attempt_status: 'succeeded',
          node_id: 'set',
          node_status: 'succeeded',
          output_ref: {
            schemaVersion: 1,
            kind: 'inline',
            value: {
              fromRun: 'Ada',
              literal: 1,
            },
          },
        },
        {
          attempt_status: 'succeeded',
          node_id: 'terminate',
          node_status: 'succeeded',
          output_ref: {
            schemaVersion: 1,
            kind: 'inline',
            value: {
              result: {
                fromRun: 'Ada',
                literal: 1,
              },
            },
          },
        },
      ]);
      for (const fact of nodeFacts)
        expect(fact.attempt_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
      const invocationKeys = ['manual', 'set', 'terminate'].map((nodeId) =>
        invocationKey({ workflowVersionId, nodeId }),
      );
      expect(terminal[0]?.scheduler_state).toEqual({
        schemaVersion: 1,
        engineVersion,
        workflowVersionId,
        revision: 4,
        runStatus: 'succeeded',
        nextEventSequence: 13,
        readySet: [],
        admittedInvocationKeys: invocationKeys,
        invocations: nodeFacts.map((fact, index) => ({
          invocationKey: invocationKeys[index],
          nodeId: fact.node_id,
          status: 'succeeded',
          attemptNumber: 1,
          output: { kind: 'inline', attemptId: fact.attempt_id },
        })),
        joins: [],
        loops: [],
        remainingIterationBudget: 0,
        cancelRequested: false,
        deadlineExpired: false,
      });
      const epoch2 = composeExecutableCompatibilityRelease(
        CORE_REGISTRY_RELEASE_SUCCESSOR,
      );
      const epoch14 = composeExecutableCompatibilityRelease(
        PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
      );
      await expect(
        workerQuery<{
          current_epoch: number;
          current_fingerprint: string;
          executable_epoch: number;
          executable_fingerprint: string;
        }>(
          `select current.epoch current_epoch,current.fingerprint current_fingerprint,
                  version.compatibility_release_epoch executable_epoch,
                  version.executable_json->>'compatibilityReleaseFingerprint' executable_fingerprint
           from app.workflow_versions version
           cross join app.node_compatibility_current current
           where version.workspace_id=$1 and version.id=$2`,
          [workspaceId, workflowVersionId],
        ),
      ).resolves.toEqual([
        {
          current_epoch: 14,
          current_fingerprint: epoch14.fingerprint,
          executable_epoch: 2,
          executable_fingerprint: epoch2.fingerprint,
        },
      ]);
    } finally {
      await Promise.allSettled([
        producer.close(),
        attemptQueue.close(),
        attempts.close(),
        coordinator.close(),
      ]);
    }
  });

  it.each([
    {
      label: 'Condition',
      acceptBranchRun: acceptConditionRun,
      branchNodeId: 'condition',
      selectedPort: 'true',
      unselectedPort: 'false',
    },
    {
      label: 'Switch',
      acceptBranchRun: acceptSwitchRun,
      branchNodeId: 'switch',
      selectedPort: 'case-01',
      unselectedPort: 'default',
    },
  ])(
    'recovers a $label selection after Redis loss on fresh workers without duplicate branch work',
    async ({
      acceptBranchRun,
      branchNodeId,
      label,
      selectedPort,
      unselectedPort,
    }) => {
      const accepted = await acceptBranchRun();
      const database = parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 6,
      });
      const runtimeCapabilities = {
        connections: () => ({
          resolve: vi.fn(() => Promise.reject(new Error('not used'))),
        }),
        artifacts: () => ({
          write: vi.fn(() => Promise.reject(new Error('not used'))),
        }),
      };
      const startWorkers = async () => {
        const coordinator = await createCoordinatorRuntime({
          database,
          maximumAdmissions: 2,
          releaseCohort: 'for_each_activation',
          redisUrl,
        });
        const attempts = await createNodeAttemptRuntime(
          {
            database,
            heartbeatIntervalMillis: 1_000,
            leaseDurationSeconds: 10,
            releaseCohort: 'for_each_activation',
            redisUrl,
            workerId: `${label.toLowerCase()}-${randomUUID()}`,
          },
          {
            registry: createPlatformNodeRegistryForRelease(
              PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
            ),
            runtimeCapabilities,
          },
        );
        await Promise.all([
          coordinator.consumer.waitUntilReady(5_000),
          attempts.consumer.waitUntilReady(5_000),
        ]);
        return { attempts, coordinator };
      };
      const producer = createQueueProducer({ redisUrl });
      const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
        connection: redisConnection(),
      });
      const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
        connection: redisConnection(),
      });
      let workers = await startWorkers();
      const attemptOutboxes: string[] = [];
      const coordinatorOutboxes = [accepted.outboxEventId];

      const publishCoordinator = async (
        outboxEventId: string,
        expectedRevision: number,
      ) => {
        const published = await producer.publish({
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: accepted.runId,
            outboxEventId,
          },
        });
        const result = await waitFor(
          async () => {
            const [rows, job] = await Promise.all([
              workerQuery<{ revision: number }>(
                `select revision from app.run_checkpoints
               where workspace_id=$1 and workflow_run_id=$2`,
                [workspaceId, accepted.runId],
              ),
              coordinatorQueue.getJob(published.jobId),
            ]);
            return {
              failedReason: job?.failedReason,
              revision: rows[0]?.revision,
              state: await job?.getState(),
            };
          },
          ({ revision, state }) =>
            revision === expectedRevision || state === 'failed',
        );
        if (result.revision !== expectedRevision)
          throw new Error(
            `${label} coordinator failed: ${result.failedReason ?? 'unknown'}`,
          );
        return published.jobId;
      };
      const executeNext = async (expectedNodeId: string) => {
        const attempt = await waitForAttemptOutbox(
          accepted.runId,
          attemptOutboxes,
        );
        attemptOutboxes.push(attempt.outboxEventId);
        const published = await producer.publish({
          name: JOB_NAME.executeNodeAttempt,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: accepted.runId,
            nodeRunId: attempt.nodeRunId,
            attemptId: attempt.attemptId,
            outboxEventId: attempt.outboxEventId,
          },
        });
        const result = await waitFor(
          async () => {
            const [rows, job] = await Promise.all([
              workerQuery<{ node_id: string; status: string }>(
                `select node_id,status from app.node_runs
               where workspace_id=$1 and id=$2`,
                [workspaceId, attempt.nodeRunId],
              ),
              attemptQueue.getJob(published.jobId),
            ]);
            return {
              failedReason: job?.failedReason,
              rows,
              state: await job?.getState(),
            };
          },
          ({ rows, state }) =>
            (rows[0]?.node_id === expectedNodeId &&
              rows[0].status === 'succeeded') ||
            state === 'failed',
        );
        if (result.rows[0]?.status !== 'succeeded')
          throw new Error(
            `${label} attempt failed: ${result.failedReason ?? 'unknown'}`,
          );
        return { ...attempt, jobId: published.jobId };
      };

      try {
        await producer.waitUntilReady(5_000);
        await publishCoordinator(accepted.outboxEventId, 1);

        await executeNext('manual');
        const manualContinuation = await waitForCoordinatorOutbox(
          accepted.runId,
          coordinatorOutboxes,
        );
        coordinatorOutboxes.push(manualContinuation);
        await publishCoordinator(manualContinuation, 2);

        const conditionAttempt = await executeNext(branchNodeId);
        const completedConditionJob = await waitFor(
          () => attemptQueue.getJob(conditionAttempt.jobId),
          (job) => job !== undefined,
        );
        if (completedConditionJob === undefined)
          throw new Error('Condition attempt job disappeared');
        await waitFor(
          () => completedConditionJob.getState(),
          (state) => state === 'completed',
        );
        await completedConditionJob.remove();
        await producer.publish({
          name: JOB_NAME.executeNodeAttempt,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: accepted.runId,
            nodeRunId: conditionAttempt.nodeRunId,
            attemptId: conditionAttempt.attemptId,
            outboxEventId: conditionAttempt.outboxEventId,
          },
        });
        const replayedConditionJob = await waitFor(
          () => attemptQueue.getJob(conditionAttempt.jobId),
          (job) => job !== undefined,
        );
        if (replayedConditionJob === undefined)
          throw new Error('Condition attempt replay disappeared');
        await waitFor(
          () => replayedConditionJob.getState(),
          (state) => state === 'completed',
        );

        const conditionContinuation = await waitForCoordinatorOutbox(
          accepted.runId,
          coordinatorOutboxes,
        );
        coordinatorOutboxes.push(conditionContinuation);
        await Promise.allSettled([
          workers.attempts.close(),
          workers.coordinator.close(),
        ]);
        await Promise.all([
          coordinatorQueue.obliterate({ force: true }),
          attemptQueue.obliterate({ force: true }),
        ]);
        workers = await startWorkers();

        const conditionJobId = await publishCoordinator(
          conditionContinuation,
          3,
        );
        const completedConditionCoordinator = await waitFor(
          () => coordinatorQueue.getJob(conditionJobId),
          (job) => job !== undefined,
        );
        if (completedConditionCoordinator === undefined)
          throw new Error('Condition coordinator job disappeared');
        await waitFor(
          () => completedConditionCoordinator.getState(),
          (state) => state === 'completed',
        );
        await completedConditionCoordinator.remove();
        await publishCoordinator(conditionContinuation, 3);

        await executeNext('selected');
        const selectedContinuation = await waitForCoordinatorOutbox(
          accepted.runId,
          coordinatorOutboxes,
        );
        coordinatorOutboxes.push(selectedContinuation);
        await publishCoordinator(selectedContinuation, 4);

        const terminal = await workerQuery<{
          attempts: string;
          branch_context: unknown;
          node_id: string;
          scheduler_state: unknown;
          status: string;
        }>(
          `select node.node_id,node.status,node.branch_context,
                checkpoint.scheduler_state,
                (select count(*)::text from app.node_attempts attempt
                  join app.node_runs attempt_node on attempt_node.id=attempt.node_run_id
                 where attempt_node.workflow_run_id=$2) attempts
           from app.node_runs node
           join app.run_checkpoints checkpoint
             on checkpoint.workflow_run_id=node.workflow_run_id
          where node.workspace_id=$1 and node.workflow_run_id=$2
          order by node.node_id`,
          [workspaceId, accepted.runId],
        );
        expect(
          terminal.map(({ node_id, status, branch_context }) => ({
            branch_context,
            node_id,
            status,
          })),
        ).toEqual(
          [
            {
              branch_context: {},
              node_id: branchNodeId,
              status: 'succeeded',
            },
            { branch_context: {}, node_id: 'manual', status: 'succeeded' },
            {
              branch_context: {
                branchPath: [
                  { nodeId: branchNodeId, outputPort: selectedPort },
                ],
                iterationPath: [],
              },
              node_id: 'selected',
              status: 'succeeded',
            },
            {
              branch_context: {
                branchPath: [
                  { nodeId: branchNodeId, outputPort: unselectedPort },
                ],
                iterationPath: [],
              },
              node_id: 'unselected',
              status: 'skipped',
            },
          ].sort((left, right) => left.node_id.localeCompare(right.node_id)),
        );
        expect(terminal[0]?.attempts).toBe('3');
        expect(parseCheckpoint(terminal[0]?.scheduler_state)).toMatchObject({
          schemaVersion: 2,
          branchSelections: [
            {
              nodeId: branchNodeId,
              selectedOutputPort: selectedPort,
            },
          ],
          runStatus: 'succeeded',
        });
      } finally {
        await Promise.allSettled([
          workers.attempts.close(),
          workers.coordinator.close(),
          producer.close(),
          coordinatorQueue.close(),
          attemptQueue.close(),
        ]);
      }
    },
    30_000,
  );

  it('recovers bounded Parallel and settled Merge after Redis loss on fresh workers', async () => {
    const accepted = await acceptParallelRun();
    const database = parseDatabaseConfig({
      connectionString: databaseUrl(workerUrl),
      max: 6,
    });
    const runtimeCapabilities = {
      connections: () => ({
        resolve: vi.fn(() => Promise.reject(new Error('not used'))),
      }),
      artifacts: () => ({
        write: vi.fn(() => Promise.reject(new Error('not used'))),
      }),
    };
    const startWorkers = async () => {
      const coordinator = await createCoordinatorRuntime({
        database,
        maximumAdmissions: 10,
        releaseCohort: 'for_each_activation',
        redisUrl,
      });
      const attempts = await createNodeAttemptRuntime(
        {
          database,
          heartbeatIntervalMillis: 1_000,
          leaseDurationSeconds: 10,
          releaseCohort: 'for_each_activation',
          redisUrl,
          workerId: `parallel-${randomUUID()}`,
        },
        {
          registry: createPlatformNodeRegistryForRelease(
            PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
          ),
          runtimeCapabilities,
        },
      );
      await Promise.all([
        coordinator.consumer.waitUntilReady(5_000),
        attempts.consumer.waitUntilReady(5_000),
      ]);
      return { attempts, coordinator };
    };
    const producer = createQueueProducer({ redisUrl });
    const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: redisConnection(),
    });
    const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
      connection: redisConnection(),
    });
    let workers = await startWorkers();
    const attemptOutboxes: string[] = [];
    const coordinatorOutboxes = [accepted.outboxEventId];
    const publishCoordinator = async (
      outboxEventId: string,
      expectedRevision: number,
    ) => {
      const published = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId,
        },
      });
      const result = await waitFor(
        async () => {
          const [rows, job] = await Promise.all([
            workerQuery<{ revision: number }>(
              `select revision from app.run_checkpoints
               where workspace_id=$1 and workflow_run_id=$2`,
              [workspaceId, accepted.runId],
            ),
            coordinatorQueue.getJob(published.jobId),
          ]);
          return {
            failedReason: job?.failedReason,
            revision: rows[0]?.revision,
            state: await job?.getState(),
          };
        },
        ({ revision, state }) =>
          revision === expectedRevision || state === 'failed',
      );
      if (result.revision !== expectedRevision)
        throw new Error(
          `Parallel coordinator failed: ${result.failedReason ?? 'unknown'}`,
        );
    };
    const executeNext = async (expectedNodeId: string) => {
      const attempt = await waitForAttemptOutbox(
        accepted.runId,
        attemptOutboxes,
      );
      attemptOutboxes.push(attempt.outboxEventId);
      const published = await producer.publish({
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: attempt.nodeRunId,
          attemptId: attempt.attemptId,
          outboxEventId: attempt.outboxEventId,
        },
      });
      const result = await waitFor(
        async () => {
          const [rows, job] = await Promise.all([
            workerQuery<{ node_id: string; status: string }>(
              `select node_id,status from app.node_runs
               where workspace_id=$1 and id=$2`,
              [workspaceId, attempt.nodeRunId],
            ),
            attemptQueue.getJob(published.jobId),
          ]);
          return {
            failedReason: job?.failedReason,
            rows,
            state: await job?.getState(),
          };
        },
        ({ rows, state }) =>
          (rows[0]?.node_id === expectedNodeId &&
            rows[0].status === 'succeeded') ||
          state === 'failed',
      );
      if (result.rows[0]?.status !== 'succeeded')
        throw new Error(
          `Parallel attempt failed: ${result.failedReason ?? 'unknown'}`,
        );
      return attempt;
    };
    const continueAfter = async (expectedRevision: number) => {
      const outboxEventId = await waitForCoordinatorOutbox(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(outboxEventId);
      await publishCoordinator(outboxEventId, expectedRevision);
      return outboxEventId;
    };

    try {
      await producer.waitUntilReady(5_000);
      await publishCoordinator(accepted.outboxEventId, 1);
      await executeNext('manual');
      await continueAfter(2);
      const parallelAttempt = await executeNext('parallel');
      const parallelContinuation = await waitForCoordinatorOutbox(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(parallelContinuation);

      await producer.publish({
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: parallelAttempt.nodeRunId,
          attemptId: parallelAttempt.attemptId,
          outboxEventId: parallelAttempt.outboxEventId,
        },
      });
      await Promise.allSettled([
        workers.attempts.close(),
        workers.coordinator.close(),
      ]);
      await Promise.all([
        coordinatorQueue.obliterate({ force: true }),
        attemptQueue.obliterate({ force: true }),
      ]);
      workers = await startWorkers();

      await publishCoordinator(parallelContinuation, 3);
      await publishCoordinator(parallelContinuation, 3);
      const bounded = await workerQuery<{
        attempt_count: string;
        node_id: string;
        status: string;
      }>(
        `select node_id,status,
                (select count(*)::text from app.node_attempts attempt
                  join app.node_runs attempt_node on attempt_node.id=attempt.node_run_id
                 where attempt_node.workflow_run_id=$2
                   and attempt_node.node_id in ('left','right')) attempt_count
           from app.node_runs
         where workspace_id=$1 and workflow_run_id=$2
           and node_id in ('left','right') order by node_id`,
        [workspaceId, accepted.runId],
      );
      expect(bounded).toEqual([
        { attempt_count: '1', node_id: 'left', status: 'ready' },
        { attempt_count: '1', node_id: 'right', status: 'ready' },
      ]);

      await executeNext('left');
      await continueAfter(4);
      await executeNext('right');
      await continueAfter(5);
      await executeNext('merge');
      await continueAfter(6);
      await executeNext('terminate');
      await continueAfter(7);

      const terminal = await workerQuery<{
        attempts: string;
        scheduler_state: unknown;
      }>(
        `select checkpoint.scheduler_state,
                (select count(*)::text from app.node_attempts attempt
                  join app.node_runs node on node.id=attempt.node_run_id
                 where node.workflow_run_id=$2) attempts
           from app.run_checkpoints checkpoint
          where checkpoint.workspace_id=$1 and checkpoint.workflow_run_id=$2`,
        [workspaceId, accepted.runId],
      );
      expect(terminal[0]?.attempts).toBe('6');
      expect(parseCheckpoint(terminal[0]?.scheduler_state)).toMatchObject({
        schemaVersion: 2,
        runStatus: 'succeeded',
        joins: [
          {
            joinId: 'merge',
            selectedBranchIds: ['branch-01', 'branch-02'],
          },
        ],
      });
    } finally {
      await Promise.allSettled([
        workers.attempts.close(),
        workers.coordinator.close(),
        producer.close(),
        coordinatorQueue.close(),
        attemptQueue.close(),
      ]);
    }
  }, 30_000);

  it('recovers bounded For Each batches and cancellation from PostgreSQL on fresh workers', async () => {
    const producer = createQueueProducer({ redisUrl });
    const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: redisConnection(),
    });
    const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
      connection: redisConnection(),
    });
    const startWorkers = async (): Promise<ChildProcess> => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          new URL('./for-each-worker-process-fixture.ts', import.meta.url)
            .pathname,
        ],
        {
          cwd: new URL('../', import.meta.url).pathname,
          env: {
            ...process.env,
            FOR_EACH_DATABASE_URL: databaseUrl(workerUrl),
            FOR_EACH_REDIS_URL: redisUrl,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await new Promise<void>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
          reject(new Error(`For Each child startup timed out: ${stderr}`));
        }, 10_000);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes('"ready":true')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          reject(
            new Error(
              `For Each child exited during startup (${String(code)}): ${stderr}`,
            ),
          );
        });
      });
      return child;
    };
    let workers = await startWorkers();
    const stopWorkers = async () => {
      if (workers.exitCode !== null) return;
      workers.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        workers.once('exit', () => {
          resolve();
        });
      });
    };
    const eraseRedisAndRestart = async () => {
      await stopWorkers();
      await Promise.all([
        coordinatorQueue.obliterate({ force: true }),
        attemptQueue.obliterate({ force: true }),
      ]);
      workers = await startWorkers();
    };

    const runFixture = async (cancelBetweenBatches: boolean) => {
      const accepted = await acceptForEachRun();
      const coordinatorOutboxes = [accepted.outboxEventId];
      const attemptOutboxes: string[] = [];
      const publishCoordinator = async (
        outboxEventId: string,
        expectedRevision: number,
      ) => {
        const published = await producer.publish({
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: accepted.runId,
            outboxEventId,
          },
        });
        const result = await waitFor(
          async () => {
            const [rows, job] = await Promise.all([
              workerQuery<{ revision: number }>(
                `select revision from app.run_checkpoints
                 where workspace_id=$1 and workflow_run_id=$2`,
                [workspaceId, accepted.runId],
              ),
              coordinatorQueue.getJob(published.jobId),
            ]);
            return {
              failedReason: job?.failedReason,
              stacktrace: job?.stacktrace,
              revision: rows[0]?.revision,
              state: await job?.getState(),
            };
          },
          ({ revision, state }) =>
            revision === expectedRevision || state === 'failed',
        );
        if (result.revision !== expectedRevision)
          throw new Error(
            `For Each coordinator failed: ${result.failedReason ?? 'unknown'} ${JSON.stringify(result.stacktrace)}`,
          );
      };
      const continueAfter = async (expectedRevision: number) => {
        const outbox = await waitForCoordinatorOutbox(
          accepted.runId,
          coordinatorOutboxes,
        );
        coordinatorOutboxes.push(outbox);
        await publishCoordinator(outbox, expectedRevision);
        return outbox;
      };
      const execute = async (nodeId: string, ordinal?: number) => {
        const rows = await waitFor(
          () =>
            workerQuery<{
              attempt_id: string;
              node_run_id: string;
              outbox_id: string;
            }>(
              `select attempt.id attempt_id,node.id node_run_id,outbox.id outbox_id
                 from app.outbox_events outbox
                 join app.node_attempts attempt on attempt.id=outbox.aggregate_id
                 join app.node_runs node on node.id=attempt.node_run_id
                where node.workspace_id=$1 and node.workflow_run_id=$2
                  and node.node_id=$3 and outbox.job_name='execute-node-attempt'
                  and not (outbox.id=any($4::uuid[]))
                  and ($5::int is null or
                    (node.branch_context->'iterationPath'->0->>'ordinal')::int=$5)
                order by outbox.created_at,outbox.id`,
              [
                workspaceId,
                accepted.runId,
                nodeId,
                attemptOutboxes,
                ordinal ?? null,
              ],
            ),
          (value) => value.length === 1,
        );
        const attempt = rows[0];
        if (attempt === undefined) throw new Error('For Each attempt missing');
        attemptOutboxes.push(attempt.outbox_id);
        const published = await producer.publish({
          name: JOB_NAME.executeNodeAttempt,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: accepted.runId,
            nodeRunId: attempt.node_run_id,
            attemptId: attempt.attempt_id,
            outboxEventId: attempt.outbox_id,
          },
        });
        const result = await waitFor(
          async () => {
            const [nodeRows, job] = await Promise.all([
              workerQuery<{ status: string }>(
                `select status from app.node_runs where workspace_id=$1 and id=$2`,
                [workspaceId, attempt.node_run_id],
              ),
              attemptQueue.getJob(published.jobId),
            ]);
            return {
              failedReason: job?.failedReason,
              state: await job?.getState(),
              status: nodeRows[0]?.status,
            };
          },
          ({ state, status }) => status === 'succeeded' || state === 'failed',
        );
        if (result.status !== 'succeeded')
          throw new Error(
            `For Each attempt failed: ${result.failedReason ?? 'unknown'}`,
          );
        return attempt;
      };
      const executeDuplicateAttempt = async (attempt: {
        attempt_id: string;
        node_run_id: string;
        outbox_id: string;
      }) => {
        const published = await producer.publish({
          name: JOB_NAME.executeNodeAttempt,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: accepted.runId,
            nodeRunId: attempt.node_run_id,
            attemptId: attempt.attempt_id,
            outboxEventId: attempt.outbox_id,
          },
        });
        const job = await waitFor(
          () => attemptQueue.getJob(published.jobId),
          (value) => value !== undefined,
        );
        if (job === undefined) throw new Error('duplicate attempt disappeared');
        await waitFor(
          () => job.getState(),
          (state) => state === 'completed' || state === 'failed',
        );
        await expect(job.getState()).resolves.toBe('completed');
      };

      await publishCoordinator(accepted.outboxEventId, 1);
      await execute('manual');
      await continueAfter(2);
      const declaration = await execute('for-each');

      const declarationJob = await attemptQueue.getJob(
        `outbox-${declaration.outbox_id}`,
      );
      await declarationJob?.remove();
      await executeDuplicateAttempt(declaration);

      // The declaration outcome is durable before any coordinator consumes it.
      await eraseRedisAndRestart();
      const declarationContinuation = await waitForCoordinatorOutbox(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(declarationContinuation);
      await publishCoordinator(declarationContinuation, 3);
      const declarationCoordinatorJob = await coordinatorQueue.getJob(
        `outbox-${declarationContinuation}`,
      );
      await declarationCoordinatorJob?.remove();
      await publishCoordinator(declarationContinuation, 3);
      await eraseRedisAndRestart();

      const reserved = await workerQuery<{
        scheduler_state: unknown;
      }>(
        `select scheduler_state from app.run_checkpoints
          where workspace_id=$1 and workflow_run_id=$2`,
        [workspaceId, accepted.runId],
      );
      expect(parseCheckpoint(reserved[0]?.scheduler_state)).toMatchObject({
        remainingIterationBudget: 997,
        loops: [
          {
            activeOrdinals: [0, 1],
            nextOrdinal: 2,
            terminalOrdinals: [],
          },
        ],
      });

      for (const ordinal of [0, 1]) {
        await execute('body-map', ordinal);
        await continueAfter(4 + ordinal);
      }
      await execute('body-sink', 0);
      await execute('body-sink', 1);

      if (cancelBetweenBatches) {
        await apiDatabase.withWorkspace(workspaceId, (transaction) =>
          requestWorkflowRunCancellation(transaction, {
            actor: 'for-each-recovery-test',
            reason: 'cancel between canonical batches',
            runId: accepted.runId,
          }),
        );
        await eraseRedisAndRestart();
        await continueAfter(6);
        const canceled = await waitFor(
          () =>
            workerQuery<{ scheduler_state: unknown; status: string }>(
              `select run.status,checkpoint.scheduler_state
                 from app.workflow_runs run
                 join app.run_checkpoints checkpoint
                   on checkpoint.workflow_run_id=run.id
                where run.workspace_id=$1 and run.id=$2`,
              [workspaceId, accepted.runId],
            ),
          (rows) => rows[0]?.status === 'canceled',
        );
        expect(parseCheckpoint(canceled[0]?.scheduler_state)).toMatchObject({
          cancelRequested: true,
          remainingIterationBudget: 997,
          runStatus: 'canceled',
        });
        await expect(
          workerQuery<{ count: string }>(
            `select count(*)::text count from app.node_runs
              where workspace_id=$1 and workflow_run_id=$2
                and branch_context->'iterationPath' @> '[{"loopNodeId":"for-each","ordinal":2}]'::jsonb`,
            [workspaceId, accepted.runId],
          ),
        ).resolves.toEqual([{ count: '0' }]);
        return;
      }

      // A sink outcome survives worker/Redis loss before coordinator consumption.
      await eraseRedisAndRestart();
      await continueAfter(6);
      const laterBatch = await workerQuery<{ scheduler_state: unknown }>(
        `select scheduler_state from app.run_checkpoints
          where workspace_id=$1 and workflow_run_id=$2`,
        [workspaceId, accepted.runId],
      );
      expect(parseCheckpoint(laterBatch[0]?.scheduler_state)).toMatchObject({
        remainingIterationBudget: 997,
        loops: [
          {
            activeOrdinals: [2],
            nextOrdinal: 3,
            terminalOrdinals: [0, 1],
          },
        ],
      });
      await eraseRedisAndRestart();
      await execute('body-map', 2);
      await continueAfter(7);
      await execute('body-sink', 2);
      await continueAfter(8);
      await continueAfter(9);
      await execute('outer-successor');
      await continueAfter(10);

      const facts = await workerQuery<{
        branch_context: unknown;
        node_id: string;
        output_ref: unknown;
        scheduler_state: unknown;
        status: string;
      }>(
        `select node.node_id,node.status,node.branch_context,node.output_ref,
                checkpoint.scheduler_state
           from app.node_runs node
           join app.run_checkpoints checkpoint
             on checkpoint.workflow_run_id=node.workflow_run_id
          where node.workspace_id=$1 and node.workflow_run_id=$2
          order by node.node_id,node.invocation_key`,
        [workspaceId, accepted.runId],
      );
      expect(parseCheckpoint(facts[0]?.scheduler_state)).toMatchObject({
        remainingIterationBudget: 997,
        runStatus: 'succeeded',
        loops: [
          {
            activeOrdinals: [],
            nextOrdinal: 3,
            terminalOrdinals: [0, 1, 2],
          },
        ],
      });
      expect(
        facts
          .filter(({ node_id }) => node_id === 'body-map')
          .map(({ branch_context, output_ref }) => ({
            branch_context,
            output_ref,
          })),
      ).toEqual(
        [
          { id: 'alpha', value: 11 },
          { id: 'beta', value: 22 },
          { id: 'gamma', value: 33 },
        ].map((item, ordinal) => ({
          branch_context: {
            branchPath: [],
            iterationPath: [{ loopNodeId: 'for-each', ordinal }],
          },
          output_ref: {
            schemaVersion: 1,
            kind: 'inline',
            value: { item, ordinal },
          },
        })),
      );
      expect(
        facts
          .filter(({ node_id }) => node_id === 'body-sink')
          .map(({ output_ref }) => output_ref),
      ).toEqual(
        [
          { id: 'alpha', value: 11 },
          { id: 'beta', value: 22 },
          { id: 'gamma', value: 33 },
        ].map((item, ordinal) => ({
          schemaVersion: 1,
          kind: 'inline',
          value: { result: { item, ordinal } },
        })),
      );
      expect(
        facts.find(({ node_id }) => node_id === 'outer-successor')?.output_ref,
      ).toEqual({
        schemaVersion: 1,
        kind: 'inline',
        value: {
          result: {
            items: [
              { id: 'alpha', value: 11 },
              { id: 'beta', value: 22 },
              { id: 'gamma', value: 33 },
            ],
            iterationCount: 3,
          },
        },
      });
      expect(
        facts.filter(({ node_id }) => node_id === 'for-each'),
      ).toHaveLength(1);
      await expect(
        workerQuery<{ attempts: string; controls: string }>(
          `select
             count(*)::text attempts,
             count(*) filter (where node.node_id='for-each')::text controls
             from app.node_attempts attempt
             join app.node_runs node on node.id=attempt.node_run_id
            where node.workspace_id=$1 and node.workflow_run_id=$2`,
          [workspaceId, accepted.runId],
        ),
      ).resolves.toEqual([{ attempts: '9', controls: '1' }]);
      void declaration;
    };

    try {
      await producer.waitUntilReady(5_000);
      await runFixture(false);
      await runFixture(true);
    } finally {
      await stopWorkers();
      await Promise.allSettled([
        producer.close(),
        coordinatorQueue.close(),
        attemptQueue.close(),
      ]);
    }
  }, 60_000);

  it('recovers due retry and Wait work through SQL, Redis outage, BullMQ, and fresh coordination', async () => {
    const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: redisConnection(),
    });
    try {
      await coordinatorQueue.obliterate({ force: true });
    } finally {
      await coordinatorQueue.close();
    }
    const fixtureAdmin = new Pool({
      connectionString: databaseUrl(adminUrl),
      max: 1,
    });
    try {
      await fixtureAdmin.query(
        `update app.outbox_events
         set published_at=coalesce(published_at,clock_timestamp())
         where job_name='advance-workflow-run'`,
      );
    } finally {
      await fixtureAdmin.end();
    }
    const runId = randomUUID();
    const nodeIds = ['manual', 'set'] as const;
    const invocationKeys = nodeIds.map((nodeId) =>
      invocationKey({ workflowVersionId, nodeId }),
    );
    const providerKeys = nodeIds.map(
      (nodeId) => `due-wakeup-provider-key:${runId}:${nodeId}`,
    );
    const nodeRunIds = nodeIds.map(() => randomUUID());
    const firstAttemptIds = nodeIds.map(() => randomUUID());
    const dueAt = new Date(Date.now() + 500).toISOString();
    const waitingCheckpoint = {
      schemaVersion: 1 as const,
      engineVersion,
      workflowVersionId,
      revision: 0,
      runStatus: 'waiting' as const,
      nextEventSequence: 2,
      readySet: [],
      admittedInvocationKeys: invocationKeys,
      invocations: nodeIds.map((nodeId) => ({
        invocationKey: invocationKey({ workflowVersionId, nodeId }),
        nodeId,
        status: 'waiting' as const,
        attemptNumber: 1,
        resumeAt: dueAt,
        waitKind:
          nodeId === 'manual'
            ? ('retry_backoff' as const)
            : ('node_wait' as const),
        ...(nodeId === 'set'
          ? {
              output: {
                kind: 'inline' as const,
                attemptId: firstAttemptIds[1] as string,
              },
            }
          : {}),
      })),
      joins: [],
      loops: [],
      remainingIterationBudget: 0,
      cancelRequested: false,
      deadlineExpired: false,
    };
    await apiQuery(
      `insert into app.workflow_runs (
         id,workspace_id,workflow_id,workflow_version_id,trigger_type,status
       ) values ($1,$2,$3,$4,'manual','waiting')`,
      [runId, workspaceId, workflowId, workflowVersionId],
    );
    await apiQuery(
      `insert into app.run_events
         (workspace_id,workflow_run_id,sequence,type,payload)
       values ($1,$2,1,'run.queued','{"schemaVersion":1}'::jsonb)`,
      [workspaceId, runId],
    );
    await apiQuery(
      `insert into app.run_checkpoints (
         workflow_run_id,workspace_id,workflow_version_id,revision,
         engine_version,scheduler_state
       ) values ($1,$2,$3,0,$4,$5::jsonb)`,
      [
        runId,
        workspaceId,
        workflowVersionId,
        engineVersion,
        JSON.stringify(waitingCheckpoint),
      ],
    );
    const seedClient = await workerPool.connect();
    try {
      await seedClient.query('begin');
      await seedClient.query(
        "select set_config('app.workspace_id', $1, true)",
        [workspaceId],
      );
      await seedClient.query('set constraints all deferred');
      for (const [index, nodeId] of nodeIds.entries()) {
        if (nodeId === 'manual') {
          await seedClient.query(
            `insert into app.node_runs (
              id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
              status,side_effect_class,provider_idempotency_key,current_attempt_id,
              current_attempt_number,retry_due_at,wait_kind
            ) values ($1,$2,$3,$4,$5,'{}','waiting','idempotent_with_key',$6,$7,1,$8,
                      'retry_backoff')`,
            [
              nodeRunIds[index],
              workspaceId,
              runId,
              nodeId,
              invocationKeys[index],
              providerKeys[index],
              firstAttemptIds[index],
              dueAt,
            ],
          );
          await seedClient.query(
            `insert into app.node_attempts (
              id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
              provider_idempotency_key,safe_error_code,executor_failure_kind,
              executor_error_kind,executor_possibly_dispatched,retry_decision,
              completed_at
            ) values ($1,$2,$3,1,'failed','idempotent_with_key',$4,
                      'execution.rate_limit','retry','rate_limit',false,'retry',
                      clock_timestamp())`,
            [
              firstAttemptIds[index],
              workspaceId,
              nodeRunIds[index],
              providerKeys[index],
            ],
          );
        } else {
          const output = JSON.stringify({
            schemaVersion: 1,
            kind: 'inline',
            value: { preserved: true },
          });
          await seedClient.query(
            `insert into app.node_runs (
              id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
              status,side_effect_class,current_attempt_id,current_attempt_number,
              resume_at,wait_kind,output_ref
            ) values ($1,$2,$3,$4,$5,'{}','waiting','safe',$6,1,$7,'node_wait',$8::jsonb)`,
            [
              nodeRunIds[index],
              workspaceId,
              runId,
              nodeId,
              invocationKeys[index],
              firstAttemptIds[index],
              dueAt,
              output,
            ],
          );
          await seedClient.query(
            `insert into app.node_attempts (
              id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
              output_ref,completed_at
            ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb,clock_timestamp())`,
            [firstAttemptIds[index], workspaceId, nodeRunIds[index], output],
          );
        }
      }
      await seedClient.query('commit');
    } catch (error: unknown) {
      await seedClient.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      seedClient.release();
    }

    const retryEngine: CoordinatorAdvanceEngine = {
      advance: (input) => {
        const current = parseCheckpoint(input.checkpoint);
        if (current.revision > 0)
          return Promise.resolve({
            kind: 'no_change',
            revision: current.revision,
          });
        const invocations = current.invocations.map((invocation) => {
          const {
            resumeAt: _resumeAt,
            waitKind: _waitKind,
            ...active
          } = invocation;
          void _resumeAt;
          void _waitKind;
          return {
            ...active,
            status: 'running' as const,
            attemptNumber: 2,
          };
        });
        return Promise.resolve({
          kind: 'transition',
          plan: {
            expectedRevision: 0,
            expectedNextEventSequence: 2,
            consumedThroughEventSequence: 1,
            checkpoint: {
              ...current,
              revision: 1,
              runStatus: 'running',
              nextEventSequence: 4,
              invocations,
            },
            events: nodeIds.map((nodeId, index) => ({
              schemaVersion: 1 as const,
              sequence: index + 2,
              name: 'node.ready' as const,
              occurredAt: input.occurredAt,
              invocationKey: invocationKey({ workflowVersionId, nodeId }),
              nodeId,
              attemptNumber: 1,
            })),
            nodeRunAdmissions: [],
            attempts: nodeIds.map((nodeId) => ({
              invocationKey: invocationKey({ workflowVersionId, nodeId }),
              nodeId,
              attemptNumber: 2,
              admissionKind:
                nodeId === 'manual'
                  ? ('retry' as const)
                  : ('wait_resume' as const),
              sideEffectClass:
                nodeId === 'manual'
                  ? ('idempotent_with_key' as const)
                  : ('safe' as const),
              ...(nodeId === 'manual'
                ? {
                    providerIdempotencyKey: `due-wakeup-provider-key:${runId}:${nodeId}`,
                  }
                : {}),
            })),
          },
        });
      },
    };
    const runtimeOptions = {
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 6,
      }),
      dueWakeupBatchSize: 10,
      dueWakeupPollIntervalMillis: 25,
      maximumAdmissions: 2,
      releaseCohort: 'for_each_activation' as const,
      redisUrl,
    };
    const beforeDue = await createCoordinatorRuntime(runtimeOptions, {
      engine: retryEngine,
    });
    try {
      await beforeDue.consumer.waitUntilReady(5_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      await expect(
        workerQuery<{ attempts: string; wakeups: string }>(
          `select
             (select count(*)::text from app.node_attempts attempt
               join app.node_runs node on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
               where node.workflow_run_id=$1) attempts,
             (select count(*)::text from app.outbox_events
               where aggregate_id=$1 and job_name='advance-workflow-run') wakeups`,
          [runId],
        ),
      ).resolves.toEqual([{ attempts: '2', wakeups: '0' }]);
    } finally {
      await beforeDue.close();
    }

    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(dueAt) - Date.now() + 25)),
    );
    const afterClaim = await createCoordinatorRuntime(runtimeOptions, {
      engine: retryEngine,
    });
    await afterClaim.consumer.waitUntilReady(5_000);
    await waitFor(
      () =>
        workerQuery<{ attempts: string; wakeups: string }>(
          `select
             (select count(*)::text from app.node_attempts attempt
               join app.node_runs node on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
               where node.workflow_run_id=$1) attempts,
             (select count(*)::text from app.outbox_events
               where aggregate_id=$1 and job_name='advance-workflow-run') wakeups`,
          [runId],
        ),
      (rows) => rows[0]?.attempts === '2' && rows[0].wakeups === '2',
    );

    const unavailableRedis = new URL(redisUrl);
    unavailableRedis.port = '1';
    const redisError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const unavailableDispatcher = createCoordinatorDispatcher(
      afterClaim.consumer,
      unavailableRedis.toString(),
    );
    try {
      await expect(unavailableDispatcher.dispatchOnce()).resolves.toMatchObject(
        {
          claimed: 2,
          failed: 2,
          published: 0,
        },
      );
    } finally {
      await unavailableDispatcher.close().catch(() => undefined);
      redisError.mockRestore();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const dispatcher = createCoordinatorDispatcher(afterClaim.consumer);
    try {
      await dispatcher.checkReadiness();
      await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
        claimed: 2,
        published: 2,
      });
      const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
        connection: redisConnection(),
      });
      try {
        const wakeupJobs = await waitFor(
          () =>
            coordinatorQueue.getJobs([
              'active',
              'completed',
              'failed',
              'waiting',
            ]),
          (jobs) => jobs.length === 2,
        );
        await waitFor(
          () => Promise.all(wakeupJobs.map((job) => job.getState())),
          (states) =>
            states.every((state) => ['completed', 'failed'].includes(state)),
        );
        const failed = await coordinatorQueue.getJobs(['failed']);
        if (failed.length > 0)
          throw new Error(
            `due wakeup coordinator failed: ${failed.map((job) => job.failedReason).join('; ')}`,
          );
      } finally {
        await coordinatorQueue.close();
      }
      const facts = await waitFor(
        () =>
          workerQuery<{
            attempt_count: string;
            attempt_outboxes: string;
            event_count: string;
            provider_keys: (string | null)[];
            retry_events: string;
          }>(
            `select
               (select count(*)::text from app.node_attempts attempt
                 join app.node_runs node on node.workspace_id=attempt.workspace_id
                  and node.id=attempt.node_run_id
                 where node.workflow_run_id=$1) attempt_count,
               (select array_agg(attempt.provider_idempotency_key order by node.node_id,attempt.attempt_number)
                 from app.node_attempts attempt
                 join app.node_runs node on node.workspace_id=attempt.workspace_id
                  and node.id=attempt.node_run_id
                 where node.workflow_run_id=$1) provider_keys,
               (select count(*)::text from app.outbox_events
                 where payload->>'runId'=$1::text and job_name='execute-node-attempt') attempt_outboxes,
               (select count(*)::text from app.run_events
                 where workflow_run_id=$1) event_count,
               (select count(*)::text from app.run_events
                 where workflow_run_id=$1 and type='node.retry_scheduled') retry_events`,
            [runId],
          ),
        (rows) => rows[0]?.attempt_count === '4',
      );
      const fact = facts[0];
      if (fact === undefined) throw new Error('due wakeup facts missing');
      expect(fact).toEqual({
        attempt_count: '4',
        attempt_outboxes: '2',
        event_count: '3',
        provider_keys: [providerKeys[0], providerKeys[0], null, null],
        retry_events: '0',
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const verificationScanner = createDueNodeWakeupScanner(
        runtimeOptions.database,
      );
      try {
        await expect(verificationScanner.claimDueWakeups(10)).resolves.toBe(0);
      } finally {
        await verificationScanner.close();
      }
      await expect(
        workerQuery<{ attempts: string; wakeups: string }>(
          `select
             (select count(*)::text from app.node_attempts attempt
               join app.node_runs node on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
               where node.workflow_run_id=$1) attempts,
             (select count(*)::text from app.outbox_events
               where aggregate_id=$1 and job_name='advance-workflow-run') wakeups`,
          [runId],
        ),
      ).resolves.toEqual([{ attempts: '4', wakeups: '2' }]);
    } finally {
      await Promise.allSettled([dispatcher.close(), afterClaim.close()]);
    }
  });

  it('rejects and audits an outbox identity replayed with a different run payload', async () => {
    const [authoritative, target] = await Promise.all([
      acceptRun(),
      acceptRun(),
    ]);
    const runtime = await createCoordinatorRuntime({
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 4,
      }),
      maximumAdmissions: 1,
      releaseCohort: 'for_each_activation',
      redisUrl,
    });
    const producer = createQueueProducer({ redisUrl });
    const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: redisConnection(),
    });
    try {
      await queue.obliterate({ force: true });
      await Promise.all([
        runtime.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      const published = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: target.runId,
          outboxEventId: authoritative.outboxEventId,
        },
      });
      const forgedJob = await waitFor(
        () => queue.getJob(published.jobId),
        (value) => value !== undefined,
      );
      if (forgedJob === undefined) throw new Error('forged job disappeared');
      await waitFor(
        () => forgedJob.getState(),
        (state) => state === 'failed' || state === 'completed',
      );

      await expect(forgedJob.getState()).resolves.toBe('failed');
      await expect(
        workerQuery<{
          audit_count: string;
          event_count: string;
          inbox_count: string;
          node_count: string;
          revision: number;
        }>(
          `select checkpoint.revision,
             (select count(*)::text from app.run_events event
               where event.workspace_id=checkpoint.workspace_id
                 and event.workflow_run_id=checkpoint.workflow_run_id) event_count,
             (select count(*)::text from app.node_runs node
               where node.workspace_id=checkpoint.workspace_id
                 and node.workflow_run_id=checkpoint.workflow_run_id) node_count,
             (select count(*)::text from app.inbox_receipts receipt
               where receipt.workspace_id=checkpoint.workspace_id
                 and receipt.message_id=$3) inbox_count,
             (select count(*)::text from app.transport_security_audit_facts fact
               where fact.workspace_id=checkpoint.workspace_id
                 and fact.message_id=$3) audit_count
           from app.run_checkpoints checkpoint
           where checkpoint.workspace_id=$1
             and checkpoint.workflow_run_id=$2`,
          [workspaceId, target.runId, authoritative.outboxEventId],
        ),
      ).resolves.toEqual([
        {
          audit_count: '1',
          event_count: '1',
          inbox_count: '0',
          node_count: '0',
          revision: 0,
        },
      ]);
    } finally {
      await Promise.allSettled([
        producer.close(),
        runtime.close(),
        queue.close(),
      ]);
    }
  });
});
