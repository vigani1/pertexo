import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  identityWorkspaceClientContract,
  identityWorkspaceOpenApiDocument,
  oidcCallbackRequestSchema,
  oidcStartResponseSchema,
  workspaceCreateRequestSchema,
  workspaceDeletionRequestSchema,
  workspaceResponseSchema,
} from '../../src/identity-workspace/index.js';

describe('identity/workspace generated contracts', () => {
  it('projects every client schema mechanically from the owning Zod contract', () => {
    expect(identityWorkspaceClientContract).toEqual({
      schemaVersion: '1.0.0',
      schemas: {
        OidcCallbackRequest: generated(oidcCallbackRequestSchema, 'input'),
        OidcStartResponse: generated(oidcStartResponseSchema, 'output'),
        WorkspaceCreateRequest: generated(
          workspaceCreateRequestSchema,
          'input',
        ),
        WorkspaceDeletionRequest: generated(
          workspaceDeletionRequestSchema,
          'input',
        ),
        WorkspaceResponse: generated(workspaceResponseSchema, 'output'),
      },
    });
  });

  it('documents all five public route templates and their request/response schemas', () => {
    expect(identityWorkspaceOpenApiDocument.openapi).toBe('3.1.0');
    expect(Object.keys(identityWorkspaceOpenApiDocument.paths)).toEqual([
      '/v1/auth/oidc/start',
      '/v1/auth/oidc/callback',
      '/v1/auth/logout',
      '/v1/workspaces',
      '/v1/workspaces/{workspaceId}/deletion',
    ]);
    expect(identityWorkspaceOpenApiDocument.components.schemas).toEqual(
      identityWorkspaceClientContract.schemas,
    );
    expect(
      identityWorkspaceOpenApiDocument.paths['/v1/workspaces'].post.requestBody
        .content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/WorkspaceCreateRequest' });
    expect(
      identityWorkspaceOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/deletion'
      ].post.requestBody.content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/WorkspaceDeletionRequest' });
    expect(
      identityWorkspaceOpenApiDocument.components.securitySchemes.cookieSession,
    ).toEqual({
      type: 'apiKey',
      in: 'cookie',
      name: 'pertexo_session',
    });
    expect(
      identityWorkspaceOpenApiDocument.paths['/v1/workspaces'].post.parameters,
    ).toContainEqual(
      expect.objectContaining({ in: 'header', name: 'x-csrf-token' }),
    );
    expect(
      identityWorkspaceOpenApiDocument.paths['/v1/workspaces'].post.parameters,
    ).toContainEqual(
      expect.objectContaining({ in: 'header', name: 'Idempotency-Key' }),
    );
    expect(
      identityWorkspaceOpenApiDocument.paths['/v1/auth/logout'].post.parameters,
    ).not.toContainEqual(
      expect.objectContaining({ in: 'header', name: 'Idempotency-Key' }),
    );
  });

  it('preserves strict writes and bounded field constraints in generated JSON Schema', () => {
    const create =
      identityWorkspaceClientContract.schemas.WorkspaceCreateRequest;
    const deletion =
      identityWorkspaceClientContract.schemas.WorkspaceDeletionRequest;
    const callback =
      identityWorkspaceClientContract.schemas.OidcCallbackRequest;

    expect(create).toMatchObject({
      additionalProperties: false,
      required: ['name', 'slug'],
      properties: {
        name: { maxLength: 128, minLength: 1 },
        slug: { maxLength: 64, minLength: 1 },
      },
    });
    expect(deletion).toMatchObject({
      additionalProperties: false,
      required: ['reason'],
      properties: { reason: { maxLength: 512, minLength: 1 } },
    });
    expect(callback).toMatchObject({
      additionalProperties: false,
      required: ['code', 'state'],
      properties: {
        code: { maxLength: 4_096, minLength: 1 },
        state: { maxLength: 512, minLength: 16 },
      },
    });
  });
});

function generated(schema: z.ZodType, io: 'input' | 'output') {
  return z.toJSONSchema(schema, { io, target: 'draft-2020-12' });
}
