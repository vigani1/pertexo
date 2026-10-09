import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import type { ExecutionContext } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkflowTagConflictError,
  type WorkflowTagDatabase,
  type WorkflowFavoriteDatabase,
} from '@pertexo/database/authoring';
import { WorkflowOrganizationController } from '../../../src/workflow-authoring/organization/controller.js';
import { WorkflowOrganizationCommandsUseCase } from '../../../src/workflow-authoring/organization/commands.js';
import { WorkflowOrganizationReadsUseCase } from '../../../src/workflow-authoring/organization/reads.js';
import {
  WorkflowReadGuard,
  WorkflowUpdateGuard,
} from '../../../src/workflow-authoring/http/guards.js';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
} from '../../../src/workspaces/index.js';
import { DoubleSubmitCsrfPolicy } from '../../../src/identity/index.js';
import {
  applicationError,
  throwApplicationError,
  RequestContextStore,
  RequestContextMiddleware,
  ProblemDetailsFilter,
} from '../../../src/platform/http/index.js';
import { RATE_LIMIT_METADATA } from '../../../src/platform/rate-limit/metadata.js';
import { WORKFLOW_AUTHORING_AUTHORIZATION } from '../../../src/workflow-authoring/tokens.js';
import type { WorkflowAuthoringRequest } from '../../../src/workflow-authoring/types.js';

const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const tagId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const csrf = 'a'.repeat(43);
const headers = {
  cookie: `pertexo_csrf=${csrf}`,
  'x-csrf-token': csrf,
  'idempotency-key': 'organization-http-command',
};
const prefix = `/v1/workspaces/${workspaceId}`;
const tagResult = {
  tag: { id: tagId, key: 'release', revision: 2 },
  replayed: false,
};
const routes = [
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

function fixture(role: 'owner' | 'admin' | 'builder' | 'viewer' = 'owner') {
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
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

/** Real Nest/Fastify routes and real workspace/CSRF policy, fake session admission
 * and persistence. This does not qualify production session auth or live SQL. */
async function httpFixture(
  role: 'owner' | 'admin' | 'builder' | 'viewer' = 'owner',
) {
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
  app.useGlobalFilters(new ProblemDetailsFilter(contexts));
  await app.init();
  return { ...f, app };
}

describe('organization controller registered HTTP seam (fake session and persistence)', () => {
  it.each(routes)(
    'registers $method $path with guards, rate class and private cache metadata',
    (route) => {
      // Metadata inspection never invokes the unbound controller method.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const handler = WorkflowOrganizationController.prototype[route.name];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(route.path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        { GET: 0, POST: 1, PUT: 2 }[route.method],
      );
      expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([
        { name: 'Cache-Control', value: 'private, no-store' },
      ]);
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
        SessionAuthenticationGuard,
        route.name === 'replaceTags' ? WorkflowUpdateGuard : WorkflowReadGuard,
        ...(route.method === 'GET' ? [] : [CsrfProtectionGuard]),
      ]);
      expect(
        Reflect.getMetadata(RATE_LIMIT_METADATA, handler) ??
          Reflect.getMetadata(
            RATE_LIMIT_METADATA,
            WorkflowOrganizationController,
          ),
      ).toBe(
        route.method === 'GET' ? 'authenticated_read' : 'ordinary_mutation',
      );
      if (route.method !== 'GET')
        expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
          route.status,
        );
    },
  );

  it.each(routes)(
    'serves exact $method $path and private no-store success',
    async (route) => {
      const f = await httpFixture();
      const response = await f.app.inject({
        method: route.method,
        url: prefix + route.suffix,
        headers,
        ...(route.body === undefined ? {} : { payload: route.body }),
      });
      expect(response.statusCode).toBe(route.status);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).not.toContain('actorId');
      expect(response.body).not.toContain('generation');
      const calls = [
        ...f.tags.createTag.mock.calls,
        ...f.tags.renameTag.mock.calls,
        ...f.tags.deleteTag.mock.calls,
        ...f.tags.replaceTags.mock.calls,
        ...f.tags.listTags.mock.calls,
        ...f.tags.listTagAssignments.mock.calls,
        ...f.favorites.setFavorite.mock.calls,
      ];
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toMatchObject({ workspaceId, actorId });
    },
  );

  it('admits admin vocabulary/discovery, viewer favorites, and builder assignments only', async () => {
    const admin = await httpFixture('admin');
    for (const route of routes)
      expect(
        (
          await admin.app.inject({
            method: route.method,
            url: prefix + route.suffix,
            headers,
            ...(route.body === undefined ? {} : { payload: route.body }),
          })
        ).statusCode,
      ).toBe(route.status);
    for (const role of ['viewer', 'builder'] as const) {
      const f = await httpFixture(role);
      for (const route of routes) {
        const allowed =
          route.name === 'listTags' ||
          route.name === 'favorite' ||
          (role === 'builder' && route.name === 'replaceTags');
        const response = await f.app.inject({
          method: route.method,
          url: prefix + route.suffix,
          headers,
          ...(route.body === undefined ? {} : { payload: route.body }),
        });
        expect(response.statusCode).toBe(
          allowed ? route.status : route.name === 'replaceTags' ? 404 : 403,
        );
      }
    }
  });

  it('uses session and real CSRF guards before mutations', async () => {
    const f = await httpFixture();
    const route = routes[1];
    const anonymous = await f.app.inject({
      method: 'POST',
      url: prefix + route.suffix,
      payload: route.body,
      headers: { ...headers, 'x-test-anonymous': 'true' },
    });
    expect(anonymous.statusCode).toBe(401);
    const missing = await f.app.inject({
      method: 'POST',
      url: prefix + route.suffix,
      payload: route.body,
      headers: { 'idempotency-key': headers['idempotency-key'] },
    });
    expect(missing.statusCode).toBe(403);
    expect(f.tags.createTag).not.toHaveBeenCalled();
  });

  it('rejects invalid IDs, extra bodies, duplicate queries and command headers', async () => {
    const f = await httpFixture();
    for (const [method, url, payload] of [
      ['POST', `${prefix}/workflow-tags/not-a-uuid/rename`, routes[2].body],
      ['PUT', `${prefix}/workflows/not-a-uuid/favorite`, { favorite: true }],
    ] as const)
      expect(
        (await f.app.inject({ method, url, headers, payload })).statusCode,
      ).toBe(400);
    for (const payload of [
      { key: 'release', actorId },
      { key: 'release', proof: {} },
      { key: 'release', generation: tagId },
    ])
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: prefix + '/workflow-tags',
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: prefix + '/workflow-tags?limit=1&limit=2',
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: prefix + '/workflow-tags',
          headers: { ...headers, 'idempotency-key': '' },
          payload: { key: 'release' },
        })
      ).statusCode,
    ).toBe(400);
    expect(f.tags.createTag).not.toHaveBeenCalled();
  });

  it('maps known failures without leaking private cause or conflict metadata', async () => {
    const f = await httpFixture();
    for (const error of [new WorkflowTagConflictError('tag_revision')]) {
      Object.assign(error, {
        actorId,
        generation: 'private-generation',
        currentRevision: 99,
        cause: new Error('private-cause'),
      });
      f.tags.createTag.mockRejectedValueOnce(error);
      const response = await f.app.inject({
        method: 'POST',
        url: prefix + '/workflow-tags',
        headers,
        payload: { key: 'release' },
      });
      expect(response.statusCode).toBe(
        error instanceof WorkflowTagConflictError ? 409 : 503,
      );
      expect(response.body).not.toContain('private');
      expect(response.body).not.toContain('currentRevision');
      expect(response.body).not.toContain('generation');
    }
  });

  it('rejects private persistence response extensions without exposing them', async () => {
    const f = await httpFixture();
    f.tags.createTag.mockResolvedValueOnce({
      ...tagResult,
      generation: 'private-generation',
      actorId,
    });
    const response = await f.app.inject({
      method: 'POST',
      url: prefix + '/workflow-tags',
      headers,
      payload: { key: 'release' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('request.invalid');
    expect(response.body).not.toContain('private-generation');
    expect(response.body).not.toContain('actorId');
  });

  it('propagates disconnect cancellation and removes request listeners (direct request seam)', async () => {
    const f = fixture();
    const raw = new EventEmitter();
    const request = {
      headers,
      identitySession: {
        userId: actorId,
        sessionId,
        expiresAt: new Date('2099-01-01'),
        clientMetadata: {},
      },
      raw,
    };
    let signal: AbortSignal | undefined;
    f.tags.createTag.mockImplementationOnce(
      (input: { signal?: AbortSignal }) => {
        signal = input.signal;
        raw.emit('aborted');
        input.signal?.throwIfAborted();
        return Promise.resolve(tagResult);
      },
    );
    await expect(
      new WorkflowOrganizationController(f.commands, f.reads).createTag(
        request,
        { workspaceId },
        { key: 'release' },
      ),
    ).rejects.toMatchObject({ code: 'internal.unexpected' });
    expect(signal?.aborted).toBe(true);
    expect(raw.listenerCount('aborted')).toBe(0);
  });
});
