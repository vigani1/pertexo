import type { ExecutionContext } from '@nestjs/common';
import 'reflect-metadata';
import { APPLICATION_ERROR_MAPPERS } from '../../../../../src/application-errors.js';
import { AutomationAuthenticationGuard } from '../../../../../src/authentication/automation/guard.js';
import { WORKSPACE_AUTHORIZATION } from '../../../../../src/workspaces/tokens.js';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  WorkflowFolderStore,
  WorkflowOrganizationBatchStore,
} from '@pertexo/core/authoring';
import { vi } from 'vitest';
import { WorkflowAuthoringController } from '../../../../../src/workflow-authoring/http/workflow-authoring.controller.js';
import { WorkflowOrganizationBatchesController } from '../../../../../src/workflow-authoring/organization/batch/workflow-organization-batches.controller.js';
import { WorkflowOrganizationBatchesUseCase } from '../../../../../src/workflow-authoring/organization/batch/workflow-organization-batches.service.js';
import { WorkflowOrganizationCommandsUseCase } from '../../../../../src/workflow-authoring/organization/commands.js';
import { WorkflowOrganizationController } from '../../../../../src/workflow-authoring/organization/workflow-organization.controller.js';
import { WorkflowFoldersController } from '../../../../../src/workflow-authoring/organization/folders/workflow-folders.controller.js';
import { WorkflowFoldersUseCase } from '../../../../../src/workflow-authoring/organization/folders/workflow-folders.service.js';
import { WorkflowOrganizationReadsUseCase } from '../../../../../src/workflow-authoring/organization/reads.js';

import { DoubleSubmitCsrfPolicy } from '../../../../../src/identity/index.js';
import {
  applicationError,
  ProblemDetailsFilter,
  RequestContextMiddleware,
  RequestContextStore,
  throwApplicationError,
} from '../../../../../src/platform/http/index.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../../../../src/workspaces/index.js';

import type { WorkflowAuthoringRequest } from '../../../../../src/workflow-authoring/workflow-transport.js';

export const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const folderId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const tagId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export const sessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const csrf = 'x'.repeat(43);

export const headers = {
  cookie: `pertexo_csrf=${csrf}`,
  'x-csrf-token': csrf,
  'idempotency-key': 'folder-batch-http',
};

export const prefix = `/v1/workspaces/${workspaceId}`;

const folder = {
  id: folderId,
  name: 'Operations',
  parentId: null,
  revision: 2,
  depth: 1,
};

export const placement = {
  workflowId,
  folderId: null,
  organizationRevision: 2,
  replayed: false,
};

const selected = [{ workflowId, expectedOrganizationRevision: 1 }];

export const routes = [
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

/** Real HTTP/CSRF/problem handling with fake session admission and persistence.
 * This fixture is not evidence for production session authentication or SQL. */
export async function setup() {
  const folders = {
    sharingPrincipals: vi.fn(),
    readSharing: vi.fn(),
    replaceSharing: vi.fn(),
    reviewMove: vi.fn(),
    listFolders: vi.fn().mockResolvedValue({ items: [folder] }),
    createFolder: vi.fn().mockResolvedValue({ folder, replayed: false }),
    renameFolder: vi.fn().mockResolvedValue({ folder, replayed: true }),
    moveFolder: vi.fn().mockResolvedValue({ folder, replayed: false }),
    deleteFolder: vi
      .fn()
      .mockResolvedValue({ folderId, deleted: true, replayed: false }),
    placeWorkflow: vi.fn().mockResolvedValue(placement),
    close: vi.fn(),
  } satisfies WorkflowFolderStore;
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
  } satisfies WorkflowOrganizationBatchStore;
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

      { provide: WORKSPACE_AUTHORIZATION, useValue: authorization },
      { provide: RequestContextStore, useValue: contexts },
      { provide: WorkflowFoldersUseCase, useValue: folderUseCase },
      { provide: WorkflowOrganizationBatchesUseCase, useValue: batchUseCase },
      // The sibling tag/favorite routes are registered for collisions only.
      { provide: WorkflowOrganizationCommandsUseCase, useValue: {} },
      { provide: WorkflowOrganizationReadsUseCase, useValue: {} },
    ],
  });
  const controlledAuthentication = {
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
  };
  builder
    .overrideGuard(SessionAuthenticationGuard)
    .useValue(controlledAuthentication);
  builder
    .overrideGuard(AutomationAuthenticationGuard)
    .useValue(controlledAuthentication);
  builder
    .overrideGuard(CsrfProtectionGuard)
    .useValue(new CsrfProtectionGuard(new DoubleSubmitCsrfPolicy()));

  const module = await builder.compile();
  // The source transform does not retain constructor design:paramtypes.
  {
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
  app.useGlobalFilters(
    new ProblemDetailsFilter(contexts, undefined, APPLICATION_ERROR_MAPPERS),
  );
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

export async function cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture() {
  await Promise.all(open.splice(0).map((app) => app.close()));
}
