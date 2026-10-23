import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { expectProblem } from '../../../support/better-auth/real-api.support.js';

import type { createFoldersBulkFixture } from './fixture.js';

export function registerRechecksRealBuilderAuthorityOnArchivedPlacement(
  caseFixture: ReturnType<typeof createFoldersBulkFixture>,
): void {
  const { fixture, createFolder, api } = caseFixture;

  it('rechecks real builder authority on archived placement and exact bulk replay', async () => {
    const f = await fixture(),
      destination = await createFolder(f);
    const email = `${randomUUID()}@example.test`;
    await api.signUp(email, '/login?verified=true');
    const builder = await api.signIn(email);
    const actorId = (
      await api.send('GET', '/v1/users/me', { browser: builder })
    ).json<{ id: string }>().id;
    await api
      .database()
      .query(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active')",
        [f.workspaceId, actorId],
      );
    const list = await api.send('GET', `${f.route}/workflow-folders`, {
      browser: builder,
    });
    expect(list.statusCode, list.payload).toBe(200);
    expectProblem(
      await api.send('POST', `${f.route}/workflow-folders`, {
        browser: builder,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Forbidden', parentId: null },
      }),
      403,
      'auth.forbidden',
    );
    const singleKey = randomUUID(),
      single = { folderId: destination.id, expectedOrganizationRevision: 1 };
    const singlePlacement = () =>
      api.send('POST', `${f.route}/workflows/${f.workflowId}/folder`, {
        browser: builder,
        headers: { 'idempotency-key': singleKey },
        payload: single,
      });
    expect((await singlePlacement()).statusCode).toBe(200);
    const bulkKey = randomUUID(),
      bulk = {
        operation: 'move',
        folderId: destination.id,
        items: [{ workflowId: f.workflowId, expectedOrganizationRevision: 2 }],
      };
    const bulkPlacement = () =>
      api.send('POST', `${f.route}/workflows/organization/bulk`, {
        browser: builder,
        headers: { 'idempotency-key': bulkKey },
        payload: bulk,
      });
    expect((await bulkPlacement()).json()).toMatchObject({
      items: [{ status: 'updated', organizationRevision: 3 }],
    });
    expect(
      (
        await api.send('POST', `${f.route}/workflows/${f.workflowId}/archive`, {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { expectedLifecycleRevision: 1 },
        })
      ).statusCode,
    ).toBe(202);
    expectProblem(await singlePlacement(), 409, 'workflow.lifecycle_conflict');
    expect((await bulkPlacement()).json()).toEqual({
      items: [
        {
          workflowId: f.workflowId,
          status: 'conflict',
          code: 'workflow.lifecycle_conflict',
        },
      ],
    });
    const adminUnfile = await api.send(
      'POST',
      `${f.route}/workflows/${f.workflowId}/folder`,
      {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { folderId: null, expectedOrganizationRevision: 3 },
      },
    );
    expect(adminUnfile.statusCode, adminUnfile.payload).toBe(200);
    expectProblem(
      await api.send('POST', `${f.route}/workflow-tags/cleanup/detach`, {
        browser: builder,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          tagId: randomUUID(),
          items: [
            { workflowId: f.workflowId, expectedOrganizationRevision: 4 },
          ],
        },
      }),
      403,
      'auth.forbidden',
    );
    await api
      .database()
      .query(
        "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
        [f.workspaceId, actorId],
      );
    expectProblem(await bulkPlacement(), 404, 'resource.not_found');
  });
}
