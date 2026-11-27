import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, it, expect } from 'vitest';
import {
  describeIntegration,
  resetAuthenticatedWorkflowLifecycleHTTPCommandsFixture,
  cleanAuthenticatedWorkflowLifecycleHTTPCommandsFixture,
  lifecyclePath,
  fixture,
  expectLifecycleResponse,
  expectHistoryUnchanged,
  lifecycleFacts,
  type LifecycleResponse,
} from './workflow-lifecycle.fixture.js';
import { expectProblem, mutationHeaders } from '../lifecycle.support.js';

describeIntegration('authenticated workflow lifecycle HTTP commands', () => {
  beforeEach(resetAuthenticatedWorkflowLifecycleHTTPCommandsFixture);

  afterEach(cleanAuthenticatedWorkflowLifecycleHTTPCommandsFixture);
  it('requires authentication and CSRF for each lifecycle command', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    const body = { expectedLifecycleRevision: 1 };

    for (const command of ['archive', 'restore'] as const) {
      const path = lifecyclePath(workspaceId, ids.unpublished, command);
      const unauthenticated = await application.inject({
        method: 'POST',
        url: path,
        headers: { 'idempotency-key': `unauthenticated-${command}` },
        payload: body,
      });
      expectProblem(unauthenticated, 401, 'auth.unauthenticated');

      const missingCsrf = await application.inject({
        method: 'POST',
        url: path,
        headers: {
          cookie: owner.cookieHeader,
          'idempotency-key': `missing-csrf-${command}`,
        },
        payload: body,
      });
      expectProblem(missingCsrf, 403, 'auth.forbidden');
    }
  });

  it('requires one idempotency key and a strict lifecycle body', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    const body = { expectedLifecycleRevision: 1 };

    for (const command of ['archive', 'restore'] as const) {
      const path = lifecyclePath(workspaceId, ids.unpublished, command);

      const missingKey = await application.inject({
        method: 'POST',
        url: path,
        headers: { cookie: owner.cookieHeader, 'x-csrf-token': owner.csrf },
        payload: body,
      });
      expectProblem(missingKey, 400, 'request.invalid');

      const combinedKey = await application.inject({
        method: 'POST',
        url: path,
        headers: mutationHeaders(owner, {
          'idempotency-key': `first-${command},second-${command}`,
        }),
        payload: body,
      });
      expectProblem(combinedKey, 400, 'request.invalid');

      const duplicateHeaders = await application.inject({
        method: 'POST',
        url: path,
        headers: {
          cookie: owner.cookieHeader,
          'x-csrf-token': owner.csrf,
          'idempotency-key': [
            `duplicate-one-${command}`,
            `duplicate-two-${command}`,
          ],
        },
        payload: body,
      });
      expectProblem(duplicateHeaders, 400, 'request.invalid');

      const extraBody = await application.inject({
        method: 'POST',
        url: path,
        headers: mutationHeaders(owner),
        payload: { ...body, unexpected: true },
      });
      expectProblem(extraBody, 400, 'request.invalid');

      const invalidRevision = await application.inject({
        method: 'POST',
        url: path,
        headers: mutationHeaders(owner),
        payload: { expectedLifecycleRevision: 0 },
      });
      expectProblem(invalidRevision, 400, 'request.invalid');
    }
  });

  it('rejects malformed trace context at the HTTP boundary', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    for (const traceparent of [
      'arbitrary',
      `00-${'0'.repeat(32)}-${'1'.repeat(16)}-01`,
      `00-${'1'.repeat(32)}-${'0'.repeat(16)}-01`,
    ]) {
      expectProblem(
        await application.inject({
          method: 'POST',
          url: lifecyclePath(workspaceId, ids.unpublished, 'archive'),
          headers: mutationHeaders(owner, { traceparent }),
          payload: { expectedLifecycleRevision: 1 },
        }),
        400,
        'request.invalid',
      );
    }
  });

  it('hides lifecycle commands from roles without publication authority and other tenants', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    const body = { expectedLifecycleRevision: 1 };

    for (const role of ['operator', 'viewer'] as const) {
      const cookies = await fixture.login(role);
      for (const command of ['archive', 'restore'] as const) {
        const denied = await application.inject({
          method: 'POST',
          url: lifecyclePath(workspaceId, ids.unpublished, command),
          headers: mutationHeaders(cookies),
          payload: body,
        });
        expectProblem(denied, 404, 'resource.not_found');
      }
    }

    const wrongTenant = await application.inject({
      method: 'POST',
      url: lifecyclePath(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ids.unpublished,
        'archive',
      ),
      headers: mutationHeaders(owner),
      payload: body,
    });
    expectProblem(wrongTenant, 404, 'resource.not_found');
  });

  for (const status of ['suspended', 'pending_deletion'] as const) {
    it(`hides lifecycle commands while the workspace is ${status}`, async () => {
      const { application, ids, workspaceId } = fixture;
      await fixture.setWorkspaceStatus(status);
      try {
        const owner = await fixture.login('owner');
        for (const command of ['archive', 'restore'] as const) {
          const denied = await application.inject({
            method: 'POST',
            url: lifecyclePath(workspaceId, ids.unpublished, command),
            headers: mutationHeaders(owner),
            payload: { expectedLifecycleRevision: 1 },
          });
          expectProblem(denied, 404, 'resource.not_found');
        }
      } finally {
        await fixture.setWorkspaceStatus('active');
      }
    });
  }
  it('archives and restores an unpublished workflow with exact concurrent idempotency and CAS', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    const path = lifecyclePath(workspaceId, ids.unpublished, 'archive');
    const archiveHeaders = mutationHeaders(owner, {
      'idempotency-key': 'unpublished-archive-concurrent',
    });
    const archiveRequests = await Promise.all([
      application.inject({
        method: 'POST',
        url: path,
        headers: archiveHeaders,
        payload: { expectedLifecycleRevision: 1 },
      }),
      application.inject({
        method: 'POST',
        url: path,
        headers: archiveHeaders,
        payload: { expectedLifecycleRevision: 1 },
      }),
    ]);
    expect(archiveRequests.map(({ statusCode }) => statusCode).sort()).toEqual([
      202, 202,
    ]);
    const archiveBodies = archiveRequests.map((response) =>
      response.json<LifecycleResponse>(),
    );
    const acceptedArchive = archiveBodies.find(({ replayed }) => !replayed);
    if (acceptedArchive === undefined)
      throw new Error('accepted archive response missing');
    expect(archiveBodies.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(archiveBodies[0]?.workflow).toMatchObject({
      id: ids.unpublished,
      lifecycleStatus: 'archived',
      lifecycleRevision: 2,
      activationStatus: 'inactive',
      webhookSetupRequired: false,
      publishedVersionId: null,
    });
    expect(archiveBodies[0]?.workflow).toEqual(archiveBodies[1]?.workflow);
    expectLifecycleResponse(archiveRequests[0], {
      workspaceId,
      name: 'Unpublished lifecycle target',
      id: ids.unpublished,
      lifecycleStatus: 'archived',
      lifecycleRevision: 2,
      activationStatus: 'inactive',
      webhookSetupRequired: false,
      publishedVersionId: null,
      replayed: archiveBodies[0]?.replayed ?? false,
    });

    const replay = await application.inject({
      method: 'POST',
      url: path,
      headers: archiveHeaders,
      payload: { expectedLifecycleRevision: 1 },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json<LifecycleResponse>()).toEqual({
      replayed: true,
      workflow: acceptedArchive.workflow,
    });

    const mismatch = await application.inject({
      method: 'POST',
      url: path,
      headers: archiveHeaders,
      payload: { expectedLifecycleRevision: 2 },
    });
    expectProblem(mismatch, 409, 'request.idempotency_conflict');

    const restored = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.unpublished, 'restore'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'unpublished-restore',
      }),
      payload: { expectedLifecycleRevision: 2 },
    });
    expectLifecycleResponse(restored, {
      workspaceId,
      name: 'Unpublished lifecycle target',
      id: ids.unpublished,
      lifecycleStatus: 'active',
      lifecycleRevision: 3,
      activationStatus: 'inactive',
      webhookSetupRequired: false,
      publishedVersionId: null,
      replayed: false,
    });

    const replayAfterRestore = await application.inject({
      method: 'POST',
      url: path,
      headers: archiveHeaders,
      payload: { expectedLifecycleRevision: 1 },
    });
    expect(replayAfterRestore.statusCode).toBe(202);
    expect(replayAfterRestore.json<LifecycleResponse>()).toEqual({
      replayed: true,
      workflow: acceptedArchive.workflow,
    });
    expect(await fixture.readLifecycle(ids.unpublished)).toEqual({
      lifecycleStatus: 'active',
      lifecycleRevision: 3,
      activationStatus: 'inactive',
      publishedVersionId: null,
    });

    const beforeNoop = await fixture.readHistory(ids.unpublished);
    const beforeNoopFacts = await lifecycleFacts(fixture, ids.unpublished);
    const noop = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.unpublished, 'restore'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'unpublished-noop',
      }),
      payload: { expectedLifecycleRevision: 3 },
    });
    expectLifecycleResponse(noop, {
      workspaceId,
      name: 'Unpublished lifecycle target',
      id: ids.unpublished,
      lifecycleStatus: 'active',
      lifecycleRevision: 3,
      activationStatus: 'inactive',
      webhookSetupRequired: false,
      publishedVersionId: null,
      replayed: false,
    });
    await expectHistoryUnchanged(fixture, ids.unpublished, beforeNoop);
    expect(await lifecycleFacts(fixture, ids.unpublished)).toEqual(
      beforeNoopFacts,
    );

    const stale = await application.inject({
      method: 'POST',
      url: path,
      headers: mutationHeaders(owner, {
        'idempotency-key': 'unpublished-stale',
      }),
      payload: { expectedLifecycleRevision: 1 },
    });
    expectProblem(stale, 409, 'workflow.lifecycle_conflict');
    expect(stale.json()).toMatchObject({ currentLifecycleRevision: 3 });
  });

  it('archives and restores a published workflow without changing draft, version, or run history', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    const before = await fixture.readHistory(ids.published);
    expect(before.runs).toEqual([
      {
        id: ids.run,
        status: 'succeeded',
        workflowVersionId: ids.publishedVersion,
      },
    ]);
    const beforeFacts = await lifecycleFacts(fixture, ids.published);

    const archive = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.published, 'archive'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'published-archive',
      }),
      payload: { expectedLifecycleRevision: 1 },
    });
    expectLifecycleResponse(archive, {
      workspaceId,
      name: 'Published lifecycle target',
      id: ids.published,
      lifecycleStatus: 'archived',
      lifecycleRevision: 2,
      activationStatus: 'deactivating',
      webhookSetupRequired: false,
      publishedVersionId: ids.publishedVersion,
      replayed: false,
    });
    await expectHistoryUnchanged(fixture, ids.published, before);

    const afterArchiveFacts = await lifecycleFacts(fixture, ids.published);
    expect(afterArchiveFacts).toEqual({
      audit: beforeFacts.audit + 1,
      reconciliationOutbox: beforeFacts.reconciliationOutbox + 1,
    });

    const archiveRetry = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.published, 'archive'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'published-archive',
      }),
      payload: { expectedLifecycleRevision: 1 },
    });
    expectLifecycleResponse(archiveRetry, {
      workspaceId,
      name: 'Published lifecycle target',
      id: ids.published,
      lifecycleStatus: 'archived',
      lifecycleRevision: 2,
      activationStatus: 'deactivating',
      webhookSetupRequired: false,
      publishedVersionId: ids.publishedVersion,
      replayed: true,
    });
    expect(await lifecycleFacts(fixture, ids.published)).toEqual(
      afterArchiveFacts,
    );

    const restore = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.published, 'restore'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'published-restore',
      }),
      payload: { expectedLifecycleRevision: 2 },
    });
    expectLifecycleResponse(restore, {
      workspaceId,
      name: 'Published lifecycle target',
      id: ids.published,
      lifecycleStatus: 'active',
      lifecycleRevision: 3,
      activationStatus: 'activating',
      webhookSetupRequired: false,
      publishedVersionId: ids.publishedVersion,
      replayed: false,
    });
    await expectHistoryUnchanged(fixture, ids.published, before);
    expect(await lifecycleFacts(fixture, ids.published)).toEqual({
      audit: beforeFacts.audit + 2,
      reconciliationOutbox: beforeFacts.reconciliationOutbox + 2,
    });

    const raceHeaders = [
      mutationHeaders(owner, { 'idempotency-key': 'published-cas-a' }),
      mutationHeaders(owner, { 'idempotency-key': 'published-cas-b' }),
    ];
    const beforeRace = await fixture.readHistory(ids.published);
    const beforeRaceFacts = await lifecycleFacts(fixture, ids.published);
    const race = await Promise.all(
      raceHeaders.map((headers) =>
        application.inject({
          method: 'POST',
          url: lifecyclePath(workspaceId, ids.published, 'archive'),
          headers,
          payload: { expectedLifecycleRevision: 3 },
        }),
      ),
    );
    expect(race.map(({ statusCode }) => statusCode).sort()).toEqual([202, 409]);
    const conflict = race.find(({ statusCode }) => statusCode === 409);
    if (conflict === undefined)
      throw new Error('CAS conflict response missing');
    expectProblem(conflict, 409, 'workflow.lifecycle_conflict');
    expect(conflict.json()).toMatchObject({ currentLifecycleRevision: 4 });
    await expectHistoryUnchanged(fixture, ids.published, beforeRace);
    expect(await lifecycleFacts(fixture, ids.published)).toEqual({
      audit: beforeRaceFacts.audit + 1,
      reconciliationOutbox: beforeRaceFacts.reconciliationOutbox + 1,
    });
  });

  it('serves reads, draft ETags and history to a viewer, refuses its writes, and pages workflows by opaque cursor', async () => {
    const { application, ids, workspaceId } = fixture;
    const viewer = await fixture.login('viewer');
    const owner = await fixture.login('owner');
    const base = `/v1/workspaces/${workspaceId}/workflows`;
    const read = (url: string, cookies = viewer) =>
      application.inject({
        method: 'GET',
        url,
        headers: { cookie: cookies.cookieHeader },
      });

    const one = await read(`${base}/${ids.unpublished}`);
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json()).toMatchObject({
      workflow: { id: ids.unpublished, name: 'Unpublished lifecycle target' },
    });
    expect(one.json()).not.toHaveProperty('templateOrigin');
    expect(one.json()).not.toHaveProperty('workflow.createdBy');
    const withOrigin = await read(
      `${base}/${ids.unpublished}?include=templateOrigin`,
    );
    expect(withOrigin.statusCode, withOrigin.body).toBe(200);
    expect(withOrigin.json()).toMatchObject({ templateOrigin: null });

    const draft = await read(`${base}/${ids.unpublished}/draft`);
    expect(draft.statusCode, draft.body).toBe(200);
    const etag = String(draft.headers.etag);
    expect(etag).toMatch(/^"draft\./u);
    const revision = draft.json<{ revision: number }>().revision;
    const graph = draft.json<{ graph: unknown }>().graph;
    const validated = await application.inject({
      method: 'POST',
      url: `${base}/${ids.unpublished}/validate`,
      headers: mutationHeaders(viewer),
      payload: {},
    });
    expect([200, 503], validated.body).toContain(validated.statusCode);

    const versions = await read(`${base}/${ids.published}/versions`);
    expect(versions.statusCode, versions.body).toBe(200);
    const history = versions.json<{
      items: Record<string, unknown>[];
      nextCursor: string | null;
    }>();
    expect(history.items).toEqual([
      expect.objectContaining({
        id: ids.publishedVersion,
        workflowId: ids.published,
        versionNumber: 4,
      }),
    ]);
    expect(history.items[0]).not.toHaveProperty('workspaceId');
    expect(history.items[0]).not.toHaveProperty('publishedBy');
    expect(history.nextCursor).toBeNull();
    const named = await read(
      `${base}/${ids.published}/versions?include=publishedBy`,
    );
    expect(named.statusCode, named.body).toBe(200);
    expect(
      named.json<{ items: Record<string, unknown>[] }>().items[0],
    ).toMatchObject({
      id: ids.publishedVersion,
      publishedBy: {
        id: fixture.ownerUserId,
        displayName: 'Lifecycle owner',
      },
    });
    expect((await read(`${base}/${ids.unpublished}/versions`)).json()).toEqual({
      items: [],
      nextCursor: null,
    });
    expectProblem(
      await read(`${base}/${randomUUID()}/draft`),
      404,
      'resource.not_found',
    );
    const exact = await read(
      `${base}/${ids.published}/versions?versionId=${ids.publishedVersion}`,
    );
    expect(exact.json()).toMatchObject({
      items: [{ id: ids.publishedVersion }],
      nextCursor: null,
    });

    for (const [method, url, headers] of [
      ['PUT', `${base}/${ids.unpublished}/draft`, { 'if-match': etag }],
      ['POST', `${base}/${ids.unpublished}/publish`, { 'if-match': etag }],
    ] as const)
      expectProblem(
        await application.inject({
          method,
          url,
          headers: mutationHeaders(viewer, headers),
          payload: method === 'PUT' ? { graph } : {},
        }),
        404,
        'resource.not_found',
      );

    const stale = await application.inject({
      method: 'PUT',
      url: `${base}/${ids.unpublished}/draft`,
      headers: mutationHeaders(owner, {
        'if-match': '"draft.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"',
      }),
      payload: { graph },
    });
    expectProblem(stale, 412, 'workflow.revision_conflict');
    expect(stale.json()).toMatchObject({
      currentRevision: revision,
      currentEtag: etag,
    });
    const unchanged = await read(`${base}/${ids.unpublished}/draft`);
    expect(unchanged.headers.etag).toBe(etag);

    const created = await application.inject({
      method: 'POST',
      url: base,
      headers: mutationHeaders(owner),
      payload: { name: 'Third in the list' },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      workflow: { name: 'Third in the list' },
      draft: { revision: 1 },
    });
    expect(String(created.headers.etag)).toMatch(/^"draft\./u);

    for (const order of ['created_asc', 'updated_desc'] as const) {
      const seen: string[] = [];
      let after: string | null = '';
      while (after !== null) {
        const page = await read(
          `${base}?limit=1&order=${order}${after === '' ? '' : `&after=${encodeURIComponent(after)}`}`,
        );
        expect(page.statusCode, page.body).toBe(200);
        const body = page.json<{
          items: { id: string }[];
          nextCursor: string | null;
        }>();
        expect(body.items.length).toBeLessThanOrEqual(1);
        seen.push(...body.items.map(({ id }) => id));
        if (body.nextCursor !== null) {
          // A cursor is bound to the order that made it.
          const other =
            order === 'created_asc' ? 'updated_desc' : 'created_asc';
          expectProblem(
            await read(
              `${base}?limit=1&order=${other}&after=${encodeURIComponent(body.nextCursor)}`,
            ),
            400,
            'request.invalid',
          );
        }
        after = body.nextCursor;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(
        expect.arrayContaining([ids.unpublished, ids.published]),
      );
    }
    const versionsCursor = Buffer.from(
      JSON.stringify({ kind: 'versions', beforeVersionNumber: 2 }),
    ).toString('base64url');
    for (const after of ['not-a-cursor', versionsCursor])
      expectProblem(
        await read(`${base}?after=${after}`),
        400,
        'request.invalid',
      );
  });
});
