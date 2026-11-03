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
} from './lifecycle/fixture.js';
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
});
