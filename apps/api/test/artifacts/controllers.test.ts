import { describe, expect, it, vi } from 'vitest';

import {
  ArtifactService,
  type ArtifactDependencies,
} from '../../src/artifacts/index.js';
import { ArtifactsController } from '../../src/artifacts/controllers.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function request(
  headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  > = {},
) {
  return {
    requestId: 'request-42',
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
