import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { expectProblem, mutationHeaders } from '../transfer.support.js';
import {
  uploadUrl,
  requestMetadata,
  begin,
  signedPut,
  expectInvalidPutOrFinalization,
  fixture,
} from './fixture.js';

export function registerRejectsImmutableSignedPUTMetadataName(): void {
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

      await expectInvalidPutOrFinalization({
        fixture: fixture,
        owner: owner,
        uploadsUrl: uploadUrl(fixture),
        artifactId: started.artifact.id,
        result: result,
        idempotencyKey: `${name.replaceAll(' ', '-')}-${started.artifact.id}`,
      });
    },
  );

  it('keeps finalize fail-closed for missing and expired objects', async () => {
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

  it('rejects deletion that races after upload verification without releasing capacity', async () => {
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
}
