import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  integrationDescribe,
  prepareAuthenticatedArtifactTransferHTTPFixture,
  closeAuthenticatedArtifactTransferHTTPFixture,
  fixture,
  requestMetadata,
  uploadUrl,
} from './transfer/fixture.js';
import { mutationHeaders } from './transfer.support.js';

integrationDescribe('stored upload receipt failures over HTTP', () => {
  beforeAll(prepareAuthenticatedArtifactTransferHTTPFixture);
  afterAll(closeAuthenticatedArtifactTransferHTTPFixture);
  it('keeps a damaged exact upload retry distinct from a storage outage and caller input', async () => {
    const owner = await fixture.login('owner');
    const request = {
      method: 'POST' as const,
      url: uploadUrl(fixture),
      headers: mutationHeaders(owner, randomUUID()),
      payload: requestMetadata(Buffer.from('receipt corruption probe')),
    };
    const first = await fixture.application.inject(request);
    expect(first.statusCode, first.payload).toBe(201);
    const id = first.json<{ artifact: { id: string } }>().artifact.id;
    const charged = await fixture.readCapacity();
    const storage = fixture.readStorageCalls();
    await fixture.withOwner((client) =>
      client.query(
        'update app.idempotency_records set result_ref=\'{"privateBrokenReceipt":"DO_NOT_EXPOSE"}\'::jsonb where workspace_id=$1 and operation=\'artifact.upload\' and resource_id=$2',
        [fixture.workspaceId, id],
      ),
    );
    const retry = await fixture.application.inject(request);
    expect(retry.statusCode, retry.payload).toBe(409);
    expect(retry.json()).toMatchObject({
      code: 'request.idempotency_conflict',
      title: 'Idempotency conflict',
    });
    expect(retry.payload).not.toContain('DO_NOT_EXPOSE');
    expect(retry.payload).not.toContain('privateBrokenReceipt');
    expect(await fixture.readCapacity()).toEqual(charged);
    expect(fixture.readStorageCalls()).toEqual(storage);
  });
});
