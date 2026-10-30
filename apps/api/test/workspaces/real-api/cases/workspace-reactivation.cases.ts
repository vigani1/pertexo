import { randomBytes, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { mutationHeaders } from '../cookies.js';
import { expectProblem } from '../assertions.js';
import type { SessionCookies } from '../contract.js';
import type { createWorkspaceApiFixture } from '../fixture.js';

export function registerReactivatesSuspendedWorkspace(
  caseFixture: ReturnType<typeof createWorkspaceApiFixture>,
): void {
  const { login, createWorkspace, withOwnerWorkspace, workspaceAggregate } =
    caseFixture;
  let ownerUserId: string | undefined;

  /**
   * Deleting and restoring end sessions, so these cases need many. Sign-ins share
   * a small per-origin budget, so only the ones under test go through HTTP.
   */
  async function issuedSession(userId: string): Promise<SessionCookies> {
    const issued = await caseFixture.issueSession(userId);
    const csrf = randomBytes(32).toString('base64url');
    return {
      ...issued,
      csrf,
      cookieHeader: `${issued.cookieHeader}; pertexo_csrf=${csrf}`,
    };
  }

  async function ownerSession(): Promise<SessionCookies> {
    if (ownerUserId === undefined) {
      const me = await caseFixture.application.inject({
        method: 'GET',
        url: '/v1/users/me',
        headers: { cookie: (await login()).cookieHeader },
      });
      ownerUserId = me.json<{ id: string }>().id;
    }
    return issuedSession(ownerUserId);
  }

  function reactivate(
    workspaceId: string,
    cookies: SessionCookies,
    idempotencyKey = `reactivate-${randomUUID()}`,
  ) {
    return caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/reactivate`,
      headers: mutationHeaders(cookies, { 'idempotency-key': idempotencyKey }),
    });
  }

  async function requestDeletion(
    workspaceId: string,
    cookies: SessionCookies,
  ): Promise<void> {
    const deletion = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/deletion`,
      headers: mutationHeaders(cookies),
      payload: { reason: 'integration reactivation proof' },
    });
    expect(deletion.statusCode, deletion.payload).toBe(200);
  }

  /** The workspace, restored, and the session that sent the restore. */
  async function deleteAndRestore(name: string) {
    const creator = await ownerSession();
    const workspaceId = await createWorkspace(creator, name);
    await requestDeletion(workspaceId, creator);
    const restorer = await ownerSession();
    const restored = await caseFixture.application.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/deletion`,
      headers: mutationHeaders(restorer),
    });
    expect(restored.statusCode, restored.payload).toBe(200);
    return { workspaceId, restorer };
  }

  async function workspaceStatus(workspaceId: string) {
    return (await workspaceAggregate(workspaceId)).workspace?.status;
  }

  async function reactivationAudits(workspaceId: string) {
    return (await workspaceAggregate(workspaceId)).events.filter(
      ({ action }) => action === 'workspace.reactivated',
    );
  }

  it('signs members out on restore and lets a fresh sign-in read the suspended workspace', async () => {
    const { workspaceId, restorer } = await deleteAndRestore(
      'Restored Read Proof',
    );

    const signedOut = await caseFixture.application.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: { cookie: restorer.cookieHeader },
    });
    expect(signedOut.statusCode).toBe(401);

    const fresh = await login();
    const listed = await caseFixture.application.inject({
      method: 'GET',
      url: '/v1/workspaces?limit=100',
      headers: { cookie: fresh.cookieHeader },
    });
    expect(listed.statusCode, listed.payload).toBe(200);
    expect(
      listed
        .json<{ items: { id: string }[] }>()
        .items.find((item) => item.id === workspaceId),
    ).toMatchObject({
      status: 'suspended',
      role: 'owner',
      capabilities: expect.arrayContaining(['workspace:manage']) as string[],
    });
    const runs = await caseFixture.application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs`,
      headers: { cookie: fresh.cookieHeader },
    });
    expect(runs.statusCode, runs.payload).toBe(200);
  });
  it('reactivates through a fresh sign-in, refuses a missing CSRF token and replays a retry', async () => {
    const { workspaceId } = await deleteAndRestore('Reactivation Proof');
    const cookies = await login();
    const url = `/v1/workspaces/${workspaceId}/reactivate`;
    const key = `reactivate-${randomUUID()}`;

    const missingCsrf = await caseFixture.application.inject({
      method: 'POST',
      url,
      headers: { cookie: cookies.cookieHeader, 'idempotency-key': key },
    });
    expectProblem(missingCsrf, 403, 'auth.forbidden');
    const unauthenticated = await caseFixture.application.inject({
      method: 'POST',
      url,
      headers: { 'idempotency-key': key },
    });
    expectProblem(unauthenticated, 401, 'auth.unauthenticated');
    expect(await workspaceStatus(workspaceId)).toBe('suspended');

    const reactivated = await reactivate(workspaceId, cookies, key);
    expect(reactivated.statusCode, reactivated.payload).toBe(200);
    expect(reactivated.json()).toEqual({
      workspaceId,
      change: 'reactivated',
      occurredAt: expect.any(String) as string,
    });
    expect(await workspaceStatus(workspaceId)).toBe('active');
    expect(await reactivationAudits(workspaceId)).toHaveLength(1);

    const retry = await reactivate(workspaceId, cookies, key);
    expect(retry.statusCode, retry.payload).toBe(200);
    expect(retry.json()).toEqual(reactivated.json());
    expect(await reactivationAudits(workspaceId)).toHaveLength(1);

    // Reactivating signs nobody out, and the workspace takes work again.
    const created = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/workflows`,
      headers: mutationHeaders(cookies),
      payload: { name: 'Allowed once active' },
    });
    expect(created.statusCode, created.payload).toBe(201);
  });
  it('refuses every role but owner', async () => {
    const { workspaceId } = await deleteAndRestore('Reactivation Roles');
    for (const role of ['admin', 'builder', 'operator', 'viewer']) {
      const userId = randomUUID();
      await withOwnerWorkspace(workspaceId, async (client) => {
        await client.query(
          `insert into app.users(id,email,display_name) values($1,$2,$3)`,
          [userId, `${userId}@example.test`, role],
        );
        await client.query(
          `insert into app.workspace_memberships(workspace_id,user_id,role)
           values($1,$2,$3)`,
          [workspaceId, userId, role],
        );
      });

      expectProblem(
        await reactivate(workspaceId, await issuedSession(userId)),
        403,
        'auth.forbidden',
      );
    }
    expect(await workspaceStatus(workspaceId)).toBe('suspended');
    expect(await reactivationAudits(workspaceId)).toEqual([]);
  });
  it('refuses a workspace that is not suspended', async () => {
    const creator = await ownerSession();
    const active = await createWorkspace(creator, 'Reactivation Active');
    expectProblem(await reactivate(active, creator), 409, 'workspace.conflict');
    expect(await workspaceStatus(active)).toBe('active');

    await requestDeletion(active, creator);
    expectProblem(
      await reactivate(active, await ownerSession()),
      409,
      'workspace.conflict',
    );
    expect(await workspaceStatus(active)).toBe('pending_deletion');

    // As for Restore, the route's guard hides the last two states.
    await withOwnerWorkspace(active, (client) =>
      client.query(`update app.workspaces set status='purging' where id=$1`, [
        active,
      ]),
    );
    expectProblem(
      await reactivate(active, await ownerSession()),
      403,
      'auth.forbidden',
    );
    await withOwnerWorkspace(active, (client) =>
      client.query(
        `update app.workspaces
         set status='deleted', created_by=null, deletion_requested_by=null,
             deletion_reason='purged', name='Deleted workspace',
             slug='deleted-'||id
         where id=$1`,
        [active],
      ),
    );
    expectProblem(
      await reactivate(active, await ownerSession()),
      403,
      'auth.forbidden',
    );
    expect(await workspaceStatus(active)).toBe('deleted');
    expect(await reactivationAudits(active)).toEqual([]);
  });
}
