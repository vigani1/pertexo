import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  parseArtifactStoreConfig,
  parseDualRegionArtifactStoreConfig,
} from '../src/config.js';
import { createDualRegionArtifactStore } from '../src/dual-region-artifact-store.js';
import { createArtifactStore } from '../src/store.js';

const integrationDescribe =
  process.env.ARTIFACT_STORE_INTEGRATION === 'true' ? describe : describe.skip;

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

integrationDescribe('ArtifactStore S3 integration', () => {
  it('persists, verifies, streams, isolates, and deletes an artifact', async () => {
    const config = parseArtifactStoreConfig(process.env);
    const store = createArtifactStore(config);
    const body = Buffer.from('real S3-compatible artifact fixture');
    const identity = {
      artifactId: randomUUID(),
      workspaceId: randomUUID(),
    };
    const metadata = {
      ...identity,
      byteLength: body.byteLength,
      mediaType: 'text/plain; charset=utf-8',
      sha256: createHash('sha256').update(body).digest('hex'),
    };

    try {
      await expect(store.checkReadiness()).resolves.toEqual({
        bucket: config.bucket,
        region: config.region,
      });
      await expect(
        store.put({ ...metadata, body: Readable.from([body]) }),
      ).resolves.toEqual(metadata);
      await expect(store.head(identity)).resolves.toEqual(metadata);
      await expect(
        store.head({ ...identity, workspaceId: randomUUID() }),
      ).resolves.toBeNull();

      const download = await store.getStream(identity);
      await expect(readAll(download.body)).resolves.toEqual(body);

      await store.delete(identity);
      await store.delete(identity);
      await expect(store.head(identity)).resolves.toBeNull();
    } finally {
      await store.delete(identity).catch(() => undefined);
      store.close();
    }
  });

  it('commits tenant bytes only after both regional stores validate', async () => {
    const config = parseDualRegionArtifactStoreConfig(process.env);
    const store = createDualRegionArtifactStore(
      config.primary,
      config.recovery,
    );
    const body = Buffer.from('dual-region artifact fixture');
    const metadata = {
      artifactId: randomUUID(),
      byteLength: body.byteLength,
      mediaType: 'application/octet-stream',
      sha256: createHash('sha256').update(body).digest('hex'),
      workspaceId: randomUUID(),
    };

    try {
      await expect(
        store.put({ ...metadata, body: Readable.from([body]) }),
      ).resolves.toEqual(metadata);
      await expect(store.verifyReplicas(metadata)).resolves.toEqual(metadata);
      const download = await store.getStream(metadata);
      await expect(readAll(download.body)).resolves.toEqual(body);
    } finally {
      await store.delete(metadata).catch(() => undefined);
      store.close();
    }
  });

  it('presigns a direct PUT and validates its bytes before finalization', async () => {
    const config = parseArtifactStoreConfig(process.env);
    const store = createArtifactStore(config);
    const body = Buffer.from('direct signed upload fixture');
    const metadata = {
      artifactId: randomUUID(),
      byteLength: body.byteLength,
      mediaType: 'application/octet-stream',
      sha256: createHash('sha256').update(body).digest('hex'),
      workspaceId: randomUUID(),
    };

    try {
      const upload = await store.beginDirectUpload({
        ...metadata,
        expiresInSeconds: 300,
      });
      expect(
        new URL(upload.url).searchParams.get('X-Amz-SignedHeaders')?.split(';'),
      ).toEqual([
        'content-length',
        'content-type',
        'host',
        'if-none-match',
        'x-amz-checksum-sha256',
        'x-amz-meta-artifact-id',
        'x-amz-meta-byte-length',
        'x-amz-meta-media-type',
        'x-amz-meta-sha256',
        'x-amz-meta-workspace-id',
      ]);
      const response = await fetch(upload.url, {
        body,
        headers: upload.headers,
        method: upload.method,
      });
      expect(response.ok).toBe(true);
      const duplicate = await fetch(upload.url, {
        body,
        headers: upload.headers,
        method: upload.method,
      });
      expect(duplicate.status).toBe(412);

      await expect(store.validateDirectUpload(metadata)).resolves.toEqual(
        metadata,
      );
      await expect(
        store.validateDirectUpload({ ...metadata, sha256: '0'.repeat(64) }),
      ).rejects.toBeDefined();

      const download = await store.beginDirectDownload({
        artifactId: metadata.artifactId,
        expiresInSeconds: 300,
        workspaceId: metadata.workspaceId,
      });
      expect(
        new URL(download.url).searchParams.get('response-content-disposition'),
      ).toBe('attachment');
      const downloadResponse = await fetch(download.url, {
        method: download.method,
      });
      expect(downloadResponse.ok).toBe(true);
      expect(Buffer.from(await downloadResponse.arrayBuffer())).toEqual(body);
    } finally {
      await store.delete(metadata).catch(() => undefined);
      store.close();
    }
  });
});
