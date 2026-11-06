import {
  WorkflowFolderConflictError,
  WorkflowNotFoundError,
  WorkflowTagConflictError,
} from '@pertexo/core/authoring';
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import {
  actorId,
  cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture,
  folderId,
  headers,
  placement,
  prefix,
  routes,
  sessionId,
  setup,
  workflowId,
  workspaceId,
} from './batch-http.fixture.js';

afterEach(cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture);
describe('folder and batch HTTP routes with controlled session/persistence', () => {
  for (const route of routes) {
    it(`${route.method}: registers the exact route and forwards current scoped input`, async () => {
      const f = await setup();
      const response = await f.inject(route);
      expect(response.statusCode).toBe(route.status);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(f.port(route)).toHaveBeenCalledOnce();
      expect(f.port(route).mock.calls[0]?.[0]).toMatchObject({
        workspaceId,
        actorId,
        ...(route.method === 'list'
          ? {}
          : { idempotencyKey: headers['idempotency-key'] }),
      });
      if (route.method === 'cleanup')
        expect(response.json()).toEqual({
          items: [
            {
              workflowId,
              status: 'detached',
              organizationRevision: 2,
              replayed: false,
            },
          ],
        });
      if (route.method === 'bulk')
        expect(response.json()).toEqual({
          items: [
            {
              workflowId,
              status: 'updated',
              organizationRevision: 2,
              replayed: false,
            },
          ],
        });
      if (['rename', 'move', 'delete'].includes(route.method))
        expect(f.port(route).mock.calls[0]?.[0]).toMatchObject({ folderId });
      if (route.method === 'place')
        expect(f.folders.placeWorkflow.mock.calls[0]?.[0]).toMatchObject({
          workflowId,
          folderId: null,
          expectedOrganizationRevision: 1,
        });
    });
    it(`${route.method}: refuses malformed and private fields through HTTP`, async () => {
      const f = await setup();
      for (const extra of [
        { actorId },
        { workspaceId },
        { proof: true },
        { admission_xid: '42' },
        { idempotencyKey: 'body-key' },
        { currentRevision: 7 },
      ]) {
        const overrides =
          route.method === 'list'
            ? {
                url:
                  prefix +
                  route.url +
                  '?' +
                  new URLSearchParams(
                    Object.entries(extra).map(([name, value]) => [
                      name,
                      String(value),
                    ]),
                  ).toString(),
              }
            : { payload: { ...route.payload, ...extra } };
        expect((await f.inject(route, overrides)).statusCode).toBe(400);
      }
      if (route.method !== 'list')
        expect((await f.inject(route, { payload: null })).statusCode).toBe(400);
    });
    it(`${route.method}: unauthenticated or private input never reaches persistence`, async () => {
      const f = await setup();
      expect(
        (
          await f.inject(route, {
            headers: { ...headers, 'x-test-anonymous': 'true' },
          })
        ).statusCode,
      ).toBe(401);
      const overrides =
        route.method === 'list'
          ? { url: prefix + route.url + '?actorId=private&actorId=duplicate' }
          : {
              payload: {
                ...route.payload,
                actorId,
                proof: 'private',
                admission_xid: '42',
              },
            };
      expect((await f.inject(route, overrides)).statusCode).toBe(400);
      expect(f.port(route)).not.toHaveBeenCalled();
    });
    if (route.method !== 'list')
      it(`${route.method}: real CSRF and command key policy fence mutations`, async () => {
        const f = await setup();
        expect(
          (
            await f.inject(route, {
              headers: { 'idempotency-key': 'valid-key' },
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await f.inject(route, {
              headers: { ...headers, 'x-csrf-token': 'different' },
            })
          ).statusCode,
        ).toBe(403);
        const { 'idempotency-key': ignored, ...withoutKey } = headers;
        expect(ignored).toBeTruthy();
        for (const commandHeaders of [
          withoutKey,
          { ...headers, 'idempotency-key': '' },
          { ...headers, 'idempotency-key': ['first', 'second'] },
        ])
          expect(
            (await f.inject(route, { headers: commandHeaders })).statusCode,
          ).toBe(400);
        expect(f.port(route)).not.toHaveBeenCalled();
      });
  }
  it.each(
    routes.filter(
      (route) => route.method === 'bulk' || route.method === 'cleanup',
    ),
  )('refuses strict $method parents before admission', async (route) => {
    const f = await setup();
    for (const extra of [
      { actorId },
      { proof: true },
      { parentHash: folderId },
      { idempotencyKey: 'body-key' },
      { selectAll: true },
    ]) {
      expect(
        (await f.inject(route, { payload: { ...route.payload, ...extra } }))
          .statusCode,
      ).toBe(400);
    }
    for (const selection of [
      [],
      [
        { workflowId, expectedOrganizationRevision: 1 },
        { workflowId, expectedOrganizationRevision: 1 },
      ],
      [{ workflowId, expectedOrganizationRevision: 0 }],
      Array.from({ length: 51 }, (_, index) => ({
        workflowId: `${String(index).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        expectedOrganizationRevision: 1,
      })),
    ]) {
      expect(
        (
          await f.inject(route, {
            payload: { ...route.payload, items: selection },
          })
        ).statusCode,
      ).toBe(400);
    }
  });
  it('rejects invalid workspace/folder/workflow params and any nonempty read query', async () => {
    const f = await setup();
    for (const url of [
      '/v1/workspaces/invalid/workflow-folders',
      `${prefix}/workflow-folders/invalid/rename`,
      `${prefix}/workflows/invalid/folder`,
    ]) {
      expect(
        (
          await f.app.inject({
            method: url.endsWith('workflow-folders') ? 'GET' : 'POST',
            url,
            headers,
            ...(url.endsWith('workflow-folders')
              ? {}
              : { payload: routes[2].payload }),
          })
        ).statusCode,
        url,
      ).toBe(400);
    }
    for (const query of ['?limit=1', '?limit=1&limit=2', '?cursor=opaque'])
      expect(
        (
          await f.inject(routes[0], {
            url: prefix + '/workflow-folders' + query,
          })
        ).statusCode,
      ).toBe(400);
    for (const route of routes) expect(f.port(route)).not.toHaveBeenCalled();
  });

  it.each([
    'name',
    'limit',
    'revision',
    'hierarchy',
    'not_empty',
    'not_visible',
  ] as const)(
    'sanitizes folder %s conflicts into a 409 problem',
    async (kind) => {
      const f = await setup();
      const error = Object.assign(new WorkflowFolderConflictError(kind), {
        message: 'private-message',
        currentRevision: 99,
        body: { proof: 'private-proof' },
        cause: new Error('private-cause'),
      });
      f.folders.createFolder.mockRejectedValueOnce(error);
      const response = await f.inject(routes[1]);
      expect(response.statusCode).toBe(409);
      expect(response.json<{ code: string }>().code).toMatch(
        /^workflow\.folder_/u,
      );
      expect(response.body).not.toContain('private');
      expect(response.body).not.toContain('currentRevision');
      expect(response.body).not.toContain('proof');
    },
  );

  it('retains ordered partial bulk results without leaking folder placement or error properties', async () => {
    const f = await setup();
    const ids = [workflowId, sessionId, actorId];
    f.batches.executeBatchItem.mockResolvedValueOnce({
      ...placement,
      workflowId,
    });
    f.batches.executeBatchItem.mockRejectedValueOnce(
      Object.assign(new WorkflowTagConflictError('organization_revision'), {
        currentRevision: 99,
        body: 'private',
      }),
    );
    f.batches.executeBatchItem.mockRejectedValueOnce(
      new WorkflowNotFoundError(),
    );
    const response = await f.inject(routes[6], {
      payload: {
        operation: 'move',
        folderId: null,
        items: ids.map((id) => ({
          workflowId: id,
          expectedOrganizationRevision: 1,
        })),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          workflowId,
          status: 'updated',
          organizationRevision: 2,
          replayed: false,
        },
        {
          workflowId: sessionId,
          status: 'conflict',
          code: 'workflow.organization_revision_conflict',
        },
        { workflowId: actorId, status: 'not_visible' },
      ],
    });
    for (const [index, id] of ids.entries())
      expect(f.batches.executeBatchItem).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({ workflowId: id }),
      );
    expect(response.body).not.toContain('folderId');
    expect(response.body).not.toContain('private');
  });
});
