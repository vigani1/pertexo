import { expect, it } from 'vitest';

import { expectProblem, mutationHeaders } from '../transfer.support.js';
import { denialCases, uploadUrl, requestMetadata, fixture } from './fixture.js';

export function registerRejectsNameBeforePersistenceStorage(): void {
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
      // Suspension revokes members' sessions (ADR 013).
      const revoked = await fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        headers: mutationHeaders(owner, 'denial-revoked'),
        payload: requestMetadata(Buffer.from('revoked denial')),
      });
      expectProblem(revoked, 401, 'auth.unauthenticated');
      const suspended = await fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        headers: mutationHeaders(
          await fixture.login('owner'),
          'denial-suspended',
        ),
        payload: requestMetadata(Buffer.from('suspended denial')),
      });
      expectProblem(suspended, 404, 'resource.not_found');
    } finally {
      await fixture.setWorkspaceStatus('active');
    }
    expect(await fixture.readCapacity()).toEqual(baseline);
    expect(fixture.readStorageCalls()).toEqual(storageBefore);
  });

  it('still reads an artifact while the workspace is suspended', async () => {
    const owner = await fixture.login('owner');
    const begun = await fixture.application.inject({
      method: 'POST',
      url: uploadUrl(fixture),
      headers: mutationHeaders(owner, 'suspended-read'),
      payload: requestMetadata(Buffer.from('suspended read')),
    });
    expect(begun.statusCode, begun.payload).toBe(201);
    const artifactId = begun.json<{ artifact: { id: string } }>().artifact.id;
    await fixture.setWorkspaceStatus('suspended');
    try {
      const metadata = await fixture.application.inject({
        method: 'GET',
        url: `/v1/workspaces/${fixture.workspaceId}/artifacts/${artifactId}`,
        headers: { cookie: (await fixture.login('viewer')).cookieHeader },
      });
      expect(metadata.statusCode, metadata.payload).toBe(200);
    } finally {
      await fixture.setWorkspaceStatus('active');
    }
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
}
