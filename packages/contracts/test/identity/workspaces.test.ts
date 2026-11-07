import { describe, expect, it } from 'vitest';

import {
  API_PROBLEM_CODES,
  API_PROBLEM_MANIFEST,
  apiProblemSchema,
  apiProblemShape,
} from '../../src/errors/api-problem.js';
import {
  idempotencyKeySchema,
  invitationAcceptanceCompleteRequestSchema,
  invitationAcceptanceJourneySchema,
  invitationAcceptanceResolveRequestSchema,
  workspaceCreateRequestSchema,
  workspaceRenameRequestSchema,
  workspaceInvitationCreateRequestSchema,
  workspaceMemberRoleChangeRequestSchema,
} from '../../src/schemas/identity/workspaces.js';
import { identityWorkspaceOpenApiDocument } from '../../src/server.js';

describe('identity and problem public contracts', () => {
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
      workspaceRenameRequestSchema.parse({
        name: 'Renamed operations',
        expectedRevision: 3,
      }),
    ).toEqual({ name: 'Renamed operations', expectedRevision: 3 });
    expect(
      workspaceRenameRequestSchema.safeParse({
        name: 'Renamed operations',
        expectedRevision: 3,
        slug: 'must-remain-stable',
      }).success,
    ).toBe(false);
    expect(
      workspaceMemberRoleChangeRequestSchema.parse({
        role: 'operator',
        expectedRoleRevision: 7,
      }),
    ).toEqual({ role: 'operator', expectedRoleRevision: 7 });
    expect(
      workspaceMemberRoleChangeRequestSchema.safeParse({
        role: 'owner',
        expectedRoleRevision: 7,
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

  it('shares ApiProblem across client schemas and error responses', () => {
    expect(
      identityWorkspaceOpenApiDocument.components.schemas.ApiProblem,
    ).toBeDefined();
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
      identityWorkspaceOpenApiDocument.paths['/v1/workspaces'].get.responses[
        '200'
      ],
    ).toBeDefined();
  });

  it('keeps invitation commands strict and excludes owner assignment', () => {
    expect(
      workspaceInvitationCreateRequestSchema.parse({
        email: ' Member@Example.com ',
        role: 'builder',
      }),
    ).toEqual({ email: 'Member@Example.com', role: 'builder' });
    expect(
      workspaceInvitationCreateRequestSchema.safeParse({
        email: 'member@example.com',
        role: 'owner',
      }).success,
    ).toBe(false);
    expect(
      workspaceInvitationCreateRequestSchema.safeParse({
        email: 'member@example.com',
        role: 'viewer',
        message: 'not part of the first slice',
      }).success,
    ).toBe(false);
  });

  it('models browser-bound invitation acceptance without exposing secrets', () => {
    expect(
      invitationAcceptanceResolveRequestSchema.safeParse({ token: 'short' })
        .success,
    ).toBe(true);
    expect(
      invitationAcceptanceResolveRequestSchema.safeParse({ token: '' }).success,
    ).toBe(false);
    expect(
      invitationAcceptanceCompleteRequestSchema.safeParse({
        intentId: 'a31a3bd0-d607-4f13-85d6-00b1c4cd4bb7',
        expectedRevision: 2,
        token: 'must-not-be-accepted',
      }).success,
    ).toBe(false);
    expect(
      invitationAcceptanceJourneySchema.parse({ state: 'unavailable' }),
    ).toEqual({ state: 'unavailable' });
    expect(
      identityWorkspaceOpenApiDocument.paths[
        '/v1/invitation-acceptance/complete'
      ].post.security,
    ).toEqual([{ cookieSession: [], invitationBinding: [] }]);
  });

  it('refuses invitation details in an otherwise valid sign-in journey', () => {
    const journey = {
      state: 'sign_in_required',
      intentId: 'a31a3bd0-d607-4f13-85d6-00b1c4cd4bb7',
      expiresAt: '2099-09-19T15:00:00.000Z',
      csrfToken: 'c'.repeat(32),
    };
    expect(invitationAcceptanceJourneySchema.parse(journey)).toEqual(journey);
    expect(
      invitationAcceptanceJourneySchema.safeParse({
        ...journey,
        email: 'secret@example.com',
      }).success,
    ).toBe(false);
  });

  it('refuses a short CSRF token independently of invitation privacy', () => {
    expect(
      invitationAcceptanceJourneySchema.safeParse({
        state: 'sign_in_required',
        intentId: 'a31a3bd0-d607-4f13-85d6-00b1c4cd4bb7',
        expiresAt: '2099-09-19T15:00:00.000Z',
        csrfToken: 'not-long-enough',
      }).success,
    ).toBe(false);
  });
});
