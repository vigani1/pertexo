import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeWorkflowLifecycleApiFixture,
  createWorkflowLifecycleApiFixture,
  expectProblem,
  mutationHeaders,
  type WorkflowLifecycleApiFixture,
  workflowLifecycleIntegrationEnabled,
} from '../support/workflow-lifecycle.integration.support.js';

const describeIntegration = workflowLifecycleIntegrationEnabled
  ? describe
  : describe.skip;

describeIntegration('authenticated immutable version restoration', () => {
  let fixture: WorkflowLifecycleApiFixture;
  beforeEach(async () => {
    fixture = await createWorkflowLifecycleApiFixture();
  });
  afterEach(async () => {
    await closeWorkflowLifecycleApiFixture(fixture);
  });

  it.each(['owner', 'builder'] as const)(
    'lets an active %s restore only the draft with a fresh tag and rejects stale retries',
    async (role) => {
      const { application, workspaceId, ids } = fixture;
      const owner = await fixture.login(role);
      const base = `/v1/workspaces/${workspaceId}/workflows/${ids.published}`;
      const url = `${base}/versions/${ids.publishedVersion}/restore`;
      const original = await fixture.readHistory(ids.published);
      const lifecycle = await fixture.readLifecycle(ids.published);
      expect(original.runs).toHaveLength(1);
      const current = await application.inject({
        method: 'GET',
        url: `${base}/draft`,
        headers: { cookie: owner.cookieHeader },
      });
      expect(current.statusCode).toBe(200);
      const tag = String(current.headers.etag);
      const headers = mutationHeaders(owner, { 'if-match': tag });
      const restored = await application.inject({
        method: 'POST',
        url,
        headers,
        payload: {},
      });
      expect(restored.statusCode, restored.body).toBe(200);
      expect(restored.headers.etag).not.toBe(tag);
      expect(restored.json()).toMatchObject({
        revision: original.draft.revision + 1,
        graph: original.versions[0]?.graph,
      });
      const stale = await application.inject({
        method: 'POST',
        url,
        headers,
        payload: {},
      });
      expectProblem(stale, 412, 'workflow.revision_conflict');
      expect(stale.headers.etag).toBe(restored.headers.etag);
      const identical = await application.inject({
        method: 'POST',
        url,
        headers: mutationHeaders(owner, {
          'if-match': String(restored.headers.etag),
        }),
        payload: {},
      });
      expect(identical.statusCode, identical.body).toBe(200);
      expect(identical.json()).toMatchObject({
        revision: original.draft.revision + 2,
      });
      expect(identical.headers.etag).not.toBe(restored.headers.etag);
      const after = await fixture.readHistory(ids.published);
      expect(after.versions).toEqual(original.versions);
      expect(after.runs).toEqual(original.runs);
      expect(await fixture.readLifecycle(ids.published)).toEqual(lifecycle);
    },
  );

  it('rejects version restoration into an archived workflow without changing lifecycle or history', async () => {
    const { application, workspaceId, ids } = fixture;
    const owner = await fixture.login('owner');
    const base = `/v1/workspaces/${workspaceId}/workflows/${ids.published}`;
    const current = await application.inject({
      method: 'GET',
      url: `${base}/draft`,
      headers: { cookie: owner.cookieHeader },
    });
    const original = await fixture.readHistory(ids.published);
    const archived = await application.inject({
      method: 'POST',
      url: `${base}/archive`,
      headers: mutationHeaders(owner),
      payload: { expectedLifecycleRevision: 1 },
    });
    expect(archived.statusCode, archived.body).toBe(202);

    const restored = await application.inject({
      method: 'POST',
      url: `${base}/versions/${ids.publishedVersion}/restore`,
      headers: mutationHeaders(owner, {
        'if-match': String(current.headers.etag),
      }),
      payload: {},
    });
    expectProblem(restored, 404, 'resource.not_found');
    const after = await fixture.readHistory(ids.published);
    expect(after).toEqual(original);
    expect(await fixture.readLifecycle(ids.published)).toEqual({
      lifecycleStatus: 'archived',
      lifecycleRevision: 2,
      activationStatus: 'deactivating',
      publishedVersionId: ids.publishedVersion,
    });
  });

  it('hides unknown and cross-tenant retained version sources without mutating the draft', async () => {
    const { application, workspaceId, ids } = fixture;
    const owner = await fixture.login('owner');
    const base = `/v1/workspaces/${workspaceId}/workflows/${ids.published}`;
    const current = await application.inject({
      method: 'GET',
      url: `${base}/draft`,
      headers: { cookie: owner.cookieHeader },
    });
    const tag = String(current.headers.etag);
    const before = await fixture.readHistory(ids.published);
    const foreignVersionId = await fixture.createForeignVersion();

    for (const sourceVersionId of [randomUUID(), foreignVersionId]) {
      const response = await application.inject({
        method: 'POST',
        url: `${base}/versions/${sourceVersionId}/restore`,
        headers: mutationHeaders(owner, { 'if-match': tag }),
        payload: {},
      });
      expectProblem(response, 404, 'resource.not_found');
    }
    expect(await fixture.readHistory(ids.published)).toEqual(before);
  });

  it('enforces authentication, CSRF, strict body, source identity and active update authority', async () => {
    const { application, workspaceId, ids } = fixture;
    const owner = await fixture.login('owner');
    const base = `/v1/workspaces/${workspaceId}/workflows/${ids.published}`;
    const url = `${base}/versions/${ids.publishedVersion}/restore`;
    const current = await application.inject({
      method: 'GET',
      url: `${base}/draft`,
      headers: { cookie: owner.cookieHeader },
    });
    const tag = String(current.headers.etag);
    const before = await fixture.readHistory(ids.published);
    expectProblem(
      await application.inject({ method: 'POST', url, payload: {} }),
      401,
      'auth.unauthenticated',
    );
    expectProblem(
      await application.inject({
        method: 'POST',
        url,
        headers: { cookie: owner.cookieHeader, 'if-match': tag },
        payload: {},
      }),
      403,
      'auth.forbidden',
    );
    expectProblem(
      await application.inject({
        method: 'POST',
        url,
        headers: mutationHeaders(owner),
        payload: {},
      }),
      428,
      'request.precondition_required',
    );
    expectProblem(
      await application.inject({
        method: 'POST',
        url,
        headers: mutationHeaders(owner, { 'if-match': tag }),
        payload: { publish: true },
      }),
      400,
      'request.invalid',
    );
    for (const role of ['operator', 'viewer'] as const) {
      const member = await fixture.login(role);
      expectProblem(
        await application.inject({
          method: 'POST',
          url,
          headers: mutationHeaders(member, { 'if-match': tag }),
          payload: {},
        }),
        404,
        'resource.not_found',
      );
    }
    const wrongWorkflow = url.replace(ids.published, ids.unpublished);
    const otherDraft = await application.inject({
      method: 'GET',
      url: `${base.replace(ids.published, ids.unpublished)}/draft`,
      headers: { cookie: owner.cookieHeader },
    });
    expectProblem(
      await application.inject({
        method: 'POST',
        url: wrongWorkflow,
        headers: mutationHeaders(owner, {
          'if-match': String(otherDraft.headers.etag),
        }),
        payload: {},
      }),
      404,
      'resource.not_found',
    );
    for (const status of ['suspended', 'pending_deletion'] as const) {
      await fixture.setWorkspaceStatus(status);
      try {
        const currentOwner = await fixture.login('owner');
        expectProblem(
          await application.inject({
            method: 'POST',
            url,
            headers: mutationHeaders(currentOwner, { 'if-match': tag }),
            payload: {},
          }),
          404,
          'resource.not_found',
        );
      } finally {
        await fixture.setWorkspaceStatus('active');
      }
    }
    expect(await fixture.readHistory(ids.published)).toEqual(before);
  });
});
