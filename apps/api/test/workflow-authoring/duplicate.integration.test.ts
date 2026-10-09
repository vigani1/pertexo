import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowDuplicateResponse } from '@pertexo/contracts';
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
describeIntegration(
  'authenticated atomic workflow duplication HTTP command (ADR060)',
  () => {
    let fixture: WorkflowLifecycleApiFixture;
    beforeEach(async () => {
      fixture = await createWorkflowLifecycleApiFixture();
    });
    afterEach(async () => {
      await closeWorkflowLifecycleApiFixture(fixture);
    });

    it('copies the saved draft once for concurrent exact requests and retains recovery after a source save', async () => {
      const { application, workspaceId, ids } = fixture;
      const session = await fixture.login('builder');
      const base = `/v1/workspaces/${workspaceId}/workflows/${ids.published}`;
      const original = await fixture.readHistory(ids.published);
      const draft = await application.inject({
        method: 'GET',
        url: `${base}/draft`,
        headers: { cookie: session.cookieHeader },
      });
      expect(draft.statusCode, draft.payload).toBe(200);
      const headers = mutationHeaders(session, {
        'if-match': String(draft.headers.etag),
        'idempotency-key': 'copy-concurrent',
      });
      const payload = {
        name: 'Independent saved copy',
        source: { kind: 'draft' },
      };
      const command = {
        method: 'POST' as const,
        url: `${base}/duplicate`,
        headers,
        payload,
      };
      const responses = await Promise.all([
        application.inject(command),
        application.inject(command),
      ]);
      for (const response of responses)
        expect(response.statusCode, response.payload).toBe(201);
      const result = responses[0].json<WorkflowDuplicateResponse>();
      expect(Object.keys(result)).toEqual(['workflowId']);
      expect(result.workflowId).not.toBe(ids.published);
      expect(responses[1].json()).toEqual(result);
      expect(responses[0].headers.location).toBe(
        `/v1/workspaces/${workspaceId}/workflows/${result.workflowId}`,
      );
      expect(await fixture.readHistory(result.workflowId)).toMatchObject({
        draft: { revision: 1, graph: original.draft.graph },
        versions: [],
        runs: [],
      });
      expect(await fixture.readLifecycle(result.workflowId)).toMatchObject({
        lifecycleStatus: 'active',
        activationStatus: 'inactive',
        publishedVersionId: null,
        lifecycleRevision: 1,
      });
      const saved = await application.inject({
        method: 'PUT',
        url: `${base}/draft`,
        headers: mutationHeaders(session, {
          'if-match': String(draft.headers.etag),
        }),
        payload: { graph: original.draft.graph },
      });
      expect(saved.statusCode, saved.payload).toBe(200);
      const recovered = await application.inject(command);
      expect(recovered.statusCode, recovered.payload).toBe(201);
      expect(recovered.json()).toEqual(result);
      expectProblem(
        await application.inject({
          ...command,
          payload: { ...payload, name: 'Changed intent' },
        }),
        409,
        'request.idempotency_conflict',
      );
      expectProblem(
        await application.inject({
          ...command,
          headers: { ...headers, 'idempotency-key': 'fresh-stale-copy' },
        }),
        412,
        'workflow.revision_conflict',
      );
      expect(await fixture.readHistory(result.workflowId)).toMatchObject({
        draft: { revision: 1, graph: original.draft.graph },
      });
    });

    it('selects the exact retained version without a draft tag and does not publish or copy history', async () => {
      const { application, workspaceId, ids } = fixture;
      const session = await fixture.login('owner');
      const original = await fixture.readHistory(ids.published);
      const response = await application.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/workflows/${ids.published}/duplicate`,
        headers: mutationHeaders(session),
        payload: {
          name: 'Exact version copy',
          source: { kind: 'version', versionId: ids.publishedVersion },
        },
      });
      expect(response.statusCode, response.payload).toBe(201);
      const { workflowId } = response.json<WorkflowDuplicateResponse>();
      expect(await fixture.readHistory(workflowId)).toMatchObject({
        draft: { revision: 1, graph: original.versions[0]?.graph },
        versions: [],
        runs: [],
      });
      expect(await fixture.readHistory(ids.published)).toEqual(original);
      expect(await fixture.readLifecycle(workflowId)).toMatchObject({
        publishedVersionId: null,
        activationStatus: 'inactive',
      });
    });

    it('requires authentication, CSRF, one key, conditional strong tag and strict server-selected source', async () => {
      const { application, workspaceId, ids } = fixture;
      const session = await fixture.login('owner');
      const url = `/v1/workspaces/${workspaceId}/workflows/${ids.unpublished}/duplicate`;
      const payload = { name: 'Copy', source: { kind: 'draft' } };
      expectProblem(
        await application.inject({ method: 'POST', url, payload }),
        401,
        'auth.unauthenticated',
      );
      expectProblem(
        await application.inject({
          method: 'POST',
          url,
          payload,
          headers: {
            cookie: session.cookieHeader,
            'idempotency-key': 'no-csrf',
          },
        }),
        403,
        'auth.forbidden',
      );
      expectProblem(
        await application.inject({
          method: 'POST',
          url,
          payload,
          headers: mutationHeaders(session),
        }),
        428,
        'request.precondition_required',
      );
      for (const value of ['*', 'W/"tag"', '"bad"'])
        expectProblem(
          await application.inject({
            method: 'POST',
            url,
            payload,
            headers: mutationHeaders(session, { 'if-match': value }),
          }),
          400,
          'request.invalid',
        );
      for (const invalid of [
        { ...payload, graph: {} },
        { ...payload, workspaceId },
        {
          name: 'Copy',
          source: { kind: 'draft', versionId: ids.publishedVersion },
        },
      ])
        expectProblem(
          await application.inject({
            method: 'POST',
            url,
            payload: invalid,
            headers: mutationHeaders(session),
          }),
          400,
          'request.invalid',
        );
      expectProblem(
        await application.inject({
          method: 'POST',
          url,
          payload: {
            name: 'Version',
            source: { kind: 'version', versionId: ids.publishedVersion },
          },
          headers: mutationHeaders(session, {
            'idempotency-key': 'first,second',
          }),
        }),
        400,
        'request.invalid',
      );
    });

    it('hides source/version/tenant mismatches and denies read-only roles and suspended workspaces', async () => {
      const { application, workspaceId, ids } = fixture;
      const payload = {
        name: 'Copy',
        source: { kind: 'version', versionId: ids.publishedVersion },
      };
      const url = `/v1/workspaces/${workspaceId}/workflows/${ids.published}/duplicate`;
      for (const role of ['operator', 'viewer'] as const) {
        const session = await fixture.login(role);
        expectProblem(
          await application.inject({
            method: 'POST',
            url,
            headers: mutationHeaders(session),
            payload,
          }),
          404,
          'resource.not_found',
        );
      }
      const owner = await fixture.login('owner');
      for (const invalidUrl of [
        `/v1/workspaces/${randomUUID()}/workflows/${ids.published}/duplicate`,
        `/v1/workspaces/${workspaceId}/workflows/${ids.unpublished}/duplicate`,
      ])
        expectProblem(
          await application.inject({
            method: 'POST',
            url: invalidUrl,
            headers: mutationHeaders(owner),
            payload,
          }),
          404,
          'resource.not_found',
        );
      const foreignVersion = await fixture.createForeignVersion();
      expectProblem(
        await application.inject({
          method: 'POST',
          url,
          headers: mutationHeaders(owner),
          payload: {
            ...payload,
            source: { kind: 'version', versionId: foreignVersion },
          },
        }),
        404,
        'resource.not_found',
      );
      await fixture.setWorkspaceStatus('suspended');
      try {
        expectProblem(
          await application.inject({
            method: 'POST',
            url,
            headers: mutationHeaders(owner),
            payload,
          }),
          404,
          'resource.not_found',
        );
      } finally {
        await fixture.setWorkspaceStatus('active');
      }
    });
  },
);
