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
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import type { TransportMetrics } from '@pertexo/observability/transport-metrics';
import {
  createQueueConsumer,
  createQueueProducer,
  JOB_NAME,
  QUEUE_NAME,
} from '@pertexo/queue';
import type {
  QueueConsumer,
  QueueDelivery,
  QueueJob,
  QueueProducer,
} from '@pertexo/queue';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { observeWorkspaceArtifactCapacity } from '../src/runtime/artifact-metrics.js';
import { createWorkerNodeRuntimeCapabilities } from '../src/execution/node-runtime-capabilities.js';

const integration =
  process.env.ARTIFACT_STORE_INTEGRATION === 'true' &&
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const describeIntegration = integration ? describe : describe.skip;
const redisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@127.0.0.1:6379/0';
const apiDatabaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerDatabaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';

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
    const store = createArtifactStore(parseArtifactStoreConfig(process.env));
    const database = createWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: apiDatabaseUrl, max: 2 }),
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
    let consumer: QueueConsumer | undefined;
    let producer: QueueProducer | undefined;

    try {
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
      });
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
      });
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
      });
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
        redisUrl,
      });
      producer = createQueueProducer({ redisUrl });
      await Promise.all([
        consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);

      const invalidJob = {
        name: JOB_NAME.expireArtifacts,
        data: {
          artifactId: metadata.artifactId,
          bytes: body.toString('base64'),
          graph: { nodes: [] },
          outboxEventId,
          schemaVersion: 1,
          secret: 'must-never-enter-redis',
          workspaceId: metadata.workspaceId,
        },
      } as unknown as QueueJob;
      await expect(producer.publish(invalidJob)).rejects.toBeDefined();

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
    } finally {
      await producer?.close().catch(() => undefined);
      await consumer?.close().catch(() => undefined);
      await store.delete(metadata).catch(() => undefined);
      await store.delete(corruptMetadata).catch(() => undefined);
      await store.delete(expiredMetadata).catch(() => undefined);
      store.close();
      await database.close();
    }
  });
});

describeIntegration('Phase 4 worker artifact output capability', () => {
  it('streams a bounded node response through worker metadata and object-store adapters', async () => {
    const artifactConfig = parseDualRegionArtifactStoreConfig(process.env);
    const runtime = await createWorkerNodeRuntimeCapabilities({
      database: parseDatabaseConfig({
        connectionString: workerDatabaseUrl,
        max: 2,
      }),
      artifactStore: artifactConfig,
    });
    const verifier = createDualRegionArtifactStore(
      artifactConfig.primary,
      artifactConfig.recovery,
    );
    const database = createWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: apiDatabaseUrl, max: 2 }),
    );
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
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');
    const first = Buffer.alloc(40_000, 7);
    const second = Buffer.alloc(30_000, 9);
    let reference: Awaited<ReturnType<(typeof artifacts)['write']>> | undefined;
    try {
      reference = await artifacts.write({
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
      expect(reference.byteLength).toBe(70_000);
      expect(reference.sha256).toBe(
        createHash('sha256')
          .update(Buffer.alloc(40_000, 7))
          .update(Buffer.alloc(30_000, 9))
          .digest('hex'),
      );
      const rows = await database.withWorkspace(workspaceId, ({ db }) =>
        db
          .select({ status: artifactsTable.status })
          .from(artifactsTable)
          .where(eq(artifactsTable.id, reference?.artifactId ?? 'missing')),
      );
      expect(rows).toEqual([{ status: 'available' }]);
      const download = await verifier.getStream({
        artifactId: reference.artifactId,
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
    } finally {
      if (reference !== undefined)
        await verifier
          .delete({ artifactId: reference.artifactId, workspaceId })
          .catch(() => undefined);
      verifier.close();
      await runtime.close();
      await database.close();
    }
  });
});
