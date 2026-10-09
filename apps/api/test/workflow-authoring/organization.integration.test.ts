import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { expectProblem } from '../support/better-auth-real-api.integration.support.js';
import { useOrganizationOwnedApi } from '../support/workflow-organization-owned-api.fixture.js';

describe.skipIf(process.env.F07_ORGANIZATION_OWNED_FIXTURE !== 'true')(
  'owned real session organization HTTP',
  () => {
    const { api, fixture } = useOrganizationOwnedApi('f07-organization');
    it('requires real session/CSRF/single key and rejects untrusted private body fields', async () => {
      const f = await fixture(),
        url = `${f.route}/workflow-tags`;
      expectProblem(await api.send('GET', url), 401, 'auth.unauthenticated');
      expectProblem(
        await api.send('POST', url, {
          headers: {
            cookie: f.browser.cookie,
            'idempotency-key': randomUUID(),
          },
          payload: { key: 'ops' },
        }),
        403,
        'auth.forbidden',
      );
      for (const headers of [{}, { 'idempotency-key': 'first,second' }])
        expectProblem(
          await api.send('POST', url, {
            browser: f.browser,
            headers,
            payload: { key: 'ops' },
          }),
          400,
          'request.invalid',
        );
      for (const extra of ['actorId', 'generation', 'verifiedAbsence']) {
        const response = await api.send(
          'PUT',
          `${f.route}/workflows/${f.workflowId}/favorite`,
          {
            browser: f.browser,
            payload: { favorite: true, [extra]: 'private-marker' },
          },
        );
        expectProblem(response, 400, 'request.invalid');
        expect(response.payload).not.toContain('private-marker');
      }
    });

    it('serves strict default and projected reads, tag command recovery and favorites', async () => {
      const f = await fixture();
      const created = await api.send('POST', `${f.route}/workflow-tags`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { key: ' Ops ' },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const tag = created.json<{
        tag: { id: string; key: string; revision: number };
      }>().tag;
      expect(tag.key).toBe('ops');
      const key = randomUUID(),
        body = { tagIds: [tag.id], expectedOrganizationRevision: 1 };
      const url = `${f.route}/workflows/${f.workflowId}`;
      const first = await api.send('POST', `${url}/tags`, {
        browser: f.browser,
        headers: { 'idempotency-key': key },
        payload: body,
      });
      expect(first.statusCode, first.payload).toBe(200);
      const replay = await api.send('POST', `${url}/tags`, {
        browser: f.browser,
        headers: { 'idempotency-key': key },
        payload: body,
      });
      expect(replay.json()).toMatchObject({
        organizationRevision: 2,
        replayed: true,
      });
      expectProblem(
        await api.send('POST', `${url}/tags`, {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: body,
        }),
        409,
        'workflow.organization_revision_conflict',
      );
      const projected = await api.send('GET', `${url}?include=organization`, {
        browser: f.browser,
      });
      expect(projected.statusCode, projected.payload).toBe(200);
      expect(projected.headers['cache-control']).toBe('private, no-store');
      const organization = projected.json<{
        organization: { tags: unknown[]; organizationRevision: number };
      }>().organization;
      expect(organization.tags).toEqual([tag]);
      expect(Object.keys(organization).sort()).toEqual([
        'folderId',
        'isFavorite',
        'organizationRevision',
        'tags',
      ]);
      const favorite = await api.send('PUT', `${url}/favorite`, {
        browser: f.browser,
        payload: { favorite: true },
      });
      expect(favorite.statusCode, favorite.payload).toBe(200);
      const original = await api.send('GET', url, { browser: f.browser });
      expect(Object.keys(original.json()).sort()).toEqual(['workflow']);
      const combined = await api.send(
        'GET',
        `${url}?include=templateOrigin,organization`,
        { browser: f.browser },
      );
      expect(combined.statusCode, combined.payload).toBe(200);
      expect(combined.json()).toMatchObject({
        templateOrigin: null,
        organization: { isFavorite: true },
      });
      const defaultList = await api.send('GET', `${f.route}/workflows`, {
        browser: f.browser,
      });
      expect(
        defaultList.json<{ items: object[] }>().items[0],
      ).not.toHaveProperty('organization');
    });

    it('filters literally before pagination and rejects cursor filter/purpose tampering over HTTP', async () => {
      const f = await fixture();
      const tagReply = await api.send('POST', `${f.route}/workflow-tags`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { key: 'selected' },
      });
      const tagId = tagReply.json<{ tag: { id: string } }>().tag.id;
      const second = await api.send('POST', `${f.route}/workflows`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Second%_\\' },
      });
      const secondId = second.json<{ workflow: { id: string } }>().workflow.id;
      for (const workflowId of [f.workflowId, secondId]) {
        const response = await api.send(
          'POST',
          `${f.route}/workflows/${workflowId}/tags`,
          {
            browser: f.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { tagIds: [tagId], expectedOrganizationRevision: 1 },
          },
        );
        expect(response.statusCode, response.payload).toBe(200);
      }
      const query = `query=${encodeURIComponent('%_\\')}&tagId=${tagId}&include=organization&limit=1`;
      const first = await api.send('GET', `${f.route}/workflows?${query}`, {
        browser: f.browser,
      });
      expect(first.statusCode, first.payload).toBe(200);
      const page = first.json<{
        items: { workflow: { id: string } }[];
        nextCursor: string;
      }>();
      expect(page.items.map((item) => item.workflow.id)).toEqual([
        f.workflowId,
      ]);
      const last = await api.send(
        'GET',
        `${f.route}/workflows?${query}&after=${encodeURIComponent(page.nextCursor)}`,
        { browser: f.browser },
      );
      expect(
        last
          .json<{ items: { workflow: { id: string } }[]; nextCursor: null }>()
          .items.map((item) => item.workflow.id),
      ).toEqual([secondId]);
      expectProblem(
        await api.send(
          'GET',
          `${f.route}/workflows?${query}&view=active&after=${encodeURIComponent(page.nextCursor)}`,
          { browser: f.browser },
        ),
        400,
        'request.invalid',
      );
      expectProblem(
        await api.send(
          'GET',
          `${f.route}/workflow-tags?after=${encodeURIComponent(page.nextCursor)}`,
          { browser: f.browser },
        ),
        400,
        'request.invalid',
      );
      const empty = await api.send(
        'GET',
        `${f.route}/workflows?tagId=${randomUUID()}&include=organization`,
        { browser: f.browser },
      );
      expect(empty.json()).toEqual({ items: [], nextCursor: null });
      const impossibleName = await api.send(
        'GET',
        `${f.route}/workflows?query=%00&include=organization`,
        { browser: f.browser },
      );
      expect(impossibleName.statusCode, impossibleName.payload).toBe(200);
      expect(impossibleName.json()).toEqual({ items: [], nextCursor: null });
    });

    it('preserves tag identity on rename and atomically deletes bounded archived assignments', async () => {
      const f = await fixture();
      const created = await api.send('POST', `${f.route}/workflow-tags`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { key: 'before-rename' },
      });
      const tag = created.json<{ tag: { id: string; revision: number } }>().tag;
      const workflow = `${f.route}/workflows/${f.workflowId}`;
      expect(
        (
          await api.send('POST', `${workflow}/tags`, {
            browser: f.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { tagIds: [tag.id], expectedOrganizationRevision: 1 },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await api.send('POST', `${workflow}/archive`, {
            browser: f.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { expectedLifecycleRevision: 1 },
          })
        ).statusCode,
      ).toBe(202);
      const renamed = await api.send(
        'POST',
        `${f.route}/workflow-tags/${tag.id}/rename`,
        {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { key: 'After-Rename', expectedTagRevision: tag.revision },
        },
      );
      expect(renamed.statusCode, renamed.payload).toBe(200);
      expect(renamed.json()).toMatchObject({
        tag: { id: tag.id, key: 'after-rename', revision: 2 },
      });
      const assigned = await api.send(
        'GET',
        `${f.route}/workflow-tags/${tag.id}/workflows?limit=1`,
        { browser: f.browser },
      );
      expect(assigned.statusCode, assigned.payload).toBe(200);
      expect(assigned.json()).toEqual({
        items: [{ workflowId: f.workflowId, organizationRevision: 2 }],
        nextCursor: null,
      });
      const before = (
        await api.send('GET', `${workflow}?include=organization`, {
          browser: f.browser,
        })
      ).json<{ workflow: object }>().workflow;
      const key = randomUUID(),
        url = `${f.route}/workflow-tags/${tag.id}/delete`,
        payload = { expectedTagRevision: 2 };
      const deleted = await api.send('POST', url, {
        browser: f.browser,
        headers: { 'idempotency-key': key },
        payload,
      });
      expect(deleted.statusCode, deleted.payload).toBe(200);
      expect(deleted.json()).toEqual({
        tagId: tag.id,
        deleted: true,
        detachedWorkflowCount: 1,
        replayed: false,
      });
      expect(
        (
          await api.send('POST', url, {
            browser: f.browser,
            headers: { 'idempotency-key': key },
            payload,
          })
        ).json(),
      ).toMatchObject({ replayed: true });
      const after = (
        await api.send('GET', `${workflow}?include=organization`, {
          browser: f.browser,
        })
      ).json<{ workflow: object; organization: object }>();
      expect(after.workflow).toEqual(before);
      expect(after.organization).toMatchObject({
        tags: [],
        organizationRevision: 3,
      });
    });

    it('keeps viewer favorites private while enforcing current admin/editor roles', async () => {
      const f = await fixture(),
        url = `${f.route}/workflows/${f.workflowId}`;
      expect(
        (
          await api.send('PUT', `${url}/favorite`, {
            browser: f.browser,
            payload: { favorite: true },
          })
        ).statusCode,
      ).toBe(200);
      for (const role of ['viewer', 'builder', 'admin'] as const) {
        const email = `${randomUUID()}@example.test`;
        await api.signUp(email, '/login?verified=true');
        const member = await api.signIn(email);
        const userId = (
          await api.send('GET', '/v1/users/me', { browser: member })
        ).json<{ id: string }>().id;
        // Real user/session; privileged fixture membership setup is not invitation proof.
        await api
          .database()
          .query(
            "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')",
            [f.workspaceId, userId, role],
          );
        const projection = await api.send(
          'GET',
          `${url}?include=organization`,
          { browser: member },
        );
        expect(projection.statusCode, projection.payload).toBe(200);
        const metadata = projection.json<{
          organization: {
            isFavorite: boolean;
            organizationRevision: number;
          };
        }>().organization;
        expect(metadata.isFavorite).toBe(false);
        const create = await api.send('POST', `${f.route}/workflow-tags`, {
          browser: member,
          headers: { 'idempotency-key': randomUUID() },
          payload: { key: `${role}-tag` },
        });
        if (role === 'admin')
          expect(create.statusCode, create.payload).toBe(201);
        else expectProblem(create, 403, 'auth.forbidden');
        const replacement = await api.send('POST', `${url}/tags`, {
          browser: member,
          headers: { 'idempotency-key': randomUUID() },
          payload: {
            tagIds: [],
            expectedOrganizationRevision: metadata.organizationRevision,
          },
        });
        if (role === 'viewer')
          expectProblem(replacement, 404, 'resource.not_found');
        else expect(replacement.statusCode, replacement.payload).toBe(200);
        const starred = await api.send('PUT', `${url}/favorite`, {
          browser: member,
          payload: { favorite: true },
        });
        expect(starred.statusCode, starred.payload).toBe(200);
        await api
          .database()
          .query(
            "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
            [f.workspaceId, userId],
          );
        expectProblem(
          await api.send(
            'GET',
            `${f.route}/workflows?favoritesOnly=true&include=organization`,
            { browser: member },
          ),
          404,
          'resource.not_found',
        );
      }
    });
  },
);
