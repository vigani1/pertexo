import {
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  ObservedS3Client,
  observePresign,
  type ObjectStoreObserver,
  type ObjectStoreRequestObservation,
  type ObjectStoreSafetyObservation,
} from '../src/object-store-telemetry.js';
import { createArtifactDownloadPresigner } from '../src/artifact-download.js';
import { createArtifactStore } from '../src/store.js';
import type { S3ClientLike } from '../src/store.js';

const ARTIFACT_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c02';
const WORKSPACE_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c01';

function recordingObserver() {
  const requests: ObjectStoreRequestObservation[] = [];
  const safety: ObjectStoreSafetyObservation[] = [];
  const observer: ObjectStoreObserver = {
    observeRequest(observation) {
      requests.push(observation);
    },
    observeSafetyViolation(observation) {
      safety.push(observation);
    },
  };
  return { observer, requests, safety };
}

describe('object-store telemetry', () => {
  it('observes the production GET presigner without network I/O', async () => {
    const recording = recordingObserver();
    const client = new S3Client({
      credentials: {
        accessKeyId: 'access',
        secretAccessKey: 'secret',
      },
      endpoint: 'http://localhost:9090',
      forcePathStyle: true,
      region: 'us-east-1',
    });
    try {
      const presign = createArtifactDownloadPresigner(
        client,
        recording.observer,
        'artifact',
      );
      const url = await presign({
        command: new GetObjectCommand({
          Bucket: 'pertexo-artifacts',
          Key: `workspaces/${WORKSPACE_ID}/artifacts/${ARTIFACT_ID}`,
        }),
        expiresInSeconds: 60,
        signal: new AbortController().signal,
      });

      expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('60');
      expect(recording.requests).toEqual([
        expect.objectContaining({
          operation: 'presign_get_object',
          outcome: 'success',
        }),
      ]);
    } finally {
      client.destroy();
    }
  });

  it('records only the bounded request dimensions and classifies failures', async () => {
    const recording = recordingObserver();
    const failure = Object.assign(new Error('private provider detail'), {
      $metadata: { httpStatusCode: 503 },
      name: 'ServiceUnavailable',
    });
    const raw = {
      destroy: vi.fn(),
      send: () => Promise.reject(failure),
    };
    const client = new ObservedS3Client(
      raw,
      recording.observer,
      'control_ledger',
      'recovery',
    );

    await expect(
      client.send(new HeadBucketCommand({ Bucket: 'secret' })),
    ).rejects.toBe(failure);

    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]).toMatchObject({
      errorClass: 'service_error',
      operation: 'head_bucket',
      outcome: 'error',
      regionRole: 'recovery',
      surface: 'control_ledger',
    });
    expect(JSON.stringify(recording.requests)).not.toContain('secret');
    expect(JSON.stringify(recording.requests)).not.toContain(
      'private provider detail',
    );
  });

  it.each([
    [
      Object.assign(new Error('private abort detail'), { name: 'AbortError' }),
      'aborted',
    ],
    [
      Object.assign(new Error('private timeout detail'), {
        name: 'TimeoutError',
      }),
      'timeout',
    ],
  ] as const)(
    'classifies provider %s without leaking its message',
    async (failure, errorClass) => {
      const recording = recordingObserver();
      const client = new ObservedS3Client(
        { destroy: vi.fn(), send: () => Promise.reject(failure) },
        recording.observer,
        'artifact',
        'artifact',
      );

      await expect(
        client.send({ constructor: { name: 'FutureS3Command' } } as never),
      ).rejects.toBe(failure);
      expect(recording.requests).toEqual([
        expect.objectContaining({ operation: 'unknown', errorClass }),
      ]);
      expect(JSON.stringify(recording.requests)).not.toContain(failure.message);
    },
  );

  it('isolates observer failures from requests and safety enforcement', async () => {
    const observer: ObjectStoreObserver = {
      observeRequest() {
        throw new Error('metrics unavailable');
      },
      observeSafetyViolation() {
        throw new Error('metrics unavailable');
      },
    };
    const client: S3ClientLike = {
      destroy: vi.fn(),
      send: () => Promise.resolve({}),
    };
    const store = createArtifactStore(
      {
        accessKeyId: 'access',
        bucket: 'artifacts',
        endpoint: 'http://localhost:9090',
        forcePathStyle: true,
        maxObjectBytes: 4,
        region: 'us-east-1',
        requestTimeoutMs: 100,
        secretAccessKey: 'secret',
      },
      {
        client,
        observer,
        presignPutObject: () => Promise.resolve('https://example.test/signed'),
      },
    );

    await expect(store.checkReadiness()).resolves.toEqual({
      bucket: 'artifacts',
      region: 'us-east-1',
    });
    await expect(
      store.put({
        artifactId: ARTIFACT_ID,
        body: Readable.from(['hello']),
        byteLength: 5,
        mediaType: 'text/plain',
        sha256: '0'.repeat(64),
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow('configured limit');
  });

  it.each(['name', 'metadata', 'prototype', 'revoked'] as const)(
    'contains hostile %s failure classification and preserves exact rejection',
    async (shape) => {
      const target = new Error('private provider detail');
      let failure: unknown;
      if (shape === 'name') {
        Object.defineProperty(target, 'name', {
          get() {
            throw new Error('name trap');
          },
        });
        failure = target;
      } else if (shape === 'metadata') {
        Object.defineProperty(target, '$metadata', {
          get() {
            throw new Error('metadata trap');
          },
        });
        failure = target;
      } else if (shape === 'prototype') {
        failure = new Proxy(target, {
          getPrototypeOf() {
            throw new Error('prototype trap');
          },
        });
      } else {
        const revocable = Proxy.revocable(target, {});
        revocable.revoke();
        failure = revocable.proxy;
      }
      const recording = recordingObserver();
      const client = new ObservedS3Client(
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- provider failures are unknown at this boundary.
        { destroy: vi.fn(), send: () => Promise.reject(failure) },
        recording.observer,
        'artifact',
        'artifact',
      );

      const request = client.send(new HeadBucketCommand({ Bucket: 'secret' }));
      await expect(request).rejects.toBe(failure);
      expect(recording.requests).toEqual([
        expect.objectContaining({ errorClass: 'unknown', outcome: 'error' }),
      ]);

      const presign = observePresign(
        recording.observer,
        'artifact',
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- presigner failures are unknown at this boundary.
        () => Promise.reject(failure),
      );
      await expect(presign).rejects.toBe(failure);
      expect(recording.requests).toHaveLength(2);
    },
  );

  it('contains hostile command inspection without changing a successful result', async () => {
    const result = Object.freeze({ etag: 'result' });
    const recording = recordingObserver();
    const client = new ObservedS3Client(
      { destroy: vi.fn(), send: () => Promise.resolve(result) },
      recording.observer,
      'artifact',
      'artifact',
    );
    const command = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'constructor') throw new Error('constructor trap');
          return undefined;
        },
      },
    );

    await expect(client.send(command as never)).resolves.toBe(result);
    expect(recording.requests).toEqual([
      expect.objectContaining({ operation: 'unknown', outcome: 'success' }),
    ]);
  });

  it('contains a hostile abort reason during request classification', async () => {
    const failure = new Error('provider rejected');
    const reason = new Proxy(new Error('private cancellation'), {
      getPrototypeOf() {
        throw new Error('prototype trap');
      },
    });
    const controller = new AbortController();
    controller.abort(reason);
    const recording = recordingObserver();
    const client = new ObservedS3Client(
      { destroy: vi.fn(), send: () => Promise.reject(failure) },
      recording.observer,
      'artifact',
      'artifact',
    );

    await expect(
      client.send(new HeadBucketCommand({ Bucket: 'secret' }), {
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(failure);
    expect(recording.requests).toEqual([
      expect.objectContaining({ errorClass: 'unknown', outcome: 'error' }),
    ]);
  });

  it('preserves a hostile provider rejection through the public store wrapper', async () => {
    const target = new Error('hidden');
    Object.defineProperty(target, 'name', {
      get() {
        throw new Error('name trap');
      },
    });
    const recording = recordingObserver();
    const store = createArtifactStore(
      {
        accessKeyId: 'access',
        bucket: 'artifacts',
        endpoint: 'http://localhost:9090',
        forcePathStyle: true,
        maxObjectBytes: 4,
        region: 'us-east-1',
        requestTimeoutMs: 100,
        secretAccessKey: 'secret',
      },
      {
        client: {
          destroy: vi.fn(),
          send: () => Promise.reject(target),
        },
        observer: recording.observer,
      },
    );

    await expect(
      store.head({ artifactId: ARTIFACT_ID, workspaceId: WORKSPACE_ID }),
    ).rejects.toBe(target);
    expect(recording.safety).toEqual([]);
  });

  it('observes presigning and existing artifact integrity enforcement', async () => {
    const recording = recordingObserver();
    const client: S3ClientLike = {
      destroy: vi.fn(),
      send: () => Promise.resolve({}),
    };
    const store = createArtifactStore(
      {
        accessKeyId: 'access',
        bucket: 'artifacts',
        endpoint: 'http://localhost:9090',
        forcePathStyle: true,
        maxObjectBytes: 4,
        region: 'us-east-1',
        requestTimeoutMs: 100,
        secretAccessKey: 'secret',
      },
      {
        client,
        observer: recording.observer,
        presignGetObject: () =>
          Promise.resolve('https://example.test/download'),
        presignPutObject: () => Promise.resolve('https://example.test/signed'),
      },
    );

    await store.beginDirectUpload({
      artifactId: ARTIFACT_ID,
      byteLength: 4,
      expiresInSeconds: 60,
      mediaType: 'text/plain',
      sha256: '0'.repeat(64),
      workspaceId: WORKSPACE_ID,
    });
    await store.beginDirectDownload({
      artifactId: ARTIFACT_ID,
      expiresInSeconds: 60,
      workspaceId: WORKSPACE_ID,
    });
    await expect(
      store.put({
        artifactId: ARTIFACT_ID,
        body: Readable.from(['hello']),
        byteLength: 5,
        mediaType: 'text/plain',
        sha256: '0'.repeat(64),
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow('configured limit');
    expect(recording.safety).toEqual([]);
    await expect(
      store.head({ artifactId: ARTIFACT_ID, workspaceId: WORKSPACE_ID }),
    ).rejects.toThrow('Stored artifact metadata is invalid');

    expect(recording.requests).toEqual([
      expect.objectContaining({
        errorClass: 'none',
        operation: 'presign_put_object',
        outcome: 'success',
        regionRole: 'artifact',
        surface: 'artifact',
      }),
      expect.objectContaining({
        errorClass: 'none',
        operation: 'presign_get_object',
        outcome: 'success',
        regionRole: 'artifact',
        surface: 'artifact',
      }),
      expect.objectContaining({
        errorClass: 'none',
        operation: 'head_object',
        outcome: 'success',
        regionRole: 'artifact',
        surface: 'artifact',
      }),
    ]);
    expect(recording.safety).toEqual([
      {
        check: 'artifact_integrity',
        regionRole: 'artifact',
        surface: 'artifact',
      },
    ]);
  });
});
