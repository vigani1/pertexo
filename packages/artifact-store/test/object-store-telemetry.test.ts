import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  ObservedS3Client,
  type ObjectStoreObserver,
  type ObjectStoreRequestObservation,
  type ObjectStoreSafetyObservation,
} from '../src/object-store-telemetry.js';
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
