import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { mutationHeaders } from '../cookies.js';
import { expectProblem } from '../assertions.js';
import type { createWorkspaceApiFixture } from '../fixture.js';

export function registerEnforcesCSRFAtomicallyCreatesOwnerMembershipCorrelated(
  caseFixture: ReturnType<typeof createWorkspaceApiFixture>,
): void {
  const { login, workspaceAggregate } = caseFixture;

  it('enforces CSRF and atomically creates an owner membership and correlated audit fact', async () => {
    const cookies = await login();
    const slug = `phase1-${randomUUID().slice(0, 12)}`;
    const missingCsrf = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { cookie: cookies.cookieHeader },
      payload: { name: 'Rejected Workspace', slug: `${slug}-rejected` },
    });
    expectProblem(missingCsrf, 403, 'auth.forbidden');

    const requestId = `phase1-create-${randomUUID()}`;
    const traceId = randomUUID().replaceAll('-', '');
    const creationKey = `create-${randomUUID()}`;
    const created = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies, {
        'x-request-id': requestId,
        'idempotency-key': creationKey,
        traceparent: `00-${traceId}-0123456789abcdef-01`,
      }),
      payload: { name: 'Phase One Workspace', slug },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['x-request-id']).toBe(requestId);
    const workspace = created.json<{ id: string; status: string }>();
    expect(workspace.status).toBe('active');

    const discovered = await caseFixture.application.inject({
      method: 'GET',
      url: '/v1/workspaces?limit=100',
      headers: { cookie: cookies.cookieHeader },
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.headers['cache-control']).toBe('private, no-store');
    const discoveredItems = discovered.json<{
      items: { id: string; role: string; capabilities: string[] }[];
    }>().items;
    const discoveredWorkspace = discoveredItems.find(
      (item) => item.id === workspace.id,
    );
    expect(discoveredWorkspace).toMatchObject({
      id: workspace.id,
      role: 'owner',
    });
    expect(discoveredWorkspace?.capabilities).toEqual(
      expect.arrayContaining(['workspace:manage', 'workflow:create']),
    );

    const creationRetry = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies, {
        'idempotency-key': creationKey,
      }),
      payload: { name: 'Phase One Workspace', slug },
    });
    expect(creationRetry.statusCode).toBe(201);
    expect(creationRetry.json()).toEqual(created.json());
    const changedCreation = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies, {
        'idempotency-key': creationKey,
      }),
      payload: { name: 'Changed Workspace', slug },
    });
    expectProblem(changedCreation, 409, 'request.idempotency_conflict');

    const aggregate = await workspaceAggregate(workspace.id);
    expect(aggregate.memberships).toHaveLength(1);
    expect(aggregate.memberships[0]).toMatchObject({ role: 'owner' });
    expect(aggregate.events).toHaveLength(2);
    expect(aggregate.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'workspace.created',
          requestId,
          traceId,
        }),
        expect.objectContaining({
          action: 'workspace.member_added',
          requestId,
          traceId,
          targetType: 'workspace_member',
          targetId: aggregate.memberships[0]?.userId,
          metadata: {
            source: 'workspace_creation',
            role: 'owner',
            status: 'active',
            roleRevision: 1,
          },
        }),
      ]),
    );

    const duplicate = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies),
      payload: { name: 'Duplicate Workspace', slug },
    });
    expectProblem(duplicate, 409, 'workspace.conflict');
    const unchanged = await workspaceAggregate(workspace.id);
    expect(unchanged.memberships).toHaveLength(1);
    expect(unchanged.events).toHaveLength(2);
    expect(unchanged.events).toEqual(expect.arrayContaining(aggregate.events));

    const forgedRole = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies),
      payload: { name: 'Forged Role', slug: `${slug}-forged`, role: 'owner' },
    });
    expectProblem(forgedRole, 400, 'request.invalid');

    const forgedWorkspace = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${randomUUID()}/deletion`,
      headers: mutationHeaders(cookies),
      payload: { reason: 'forged workspace context' },
    });
    expectProblem(forgedWorkspace, 403, 'auth.forbidden');
  });
}
