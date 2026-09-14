import { randomUUID } from 'node:crypto';

import {
  migrateDatabase,
  parseDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database/testing';
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
} from '@pertexo/node-catalog';
import { QUEUE_NAME } from '@pertexo/queue';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseHistory,
  createExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';
import { Queue } from 'bullmq';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

import { activateCompatibilityReleaseFixture } from './compatibility-release.fixture.js';
import { dropDisconnectedDatabase } from './disposable-database.js';
import { createRedisTestNamespace } from './redis-test-namespace.js';

const releaseCohort = 'schedule_activation' as const;
type ScheduleRelease = ReturnType<
  typeof platformExecutableRegistryHistory
>[number];

function scheduleAuthoringOptions() {
  const nodeReleases = platformExecutableRegistryHistory(releaseCohort);
  const history = createExecutableCompatibilityReleaseHistory(
    nodeReleases.map(composeExecutableCompatibilityRelease),
  );
  const readiness = createExecutableCompatibilityReleaseSupport(
    platformRegistryReleaseSupport(releaseCohort).map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const variants = nodeReleases.map((nodeRelease) => {
    const release = composeExecutableCompatibilityRelease(nodeRelease);
    const description = history.descriptions.find(
      ({ epoch, fingerprint }) =>
        epoch === release.epoch && fingerprint === release.fingerprint,
    );
    if (description === undefined)
      throw new Error('Schedule compatibility description is missing');
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
    return {
      compatibilityRelease: description,
      definitionCatalog: catalog(false),
      placementDefinitionCatalog: catalog(true),
      executableCompiler: (
        graph: Parameters<typeof buildWorkflowExecutableV2>[0]['graph'],
      ) => {
        const compiled = buildWorkflowExecutableV2({ graph, release });
        return {
          checksum: compiled.checksum,
          executableSchemaVersion: 2 as const,
          executableJson: compiled.envelope,
          compatibilityReleaseEpoch:
            compiled.envelope.compatibilityReleaseEpoch,
          compatibilityReleaseFingerprint:
            compiled.envelope.compatibilityReleaseFingerprint,
        };
      },
    };
  });
  const latest = variants.at(-1);
  if (latest === undefined)
    throw new Error('Schedule release history is empty');
  return Object.freeze({
    definitionCatalog: latest.definitionCatalog,
    databaseOptions: Object.freeze({
      compatibilityReadinessReleases: readiness.descriptions,
      compatibilityReleaseVariants: variants,
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
  readonly releaseCohort: typeof releaseCohort;
  readonly scheduleCompatibility: ReturnType<
    typeof createExecutableCompatibilityReleaseSupport
  >['descriptions'];
  readonly setup: () => Promise<void>;
  readonly workerConfig: DatabaseConfig;
  readonly workerQuery: <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters?: unknown[],
  ) => Promise<QueryResult<Row>>;
  readonly apiQuery: <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters?: unknown[],
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
    environment.DATABASE_API_URL ??
    'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
  const workerBaseUrl =
    environment.DATABASE_WORKER_URL ??
    'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
  const dispatcherBaseUrl =
    environment.DATABASE_DISPATCHER_URL ??
    'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';
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
  const authoringOptions = scheduleAuthoringOptions();
  const scheduleCompatibility = createExecutableCompatibilityReleaseSupport(
    platformRegistryReleaseSupport(releaseCohort).map(
      composeExecutableCompatibilityRelease,
    ),
  ).descriptions;

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
  ): Promise<QueryResult<Row>> => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      if (ownerRole) await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id',$1,true)", [
        scopedWorkspaceId,
      ]);
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
  ) => queryIn<Row>(requireApiEvidence(), workspaceId, statement, parameters);

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

  const activateRelease = async (targetRelease: ScheduleRelease) =>
    activateCompatibilityReleaseFixture({
      actorId: 'schedule-integration',
      apiUrl: databaseUrl(apiBaseUrl),
      artifactPrefix: 'schedule',
      migrationUrl: databaseUrl(migrationBaseUrl),
      reasons: {
        activate: 'Activate direct Schedule integration release',
        approve: 'Approve direct Schedule integration release',
        prepare: 'Prepare direct Schedule integration release',
      },
      readCurrent: async () =>
        (
          await ownerQuery<{
            catalog_json: unknown;
            epoch: number;
            fingerprint: string;
          }>(
            `select current.epoch,current.fingerprint,release.catalog_json
               from app.node_compatibility_current current
               join app.node_compatibility_releases release
                 on release.epoch=current.epoch and release.fingerprint=current.fingerprint`,
          )
        ).rows[0],
      targetRelease,
      workerUrl: databaseUrl(workerBaseUrl),
    });

  const close = (): Promise<void> => {
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
            `grant connect on database "${databaseName}" to pertexo_migration,pertexo_api,pertexo_worker,pertexo_dispatcher`,
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
        apiRuntimeRole: 'pertexo_api',
        workerRuntimeRole: 'pertexo_worker',
        dispatcherRole: 'pertexo_dispatcher',
        maintenanceRole: 'pertexo_maintenance',
        lifecycleCommandRole: 'pertexo_lifecycle_command',
        operatorRole: 'pertexo_operator',
      });
      const releases = platformExecutableRegistryHistory(releaseCohort);
      const current = (
        await ownerQuery<{ epoch: number; fingerprint: string }>(
          `select epoch,fingerprint from app.node_compatibility_current
             where singleton=true`,
        )
      ).rows[0];
      const currentIndex = releases.findIndex((release) => {
        const composed = composeExecutableCompatibilityRelease(release);
        return (
          composed.epoch === current?.epoch &&
          composed.fingerprint === current.fingerprint
        );
      });
      if (currentIndex === -1)
        throw new Error(
          'Current schedule compatibility release is unsupported',
        );
      for (const release of releases.slice(currentIndex + 1))
        await activateRelease(release);
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
    releaseCohort,
    scheduleCompatibility,
    setup,
    workerConfig,
    workerQuery,
    workspaceId,
  });
}
