import { WorkflowTagConflictError } from '@pertexo/core/authoring';
import { EventEmitter } from 'node:events';
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowOrganizationController } from '../../../src/workflow-authoring/organization/workflow-organization.controller.js';
import {
  actorId,
  cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture,
  fixture,
  headers,
  httpFixture,
  prefix,
  routes,
  sessionId,
  tagId,
  tagResult,
  workspaceId,
} from './organization-http.fixture.js';

function deniedRouteStatus(name: string) {
  return name === 'replaceTags' ? 404 : 403;
}

afterEach(cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture);
describe('organization controller registered HTTP seam (fake session and persistence)', () => {
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

  it.each(routes.filter((route) => route.body !== undefined))(
    'refuses malformed and private $name input through HTTP',
    async (route) => {
      const f = await httpFixture();
      for (const payload of [
        {},
        ...[
          { actorId },
          { workspaceId },
          { generation: tagId },
          { proof: {} },
          { idempotencyKey: 'body-key' },
        ].map((extra) => ({ ...route.body, ...extra })),
      ]) {
        const reply = await f.app.inject({
          method: route.method,
          url: prefix + route.suffix,
          headers,
          payload,
        });
        expect(reply.statusCode).toBe(400);
        expect(reply.json()).toHaveProperty('errors');
      }
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
          allowed ? route.status : deniedRouteStatus(route.name),
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

  it('says what is wrong with a tag key the caller sent', async () => {
    const f = await httpFixture();
    const response = await f.app.inject({
      method: 'POST',
      url: prefix + '/workflow-tags',
      headers,
      payload: { key: 'has space' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'request.invalid',
      errors: [
        {
          path: '/key',
          message:
            'Use 1–32 letters, numbers and single hyphens, like billing or high-priority.',
        },
      ],
    });
    expect(f.tags.createTag).not.toHaveBeenCalled();
  });

  it('strips private persistence response extensions without exposing them', async () => {
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
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(tagResult);
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
        {
          params: { workspaceId },
          body: { key: 'release' },
          idempotencyKey: 'one-command',
          query: {},
          headers: undefined,
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(signal?.aborted).toBe(true);
    expect(raw.listenerCount('aborted')).toBe(0);
  });
});
