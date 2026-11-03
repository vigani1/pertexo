import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture,
  workspaceId,
  actorId,
  folderId,
  workflowId,
  headers,
  prefix,
  routes,
  setup,
  sessionId,
  placement,
} from './controller/fixture.js';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import { WorkflowFoldersController } from '../../../../src/workflow-authoring/organization/folders/controller.js';
import { WorkflowOrganizationBatchesController } from '../../../../src/workflow-authoring/organization/batch/controller.js';
import {
  WorkflowParticipantGuard,
  WorkflowReadGuard,
} from '../../../../src/workflow-authoring/http/guards.js';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
} from '../../../../src/workspaces/index.js';
import { RATE_LIMIT_METADATA } from '../../../../src/platform/rate-limit/metadata.js';
import {
  WorkflowFolderConflictError,
  WorkflowTagConflictError,
  WorkflowNotFoundError,
} from '@pertexo/core/authoring';

afterEach(cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture);
describe('folder and batch HTTP routes with controlled session/persistence', () => {
  for (const route of routes) {
    it(`${route.method}: preserves guard, cache and rate metadata`, () => {
      const controller =
        route.method === 'bulk' || route.method === 'cleanup'
          ? WorkflowOrganizationBatchesController
          : WorkflowFoldersController;
      // Only inspect the method metadata; never invoke this unbound handler.
      const handler =
        controller === WorkflowFoldersController
          ? // eslint-disable-next-line @typescript-eslint/unbound-method
            WorkflowFoldersController.prototype[route.method as 'list']
          : // eslint-disable-next-line @typescript-eslint/unbound-method
            WorkflowOrganizationBatchesController.prototype[
              route.method as 'bulk'
            ];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(route.path);
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
        SessionAuthenticationGuard,
        route.method === 'list' ? WorkflowReadGuard : WorkflowParticipantGuard,
        ...(route.method === 'list' ? [] : [CsrfProtectionGuard]),
      ]);
      expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([
        { name: 'Cache-Control', value: 'private, no-store' },
      ]);
      expect(
        Reflect.getMetadata(RATE_LIMIT_METADATA, handler) ??
          Reflect.getMetadata(RATE_LIMIT_METADATA, controller),
      ).toBe(
        route.method === 'list' ? 'authenticated_read' : 'ordinary_mutation',
      );
      if (route.method !== 'list')
        expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
          route.status,
        );
    });
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
