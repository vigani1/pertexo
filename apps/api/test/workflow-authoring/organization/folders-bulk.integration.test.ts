import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../support/better-auth-real-api.integration.support.js';
import { useOrganizationOwnedApi } from '../../support/workflow-organization-owned-api.fixture.js';

describe.skipIf(process.env.F07_ORGANIZATION_OWNED_FIXTURE !== 'true')(
  'owned real session folders and bulk HTTP',
  () => {
    const { api, fixture } = useOrganizationOwnedApi('f07-folders-bulk');
    async function createFolder(
      f: Awaited<ReturnType<typeof fixture>>,
      name = 'Ops',
      parentId: string | null = null,
    ) {
      const response = await api.send('POST', `${f.route}/workflow-folders`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name, parentId },
      });
      expect(response.statusCode, response.payload).toBe(201);
      return response.json<{
        folder: { id: string; name: string; revision: number; depth: number };
      }>().folder;
    }

    it('serves real folder CRUD, shared placement revisions, exact filters and nonempty conflicts', async () => {
      const f = await fixture(),
        destination = await createFolder(f, ' Ops ');
      expect(destination).toMatchObject({ name: 'Ops', revision: 1, depth: 1 });
      expectProblem(
        await api.send('POST', `${f.route}/workflow-folders`, {
          headers: {
            cookie: f.browser.cookie,
            'idempotency-key': randomUUID(),
          },
          payload: { name: 'Missing CSRF', parentId: null },
        }),
        403,
        'auth.forbidden',
      );
      expectProblem(
        await api.send('POST', `${f.route}/workflow-folders`, {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: {
            name: 'Private input',
            parentId: null,
            actorId: randomUUID(),
          },
        }),
        400,
        'request.invalid',
      );
      const child = await createFolder(f, 'Child', destination.id);
      const placement = { folderId: child.id, expectedOrganizationRevision: 1 };
      const key = randomUUID();
      const sendPlacement = () =>
        api.send('POST', `${f.route}/workflows/${f.workflowId}/folder`, {
          browser: f.browser,
          headers: { 'idempotency-key': key },
          payload: placement,
        });
      const placed = await sendPlacement();
      expect(placed.statusCode, placed.payload).toBe(200);
      expect(placed.json()).toEqual({
        workflowId: f.workflowId,
        folderId: child.id,
        organizationRevision: 2,
        replayed: false,
      });
      expect((await sendPlacement()).json()).toMatchObject({ replayed: true });
      for (const [folderId, expected] of [
        [destination.id, 0],
        [child.id, 1],
        ['root', 0],
      ] as const) {
        const page = await api.send(
          'GET',
          `${f.route}/workflows?folderId=${folderId}&include=organization`,
          { browser: f.browser },
        );
        expect(page.statusCode, page.payload).toBe(200);
        expect(page.json<{ items: unknown[] }>().items).toHaveLength(expected);
      }
      const rename = await api.send(
        'POST',
        `${f.route}/workflow-folders/${child.id}/rename`,
        {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { name: 'New child', expectedFolderRevision: 1 },
        },
      );
      expect(rename.statusCode, rename.payload).toBe(200);
      expect(rename.json()).toMatchObject({ folder: { revision: 2 } });
      const moved = await api.send(
        'POST',
        `${f.route}/workflow-folders/${child.id}/move`,
        {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { parentId: null, expectedFolderRevision: 2 },
        },
      );
      expect(moved.statusCode, moved.payload).toBe(200);
      expect(moved.json()).toMatchObject({
        folder: { parentId: null, revision: 3, depth: 1 },
      });
      expectProblem(
        await api.send(
          'POST',
          `${f.route}/workflow-folders/${child.id}/delete`,
          {
            browser: f.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { expectedFolderRevision: 3 },
          },
        ),
        409,
        'workflow.folder_not_empty',
      );
      const unfile = await api.send(
        'POST',
        `${f.route}/workflows/${f.workflowId}/folder`,
        {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { folderId: null, expectedOrganizationRevision: 2 },
        },
      );
      expect(unfile.statusCode, unfile.payload).toBe(200);
      expect(
        (
          await api.send(
            'POST',
            `${f.route}/workflow-folders/${child.id}/delete`,
            {
              browser: f.browser,
              headers: { 'idempotency-key': randomUUID() },
              payload: { expectedFolderRevision: 3 },
            },
          )
        ).statusCode,
      ).toBe(200);
      const folders = await api.send('GET', `${f.route}/workflow-folders`, {
        browser: f.browser,
      });
      expect(folders.headers['cache-control']).toBe('private, no-store');
      expect(folders.json<{ items: unknown[] }>().items).toHaveLength(1);
    });

    it('commits ordered partial bulk outcomes and binds changed/disjoint parents before any items', async () => {
      const f = await fixture(),
        foreign = await fixture(),
        destination = await createFolder(f);
      const key = randomUUID(),
        body = {
          operation: 'move',
          folderId: destination.id,
          items: [
            { workflowId: f.workflowId, expectedOrganizationRevision: 1 },
            { workflowId: foreign.workflowId, expectedOrganizationRevision: 1 },
          ],
        };
      const send = (payload: object, idempotencyKey = key) =>
        api.send('POST', `${f.route}/workflows/organization/bulk`, {
          browser: f.browser,
          headers: { 'idempotency-key': idempotencyKey },
          payload,
        });
      const first = await send(body);
      expect(first.statusCode, first.payload).toBe(200);
      expect(first.json()).toEqual({
        items: [
          {
            workflowId: f.workflowId,
            status: 'updated',
            organizationRevision: 2,
            replayed: false,
          },
          { workflowId: foreign.workflowId, status: 'not_visible' },
        ],
      });
      expect((await send(body)).json()).toMatchObject({
        items: [{ replayed: true }, { status: 'not_visible' }],
      });
      for (const changed of [
        { ...body, items: [...body.items].reverse() },
        {
          ...body,
          items: [
            { workflowId: randomUUID(), expectedOrganizationRevision: 1 },
          ],
        },
        { operation: 'replace_tags', tagIds: [], items: body.items },
      ])
        expectProblem(await send(changed), 409, 'request.idempotency_conflict');
      const stale = await send(
        { ...body, items: [body.items[0]] },
        randomUUID(),
      );
      expect(stale.json()).toEqual({
        items: [
          {
            workflowId: f.workflowId,
            status: 'conflict',
            code: 'workflow.organization_revision_conflict',
          },
        ],
      });
      const inaccessibleFolder = await send(
        {
          ...body,
          folderId: randomUUID(),
          items: [
            { workflowId: f.workflowId, expectedOrganizationRevision: 2 },
          ],
        },
        randomUUID(),
      );
      expect(inaccessibleFolder.json()).toEqual({
        items: [
          {
            workflowId: f.workflowId,
            status: 'conflict',
            code: 'workflow.folder_not_visible',
          },
        ],
      });
    });

    it('shares cleanup parent identity with general bulk and preserves archived placement', async () => {
      const f = await fixture(),
        destination = await createFolder(f);
      const tagResponse = await api.send('POST', `${f.route}/workflow-tags`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { key: 'cleanup' },
      });
      expect(tagResponse.statusCode, tagResponse.payload).toBe(201);
      const tagId = tagResponse.json<{ tag: { id: string } }>().tag.id;
      const initialPlacement = await api.send(
        'POST',
        `${f.route}/workflows/${f.workflowId}/folder`,
        {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: {
            folderId: destination.id,
            expectedOrganizationRevision: 1,
          },
        },
      );
      expect(initialPlacement.statusCode, initialPlacement.payload).toBe(200);
      const replacement = await api.send(
        'POST',
        `${f.route}/workflows/organization/bulk`,
        {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: {
            operation: 'replace_tags',
            tagIds: [tagId],
            items: [
              { workflowId: f.workflowId, expectedOrganizationRevision: 2 },
            ],
          },
        },
      );
      expect(replacement.statusCode, replacement.payload).toBe(200);
      expect(
        (
          await api.send(
            'POST',
            `${f.route}/workflows/${f.workflowId}/archive`,
            {
              browser: f.browser,
              headers: { 'idempotency-key': randomUUID() },
              payload: { expectedLifecycleRevision: 1 },
            },
          )
        ).statusCode,
      ).toBe(202);
      const key = randomUUID(),
        payload = {
          tagId,
          items: [
            { workflowId: f.workflowId, expectedOrganizationRevision: 3 },
          ],
        };
      const cleanup = () =>
        api.send('POST', `${f.route}/workflow-tags/cleanup/detach`, {
          browser: f.browser,
          headers: { 'idempotency-key': key },
          payload,
        });
      const detached = await cleanup();
      expect(detached.statusCode, detached.payload).toBe(200);
      expect(detached.json()).toEqual({
        items: [
          {
            workflowId: f.workflowId,
            status: 'detached',
            organizationRevision: 4,
            replayed: false,
          },
        ],
      });
      expect((await cleanup()).json()).toMatchObject({
        items: [{ replayed: true }],
      });
      expectProblem(
        await api.send('POST', `${f.route}/workflows/organization/bulk`, {
          browser: f.browser,
          headers: { 'idempotency-key': key },
          payload: { operation: 'move', folderId: null, items: payload.items },
        }),
        409,
        'request.idempotency_conflict',
      );
      const metadata = await api.send(
        'GET',
        `${f.route}/workflows/${f.workflowId}?include=organization`,
        { browser: f.browser },
      );
      expect(metadata.json()).toMatchObject({
        organization: {
          folderId: destination.id,
          tags: [],
          organizationRevision: 4,
        },
      });
    });

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
          items: [
            { workflowId: f.workflowId, expectedOrganizationRevision: 2 },
          ],
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
          await api.send(
            'POST',
            `${f.route}/workflows/${f.workflowId}/archive`,
            {
              browser: f.browser,
              headers: { 'idempotency-key': randomUUID() },
              payload: { expectedLifecycleRevision: 1 },
            },
          )
        ).statusCode,
      ).toBe(202);
      expectProblem(
        await singlePlacement(),
        409,
        'workflow.lifecycle_conflict',
      );
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
  },
);
