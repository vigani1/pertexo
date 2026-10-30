import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { mutationHeaders } from '../cookies.js';
import { expectProblem } from '../assertions.js';
import type { createWorkspaceApiFixture } from '../fixture.js';

export function registerConditionallyRenamesWorkspaceSafelyReconcilesLostAcknowledgements(
  caseFixture: ReturnType<typeof createWorkspaceApiFixture>,
): void {
  const { login, createWorkspace, workspaceAggregate } = caseFixture;

  it('conditionally renames a workspace and safely reconciles lost acknowledgements', async () => {
    const cookies = await login();
    const targetId = await createWorkspace(cookies, 'Rename proof');
    const firstKey = `rename-${randomUUID()}`;
    const missingCsrf = await caseFixture.application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: {
        cookie: cookies.cookieHeader,
        'idempotency-key': firstKey,
      },
      payload: { name: 'Rejected rename', expectedRevision: 1 },
    });
    expectProblem(missingCsrf, 403, 'auth.forbidden');

    const renamed = await caseFixture.application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies, { 'idempotency-key': firstKey }),
      payload: { name: 'Authoritative rename', expectedRevision: 1 },
    });
    expect(renamed.statusCode, renamed.payload).toBe(200);
    expect(renamed.json()).toMatchObject({
      workspace: {
        id: targetId,
        name: 'Authoritative rename',
        revision: 2,
      },
      changed: true,
      replayed: false,
    });
    const exactRetry = await caseFixture.application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies, { 'idempotency-key': firstKey }),
      payload: { name: 'Authoritative rename', expectedRevision: 1 },
    });
    expect(exactRetry.statusCode, exactRetry.payload).toBe(200);
    expect(exactRetry.json()).toMatchObject({ replayed: true });

    const newer = await caseFixture.application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies),
      payload: { name: 'Newer tab rename', expectedRevision: 2 },
    });
    expect(newer.statusCode, newer.payload).toBe(200);
    const historicalRetry = await caseFixture.application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies, { 'idempotency-key': firstKey }),
      payload: { name: 'Authoritative rename', expectedRevision: 1 },
    });
    expect(historicalRetry.statusCode, historicalRetry.payload).toBe(200);
    expect(historicalRetry.json()).toMatchObject({ replayed: true });

    const discovery = await caseFixture.application.inject({
      method: 'GET',
      url: '/v1/workspaces?limit=100',
      headers: { cookie: cookies.cookieHeader },
    });
    expect(
      discovery
        .json<{ items: { id: string; name: string; revision: number }[] }>()
        .items.find((item) => item.id === targetId),
    ).toMatchObject({ name: 'Newer tab rename', revision: 3 });
    const stale = await caseFixture.application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies),
      payload: { name: 'Stale overwrite', expectedRevision: 2 },
    });
    expectProblem(stale, 412, 'workspace.revision_conflict');
    const changedExactRetry = await caseFixture.application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies, { 'idempotency-key': firstKey }),
      payload: { name: 'Changed command', expectedRevision: 1 },
    });
    expectProblem(changedExactRetry, 409, 'request.idempotency_conflict');
  });

  it('applies a deletion request at once and restores it during recovery', async () => {
    const deletionCookies = await login();
    const primaryWorkspaceId = await createWorkspace(
      deletionCookies,
      'Deletion Proof',
    );
    const deletionRequestId = `phase1-delete-${randomUUID()}`;
    const deletionKey = `delete-${randomUUID()}`;
    const deletion = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(deletionCookies, {
        'x-request-id': deletionRequestId,
        'idempotency-key': deletionKey,
      }),
      payload: { reason: 'customer requested integration deletion' },
    });
    expect(deletion.statusCode).toBe(200);
    expect(deletion.json()).toEqual({
      workspaceId: primaryWorkspaceId,
      change: 'deletion_requested',
      occurredAt: expect.any(String) as string,
    });
    expect(deletion.payload).not.toContain(
      'customer requested integration deletion',
    );

    // Deletion signs out the workspace's members.
    const signedOut = await caseFixture.application.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: { cookie: deletionCookies.cookieHeader },
    });
    expect(signedOut.statusCode).toBe(401);
    const cookies = await login();

    const deletionRetry = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(cookies, { 'idempotency-key': deletionKey }),
      payload: { reason: 'customer requested integration deletion' },
    });
    expect(deletionRetry.statusCode).toBe(200);
    expect(deletionRetry.json()).toEqual(deletion.json());

    const deleted = await workspaceAggregate(primaryWorkspaceId);
    expect(deleted.workspace).toMatchObject({
      status: 'pending_deletion',
      deletionReason: 'customer requested integration deletion',
    });
    expect(deleted.events.map(({ action }) => action).sort()).toEqual([
      'workspace.created',
      'workspace.deletion_requested',
      'workspace.member_added',
    ]);

    const changedReplay = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(cookies, { 'idempotency-key': deletionKey }),
      payload: { reason: 'changed deletion request' },
    });
    expectProblem(changedReplay, 409, 'request.idempotency_conflict');

    const restore = await caseFixture.application.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(cookies, {
        'idempotency-key': `restore-${randomUUID()}`,
      }),
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json()).toMatchObject({
      workspaceId: primaryWorkspaceId,
      change: 'deletion_restored',
    });
    expect(
      (await workspaceAggregate(primaryWorkspaceId)).workspace,
    ).toMatchObject({ status: 'suspended', deletionReason: null });
  });
}
