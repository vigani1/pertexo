import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  ArtifactApiUnavailableError,
  ArtifactService,
} from '../../../src/artifacts/index.js';

import {
  artifactId,
  context,
  dependencies,
  service,
  uploadRequest,
} from './fixture.js';

function finalizing(store: Parameters<typeof dependencies>[1]) {
  return new ArtifactService(dependencies({}, store), {
    maxObjectBytes: 100,
    now: () => new Date('2026-09-06T00:00:00.000Z'),
  });
}

// api-04: a storage outage keeps its cause, so the log says why it failed.
export function registerKeepsStorageFailureCause(): void {
  it.fails('keeps the object store failure as the cause of a 503', async () => {
    const failure = new Error('bucket pertexo-artifacts does not exist');
    await expect(
      finalizing({
        validateDirectUpload: vi.fn().mockRejectedValue(failure),
      }).finalizeUpload({ ...context(), artifactId, request: {} }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof ArtifactApiUnavailableError && error.cause === failure,
    );
  });

  it.fails('keeps the database failure as the cause of a 503', async () => {
    const failure = new Error('connection terminated unexpectedly');
    await expect(
      service(
        dependencies({ beginUpload: vi.fn().mockRejectedValue(failure) }),
      ).beginUpload({
        ...context(),
        request: uploadRequest,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof ArtifactApiUnavailableError && error.cause === failure,
    );
  });

  it.fails(
    'lets a client disconnect through instead of reporting a storage outage',
    async () => {
      const disconnect = new AbortController();
      disconnect.abort();
      const reason: unknown = disconnect.signal.reason;
      await expect(
        finalizing({
          validateDirectUpload: vi.fn().mockRejectedValue(reason),
        }).finalizeUpload({
          ...context(),
          artifactId,
          request: {},
          signal: disconnect.signal,
        }),
      ).rejects.toBe(reason);
    },
  );
}
