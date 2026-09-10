import { describe, expect, it, vi } from 'vitest';

import {
  ArtifactService,
  type ArtifactDependencies,
} from '../../src/artifacts/index.js';
import { ArtifactsController } from '../../src/artifacts/controllers.js';
import { mapArtifactError } from '../../src/artifacts/errors.js';
import { APPLICATION_ERROR_CATALOG } from '../../src/platform/http/index.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const guardActorId = '99999999-9999-4999-8999-999999999999';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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
  const dependencies: ArtifactDependencies = {
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
      validateDirectUpload: vi.fn(),
    },
  };
  const service = new ArtifactService(dependencies, { maxObjectBytes: 1_024 });
  const beginUpload = vi.spyOn(service, 'beginUpload');
  return {
    instance: new ArtifactsController(service),
    beginUpload,
  };
}

describe('artifacts controller public seam', () => {
  it('projects absent and guarded workspace context through the owning controller', async () => {
    const fixture = controller();
    fixture.beginUpload.mockResolvedValue({} as never);
    await fixture.instance.beginUpload(
      request(
        { 'idempotency-key': 'session-context' },
        { traceId: 'session-trace' },
      ),
      { workspaceId },
      {},
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
      { workspaceId },
      {},
    );
    expect(fixture.beginUpload).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actor: authorizedWorkspace.actor,
        authorizedWorkspace,
      }),
    );
  });

  it('maps an invalid session actor from the controller to request.invalid status 400', async () => {
    const fixture = controller();
    let thrown: unknown;
    try {
      await fixture.instance.beginUpload(
        {
          ...request({ 'idempotency-key': 'invalid-actor' }),
          identitySession: {
            ...request().identitySession,
            userId: 'not-a-uuid',
          },
        },
        { workspaceId },
        {},
      );
    } catch (error) {
      thrown = error;
    }
    expect(mapArtifactError(thrown)).toMatchObject({ code: 'request.invalid' });
    expect(APPLICATION_ERROR_CATALOG['request.invalid'].status).toBe(400);
    expect(fixture.beginUpload).not.toHaveBeenCalled();
  });
  it.each([
    ['duplicate header values', { 'Idempotency-Key': ['first', 'second'] }],
    ['comma-joined values', { 'idempotency-key': 'first,second' }],
  ] as const)(
    'rejects %s before delegating the upload',
    async (_case, headers) => {
      const fixture = controller();

      await expect(
        fixture.instance.beginUpload(request(headers), { workspaceId }, {}),
      ).rejects.toMatchObject({ name: 'ZodError' });
      expect(fixture.beginUpload).not.toHaveBeenCalled();
    },
  );

  it('accepts a case-insensitive singleton header and forwards its value once', async () => {
    const fixture = controller();
    const response = {
      artifact: {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        workspaceId,
        byteLength: 4,
        mediaType: 'text/plain',
        sha256: 'a'.repeat(64),
        status: 'pending',
        createdAt: '2026-09-06T00:00:00.000Z',
        expiresAt: '2026-09-06T00:15:00.000Z',
      },
      upload: {
        method: 'PUT',
        url: 'https://objects.example.test/upload',
        headers: {},
        expiresAt: '2026-09-06T00:15:00.000Z',
        expiresInSeconds: 900,
      },
      replayed: false,
    } as const;
    fixture.beginUpload.mockResolvedValue(response);

    await fixture.instance.beginUpload(
      request({ 'IDEMPOTENCY-KEY': ['single'] }),
      { workspaceId },
      {},
    );

    expect(fixture.beginUpload).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ idempotencyKey: 'single' }),
    );
  });
});
