import { createHash, randomUUID } from 'node:crypto';

import {
  ArtifactIntegrityError,
  createArtifactStore,
  createDualRegionArtifactStore,
  parseArtifactStoreConfig,
  parseDualRegionArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  artifactStorageKey,
  artifacts as artifactsTable,
  claimDueUnfinalizedArtifact,
  completeArtifactRemoval,
  createPendingArtifact,
  createWorkspaceDatabase,
  finalizeArtifactUpload,
  migrateDatabase,
  parseDatabaseConfig,
  parseMigrationConfig,
} from '@pertexo/database/testing';
import type { TransportMetrics } from '@pertexo/observability/transport-metrics';
import type { NodeArtifactReference } from '@pertexo/node-sdk/server';
import {
  createQueueConsumer,
  createQueueProducer,
  jobIdForOutboxEvent,
  JOB_NAME,
  QUEUE_NAME,
} from '@pertexo/queue';
import type {
  QueueConsumer,
  QueueDelivery,
  QueueJob,
  QueueProducer,
} from '@pertexo/queue';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { observeWorkspaceArtifactCapacity } from '../src/runtime/artifact-metrics.js';
import { createWorkerNodeRuntimeCapabilities } from '../src/execution/node-runtime-capabilities.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';
import { createRedisTestNamespace } from './support/redis-test-namespace.js';
import { runWithCleanup } from './support/test-operation.js';

const integration =
  process.env.ARTIFACT_STORE_INTEGRATION === 'true' &&
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const describeIntegration = integration ? describe : describe.skip;
const redisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@127.0.0.1:6379/0';
const adminDatabaseUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationDatabaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiDatabaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerDatabaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';

function databaseUrl(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function bullConnection(privateRedisUrl: string) {
  const parsed = new URL(privateRedisUrl);
  return {
    db: Number(parsed.pathname.slice(1)),
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password === ''
      ? {}
      : { password: decodeURIComponent(parsed.password) }),
  };
}

function createArtifactDatabaseEnvironment() {
  const databaseName = `pertexo_test_artifact_reference_${randomUUID().replaceAll('-', '')}`;
  const apiConfig = parseDatabaseConfig({
    connectionString: databaseUrl(apiDatabaseUrl, databaseName),
    max: 2,
  });
  const workerConfig = parseDatabaseConfig({
    connectionString: databaseUrl(workerDatabaseUrl, databaseName),
    max: 2,
  });
  let databaseCreated = false;
  let initializePromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    apiConfig,
    workerConfig,
    initialize(): Promise<void> {
      initializePromise ??= (async () => {
        const admin = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
        let setupError: unknown;
        try {
          await admin.query(
            `create database ${quoteIdentifier(databaseName)} owner ${quoteIdentifier(process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner')}`,
          );
          databaseCreated = true;
          await admin.query(
            `revoke all on database ${quoteIdentifier(databaseName)} from public`,
          );
          await admin.query(
            `grant connect on database ${quoteIdentifier(databaseName)} to ${[
              process.env.POSTGRES_MIGRATION_USER ?? 'pertexo_migration',
              process.env.POSTGRES_API_RUNTIME_USER ?? 'pertexo_api',
              process.env.POSTGRES_WORKER_RUNTIME_USER ?? 'pertexo_worker',
              process.env.POSTGRES_DISPATCHER_RUNTIME_USER ??
                'pertexo_dispatcher',
              process.env.POSTGRES_MAINTENANCE_USER ?? 'pertexo_maintenance',
            ]
              .map(quoteIdentifier)
              .join(',')}`,
          );
        } catch (error: unknown) {
          setupError = error;
        }
        await admin.end().catch((error: unknown) => {
          setupError =
            setupError === undefined
              ? error
              : new AggregateError(
                  [setupError, error],
                  'Artifact reference database setup failed',
                );
        });
        if (setupError !== undefined)
          throw setupError instanceof Error
            ? setupError
            : new Error('Artifact reference database setup failed', {
                cause: setupError,
              });
        await migrateDatabase(
          parseMigrationConfig({
            ...process.env,
            DATABASE_MIGRATION_URL: databaseUrl(
              migrationDatabaseUrl,
              databaseName,
            ),
            NODE_ENV: 'test',
          }),
        );
      })();
      return initializePromise;
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        if (!databaseCreated) return;
        const admin = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
        const errors: unknown[] = [];
        await dropDisconnectedDatabase(admin, databaseName).catch(
          (error: unknown) => errors.push(error),
        );
        await admin.end().catch((error: unknown) => errors.push(error));
        if (errors.length > 0)
          throw new AggregateError(
            errors,
            'Artifact reference database cleanup failed',
          );
        databaseCreated = false;
      })();
      return closePromise;
    },
  });
}

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function sha256Base64(body: Buffer): string {
  return createHash('sha256').update(body).digest('base64');
}

async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Artifact reference proof timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    clearTimeout(timeout);
  }
}

describeIntegration('Phase 0D artifact reference delivery proof', () => {
  it('finalizes a direct upload before delivering only its identifiers', async () => {
    const databaseEnvironment = createArtifactDatabaseEnvironment();
    const redisNamespace = createRedisTestNamespace(
      redisUrl,
      9,
      'artifact-reference',
    );
    const body = Buffer.from('phase-0d finalized artifact');
    const corruptedBody = Buffer.from(body);
    corruptedBody[0] = corruptedBody[0] === 0x50 ? 0x51 : 0x50;
    const metadata = {
      artifactId: randomUUID(),
      byteLength: body.byteLength,
      mediaType: 'application/octet-stream',
      sha256: sha256Hex(body),
      workspaceId: randomUUID(),
    };
    const corruptMetadata = {
      ...metadata,
      artifactId: randomUUID(),
    };
    const expiredMetadata = {
      ...metadata,
      artifactId: randomUUID(),
    };
    const expiresAt = new Date(Date.now() + 300_000);
    const outboxEventId = randomUUID();
    let store: ReturnType<typeof createArtifactStore> | undefined;
    let database: ReturnType<typeof createWorkspaceDatabase> | undefined;
    let inspectionQueue: Queue | undefined;
    let consumer: QueueConsumer | undefined;
    let producer: QueueProducer | undefined;
    let corruptObjectWritten = false;
    let availableObjectWritten = false;
    let expiredObjectWritten = false;

    await runWithCleanup(
      async () => {
        await databaseEnvironment.initialize();
        await redisNamespace.acquire();
        store = createArtifactStore(parseArtifactStoreConfig(process.env));
        database = createWorkspaceDatabase(databaseEnvironment.apiConfig);
        inspectionQueue = new Queue(QUEUE_NAME.maintenance, {
          connection: bullConnection(redisNamespace.redisUrl),
        });
        await inspectionQueue.obliterate({ force: true });

        await database.withWorkspace(
          metadata.workspaceId,
          async (transaction) => {
            await createPendingArtifact(transaction, {
              ...metadata,
              expiresAt,
              purpose: 'workflow-input',
              storageKey: artifactStorageKey(
                metadata.workspaceId,
                metadata.artifactId,
              ),
            });
            await createPendingArtifact(transaction, {
              ...corruptMetadata,
              expiresAt,
              purpose: 'workflow-input',
              storageKey: artifactStorageKey(
                corruptMetadata.workspaceId,
                corruptMetadata.artifactId,
              ),
            });
            await createPendingArtifact(transaction, {
              ...expiredMetadata,
              expiresAt: new Date(Date.now() - 1_000),
              purpose: 'workflow-input',
              storageKey: artifactStorageKey(
                expiredMetadata.workspaceId,
                expiredMetadata.artifactId,
              ),
            });
          },
        );

        const corruptUpload = await store.beginDirectUpload({
          ...corruptMetadata,
          expiresInSeconds: 300,
        });
        const corruptResponse = await fetch(corruptUpload.url, {
          body: corruptedBody,
          headers: {
            ...corruptUpload.headers,
            // S3Mock intentionally does not validate signatures. Replacing this
            // signed header lets the fixture persist corrupt bytes so finalize's
            // provider-checksum validation is exercised. Real S3 rejects the
            // modified signed request before storing it.
            'x-amz-checksum-sha256': sha256Base64(corruptedBody),
          },
          method: corruptUpload.method,
          signal: AbortSignal.timeout(5_000),
        });
        await corruptResponse.arrayBuffer();
        corruptObjectWritten = corruptResponse.ok;
        expect(corruptResponse.ok).toBe(true);
        await expect(
          store.validateDirectUpload(corruptMetadata),
        ).rejects.toBeInstanceOf(ArtifactIntegrityError);
        await expect(
          database.withWorkspace(metadata.workspaceId, ({ db }) =>
            db
              .select({ status: artifactsTable.status })
              .from(artifactsTable)
              .where(eq(artifactsTable.id, corruptMetadata.artifactId)),
          ),
        ).resolves.toEqual([{ status: 'pending' }]);

        const upload = await store.beginDirectUpload({
          ...metadata,
          expiresInSeconds: 300,
        });
        const uploadResponse = await fetch(upload.url, {
          body,
          headers: upload.headers,
          method: upload.method,
          signal: AbortSignal.timeout(5_000),
        });
        await uploadResponse.arrayBuffer();
        availableObjectWritten = uploadResponse.ok;
        expect(uploadResponse.ok).toBe(true);
        const validated = await store.validateDirectUpload(metadata);
        const finalized = await database.withWorkspace(
          metadata.workspaceId,
          (transaction) =>
            finalizeArtifactUpload(transaction, {
              ...validated,
              storageKey: artifactStorageKey(
                validated.workspaceId,
                validated.artifactId,
              ),
            }),
        );
        expect(finalized.status).toBe('available');

        const expiredUpload = await store.beginDirectUpload({
          ...expiredMetadata,
          expiresInSeconds: 300,
        });
        const expiredUploadResponse = await fetch(expiredUpload.url, {
          body,
          headers: expiredUpload.headers,
          method: expiredUpload.method,
          signal: AbortSignal.timeout(5_000),
        });
        await expiredUploadResponse.arrayBuffer();
        expiredObjectWritten = expiredUploadResponse.ok;
        expect(expiredUploadResponse.ok).toBe(true);
        const claimedForRemoval = await database.withWorkspace(
          expiredMetadata.workspaceId,
          (transaction) =>
            claimDueUnfinalizedArtifact(transaction, {
              artifactId: expiredMetadata.artifactId,
            }),
        );
        expect(claimedForRemoval.id).toBe(expiredMetadata.artifactId);
        await store.delete(expiredMetadata);
        const removed = await database.withWorkspace(
          expiredMetadata.workspaceId,
          (transaction) =>
            completeArtifactRemoval(transaction, {
              artifactId: expiredMetadata.artifactId,
            }),
        );
        expect(removed.status).toBe('deleted');
        await expect(store.head(expiredMetadata)).resolves.toBeNull();

        const observeArtifacts = vi.fn<TransportMetrics['observeArtifacts']>();
        const metrics = {
          addActiveConcurrency: vi.fn(),
          observeArtifacts,
          observeExecutionStorage: vi.fn(),
          observeOutbox: vi.fn(),
          observeQueue: vi.fn(),
          recordConsumerLifecycle: vi.fn(),
          recordHandlerFinished: vi.fn(),
          recordOutboxClaim: vi.fn(),
          recordOutboxDispatchLatency: vi.fn(),
          recordOutboxLeaseEvent: vi.fn(),
          recordOutboxPublish: vi.fn(),
          recordQueueStall: vi.fn(),
          recordWorkerProcessStart: vi.fn(),
        } satisfies TransportMetrics;
        await expect(
          observeWorkspaceArtifactCapacity(
            database,
            metrics,
            metadata.workspaceId,
          ),
        ).resolves.toEqual([
          { bytes: body.byteLength, count: 1, status: 'available' },
          { bytes: body.byteLength, count: 1, status: 'deleted' },
          { bytes: 0, count: 0, status: 'deleting' },
          { bytes: body.byteLength, count: 1, status: 'pending' },
        ]);
        expect(observeArtifacts.mock.calls.map(([value]) => value)).toEqual([
          { bytes: body.byteLength, count: 1, status: 'available' },
          { bytes: body.byteLength, count: 1, status: 'deleted' },
          { bytes: 0, count: 0, status: 'deleting' },
          { bytes: body.byteLength, count: 1, status: 'pending' },
        ]);

        let resolveDelivery: ((delivery: QueueDelivery) => void) | undefined;
        const delivered = new Promise<QueueDelivery>((resolve) => {
          resolveDelivery = resolve;
        });
        consumer = createQueueConsumer({
          handler: (delivery) => {
            if (
              delivery.name === JOB_NAME.expireArtifacts &&
              delivery.data.artifactId === metadata.artifactId
            ) {
              resolveDelivery?.(delivery);
            }
            return Promise.resolve();
          },
          queueName: QUEUE_NAME.maintenance,
          redisUrl: redisNamespace.redisUrl,
        });
        producer = createQueueProducer({ redisUrl: redisNamespace.redisUrl });
        await Promise.all([
          consumer.waitUntilReady(5_000),
          producer.waitUntilReady(5_000),
        ]);

        for (const [field, value] of [
          ['bytes', body.toString('base64')],
          ['graph', { nodes: [] }],
          ['secret', 'must-never-enter-redis'],
        ] as const) {
          const invalidOutboxEventId = randomUUID();
          const invalidJob = {
            name: JOB_NAME.expireArtifacts,
            data: {
              artifactId: metadata.artifactId,
              [field]: value,
              outboxEventId: invalidOutboxEventId,
              schemaVersion: 1,
              workspaceId: metadata.workspaceId,
            },
          } as unknown as QueueJob;
          await expect(producer.publish(invalidJob)).rejects.toMatchObject({
            name: 'ZodError',
          });
          await expect(
            inspectionQueue.getJob(jobIdForOutboxEvent(invalidOutboxEventId)),
          ).resolves.toBeUndefined();
        }

        const referenceJob = {
          name: JOB_NAME.expireArtifacts,
          data: {
            artifactId: metadata.artifactId,
            outboxEventId,
            schemaVersion: 1,
            workspaceId: metadata.workspaceId,
          },
        } as const satisfies QueueJob;
        await producer.publish(referenceJob);
        const delivery = await bounded(delivered, 5_000);

        expect(delivery.data).toEqual(referenceJob.data);
        expect(Object.keys(delivery.data).toSorted()).toEqual([
          'artifactId',
          'outboxEventId',
          'schemaVersion',
          'workspaceId',
        ]);
        const serialized = JSON.stringify(delivery);
        for (const forbidden of [
          body.toString('base64'),
          metadata.mediaType,
          metadata.sha256,
          upload.url,
          'graph',
          'must-never-enter-redis',
        ]) {
          expect(serialized).not.toContain(forbidden);
        }
      },
      async () => {
        const errors: unknown[] = [];
        const attempt = async (operation: () => unknown): Promise<void> => {
          await Promise.resolve()
            .then(operation)
            .catch((error: unknown) => errors.push(error));
        };
        await attempt(() => producer?.close());
        await attempt(() => consumer?.close());
        await attempt(() => inspectionQueue?.obliterate({ force: true }));
        await attempt(() => inspectionQueue?.close());
        if (availableObjectWritten)
          await attempt(() => store?.delete(metadata));
        if (corruptObjectWritten)
          await attempt(() => store?.delete(corruptMetadata));
        if (expiredObjectWritten)
          await attempt(() => store?.delete(expiredMetadata));
        await attempt(() => store?.close());
        await attempt(() => database?.close());
        await attempt(() => redisNamespace.close());
        await attempt(() => databaseEnvironment.close());
        if (errors.length > 0)
          throw new AggregateError(
            errors,
            'Artifact reference delivery cleanup failed',
          );
      },
      'Artifact reference delivery',
    );
  });
});

describeIntegration('Phase 4 worker artifact output capability', () => {
  it('streams a bounded node response through worker metadata and object-store adapters', async () => {
    const databaseEnvironment = createArtifactDatabaseEnvironment();
    const artifactConfig = parseDualRegionArtifactStoreConfig(process.env);
    const workspaceId = randomUUID();
    const context = {
      workspaceId,
      runId: randomUUID(),
      nodeRunId: randomUUID(),
      attemptId: randomUUID(),
      attemptNumber: 1,
      nodeId: 'http-node',
      invocationKey: 'http-invocation',
      workerId: 'worker-artifact-integration',
    } as const;
    const first = Buffer.alloc(40_000, 7);
    const second = Buffer.alloc(30_000, 9);
    let runtime:
      | Awaited<ReturnType<typeof createWorkerNodeRuntimeCapabilities>>
      | undefined;
    let verifier: ReturnType<typeof createDualRegionArtifactStore> | undefined;
    let database: ReturnType<typeof createWorkspaceDatabase> | undefined;
    let reference: NodeArtifactReference | undefined;
    await runWithCleanup(
      async () => {
        await databaseEnvironment.initialize();
        runtime = await createWorkerNodeRuntimeCapabilities({
          database: databaseEnvironment.workerConfig,
          artifactStore: artifactConfig,
        });
        verifier = createDualRegionArtifactStore(
          artifactConfig.primary,
          artifactConfig.recovery,
        );
        database = createWorkspaceDatabase(databaseEnvironment.apiConfig);
        const artifacts = runtime.factories.artifacts?.(context);
        if (artifacts === undefined)
          throw new Error('artifact capability missing');
        const writtenReference = await artifacts.write({
          body: (async function* (): AsyncGenerator<Uint8Array> {
            await Promise.resolve();
            yield first;
            yield second;
          })(),
          maxBytes: 70_000,
          mediaType: 'application/octet-stream',
          purpose: 'node-output',
          signal: new AbortController().signal,
        });
        reference = writtenReference;
        expect(writtenReference.byteLength).toBe(70_000);
        expect(writtenReference.sha256).toBe(
          createHash('sha256')
            .update(Buffer.alloc(40_000, 7))
            .update(Buffer.alloc(30_000, 9))
            .digest('hex'),
        );
        const rows = await database.withWorkspace(workspaceId, ({ db }) =>
          db
            .select({ status: artifactsTable.status })
            .from(artifactsTable)
            .where(eq(artifactsTable.id, writtenReference.artifactId)),
        );
        expect(rows).toEqual([{ status: 'available' }]);
        const download = await verifier.getStream({
          artifactId: writtenReference.artifactId,
          workspaceId,
        });
        const downloaded: Buffer[] = [];
        for await (const chunk of download.body) {
          const value: unknown = chunk;
          if (!(value instanceof Uint8Array))
            throw new TypeError('artifact download chunk is not bytes');
          downloaded.push(Buffer.from(value));
        }
        expect(Buffer.concat(downloaded)).toEqual(
          Buffer.concat([Buffer.alloc(40_000, 7), Buffer.alloc(30_000, 9)]),
        );
        expect(first.every((byte) => byte === 0)).toBe(true);
        expect(second.every((byte) => byte === 0)).toBe(true);
      },
      async () => {
        const errors: unknown[] = [];
        const attempt = async (operation: () => unknown): Promise<void> => {
          await Promise.resolve()
            .then(operation)
            .catch((error: unknown) => errors.push(error));
        };
        const ownedReference = reference;
        if (ownedReference !== undefined)
          await attempt(() =>
            verifier?.delete({
              artifactId: ownedReference.artifactId,
              workspaceId,
            }),
          );
        await attempt(() => verifier?.close());
        await attempt(() => runtime?.close());
        await attempt(() => database?.close());
        await attempt(() => databaseEnvironment.close());
        if (errors.length > 0)
          throw new AggregateError(
            errors,
            'Worker artifact output cleanup failed',
          );
      },
      'Worker artifact output',
    );
  });
});
