import type { Role } from '@pertexo/workflow-model';
import { APPLICATION_ERROR_MAPPERS } from '../../../../src/application-errors.js';
import 'reflect-metadata';

import type { ExecutionContext } from '@nestjs/common';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import type {
  WorkflowTagDatabase,
  WorkflowFavoriteDatabase,
} from '@pertexo/core/authoring';
import { WorkflowOrganizationController } from '../../../../src/workflow-authoring/organization/controller.js';
import { WorkflowOrganizationCommandsUseCase } from '../../../../src/workflow-authoring/organization/commands.js';
import { WorkflowOrganizationReadsUseCase } from '../../../../src/workflow-authoring/organization/reads.js';
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

import { WORKFLOW_AUTHORING_AUTHORIZATION } from '../../../../src/workflow-authoring/tokens.js';
import type { WorkflowAuthoringRequest } from '../../../../src/workflow-authoring/types.js';

export const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const tagId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const csrf = 'a'.repeat(43);

export const headers = {
  cookie: `pertexo_csrf=${csrf}`,
  'x-csrf-token': csrf,
  'idempotency-key': 'organization-http-command',
};

export const prefix = `/v1/workspaces/${workspaceId}`;

export const tagResult = {
  tag: { id: tagId, key: 'release', revision: 2 },
  replayed: false,
};

export const routes = [
  {
    name: 'listTags',
    path: 'workflow-tags',
    method: 'GET',
    suffix: '/workflow-tags',
    body: undefined,
    status: 200,
  },
  {
    name: 'createTag',
    path: 'workflow-tags',
    method: 'POST',
    suffix: '/workflow-tags',
    body: { key: ' Release ' },
    status: 201,
  },
  {
    name: 'renameTag',
    path: 'workflow-tags/:tagId/rename',
    method: 'POST',
    suffix: `/workflow-tags/${tagId}/rename`,
    body: { key: 'release', expectedTagRevision: 1 },
    status: 200,
  },
  {
    name: 'deleteTag',
    path: 'workflow-tags/:tagId/delete',
    method: 'POST',
    suffix: `/workflow-tags/${tagId}/delete`,
    body: { expectedTagRevision: 1 },
    status: 200,
  },
  {
    name: 'assignments',
    path: 'workflow-tags/:tagId/workflows',
    method: 'GET',
    suffix: `/workflow-tags/${tagId}/workflows`,
    body: undefined,
    status: 200,
  },
  {
    name: 'replaceTags',
    path: 'workflows/:workflowId/tags',
    method: 'POST',
    suffix: `/workflows/${workflowId}/tags`,
    body: { tagIds: [tagId], expectedOrganizationRevision: 1 },
    status: 200,
  },
  {
    name: 'favorite',
    path: 'workflows/:workflowId/favorite',
    method: 'PUT',
    suffix: `/workflows/${workflowId}/favorite`,
    body: { favorite: false },
    status: 200,
  },
] as const;

export function fixture(role: Role = 'owner') {
  const tags = {
    listTags: vi
      .fn()
      .mockResolvedValue({ items: [tagResult.tag], nextId: null }),
    listTagAssignments: vi.fn().mockResolvedValue({
      items: [{ workflowId, organizationRevision: 2 }],
      nextId: null,
    }),
    createTag: vi.fn().mockResolvedValue(tagResult),
    renameTag: vi.fn().mockResolvedValue(tagResult),
    deleteTag: vi.fn().mockResolvedValue({
      tagId,
      deleted: true,
      detachedWorkflowCount: 2,
      replayed: false,
    }),
    replaceTags: vi.fn().mockResolvedValue({
      workflowId,
      organizationRevision: 2,
      tagIds: [tagId],
      replayed: false,
    }),
    detachTag: vi.fn(),
    close: vi.fn(),
  } satisfies WorkflowTagDatabase;
  const favorites = {
    setFavorite: vi.fn().mockResolvedValue({ isFavorite: false }),
    close: vi.fn(),
  } satisfies WorkflowFavoriteDatabase;
  const authorization = {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role,
      membershipStatus: 'active',
      workspaceStatus: 'active',
    }),
  };
  const commands = new WorkflowOrganizationCommandsUseCase(
    tags,
    favorites,
    authorization,
  );
  const reads = new WorkflowOrganizationReadsUseCase(
    { getWorkflow: vi.fn(), listWorkflows: vi.fn() },
    tags,
    authorization,
  );
  return { tags, favorites, authorization, commands, reads };
}

const applications: NestFastifyApplication[] = [];

/** Real Nest/Fastify routes and real workspace/CSRF policy, fake session admission
 * and persistence. This does not qualify production session auth or live SQL. */
export async function httpFixture(role: Role = 'owner') {
  const f = fixture(role);
  const contexts = new RequestContextStore();
  const module = await Test.createTestingModule({
    controllers: [WorkflowOrganizationController],
    providers: [
      { provide: WORKFLOW_AUTHORING_AUTHORIZATION, useValue: f.authorization },
      { provide: RequestContextStore, useValue: contexts },
      { provide: WorkflowOrganizationCommandsUseCase, useValue: f.commands },
      { provide: WorkflowOrganizationReadsUseCase, useValue: f.reads },
    ],
  })
    .overrideGuard(SessionAuthenticationGuard)
    .useValue({
      canActivate(context: ExecutionContext) {
        const request = context
          .switchToHttp()
          .getRequest<WorkflowAuthoringRequest>();
        if (request.headers?.['x-test-anonymous'] === 'true')
          return throwApplicationError(
            applicationError('auth.unauthenticated'),
          );
        Object.assign(request, {
          identitySession: {
            userId: actorId,
            sessionId,
            expiresAt: new Date('2099-01-01T00:00:00Z'),
            clientMetadata: {},
          },
        });
        return true;
      },
    })
    .overrideGuard(CsrfProtectionGuard)
    .useValue(new CsrfProtectionGuard(new DoubleSubmitCsrfPolicy()))
    .overrideGuard(WorkflowReadGuard)
    .useValue(new WorkflowReadGuard(f.authorization, contexts))
    .overrideGuard(WorkflowUpdateGuard)
    .useValue(new WorkflowUpdateGuard(f.authorization, contexts))
    .compile();
  // Vitest's source transform omits compiler design:paramtypes. Explicit test
  // wiring exercises production routes, not compiler-generated constructor DI.
  Object.assign(module.get(WorkflowOrganizationController), {
    commands: f.commands,
    reads: f.reads,
  });
  const app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  applications.push(app);
  const middleware = new RequestContextMiddleware(contexts);
  app.use(middleware.use.bind(middleware));
  app.useGlobalFilters(
    new ProblemDetailsFilter(contexts, undefined, APPLICATION_ERROR_MAPPERS),
  );
  await app.init();
  return { ...f, app };
}

export async function cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture() {
  await Promise.all(applications.splice(0).map((app) => app.close()));
}
