import { randomUUID } from 'node:crypto';
import {
  artifactDownloadResponseSchema,
  artifactMetadataResponseSchema,
  artifactUploadResponseSchema,
} from '@pertexo/contracts';
import { expect, it } from 'vitest';

import { expectProblem, mutationHeaders } from '../transfer.support.js';
import {
  recordBenchmarkOperation,
  requestMetadata,
  signedPut,
  parseResponse,
  fixture,
} from './fixture.js';

export function registerClaimsOneExactConcurrentUploadEnforces(): void {
  it('claims one exact concurrent upload, enforces immutable signed PUT metadata, and finalizes', async () => {
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
}
