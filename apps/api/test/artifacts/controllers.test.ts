import { describe, expect, it, vi } from 'vitest';

import {
  ArtifactService,
  type ArtifactServiceDependencies,
} from '../../src/artifacts/index.js';
import { ArtifactsController } from '../../src/artifacts/controllers.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const guardActorId = '99999999-9999-4999-8999-999999999999';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const artifactId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const metadataResponse = Object.freeze({
  id: artifactId,
  workspaceId,
  byteLength: 4,
  mediaType: 'text/plain',
  sha256: 'a'.repeat(64),
  status: 'pending' as const,
  createdAt: '2026-09-06T00:00:00.000Z',
  expiresAt: '2026-09-06T00:15:00.000Z',
});

const uploadResponse = Object.freeze({
  artifact: metadataResponse,
  upload: Object.freeze({
    method: 'PUT' as const,
    url: 'https://objects.example.test/upload',
    headers: Object.freeze({}),
    expiresAt: '2026-09-06T00:15:00.000Z',
    expiresInSeconds: 900,
  }),
  replayed: false,
});

const uploadBody = {
  byteLength: 4,
  mediaType: 'text/plain',
  sha256: 'a'.repeat(64),
};

const downloadResponse = Object.freeze({
  method: 'GET' as const,
  url: 'https://objects.example.test/download',
  expiresAt: '2026-09-06T00:01:00.000Z',
  expiresInSeconds: 60,
});

function request(
  headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  > = {},
  identifiers: Readonly<{ requestId?: string; traceId?: string }> = {},
) {
  return {
    requestId: identifiers.requestId ?? 'request-42',
    ...(identifiers.traceId === undefined
      ? {}
      : { traceId: identifiers.traceId }),
    headers,
    identitySession: {
      userId: actorId,
      sessionId,
      expiresAt: new Date('2026-09-06T20:00:00.000Z'),
      clientMetadata: {},
    },
  } as const;
}

function controller() {
  const dependencies: ArtifactServiceDependencies = {
    authorization: () =>
      Promise.resolve({
        actorId,
        workspaceId,
        role: 'owner',
        membershipStatus: 'active',
        workspaceStatus: 'active',
      }),
    database: {
      beginUpload: vi.fn(),
      getForUpload: vi.fn(),
      finalizeUpload: vi.fn(),
      getMetadata: vi.fn(),
    },
    store: {
      beginDirectDownload: vi.fn(),
      beginDirectUpload: vi.fn(),
      checkReadiness: vi.fn(),
      close: vi.fn(),
      getStream: vi.fn(),
      validateDirectUpload: vi.fn(),
    },
  };
  const service = new ArtifactService(dependencies, { maxObjectBytes: 1_024 });
  const beginUpload = vi.spyOn(service, 'beginUpload');
  const finalizeUpload = vi.spyOn(service, 'finalizeUpload');
  const getMetadata = vi.spyOn(service, 'getMetadata');
  const beginDownload = vi.spyOn(service, 'beginDownload');
  return {
    instance: new ArtifactsController(service),
    beginUpload,
    finalizeUpload,
    getMetadata,
    beginDownload,
  };
}

/** What the route hands a handler once its declared input has parsed. */
function input(params: object, body?: unknown, idempotencyKey?: string) {
  return {
    params,
    query: undefined as never,
    body: body as never,
    idempotencyKey,
  } as never;
}

describe('artifacts controller public seam', () => {
  it('projects absent and guarded workspace context through the owning controller', async () => {
    const fixture = controller();
    fixture.beginUpload.mockResolvedValue(uploadResponse);
    await fixture.instance.beginUpload(
      request({}, { traceId: 'session-trace' }),
      input({ workspaceId }, uploadBody, 'session-context'),
    );
    expect(fixture.beginUpload).toHaveBeenLastCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric matcher is intentionally untyped at this nested boundary.
        actor: expect.objectContaining({
          actorId,
          requestId: 'request-42',
          traceId: 'session-trace',
        }),
      }),
    );
    expect(fixture.beginUpload.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      'authorizedWorkspace',
    );

    const base = request({ 'idempotency-key': 'guard-context' });
    const authorizedWorkspace = {
      actor: Object.freeze({
        actorId: guardActorId,
        kind: 'user' as const,
        workspaceId,
        sessionId,
        requestId: 'guard-request',
        traceId: 'guard-trace',
      }),
      workspaceId,
      role: 'owner' as const,
      capability: 'artifact:upload' as const,
    };
    await fixture.instance.beginUpload(
      { ...base, authorizedWorkspace },
      input({ workspaceId }, uploadBody, 'guard-context'),
    );
    expect(fixture.beginUpload).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actor: authorizedWorkspace.actor,
        authorizedWorkspace,
      }),
    );
  });

  it('forwards finalize route identity and operation signal', async () => {
    const fixture = controller();
    fixture.finalizeUpload.mockResolvedValue(metadataResponse);

    await expect(
      fixture.instance.finalizeUpload(
        request(),
        input({ workspaceId, artifactId }, {}),
      ),
    ).resolves.toBe(metadataResponse);

    expect(fixture.finalizeUpload).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ artifactId, routeWorkspaceId: workspaceId }),
    );
    expect(fixture.finalizeUpload.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  it('forwards metadata route identity without creating a provider signal', async () => {
    const fixture = controller();
    fixture.getMetadata.mockResolvedValue(metadataResponse);

    await expect(
      fixture.instance.getMetadata(
        request(),
        input({ workspaceId, artifactId }),
      ),
    ).resolves.toBe(metadataResponse);

    expect(fixture.getMetadata).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ artifactId, routeWorkspaceId: workspaceId }),
    );
    expect(fixture.getMetadata.mock.calls[0]?.[0]).not.toHaveProperty('signal');
  });

  it('forwards download route identity and operation signal', async () => {
    const fixture = controller();
    fixture.beginDownload.mockResolvedValue(downloadResponse);

    await expect(
      fixture.instance.beginDownload(
        request(),
        input({ workspaceId, artifactId }),
      ),
    ).resolves.toBe(downloadResponse);

    expect(fixture.beginDownload).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        artifactId,
        routeWorkspaceId: workspaceId,
      }),
    );
    expect(fixture.beginDownload.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
  });
});
