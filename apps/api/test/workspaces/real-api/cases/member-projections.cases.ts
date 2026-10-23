import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { mutationHeaders } from '../cookies.js';
import { withTimeout, openHttpEventStream } from '../streams.js';
import { expectProblem } from '../assertions.js';

import type { createWorkspaceApiFixture } from '../fixture.js';

export function registerServesPrivateCurrentUserProjectionBoundedAuthorized(
  caseFixture: ReturnType<typeof createWorkspaceApiFixture>,
): void {
  const {
    login,
    createWorkspace,
    ownerEmail,
    withOwnerWorkspace,
    createPublishedWorkflow,
    issueSession,
    authenticatedMutation,
  } = caseFixture;

  it('serves a private current-user projection and bounded authorized member pages', async () => {
    const cookies = await login();
    const primaryWorkspaceId = await createWorkspace(cookies, 'Member Proof');
    const unauthenticated = await caseFixture.application.inject({
      method: 'GET',
      url: '/v1/users/me',
    });
    expectProblem(unauthenticated, 401, 'auth.unauthenticated');
    const profile = await caseFixture.application.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { cookie: cookies.cookieHeader },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.headers['cache-control']).toBe('private, no-store');
    expect(profile.json()).toMatchObject({
      email: ownerEmail,
      displayName: 'Phase One Real Stack',
      status: 'active',
    });
    expect(profile.json()).not.toHaveProperty('profileMetadata');

    const memberA = await caseFixture.identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Member A',
    });
    const memberB = await caseFixture.identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Member B',
    });
    await withOwnerWorkspace(primaryWorkspaceId, (client) =>
      client.query(
        `insert into app.workspace_memberships (workspace_id, user_id, role, status)
         values ($1, $2, 'viewer', 'active'), ($1, $3, 'viewer', 'active')`,
        [primaryWorkspaceId, memberA.id, memberB.id],
      ),
    );

    const first = await caseFixture.application.inject({
      method: 'GET',
      url: `/v1/workspaces/${primaryWorkspaceId}/members?limit=1`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    const firstBody = first.json<{
      items: unknown[];
      nextCursor: string | null;
    }>();
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.nextCursor).toBeTruthy();
    const second = await caseFixture.application.inject({
      method: 'GET',
      url: `/v1/workspaces/${primaryWorkspaceId}/members?limit=1&after=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(
      second.json<{ items: { userId: string }[] }>().items[0]?.userId,
    ).not.toBe((firstBody.items[0] as { userId: string }).userId);

    const crossTenant = await caseFixture.application.inject({
      method: 'GET',
      url: `/v1/workspaces/${randomUUID()}/members`,
      headers: { cookie: cookies.cookieHeader },
    });
    expectProblem(crossTenant, 403, 'auth.forbidden');

    const { base, createdBody } = await createPublishedWorkflow(
      cookies,
      primaryWorkspaceId,
    );
    const started = await caseFixture.application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/runs`,
      headers: mutationHeaders(cookies, {
        'idempotency-key': `role-revocation-run-${randomUUID()}`,
      }),
      payload: { input: { source: 'role-revocation-proof' } },
    });
    expect(started.statusCode, started.payload).toBe(202);
    const runId = started.json<{ run: { id: string } }>().run.id;
    const runUrl = `/v1/workspaces/${primaryWorkspaceId}/runs/${runId}`;

    const targetCookie = (await issueSession(memberA.id)).cookieHeader;
    const beforeChange = await caseFixture.application.inject({
      method: 'GET',
      url: runUrl,
      headers: { cookie: targetCookie },
    });
    expect(beforeChange.statusCode, beforeChange.payload).toBe(200);

    await caseFixture.application.listen(0, '127.0.0.1');
    const address = caseFixture.application.getHttpServer().address() as {
      port: number;
    };
    const openStream = openHttpEventStream(
      address.port,
      `${runUrl}/events`,
      targetCookie,
      1,
    );
    await withTimeout(openStream.started, 2_000);

    const roleHeaders = mutationHeaders(cookies, {
      'idempotency-key': `member-role-${randomUUID()}`,
    });
    try {
      const roleChange = await caseFixture.application.inject({
        method: 'POST',
        url: `/v1/workspaces/${primaryWorkspaceId}/members/${memberA.id}/role`,
        headers: roleHeaders,
        payload: { role: 'operator', expectedRoleRevision: 1 },
      });
      expect(roleChange.statusCode).toBe(200);
      expect(roleChange.json()).toEqual({
        userId: memberA.id,
        role: 'operator',
        roleRevision: 2,
        changed: true,
        replayed: false,
      });
      const afterChange = await caseFixture.application.inject({
        method: 'GET',
        url: runUrl,
        headers: { cookie: targetCookie },
      });
      expectProblem(afterChange, 401, 'auth.unauthenticated');
      await withTimeout(openStream.closed, 6_500);
    } finally {
      openStream.request.destroy();
    }
    const replay = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/members/${memberA.id}/role`,
      headers: roleHeaders,
      payload: { role: 'operator', expectedRoleRevision: 1 },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, roleRevision: 2 });
    const stale = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/members/${memberA.id}/role`,
      headers: mutationHeaders(cookies),
      payload: { role: 'viewer', expectedRoleRevision: 1 },
    });
    expectProblem(stale, 409, 'workspace.member_role_revision_conflict');
  }, 15_000);

  it('rejects a revoked session without exposing its cookie value', async () => {
    const logoutCookies = await login();
    const logout = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: mutationHeaders(logoutCookies),
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
    const afterLogout = await authenticatedMutation(logoutCookies);
    expectProblem(afterLogout, 401, 'auth.unauthenticated');
    expect(afterLogout.payload).not.toContain(logoutCookies.rawSession);
  });
}
