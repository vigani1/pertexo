import { randomUUID } from 'node:crypto';
import { lockManualFixtureClient } from './manual-start.fixture.js';

import {
  migrateDatabase,
  parseDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database/testing';
import { PLATFORM_REGISTRY_RELEASE } from '@pertexo/node-catalog';
import { QUEUE_NAME } from '@pertexo/queue';
import {
  buildWorkflowExecutable,
  composeExecutableCompatibilityRelease,
} from '@pertexo/workflow-engine';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import {
  AuthoringValidationUnavailableError,
  WorkflowAuthoringValidator,
} from '@pertexo/workflow-model/server';
import { Queue } from 'bullmq';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

import { dropDisconnectedDatabase } from './disposable-database.js';
import { createRedisTestNamespace } from './redis-test-namespace.js';

function scheduleAuthoringOptions(
  validator: Pick<WorkflowAuthoringValidator, 'validate'>,
) {
  const nodeRelease = PLATFORM_REGISTRY_RELEASE;
  const release = composeExecutableCompatibilityRelease(nodeRelease);
  const authoringPolicies = {
    releaseFingerprint: release.fingerprint,
    definitions: nodeRelease.definitions.map((manifest) => ({
      definition: {
        key: manifest.definition.key,
        version: manifest.definition.version,
      },
      policyReferences: manifest.policyReferences.map(({ key, version }) => ({
        key,
        version,
      })),
    })),
  };
  const catalog = (placement: boolean) =>
    Object.freeze({
      schemaVersion: 1 as const,
      releaseFingerprint: release.fingerprint,
      definitions: Object.freeze(
        nodeRelease.definitions
          .filter(
            (manifest) =>
              (manifest.lifecycle === 'active' ||
                (!placement && manifest.lifecycle === 'deprecated')) &&
              nodeRelease.executors.some(
                (executor) =>
                  executor.lifecycle === 'active' &&
                  executor.executor.key === manifest.executor.key &&
                  executor.executor.version === manifest.executor.version,
              ),
          )
          .map(({ definition, integration, connectionRequirements }) =>
            Object.freeze({
              ...definition,
              ...(integration === undefined
                ? {}
                : {
                    integration: Object.freeze({
                      ...integration,
                      connectionSlots: Object.freeze([
                        ...connectionRequirements,
                      ]),
                    }),
                  }),
            }),
          ),
      ),
    });
  const definitionCatalog = catalog(false);
  return Object.freeze({
    definitionCatalog,
    databaseOptions: Object.freeze({
      definitionCatalog,
      placementDefinitionCatalog: catalog(true),
      validateAuthoringGraph: (
        graph: WorkflowGraph,
        command: Readonly<{ signal?: AbortSignal }>,
      ) => validator.validate(graph, authoringPolicies, command),
      executableCompiler: (
        graph: Parameters<typeof buildWorkflowExecutable>[0]['graph'],
      ) => {
        const compiled = buildWorkflowExecutable({ graph, release });
        return {
          checksum: compiled.checksum,
          executableSchemaVersion: 2 as const,
          executableJson: compiled.envelope,
        };
      },
    }),
  });
}

export interface ScheduleTriggerFixture {
  readonly actorId: string;
  readonly apiConfig: DatabaseConfig;
  readonly authoringOptions: ReturnType<typeof scheduleAuthoringOptions>;
  readonly close: () => Promise<void>;
  readonly dispatcherConfig: DatabaseConfig;
  readonly ownerQuery: <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters?: unknown[],
  ) => Promise<QueryResult<Row>>;
  readonly ownerQueryIn: <Row extends QueryResultRow = QueryResultRow>(
    workspaceId: string,
    statement: string,
    parameters?: unknown[],
  ) => Promise<QueryResult<Row>>;
  readonly queue: Queue;
  readonly redisUrl: string;
  readonly setup: () => Promise<void>;
  readonly workerConfig: DatabaseConfig;
  readonly workerQuery: <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters?: unknown[],
  ) => Promise<QueryResult<Row>>;
  readonly apiQuery: <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters?: unknown[],
    manualStart?: Readonly<{ workflowId: string; keyHash: string }>,
  ) => Promise<QueryResult<Row>>;
  readonly workspaceId: string;
}

export function createScheduleTriggerFixture(
  environment: NodeJS.ProcessEnv = process.env,
): ScheduleTriggerFixture {
  const adminUrl =
    environment.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const migrationBaseUrl =
    environment.DATABASE_MIGRATION_URL ??
    'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
  const apiBaseUrl =
    environment.DATABASE_URL ??
    'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
  const workerBaseUrl =
    environment.DATABASE_URL ??
    'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
  const dispatcherBaseUrl =
    environment.DATABASE_MAINTENANCE_URL ??
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
  const configuredRedisUrl =
    environment.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
  const runnerOwnsDatabase =
    environment.PERTEXO_Q11_RUNNER_OWNS_DATABASE === '1';
  const databaseName = runnerOwnsDatabase
    ? environment.PERTEXO_Q11_DATABASE_NAME
    : `pertexo_test_worker_schedule_${randomUUID().replaceAll('-', '')}`;
  if (
    databaseName === undefined ||
    !/^pertexo_test_(?:q11|worker_schedule)_[a-z0-9_]+$/u.test(databaseName)
  )
    throw new Error('Schedule fixture database name is invalid');
  const databaseUrl = (base: string): string => {
    const parsed = new URL(base);
    parsed.pathname = `/${databaseName}`;
    return parsed.toString();
  };
  const databaseConfig = (base: string, max: number): DatabaseConfig =>
    parseDatabaseConfig({ connectionString: databaseUrl(base), max });
  const apiConfig = databaseConfig(apiBaseUrl, 8);
  const workerConfig = databaseConfig(workerBaseUrl, 8);
  const dispatcherConfig = databaseConfig(dispatcherBaseUrl, 2);
  const actorId = randomUUID();
  const workspaceId = randomUUID();
  const redisNamespace = createRedisTestNamespace(
    configuredRedisUrl,
    13,
    'schedule-trigger',
  );
  const redisUrl = redisNamespace.redisUrl;
  const parsedRedis = new URL(redisUrl);
  const bullConnection = Object.freeze({
    db: Number(parsedRedis.pathname.slice(1)),
    host: parsedRedis.hostname,
    port: Number(parsedRedis.port || 6379),
    ...(parsedRedis.password === ''
      ? {}
      : { password: decodeURIComponent(parsedRedis.password) }),
  });
  let authoringValidator: WorkflowAuthoringValidator | undefined;
  let admissionClosed = false;
  const authoringOptions = scheduleAuthoringOptions({
    validate: (...args) => {
      if (admissionClosed)
        throw new AuthoringValidationUnavailableError('closed');
      authoringValidator ??= new WorkflowAuthoringValidator();
      return authoringValidator.validate(...args);
    },
  });

  let owner: Pool | undefined;
  let apiEvidence: Pool | undefined;
  let workerEvidence: Pool | undefined;
  let queue: Queue | undefined;
  let databaseCreated = false;
  let redisNamespaceAcquired = false;
  let closePromise: Promise<void> | undefined;

  const requireOwner = (): Pool => {
    if (owner === undefined)
      throw new Error('Schedule owner pool is not initialized');
    return owner;
  };
  const requireApiEvidence = (): Pool => {
    if (apiEvidence === undefined)
      throw new Error('Schedule API evidence pool is not initialized');
    return apiEvidence;
  };
  const requireWorkerEvidence = (): Pool => {
    if (workerEvidence === undefined)
      throw new Error('Schedule worker evidence pool is not initialized');
    return workerEvidence;
  };
  const queryIn = async <Row extends QueryResultRow>(
    pool: Pool,
    scopedWorkspaceId: string,
    statement: string,
    parameters: unknown[] = [],
    ownerRole = false,
    manualStart?: Readonly<{ workflowId: string; keyHash: string }>,
  ): Promise<QueryResult<Row>> => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      if (ownerRole) await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id',$1,true)", [
        scopedWorkspaceId,
      ]);
      if (manualStart !== undefined)
        await lockManualFixtureClient(
          client,
          actorId,
          manualStart.workflowId,
          manualStart.keyHash,
        );
      const result = await client.query<Row>(statement, parameters);
      await client.query('commit');
      return result;
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  const ownerQueryIn = <Row extends QueryResultRow = QueryResultRow>(
    scopedWorkspaceId: string,
    statement: string,
    parameters: unknown[] = [],
  ) =>
    queryIn<Row>(
      requireOwner(),
      scopedWorkspaceId,
      statement,
      parameters,
      true,
    );
  const ownerQuery = <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters: unknown[] = [],
  ) => ownerQueryIn<Row>(workspaceId, statement, parameters);
  const workerQuery = <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters: unknown[] = [],
  ) =>
    queryIn<Row>(requireWorkerEvidence(), workspaceId, statement, parameters);
  const apiQuery = <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters: unknown[] = [],
    manualStart?: Readonly<{ workflowId: string; keyHash: string }>,
  ) =>
    queryIn<Row>(
      requireApiEvidence(),
      workspaceId,
      statement,
      parameters,
      false,
      manualStart,
    );

  const dropDatabase = async (): Promise<void> => {
    if (!databaseCreated || runnerOwnsDatabase) return;
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await dropDisconnectedDatabase(admin, databaseName);
      databaseCreated = false;
    } finally {
      await admin.end();
    }
  };

  const close = (): Promise<void> => {
    admissionClosed = true;
    closePromise ??= (async () => {
      const errors: unknown[] = [];
      const attempt = async (
        label: string,
        operation: () => void | Promise<void>,
      ) => {
        await Promise.resolve()
          .then(operation)
          .catch((cause: unknown) => {
            errors.push(
              new Error(`Schedule fixture cleanup failed: ${label}`, {
                cause,
              }),
            );
          });
      };
      await attempt('close authoring validator', () =>
        authoringValidator?.shutdown(),
      );
      if (queue !== undefined) {
        await attempt('obliterate trigger queue', () =>
          queue?.obliterate({ force: true }),
        );
        await attempt('close trigger queue', () => queue?.close());
        queue = undefined;
      }
      if (owner !== undefined) {
        await attempt('close owner pool', () => owner?.end());
        owner = undefined;
      }
      if (apiEvidence !== undefined) {
        await attempt('close API evidence pool', () => apiEvidence?.end());
        apiEvidence = undefined;
      }
      if (workerEvidence !== undefined) {
        await attempt('close worker evidence pool', () =>
          workerEvidence?.end(),
        );
        workerEvidence = undefined;
      }
      if (redisNamespaceAcquired) {
        await attempt('release Redis namespace', () => redisNamespace.close());
        redisNamespaceAcquired = false;
      }
      await attempt('drop disposable database', dropDatabase);
      if (errors.length > 0)
        throw new AggregateError(errors, 'Schedule fixture cleanup failed');
    })();
    return closePromise;
  };

  const setup = async (): Promise<void> => {
    try {
      if (!runnerOwnsDatabase) {
        const admin = new Pool({ connectionString: adminUrl, max: 1 });
        try {
          await admin.query(
            `create database "${databaseName}" owner pertexo_owner`,
          );
          databaseCreated = true;
          await admin.query(
            `revoke all on database "${databaseName}" from public`,
          );
          await admin.query(
            `grant connect on database "${databaseName}" to pertexo_migration,pertexo_app,pertexo_app,pertexo_maintenance`,
          );
        } finally {
          await admin.end();
        }
      }
      await redisNamespace.acquire();
      redisNamespaceAcquired = true;
      owner = new Pool({
        connectionString: databaseUrl(migrationBaseUrl),
        max: 2,
      });
      apiEvidence = new Pool({
        connectionString: databaseUrl(apiBaseUrl),
        max: 1,
      });
      workerEvidence = new Pool({
        connectionString: databaseUrl(workerBaseUrl),
        max: 1,
      });
      queue = new Queue(QUEUE_NAME.triggerLifecycle, {
        connection: bullConnection,
      });
      await migrateDatabase({
        connectionString: databaseUrl(migrationBaseUrl),
        ownerRole: 'pertexo_owner',
        appRole: 'pertexo_app',
        maintenanceRole: 'pertexo_maintenance',
      });
      await queue.obliterate({ force: true });
    } catch (setupError: unknown) {
      let cleanupError: unknown;
      await close().catch((error: unknown) => {
        cleanupError = error;
      });
      if (cleanupError === undefined) throw setupError;
      throw new AggregateError(
        [setupError, cleanupError],
        'Schedule fixture setup failed',
      );
    }
  };

  return Object.freeze({
    actorId,
    apiConfig,
    apiQuery,
    authoringOptions,
    close,
    dispatcherConfig,
    ownerQuery,
    ownerQueryIn,
    get queue() {
      if (queue === undefined)
        throw new Error('Schedule queue is not initialized');
      return queue;
    },
    redisUrl,
    setup,
    workerConfig,
    workerQuery,
    workspaceId,
  });
}
