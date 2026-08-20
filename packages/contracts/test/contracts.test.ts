import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { CONTRACT_ARTIFACTS } from '../src/artifacts.js';
import { apiProblemSchema } from '../src/errors/api-problem.js';
import {
  identityWorkspaceClientContract,
  identityWorkspaceOpenApiDocument,
} from '../src/identity-workspace.js';
import { workspaceCreateRequestSchema } from '../src/http/identity-workspace.js';

describe('public contracts package', () => {
  it('owns strict browser-safe request and RFC 9457 problem schemas', () => {
    expect(
      workspaceCreateRequestSchema.safeParse({
        name: 'Operations',
        slug: 'operations',
        ownerId: 'must-not-be-public-input',
      }).success,
    ).toBe(false);
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

  it('shares ApiProblem across client schemas and documented error responses', () => {
    expect(identityWorkspaceClientContract.schemas.ApiProblem).toBeDefined();
    for (const response of Object.values(
      identityWorkspaceOpenApiDocument.components.responses,
    )) {
      expect(response.content['application/problem+json'].schema).toEqual({
        $ref: '#/components/schemas/ApiProblem',
      });
    }
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

  it('keeps committed artifacts byte-identical to deterministic generation', async () => {
    for (const artifact of CONTRACT_ARTIFACTS) {
      const committed = await readFile(
        new URL(`../artifacts/${artifact.fileName}`, import.meta.url),
        'utf8',
      );
      expect(committed).toBe(artifact.content);
    }
  });
});
