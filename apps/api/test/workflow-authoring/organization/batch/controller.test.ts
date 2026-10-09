import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkflowFolderConflictError,
  WorkflowTagConflictError,
  WorkflowNotFoundError,
  type WorkflowFolderDatabase,
  type WorkflowOrganizationBatchDatabase,
} from '@pertexo/database/authoring';
import { WorkflowFoldersController } from '../../../../src/workflow-authoring/organization/folders/controller.js';
import { WorkflowOrganizationBatchesController } from '../../../../src/workflow-authoring/organization/batch/controller.js';
import { WorkflowOrganizationController } from '../../../../src/workflow-authoring/organization/controller.js';
import { WorkflowAuthoringController } from '../../../../src/workflow-authoring/http/controllers.js';
import { WorkflowFoldersUseCase } from '../../../../src/workflow-authoring/organization/folders/use-case.js';
import { WorkflowOrganizationBatchesUseCase } from '../../../../src/workflow-authoring/organization/batch/use-case.js';
import {
  WorkflowReadGuard,
  WorkflowUpdateGuard,
} from '../../../../src/workflow-authoring/http/guards.js';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
} from '../../../../src/workspaces/index.js';
import { DoubleSubmitCsrfPolicy } from '../../../../src/identity/index.js';
import {
  applicationError,
  throwApplicationError,
  RequestContextStore,
  RequestContextMiddleware,
  ProblemDetailsFilter,
} from '../../../../src/platform/http/index.js';
import { RATE_LIMIT_METADATA } from '../../../../src/platform/rate-limit/metadata.js';
import { WORKFLOW_AUTHORING_AUTHORIZATION } from '../../../../src/workflow-authoring/tokens.js';
import type { WorkflowAuthoringRequest } from '../../../../src/workflow-authoring/types.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const folderId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const tagId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const sessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const csrf = 'x'.repeat(43);
const headers = {
  cookie: `pertexo_csrf=${csrf}`,
  'x-csrf-token': csrf,
  'idempotency-key': 'folder-batch-http',
};
const prefix = `/v1/workspaces/${workspaceId}`;
const folder = {
  id: folderId,
  name: 'Operations',
  parentId: null,
  revision: 2,
  depth: 1,
};
const placement = {
  workflowId,
  folderId: null,
  organizationRevision: 2,
  replayed: false,
};
const selected = [{ workflowId, expectedOrganizationRevision: 1 }];
const routes = [
  {
    method: 'list',
    path: 'workflow-folders',
    url: '/workflow-folders',
    payload: undefined,
    port: 'listFolders',
    status: 200,
  },
  {
    method: 'create',
    path: 'workflow-folders',
    url: '/workflow-folders',
    payload: { name: 'Operations', parentId: null },
    port: 'createFolder',
    status: 201,
  },
  {
    method: 'rename',
    path: 'workflow-folders/:folderId/rename',
    url: `/workflow-folders/${folderId}/rename`,
    payload: { name: 'Operations', expectedFolderRevision: 1 },
    port: 'renameFolder',
    status: 200,
  },
  {
    method: 'move',
    path: 'workflow-folders/:folderId/move',
    url: `/workflow-folders/${folderId}/move`,
    payload: { parentId: null, expectedFolderRevision: 1 },
    port: 'moveFolder',
    status: 200,
  },
  {
    method: 'delete',
    path: 'workflow-folders/:folderId/delete',
    url: `/workflow-folders/${folderId}/delete`,
    payload: { expectedFolderRevision: 1 },
    port: 'deleteFolder',
    status: 200,
  },
  {
    method: 'place',
    path: 'workflows/:workflowId/folder',
    url: `/workflows/${workflowId}/folder`,
    payload: { folderId: null, expectedOrganizationRevision: 1 },
    port: 'placeWorkflow',
    status: 200,
  },
  {
    method: 'bulk',
    path: 'workflows/organization/bulk',
    url: '/workflows/organization/bulk',
    payload: { operation: 'move', folderId: null, items: selected },
    port: 'admitBatch',
    status: 200,
  },
  {
    method: 'cleanup',
    path: 'workflow-tags/cleanup/detach',
    url: '/workflow-tags/cleanup/detach',
    payload: { tagId, items: selected },
    port: 'admitBatch',
    status: 200,
  },
] as const;
type Route = (typeof routes)[number];
const open: NestFastifyApplication[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

/** Real HTTP/CSRF/problem handling with fake session admission and persistence.
 * This fixture is not evidence for production session authentication or SQL. */
async function setup(available = true) {
  const folders = {
    listFolders: vi.fn().mockResolvedValue({ items: [folder] }),
    createFolder: vi.fn().mockResolvedValue({ folder, replayed: false }),
    renameFolder: vi.fn().mockResolvedValue({ folder, replayed: true }),
    moveFolder: vi.fn().mockResolvedValue({ folder, replayed: false }),
    deleteFolder: vi
      .fn()
      .mockResolvedValue({ folderId, deleted: true, replayed: false }),
    placeWorkflow: vi.fn().mockResolvedValue(placement),
    close: vi.fn(),
  } satisfies WorkflowFolderDatabase;
  const batches = {
    admitBatch: vi.fn().mockResolvedValue({ admitted: true }),
    executeBatchItem: vi
      .fn()
      .mockImplementation(
        (input: { request: { operation: string }; workflowId: string }) =>
          Promise.resolve({
            workflowId: input.workflowId,
            organizationRevision: 2,
            replayed: false,
            ...(input.request.operation === 'move' ? { folderId: null } : {}),
          }),
      ),
    close: vi.fn(),
  } satisfies WorkflowOrganizationBatchDatabase;
  const authorization = {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role: 'owner',
      membershipStatus: 'active',
      workspaceStatus: 'active',
    }),
  };
  const contexts = new RequestContextStore();
  const folderUseCase = new WorkflowFoldersUseCase(folders, authorization);
  const batchUseCase = new WorkflowOrganizationBatchesUseCase(
    batches,
    authorization,
  );
  const siblingDependencies: unknown = Reflect.getMetadata(
    'design:paramtypes',
    WorkflowAuthoringController,
  );
  if (!Array.isArray(siblingDependencies))
    throw new Error('Existing authoring controller DI metadata is missing');
  const siblingProviders = siblingDependencies.map((dependency: unknown) => {
    if (typeof dependency !== 'function')
      throw new Error('Existing authoring dependency is incompatible');
    // Existing routes are registered for collision coverage, never called.
    return { provide: dependency, useValue: {} };
  });
  const builder = Test.createTestingModule({
    controllers: [
      WorkflowFoldersController,
      WorkflowOrganizationBatchesController,
      WorkflowOrganizationController,
      WorkflowAuthoringController,
    ],
    providers: [
      ...siblingProviders,
      { provide: WORKFLOW_AUTHORING_AUTHORIZATION, useValue: authorization },
      { provide: RequestContextStore, useValue: contexts },
      ...(available
        ? [
            { provide: WorkflowFoldersUseCase, useValue: folderUseCase },
            {
              provide: WorkflowOrganizationBatchesUseCase,
              useValue: batchUseCase,
            },
          ]
        : []),
    ],
  });
  builder.overrideGuard(SessionAuthenticationGuard).useValue({
    canActivate(context: ExecutionContext) {
      const request = context
        .switchToHttp()
        .getRequest<WorkflowAuthoringRequest>();
      if (request.headers?.['x-test-anonymous'] === 'true')
        return throwApplicationError(applicationError('auth.unauthenticated'));
      Object.assign(request, {
        identitySession: {
          userId: actorId,
          sessionId,
          expiresAt: new Date('2099-01-01'),
          clientMetadata: {},
        },
      });
      return true;
    },
  });
  builder
    .overrideGuard(CsrfProtectionGuard)
    .useValue(new CsrfProtectionGuard(new DoubleSubmitCsrfPolicy()));
  builder
    .overrideGuard(WorkflowReadGuard)
    .useValue(new WorkflowReadGuard(authorization, contexts));
  builder
    .overrideGuard(WorkflowUpdateGuard)
    .useValue(new WorkflowUpdateGuard(authorization, contexts));
  const module = await builder.compile();
  // The source transform does not retain constructor design:paramtypes.
  if (available) {
    Object.assign(module.get(WorkflowFoldersController), {
      folders: folderUseCase,
    });
    Object.assign(module.get(WorkflowOrganizationBatchesController), {
      batches: batchUseCase,
    });
  }
  const app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  open.push(app);
  const middleware = new RequestContextMiddleware(contexts);
  app.use(middleware.use.bind(middleware));
  app.useGlobalFilters(new ProblemDetailsFilter(contexts));
  await app.init();
  function inject(route: Route, overrides: object = {}) {
    return app.inject({
      method: route.method === 'list' ? 'GET' : 'POST',
      url: prefix + route.url,
      headers,
      ...(route.payload === undefined ? {} : { payload: route.payload }),
      ...overrides,
    });
  }
  function port(route: Route) {
    return route.port === 'admitBatch'
      ? batches.admitBatch
      : folders[route.port];
  }
  return { app, folders, batches, authorization, inject, port };
}

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
        WorkflowReadGuard,
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
    it(`${route.method}: missing optional capability fails safely`, async () => {
      const f = await setup(false);
      const response = await f.inject(route);
      expect(response.statusCode).toBe(503);
      expect(response.json<{ code: string }>().code).toBe(
        'workflow.organization_unavailable',
      );
      expect(f.port(route)).not.toHaveBeenCalled();
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
