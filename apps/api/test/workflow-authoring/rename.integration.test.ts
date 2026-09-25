import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  WorkflowRenameResponse,
  WorkflowSummaryResponse,
} from '@pertexo/contracts/workflow-authoring';

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

function renamePath(workspaceId: string, workflowId: string): string {
  return `/v1/workspaces/${workspaceId}/workflows/${workflowId}/rename`;
}

describeIntegration(
  'authenticated workflow rename HTTP command (ADR 041)',
  () => {
    let fixture: WorkflowLifecycleApiFixture;

    beforeEach(async () => {
      fixture = await createWorkflowLifecycleApiFixture();
    });

    afterEach(async () => {
      await closeWorkflowLifecycleApiFixture(fixture);
    });

    async function renamedFacts(workflowId: string) {
      return fixture.withOwner(async (client) => {
        const result = await client.query<{
          name: string;
          name_revision: number;
          audits: string;
        }>(
          `select name,name_revision,
                (select count(*) from app.audit_events
                  where target_id=$1 and action='workflow.renamed')::text audits
           from app.workflows where id=$1`,
          [workflowId],
        );
        return result.rows[0];
      });
    }

    it('requires a session, CSRF, one key and a strict body', async () => {
      const { application, ids, workspaceId } = fixture;
      const owner = await fixture.login('owner');
      const url = renamePath(workspaceId, ids.unpublished);
      const payload = { name: 'Renamed', expectedNameRevision: 1 };

      expectProblem(
        await application.inject({ method: 'POST', url, payload }),
        401,
        'auth.unauthenticated',
      );
      expectProblem(
        await application.inject({
          method: 'POST',
          url,
          headers: { cookie: owner.cookieHeader, 'idempotency-key': 'no-csrf' },
          payload,
        }),
        403,
        'auth.forbidden',
      );
      for (const headers of [
        { cookie: owner.cookieHeader, 'x-csrf-token': owner.csrf },
        mutationHeaders(owner, { 'idempotency-key': 'first,second' }),
      ])
        expectProblem(
          await application.inject({ method: 'POST', url, headers, payload }),
          400,
          'request.invalid',
        );
      for (const invalid of [
        { ...payload, lifecycleStatus: 'archived' },
        { name: '   ', expectedNameRevision: 1 },
        { name: 'Renamed', expectedNameRevision: 0 },
      ])
        expectProblem(
          await application.inject({
            method: 'POST',
            url,
            headers: mutationHeaders(owner),
            payload: invalid,
          }),
          400,
          'request.invalid',
        );
      expect(await renamedFacts(ids.unpublished)).toMatchObject({
        name: 'Unpublished lifecycle target',
        name_revision: 1,
      });
    });

    it('lets editors rename and hides the command from other roles and tenants', async () => {
      const { application, ids, workspaceId } = fixture;
      for (const role of ['operator', 'viewer'] as const) {
        const cookies = await fixture.login(role);
        expectProblem(
          await application.inject({
            method: 'POST',
            url: renamePath(workspaceId, ids.unpublished),
            headers: mutationHeaders(cookies),
            payload: { name: `By ${role}`, expectedNameRevision: 1 },
          }),
          404,
          'resource.not_found',
        );
      }
      const builder = await fixture.login('builder');
      expectProblem(
        await application.inject({
          method: 'POST',
          url: renamePath(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            ids.unpublished,
          ),
          headers: mutationHeaders(builder),
          payload: { name: 'Elsewhere', expectedNameRevision: 1 },
        }),
        404,
        'resource.not_found',
      );
      const renamed = await application.inject({
        method: 'POST',
        url: renamePath(workspaceId, ids.unpublished),
        headers: mutationHeaders(builder),
        payload: { name: 'Renamed by a builder', expectedNameRevision: 1 },
      });
      expect(renamed.statusCode, renamed.payload).toBe(200);
      expect(renamed.json<WorkflowRenameResponse>()).toMatchObject({
        replayed: false,
        workflow: { name: 'Renamed by a builder', nameRevision: 2 },
      });

      await fixture.setWorkspaceStatus('suspended');
      try {
        const owner = await fixture.login('owner');
        expectProblem(
          await application.inject({
            method: 'POST',
            url: renamePath(workspaceId, ids.unpublished),
            headers: mutationHeaders(owner),
            payload: { name: 'While suspended', expectedNameRevision: 2 },
          }),
          404,
          'resource.not_found',
        );
      } finally {
        await fixture.setWorkspaceStatus('active');
      }
    });

    it('renames once under concurrent exact retries and reports stale revisions', async () => {
      const { application, ids, workspaceId } = fixture;
      const owner = await fixture.login('owner');
      const url = renamePath(workspaceId, ids.published);
      const headers = mutationHeaders(owner, {
        'idempotency-key': 'rename-once',
      });
      const payload = {
        name: 'Published and renamed',
        expectedNameRevision: 1,
      };
      const history = await fixture.readHistory(ids.published);
      const lifecycle = await fixture.readLifecycle(ids.published);

      const responses = await Promise.all([
        application.inject({ method: 'POST', url, headers, payload }),
        application.inject({ method: 'POST', url, headers, payload }),
      ]);
      expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
      const bodies = responses.map((response) =>
        response.json<WorkflowRenameResponse>(),
      );
      expect(bodies.map(({ replayed }) => replayed).sort()).toEqual([
        false,
        true,
      ]);
      expect(bodies[0]?.workflow).toEqual(bodies[1]?.workflow);
      expect(bodies[0]?.workflow).toMatchObject({
        id: ids.published,
        name: 'Published and renamed',
        nameRevision: 2,
        lifecycleRevision: lifecycle.lifecycleRevision,
        publishedVersionId: ids.publishedVersion,
      });

      const current = await application.inject({
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/workflows/${ids.published}`,
        headers: { cookie: owner.cookieHeader },
      });
      expect(current.json<WorkflowSummaryResponse>().workflow).toMatchObject({
        name: 'Published and renamed',
        nameRevision: 2,
      });
      expectProblem(
        await application.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...payload, name: 'Another name' },
        }),
        409,
        'request.idempotency_conflict',
      );
      const stale = await application.inject({
        method: 'POST',
        url,
        headers: mutationHeaders(owner),
        payload: { name: 'Stale name', expectedNameRevision: 1 },
      });
      expectProblem(stale, 409, 'workflow.name_conflict');
      expect(stale.json()).toMatchObject({ currentNameRevision: 2 });
      expect(stale.json()).not.toHaveProperty('currentLifecycleRevision');

      expect(await fixture.readHistory(ids.published)).toEqual(history);
      expect(await fixture.readLifecycle(ids.published)).toEqual(lifecycle);
      expect(await renamedFacts(ids.published)).toEqual({
        name: 'Published and renamed',
        name_revision: 2,
        audits: '1',
      });
    });

    it('keeps an archived workflow read-only until it is restored', async () => {
      const { application, ids, workspaceId } = fixture;
      const owner = await fixture.login('owner');
      const archived = await application.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/workflows/${ids.unpublished}/archive`,
        headers: mutationHeaders(owner),
        payload: { expectedLifecycleRevision: 1 },
      });
      expect(archived.statusCode, archived.payload).toBe(202);
      expectProblem(
        await application.inject({
          method: 'POST',
          url: renamePath(workspaceId, ids.unpublished),
          headers: mutationHeaders(owner),
          payload: { name: 'Archived rename', expectedNameRevision: 1 },
        }),
        404,
        'resource.not_found',
      );
      expect(await renamedFacts(ids.unpublished)).toEqual({
        name: 'Unpublished lifecycle target',
        name_revision: 1,
        audits: '0',
      });
    });
  },
);
