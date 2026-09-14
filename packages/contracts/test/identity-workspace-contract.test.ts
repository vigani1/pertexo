import { describe, expect, it } from 'vitest';

import {
  API_PROBLEM_CODES,
  API_PROBLEM_MANIFEST,
  apiProblemSchema,
  apiProblemShape,
} from '../src/errors/api-problem.js';
import {
  idempotencyKeySchema,
  workspaceCreateRequestSchema,
} from '../src/http/identity-workspace.js';
import {
  identityWorkspaceClientContract,
  identityWorkspaceOpenApiDocument,
} from '../src/identity-workspace.js';
import { manifestProblemResponse } from '../src/openapi-primitives.js';

describe('identity and problem public contracts', () => {
  it('fails closed for mismatched canonical problem metadata', () => {
    expect(() => manifestProblemResponse(500, 'auth.unauthenticated')).toThrow(
      'status does not match',
    );
    expect(manifestProblemResponse(401, 'auth.unauthenticated')).toMatchObject({
      'x-pertexo-code': 'auth.unauthenticated',
      'x-pertexo-status': 401,
    });
  });

  it('maps every problem code exactly once to immutable HTTP metadata', () => {
    expect(Object.keys(API_PROBLEM_MANIFEST)).toEqual(API_PROBLEM_CODES);
    for (const code of API_PROBLEM_CODES) {
      const entry = API_PROBLEM_MANIFEST[code];
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.type).toBe(`urn:pertexo:problem:${code}`);
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(Object.isFrozen(API_PROBLEM_MANIFEST)).toBe(true);
  });

  it('owns strict browser-safe requests and RFC 9457 problems', () => {
    expect(Object.keys(apiProblemShape)).toEqual([
      'type',
      'title',
      'status',
      'detail',
      'instance',
      'code',
      'requestId',
      'errors',
    ]);
    expect(
      workspaceCreateRequestSchema.safeParse({
        name: 'Operations',
        slug: 'operations',
        ownerId: 'must-not-be-public-input',
      }).success,
    ).toBe(false);
    expect(idempotencyKeySchema.safeParse('one-two').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('one,two').success).toBe(false);
    expect(
      apiProblemSchema.parse({
        type: 'urn:pertexo:problem:workspace.conflict',
        title: 'Workspace conflict',
        status: 409,
        code: 'workspace.conflict',
        requestId: 'request-42',
      }),
    ).toMatchObject({ status: 409, code: 'workspace.conflict' });
    expect(
      apiProblemSchema.safeParse({
        type: 'urn:pertexo:problem:unknown',
        title: 'Unknown',
        status: 409,
        code: 'unknown.code',
        requestId: 'request-42',
      }).success,
    ).toBe(false);
  });

  it('shares ApiProblem across client schemas and error responses', () => {
    expect(identityWorkspaceClientContract.schemas.ApiProblem).toBeDefined();
    for (const response of Object.values(
      identityWorkspaceOpenApiDocument.components.responses,
    ))
      expect(response.content['application/problem+json'].schema).toEqual({
        $ref: '#/components/schemas/ApiProblem',
      });
    expect(
      identityWorkspaceOpenApiDocument.paths['/v1/workspaces'].post.responses[
        '409'
      ],
    ).toEqual({ $ref: '#/components/responses/Conflict' });
    expect(
      identityWorkspaceOpenApiDocument.paths['/v1/auth/oidc/callback'].get
        .responses['503'],
    ).toEqual({ $ref: '#/components/responses/ServiceUnavailable' });
  });
});
