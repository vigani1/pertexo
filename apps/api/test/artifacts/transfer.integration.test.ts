import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  artifactDownloadResponseSchema,
  artifactMetadataResponseSchema,
  artifactUploadResponseSchema,
  type ArtifactUploadResponse,
} from '@pertexo/contracts/artifacts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import { assertIntegrationGateConfigured } from '../support/integration-gate.js';
import {
  artifactTransferIntegrationEnabled,
  artifactTransferIntegrationRequested,
  createArtifactTransferApiFixture,
  expectProblem,
  mutationHeaders,
  type ArtifactTransferApiFixture,
  type SessionCookies,
} from '../support/artifact-transfer.integration.support.js';

if (artifactTransferIntegrationRequested) {
  assertIntegrationGateConfigured({
    name: 'artifact transfer HTTP and object-store integration',
    requested: true,
    required: {
      DATABASE_API_URL: process.env.DATABASE_API_URL,
      ARTIFACT_STORE_ACCESS_KEY_ID: process.env.ARTIFACT_STORE_ACCESS_KEY_ID,
      ARTIFACT_STORE_BUCKET: process.env.ARTIFACT_STORE_BUCKET,
      ARTIFACT_STORE_ENDPOINT: process.env.ARTIFACT_STORE_ENDPOINT,
      ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID:
        process.env.ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID,
      ARTIFACT_STORE_RECOVERY_BUCKET:
        process.env.ARTIFACT_STORE_RECOVERY_BUCKET,
      ARTIFACT_STORE_RECOVERY_ENDPOINT:
        process.env.ARTIFACT_STORE_RECOVERY_ENDPOINT,
      ARTIFACT_STORE_RECOVERY_REGION:
        process.env.ARTIFACT_STORE_RECOVERY_REGION,
      ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY:
        process.env.ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY,
      ARTIFACT_STORE_REGION: process.env.ARTIFACT_STORE_REGION,
      ARTIFACT_STORE_SECRET_ACCESS_KEY:
        process.env.ARTIFACT_STORE_SECRET_ACCESS_KEY,
    },
  });
}

const integrationDescribe = artifactTransferIntegrationEnabled
  ? describe
  : describe.skip;

function recordBenchmarkOperation(
  name: string,
  startedAt: number,
  population = 1,
): void {
  if (process.env.PERTEXO_Q11_OPERATION_TIMING !== '1') return;
  const endedAt = performance.now();
  process.stdout.write(
    `PERTEXO_Q11_OPERATION_V2=${JSON.stringify({ schemaVersion: 2, name, startedAtUnixMs: performance.timeOrigin + startedAt, endedAtUnixMs: performance.timeOrigin + endedAt, population, boundary: `composed artifact ${name} request through response or stream completion` })}\n`,
  );
}

type UploadCapability = ArtifactUploadResponse['upload'];
type ProblemResponse = Parameters<typeof expectProblem>[0];
type RequestMetadata = ReturnType<typeof requestMetadata>;
type DenialCase = Readonly<{
  name: string;
  status: number;
  code: string;
  execute(
    fixture: ArtifactTransferApiFixture,
    metadata: RequestMetadata,
  ): Promise<ProblemResponse>;
}>;

const denialCases: readonly DenialCase[] = [
  {
    name: 'unauthenticated upload',
    status: 401,
    code: 'auth.unauthenticated',
    execute: (fixture, metadata) =>
      fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        payload: metadata,
        headers: { 'idempotency-key': 'denial-unauthenticated' },
      }),
  },
  {
    name: 'missing CSRF token',
    status: 403,
    code: 'auth.forbidden',
    execute: async (fixture, metadata) => {
      const owner = await fixture.login('owner');
      return fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        payload: metadata,
        headers: {
          cookie: owner.cookieHeader,
          'idempotency-key': 'denial-missing-csrf',
        },
      });
    },
  },
  {
    name: 'missing idempotency key',
    status: 400,
    code: 'request.invalid',
    execute: async (fixture, metadata) => {
      const owner = await fixture.login('owner');
      return fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        payload: metadata,
        headers: { cookie: owner.cookieHeader, 'x-csrf-token': owner.csrf },
      });
    },
  },
  {
    name: 'comma-joined idempotency keys',
    status: 400,
    code: 'request.invalid',
    execute: async (fixture, metadata) => {
      const owner = await fixture.login('owner');
      return fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        payload: metadata,
        headers: mutationHeaders(owner, 'denial-first,denial-second'),
      });
    },
  },
  {
    name: 'duplicate idempotency headers',
    status: 400,
    code: 'request.invalid',
    execute: async (fixture, metadata) => {
      const owner = await fixture.login('owner');
      return fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        payload: metadata,
        headers: {
          cookie: owner.cookieHeader,
          'x-csrf-token': owner.csrf,
          'idempotency-key': ['denial-first', 'denial-second'],
        },
      });
    },
  },
  {
    name: 'client-selected storage key',
    status: 400,
    code: 'request.invalid',
    execute: async (fixture, metadata) => {
      const owner = await fixture.login('owner');
      return fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        headers: mutationHeaders(owner, 'denial-malformed'),
        payload: { ...metadata, storageKey: 'client-chosen-key' },
      });
    },
  },
  {
    name: 'viewer upload',
    status: 404,
    code: 'resource.not_found',
    execute: async (fixture, metadata) => {
      const viewer = await fixture.login('viewer');
      return fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        headers: mutationHeaders(viewer, 'denial-viewer'),
        payload: metadata,
      });
    },
  },
  {
    name: 'cross-tenant upload',
    status: 404,
    code: 'resource.not_found',
    execute: async (fixture, metadata) => {
      const owner = await fixture.login('owner');
      return fixture.application.inject({
        method: 'POST',
        url: `/v1/workspaces/${fixture.otherWorkspaceId}/artifacts/uploads`,
        headers: mutationHeaders(owner, 'denial-wrong-tenant'),
        payload: metadata,
      });
    },
  },
  ...(['metadata', 'download', 'finalize'] as const).map(
    (operation): DenialCase => ({
      name: `cross-tenant ${operation}`,
      status: 404,
      code: 'resource.not_found',
      execute: async (fixture) => {
        const owner = await fixture.login('owner');
        const suffix = operation === 'metadata' ? '' : `/${operation}`;
        return fixture.application.inject({
          method: operation === 'finalize' ? 'POST' : 'GET',
          url: `/v1/workspaces/${fixture.otherWorkspaceId}/artifacts/${randomUUID()}${suffix}`,
          headers: mutationHeaders(owner, `denied-artifact-${operation}`),
          ...(operation === 'finalize' ? { payload: {} } : {}),
        });
      },
    }),
  ),
];

function uploadUrl(fixture: ArtifactTransferApiFixture): string {
  return `/v1/workspaces/${fixture.workspaceId}/artifacts/uploads`;
}

integrationDescribe('authenticated artifact transfer HTTP', () => {
  let fixture!: ArtifactTransferApiFixture;
  let closeFixture: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    fixture = await createArtifactTransferApiFixture();
    closeFixture = fixture.close;
  });

  afterAll(async () => {
    await closeFixture?.();
  });

  it.each(denialCases)(
    'rejects $name before persistence or storage',
    async ({ execute, status, code }) => {
      const baseline = await fixture.readCapacity();
      const storageBefore = fixture.readStorageCalls();
      const response = await execute(
        fixture,
        requestMetadata(Buffer.from('denial probe')),
      );

      expectProblem(response, status, code);
      expect(await fixture.readCapacity()).toEqual(baseline);
      expect(fixture.readStorageCalls()).toEqual(storageBefore);
    },
  );

  it('rejects uploads while the workspace is suspended and restores state', async () => {
    const baseline = await fixture.readCapacity();
    const storageBefore = fixture.readStorageCalls();
    const owner = await fixture.login('owner');
    await fixture.setWorkspaceStatus('suspended');
    try {
      const suspended = await fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        headers: mutationHeaders(owner, 'denial-suspended'),
        payload: requestMetadata(Buffer.from('suspended denial')),
      });
      expectProblem(suspended, 404, 'resource.not_found');
    } finally {
      await fixture.setWorkspaceStatus('active');
    }
    expect(await fixture.readCapacity()).toEqual(baseline);
    expect(fixture.readStorageCalls()).toEqual(storageBefore);
  });

  it('rejects uploads during pending deletion and restores state', async () => {
    const baseline = await fixture.readCapacity();
    const storageBefore = fixture.readStorageCalls();
    await fixture.setWorkspaceStatus('pending_deletion');
    try {
      // Pending-deletion projection revokes existing workspace sessions. Log
      // in again while the workspace is still pending so the request reaches
      // the workspace-state authorization boundary rather than session auth.
      const pendingOwner = await fixture.login('owner');
      const deleting = await fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        headers: mutationHeaders(pendingOwner, 'denial-pending-deletion'),
        payload: requestMetadata(Buffer.from('pending deletion denial')),
      });
      expectProblem(deleting, 404, 'resource.not_found');
    } finally {
      await fixture.setWorkspaceStatus('active');
    }

    expect(await fixture.readCapacity()).toEqual(baseline);
    expect(fixture.readStorageCalls()).toEqual(storageBefore);
  });

  it('claims one exact concurrent upload, enforces immutable signed PUT metadata, and finalizes through both regions', async () => {
    const owner = await fixture.login('owner');
    const body = Buffer.alloc(1_048_576, 0x61);
    const metadata = requestMetadata(body);
    const key = `concurrent-${randomUUID()}`;
    const base = `/v1/workspaces/${fixture.workspaceId}/artifacts`;
    const uploadUrl = `${base}/uploads`;
    let operationStartedAt = performance.now();
    const responses = await Promise.all(
      [0, 1].map(() =>
        fixture.application.inject({
          method: 'POST',
          url: uploadUrl,
          headers: mutationHeaders(owner, key),
          payload: metadata,
        }),
      ),
    );
    recordBenchmarkOperation('artifact-begin', operationStartedAt, 2);
    for (const response of responses) expect(response.statusCode).toBe(201);
    const bodies = responses.map((response) =>
      parseResponse(response, artifactUploadResponseSchema),
    );
    expect(bodies[0]?.artifact.id).toBe(bodies[1]?.artifact.id);
    expect(bodies.map((value) => value.replayed).toSorted()).toEqual([
      false,
      true,
    ]);
    const artifactId = bodies[0]?.artifact.id;
    const upload = bodies[0]?.upload;
    if (artifactId === undefined || upload === undefined)
      throw new Error('concurrent begin did not return a capability');
    expect(bodies[0]?.artifact).not.toHaveProperty('storageKey');
    expect(bodies[0]?.artifact).not.toHaveProperty('purpose');
    expect(upload.method).toBe('PUT');
    expect(upload.expiresInSeconds).toBeGreaterThanOrEqual(60);
    expect(upload.expiresInSeconds).toBeLessThanOrEqual(900);
    expect(new URL(upload.url).pathname).toContain(artifactId);

    const changedReplay = await fixture.application.inject({
      method: 'POST',
      url: uploadUrl,
      headers: mutationHeaders(owner, key),
      payload: { ...metadata, mediaType: 'application/octet-stream' },
    });
    expectProblem(changedReplay, 409);

    operationStartedAt = performance.now();
    const uploaded = await signedPut(upload, body);
    recordBenchmarkOperation(
      'artifact-upload',
      operationStartedAt,
      body.length,
    );
    expect(uploaded.ok).toBe(true);
    await expect(
      fixture.verificationStore.head({
        artifactId,
        workspaceId: fixture.workspaceId,
      }),
    ).resolves.toMatchObject({
      artifactId,
      workspaceId: fixture.workspaceId,
      byteLength: body.length,
      mediaType: metadata.mediaType,
      sha256: metadata.sha256,
    });

    operationStartedAt = performance.now();
    const finalized = await fixture.application.inject({
      method: 'POST',
      url: `${base}/${artifactId}/finalize`,
      headers: mutationHeaders(owner, `finalize-${artifactId}`),
      payload: {},
    });
    recordBenchmarkOperation('artifact-finalize', operationStartedAt);
    expect(finalized.statusCode).toBe(200);
    const finalizedBody = parseResponse(
      finalized,
      artifactMetadataResponseSchema,
    );
    expect(finalizedBody).toMatchObject({
      id: artifactId,
      workspaceId: fixture.workspaceId,
      byteLength: body.length,
      mediaType: metadata.mediaType,
      sha256: metadata.sha256,
      status: 'available',
      expiresAt: null,
    });
    await expect(
      fixture.verificationStore.verifyReplicas({
        ...metadata,
        artifactId,
        workspaceId: fixture.workspaceId,
      }),
    ).resolves.toMatchObject({
      artifactId,
      workspaceId: fixture.workspaceId,
      byteLength: body.length,
      mediaType: metadata.mediaType,
      sha256: metadata.sha256,
    });

    const retry = await fixture.application.inject({
      method: 'POST',
      url: `${base}/${artifactId}/finalize`,
      headers: mutationHeaders(owner, `finalize-retry-${artifactId}`),
      payload: {},
    });
    expect(retry.statusCode).toBe(200);
    expect(parseResponse(retry, artifactMetadataResponseSchema)).toEqual(
      finalizedBody,
    );

    // A completed idempotency identity must never mint a replacement PUT
    // capability for an already-available artifact.
    const beforeAvailableReplay = fixture.readStorageCalls();
    const availableBeginReplay = await fixture.application.inject({
      method: 'POST',
      url: uploadUrl,
      headers: mutationHeaders(owner, key),
      payload: metadata,
    });
    expectProblem(availableBeginReplay, 409, 'artifact.conflict');
    expect(fixture.readStorageCalls()).toEqual(beforeAvailableReplay);

    const viewer = await fixture.login('viewer');
    operationStartedAt = performance.now();
    const safeMetadata = await fixture.application.inject({
      method: 'GET',
      url: `${base}/${artifactId}`,
      headers: { cookie: viewer.cookieHeader },
    });
    recordBenchmarkOperation('artifact-metadata', operationStartedAt);
    expect(safeMetadata.statusCode).toBe(200);
    expect(safeMetadata.headers['cache-control']).toBe('no-store');
    expect(parseResponse(safeMetadata, artifactMetadataResponseSchema)).toEqual(
      finalizedBody,
    );
    expect(safeMetadata.payload).not.toContain('storageKey');
    expect(safeMetadata.payload).not.toContain('workspaces/');

    operationStartedAt = performance.now();
    const download = await fixture.application.inject({
      method: 'GET',
      url: `${base}/${artifactId}/download`,
      headers: { cookie: viewer.cookieHeader },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['cache-control']).toBe('no-store');
    const capability = parseResponse(download, artifactDownloadResponseSchema);
    expect(capability.method).toBe('GET');
    expect(
      new URL(capability.url).searchParams.get('response-content-disposition'),
    ).toBe('attachment');
    expect(capability.url).not.toContain('filename');
    const downloaded = await fetch(capability.url, {
      method: capability.method,
      signal: AbortSignal.timeout(5_000),
    });
    try {
      expect(downloaded.ok).toBe(true);
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(body);
    } finally {
      if (!downloaded.bodyUsed) await downloaded.body?.cancel();
    }
    recordBenchmarkOperation(
      'artifact-download',
      operationStartedAt,
      body.length,
    );

    const durableEvidence =
      await fixture.readDurableTransferEvidence(artifactId);
    const durableEvidenceText = JSON.stringify(durableEvidence);
    const persistedClaim = durableEvidence.find((value) =>
      value.startsWith('idempotency:'),
    );
    if (persistedClaim === undefined) throw new Error('Upload claim missing');
    expect(JSON.parse(persistedClaim.slice('idempotency:'.length))).toEqual({
      artifactId,
    });
    expect(durableEvidenceText).not.toContain(upload.url);
    expect(durableEvidenceText).not.toContain(capability.url);
    expect(fixture.readLogText()).not.toContain(upload.url);
    expect(fixture.readLogText()).not.toContain(capability.url);

    const persisted = await fixture.readArtifact(artifactId);
    expect(persisted).toMatchObject({
      id: artifactId,
      workspaceId: fixture.workspaceId,
      purpose: 'user-upload',
      storageKey: `workspaces/${fixture.workspaceId}/artifacts/${artifactId}`,
      status: 'available',
      byteLength: body.length,
    });
    const capacity = await fixture.readCapacity();
    expect(Number.isSafeInteger(capacity.chargedBytes)).toBe(true);
    expect(Number.isSafeInteger(capacity.chargedCount)).toBe(true);
  });

  it.each([
    {
      name: 'changed content type',
      uploadBody: (body: Buffer) => body,
      headers: () => ({
        'content-type': 'application/octet-stream',
      }),
    },
    {
      name: 'changed checksum',
      uploadBody: (body: Buffer) => body,
      headers: () => ({
        'x-amz-checksum-sha256': Buffer.from('wrong').toString('base64'),
      }),
    },
    {
      name: 'changed content length',
      uploadBody: (body: Buffer) => body.subarray(0, body.length - 1),
      headers: (body: Buffer) => ({
        'content-length': String(body.length - 1),
      }),
    },
  ] as const)(
    'rejects immutable signed PUT metadata: $name',
    async ({ name, uploadBody, headers }) => {
      const owner = await fixture.login('owner');
      const body = Buffer.from('immutable signed metadata');
      const started = await begin(fixture, owner, requestMetadata(body));
      const result = await signedPut(
        started.upload,
        uploadBody(body),
        headers(body),
      );

      await expectInvalidPutOrFinalization(
        fixture,
        owner,
        uploadUrl(fixture),
        started.artifact.id,
        result,
        `${name.replaceAll(' ', '-')}-${started.artifact.id}`,
      );
    },
  );

  it('keeps finalize fail-closed for missing, divergent and expired objects', async () => {
    const owner = await fixture.login('owner');
    const body = Buffer.from('missing-object-finalize');
    const metadata = requestMetadata(body);
    const base = `/v1/workspaces/${fixture.workspaceId}/artifacts`;

    const missingBegin = await begin(fixture, owner, metadata);
    const missingId = missingBegin.artifact.id;
    const missingFinalize = await fixture.application.inject({
      method: 'POST',
      url: `${base}/${missingId}/finalize`,
      headers: mutationHeaders(owner, `missing-finalize-${missingId}`),
      payload: {},
    });
    expectProblem(missingFinalize, 409);
    expect((await fixture.readArtifact(missingId))?.status).toBe('pending');

    const divergentBegin = await begin(fixture, owner, metadata);
    const divergentId = divergentBegin.artifact.id;
    const divergentBody = Buffer.from('recovery-divergence');
    await signedPut(divergentBegin.upload, body);
    await fixture.recoveryStore.put({
      artifactId: divergentId,
      workspaceId: fixture.workspaceId,
      byteLength: divergentBody.length,
      mediaType: 'application/octet-stream',
      sha256: createHash('sha256').update(divergentBody).digest('hex'),
      body: Readable.from([divergentBody]),
    });
    const divergentFinalize = await fixture.application.inject({
      method: 'POST',
      url: `${base}/${divergentId}/finalize`,
      headers: mutationHeaders(owner, `divergent-finalize-${divergentId}`),
      payload: {},
    });
    expectProblem(divergentFinalize, 409);
    expect((await fixture.readArtifact(divergentId))?.status).toBe('pending');
    await fixture.recoveryStore.delete({
      artifactId: divergentId,
      workspaceId: fixture.workspaceId,
    });
    const freshService = await fixture.createFreshApplication();
    try {
      const freshOwner = await freshService.login('owner');
      const divergentRetry = await freshService.application.inject({
        method: 'POST',
        url: `${base}/${divergentId}/finalize`,
        headers: mutationHeaders(freshOwner, `divergent-retry-${divergentId}`),
        payload: {},
      });
      expect(divergentRetry.statusCode, divergentRetry.payload).toBe(200);
    } finally {
      await freshService.close();
    }

    const expiredBegin = await begin(fixture, owner, metadata);
    await fixture.expireArtifact(expiredBegin.artifact.id);
    const beforeExpiredFinalize = await fixture.readCapacity();
    const expiredFinalize = await fixture.application.inject({
      method: 'POST',
      url: `${base}/${expiredBegin.artifact.id}/finalize`,
      headers: mutationHeaders(
        owner,
        `expired-finalize-${expiredBegin.artifact.id}`,
      ),
      payload: {},
    });
    expectProblem(expiredFinalize, 409);
    expect(await fixture.readCapacity()).toEqual(beforeExpiredFinalize);
  });

  it('serializes a quota race and restores the shared capacity limit', async () => {
    const owner = await fixture.login('owner');
    const base = `/v1/workspaces/${fixture.workspaceId}/artifacts`;
    const quotaBefore = await fixture.readCapacity();
    const quotaBody = Buffer.from('quota race');
    await fixture.setCapacity({
      byteLimit: quotaBefore.chargedBytes + quotaBody.length,
      artifactCountLimit: quotaBefore.chargedCount + 1,
    });
    try {
      const quotaMetadata = requestMetadata(quotaBody);
      const quotaResponses = await Promise.all(
        [0, 1].map((index) =>
          fixture.application.inject({
            method: 'POST',
            url: `${base}/uploads`,
            headers: mutationHeaders(
              owner,
              `quota-race-${randomUUID()}-${String(index)}`,
            ),
            payload: quotaMetadata,
          }),
        ),
      );
      expect(
        quotaResponses.map((response) => response.statusCode).toSorted(),
      ).toEqual([201, 429]);
      const quotaAfter = await fixture.readCapacity();
      expect(quotaAfter.chargedBytes).toBe(
        quotaBefore.chargedBytes + quotaBody.length,
      );
      expect(quotaAfter.chargedCount).toBe(quotaBefore.chargedCount + 1);
    } finally {
      await fixture.setCapacity({
        byteLimit: quotaBefore.byteLimit,
        artifactCountLimit: quotaBefore.artifactCountLimit,
      });
    }
  });

  it('preserves post-verification authorization denial without committing finalize', async () => {
    const owner = await fixture.login('owner');
    const body = Buffer.from('membership changes after object verification');
    const started = await begin(fixture, owner, requestMetadata(body));
    expect((await signedPut(started.upload, body)).ok).toBe(true);
    const charged = await fixture.readCapacity();
    fixture.afterNextUploadVerification(() =>
      fixture.withOwner(async (client) => {
        await client.query(
          `update app.workspace_memberships set status='removed',updated_at=clock_timestamp()
             where workspace_id=$1 and user_id=$2`,
          [fixture.workspaceId, fixture.ownerUserId],
        );
      }),
    );

    try {
      const finalized = await fixture.application.inject({
        method: 'POST',
        url: `/v1/workspaces/${fixture.workspaceId}/artifacts/${started.artifact.id}/finalize`,
        headers: mutationHeaders(
          owner,
          `authorization-race-${started.artifact.id}`,
        ),
        payload: {},
      });
      expectProblem(finalized, 403, 'auth.forbidden');
      expect((await fixture.readArtifact(started.artifact.id))?.status).toBe(
        'pending',
      );
      expect(await fixture.readCapacity()).toEqual(charged);
    } finally {
      await fixture.withOwner(async (client) => {
        await client.query(
          `update app.workspace_memberships set status='active',updated_at=clock_timestamp()
             where workspace_id=$1 and user_id=$2`,
          [fixture.workspaceId, fixture.ownerUserId],
        );
      });
    }
  });

  it('rejects deletion that races after actual replica verification without releasing capacity', async () => {
    const owner = await fixture.login('owner');
    const body = Buffer.from('deletion races verified upload');
    const started = await begin(fixture, owner, requestMetadata(body));
    expect((await signedPut(started.upload, body)).ok).toBe(true);
    const charged = await fixture.readCapacity();
    fixture.afterNextUploadVerification(() =>
      fixture.withOwner(async (client) => {
        await client.query(
          `update app.artifacts set status='deleting',updated_at=clock_timestamp()
             where workspace_id=$1 and id=$2`,
          [fixture.workspaceId, started.artifact.id],
        );
      }),
    );
    const finalized = await fixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${fixture.workspaceId}/artifacts/${started.artifact.id}/finalize`,
      headers: mutationHeaders(owner, `deletion-race-${started.artifact.id}`),
      payload: {},
    });
    expectProblem(finalized, 409, 'artifact.conflict');
    expect((await fixture.readArtifact(started.artifact.id))?.status).toBe(
      'deleting',
    );
    expect(await fixture.readCapacity()).toEqual(charged);
  });

  it('does not release a pending charge on expiry and releases exactly once only after both regional deletion succeeds', async () => {
    const owner = await fixture.login('owner');
    const body = Buffer.from('retention charge proof');
    const metadata = requestMetadata(body);
    const started = await begin(fixture, owner, metadata);
    const artifactId = started.artifact.id;
    const uploaded = await signedPut(started.upload, body);
    expect(uploaded.ok).toBe(true);
    await expect(
      fixture.verificationStore.validateDirectUpload({
        ...metadata,
        artifactId,
        workspaceId: fixture.workspaceId,
      }),
    ).resolves.toMatchObject({
      artifactId,
      workspaceId: fixture.workspaceId,
      byteLength: body.length,
      mediaType: metadata.mediaType,
      sha256: metadata.sha256,
    });
    await fixture.expireArtifact(artifactId);
    const held = await fixture.readCapacity();
    expect(held.chargedCount).toBeGreaterThan(0);
    expect((await fixture.readArtifact(artifactId))?.status).toBe('pending');

    await fixture.withOwner(async (client) => {
      await client.query(
        `update app.artifacts set status='deleting',updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2`,
        [fixture.workspaceId, artifactId],
      );
    });
    expect(await fixture.readCapacity()).toEqual(held);

    await expect(
      fixture.deleteWithRecoveryFailure({
        artifactId,
        workspaceId: fixture.workspaceId,
      }),
    ).rejects.toMatchObject({ name: 'ArtifactPartialReplicationError' });
    await expect(
      fixture.verificationStore.head({
        artifactId,
        workspaceId: fixture.workspaceId,
      }),
    ).resolves.toBeNull();
    await expect(
      fixture.recoveryStore.head({
        artifactId,
        workspaceId: fixture.workspaceId,
      }),
    ).resolves.toMatchObject({
      artifactId,
      workspaceId: fixture.workspaceId,
      byteLength: body.length,
      mediaType: metadata.mediaType,
      sha256: metadata.sha256,
    });
    expect(await fixture.readCapacity()).toEqual(held);

    await fixture.verificationStore.delete({
      artifactId,
      workspaceId: fixture.workspaceId,
    });
    await expect(
      fixture.verificationStore.head({
        artifactId,
        workspaceId: fixture.workspaceId,
      }),
    ).resolves.toBeNull();
    await expect(
      fixture.recoveryStore.head({
        artifactId,
        workspaceId: fixture.workspaceId,
      }),
    ).resolves.toBeNull();
    await fixture.withOwner(async (client) => {
      await client.query(
        `update app.artifacts
            set status='deleted',deleted_at=clock_timestamp(),updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2`,
        [fixture.workspaceId, artifactId],
      );
    });
    const released = await fixture.readCapacity();
    expect(released.chargedCount).toBe(held.chargedCount - 1);
    expect(released.chargedBytes).toBe(held.chargedBytes - body.length);

    await fixture.verificationStore.delete({
      artifactId,
      workspaceId: fixture.workspaceId,
    });
    expect(await fixture.readCapacity()).toEqual(released);
  });
});

function requestMetadata(body: Uint8Array): Readonly<{
  byteLength: number;
  mediaType: string;
  sha256: string;
}> {
  return {
    byteLength: body.byteLength,
    mediaType: 'text/plain',
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

async function begin(
  fixture: ArtifactTransferApiFixture,
  cookies: SessionCookies,
  metadata: Readonly<{
    byteLength: number;
    mediaType: string;
    sha256: string;
  }>,
): Promise<ArtifactUploadResponse> {
  const response = await fixture.application.inject({
    method: 'POST',
    url: `/v1/workspaces/${fixture.workspaceId}/artifacts/uploads`,
    headers: mutationHeaders(cookies, `begin-${randomUUID()}`),
    payload: metadata,
  });
  expect(response.statusCode, response.payload).toBe(201);
  return parseResponse(response, artifactUploadResponseSchema);
}

async function signedPut(
  capability: UploadCapability,
  body: Uint8Array,
  headerChanges: Readonly<Record<string, string>> = {},
): Promise<Readonly<{ ok: boolean; status: number }>> {
  const response = await fetch(capability.url, {
    method: capability.method,
    body,
    headers: { ...capability.headers, ...headerChanges },
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  return { ok: response.ok, status: response.status };
}

function parseResponse<T>(
  response: Readonly<{ json(): unknown }>,
  schema: ZodType<T>,
): T {
  return schema.parse(response.json());
}

async function expectInvalidPutOrFinalization(
  fixture: ArtifactTransferApiFixture,
  owner: SessionCookies,
  uploadsUrl: string,
  artifactId: string,
  result: Readonly<{ ok: boolean; status: number }>,
  idempotencyKey: string,
): Promise<void> {
  if (!result.ok) {
    expect(result.status).toBeGreaterThanOrEqual(400);
    return;
  }

  // Some S3-compatible test services accept a changed signed header. In that
  // case the API's independent metadata/checksum verification must still
  // reject finalization and leave the reservation pending.
  const artifactsUrl = uploadsUrl.replace(/\/uploads$/u, '');
  const finalize = await fixture.application.inject({
    method: 'POST',
    url: `${artifactsUrl}/${artifactId}/finalize`,
    headers: mutationHeaders(owner, idempotencyKey),
    payload: {},
  });
  expectProblem(finalize, 409, 'artifact.conflict');
  expect((await fixture.readArtifact(artifactId))?.status).toBe('pending');
  await fixture.verificationStore.delete({
    artifactId,
    workspaceId: fixture.workspaceId,
  });
}
