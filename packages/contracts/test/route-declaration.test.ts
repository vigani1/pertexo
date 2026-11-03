import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineRoute, named } from '../src/routes/define.js';
import {
  authoringRoutes,
  workflowAuthoringOpenApiDocument,
} from '../src/server.js';

describe('route declaration contracts', () => {
  const valid = defineRoute({
    operationId: 'qualification',
    method: 'get',
    path: '/qualification/{itemId}',
    access: { auth: 'public' },
    rateLimit: 'authenticated_read',
    params: z.object({ itemId: z.uuid() }),
    success: {
      status: 200,
      description: 'Qualified',
      body: named('Qualified', z.object({ id: z.uuid() })),
    },
    problems: {},
  });
  it('refuses mismatched or surplus path parameters when declarations load', () => {
    expect(() =>
      defineRoute({ ...valid, path: '/qualification/{otherId}' }),
    ).toThrow(/parameters/u);
    expect(() =>
      defineRoute({
        ...valid,
        params: z.object({ itemId: z.uuid(), surplus: z.string() }),
      }),
    ).toThrow(/parameters/u);
    expect(defineRoute(valid)).toEqual(valid);
  });
  it('preserves literal path, method and component keys through the real document composition', () => {
    expectTypeOf(authoringRoutes.create.method).toEqualTypeOf<'post'>();
    expectTypeOf(
      authoringRoutes.create.path,
    ).toEqualTypeOf<'/v1/workspaces/{workspaceId}/workflows'>();
    expectTypeOf<
      keyof typeof workflowAuthoringOpenApiDocument.paths
    >().toExtend<`/v1/${string}`>();
    expectTypeOf<
      keyof typeof workflowAuthoringOpenApiDocument.components.schemas
    >().not.toEqualTypeOf<string>();
    expectTypeOf(
      workflowAuthoringOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows'
      ].post.operationId,
    ).toBeString();
    expect(
      workflowAuthoringOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows'
      ].post,
    ).toHaveProperty('responses.201');
  });
});
