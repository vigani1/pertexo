import { createHash, randomUUID } from 'node:crypto';

import {
  ArtifactIntegrityError,
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';
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
import { describe, expect, it } from 'vitest';

const integration =
  process.env.ARTIFACT_STORE_INTEGRATION === 'true' &&
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const describeIntegration = integration ? describe : describe.skip;
const redisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@127.0.0.1:6379/0';

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
    const outboxEventId = randomUUID();
    let consumer: QueueConsumer | undefined;
    let producer: QueueProducer | undefined;

    try {
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
      await expect(store.validateDirectUpload(metadata)).resolves.toEqual(
        metadata,
      );

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
      store.close();
    }
  });
});
