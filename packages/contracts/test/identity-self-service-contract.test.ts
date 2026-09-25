import { describe, expect, it } from 'vitest';

import {
  authenticationReturnPathSchema,
  invitationAcceptanceSessionRequestSchema,
  userDisplayNameSchema,
  userProfileResponseSchema,
  userProfileUpdateRequestSchema,
  workspaceMemberRemovalRequestSchema,
  workspaceMemberRemovalResponseSchema,
} from '../src/http/identity-workspace.js';
import { identityWorkspaceOpenApiDocument } from '../src/identity-workspace.js';

const workspaceId = '0199a4a2-5c1e-7000-8000-000000000001';

describe('member removal, self profile and return path contracts', () => {
  it('fences a strict member removal by role revision', () => {
    expect(
      workspaceMemberRemovalRequestSchema.parse({ expectedRoleRevision: 3 }),
    ).toEqual({ expectedRoleRevision: 3 });
    for (const body of [
      {},
      { expectedRoleRevision: 0 },
      { expectedRoleRevision: 1.5 },
      { expectedRoleRevision: 1, role: 'viewer' },
    ])
      expect(workspaceMemberRemovalRequestSchema.safeParse(body).success).toBe(
        false,
      );
    expect(
      workspaceMemberRemovalResponseSchema.safeParse({
        userId: workspaceId,
        roleRevision: 2,
        replayed: false,
        email: 'leak@example.test',
      }).success,
    ).toBe(false);
    const route =
      identityWorkspaceOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/members/{userId}/remove'
      ].post;
    expect(route.operationId).toBe('removeWorkspaceMember');
    expect(Object.keys(route.responses)).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '429',
      '500',
    ]);
  });

  it('bounds display names and requires the profile revision', () => {
    expect(userDisplayNameSchema.parse('  Ada Lovelace  ')).toBe(
      'Ada Lovelace',
    );
    expect(userDisplayNameSchema.parse('x'.repeat(128))).toHaveLength(128);
    for (const name of ['', '   ', 'x'.repeat(129), 'Line\nBreak', 'Nul\u0000'])
      expect(userDisplayNameSchema.safeParse(name).success).toBe(false);
    expect(
      userProfileUpdateRequestSchema.safeParse({ displayName: 'Ada' }).success,
    ).toBe(false);
    expect(
      userProfileUpdateRequestSchema.safeParse({
        displayName: 'Ada',
        expectedRevision: 1,
        email: 'other@example.test',
      }).success,
    ).toBe(false);
    expect(userProfileResponseSchema.shape.revision.safeParse(0).success).toBe(
      false,
    );
    const patch = identityWorkspaceOpenApiDocument.paths['/v1/users/me'].patch;
    expect(patch.operationId).toBe('updateCurrentUserProfile');
    expect(patch.responses).toHaveProperty('412');
    expect(
      invitationAcceptanceSessionRequestSchema.safeParse({ extra: true })
        .success,
    ).toBe(false);
  });

  it('accepts only known same-origin return paths', () => {
    for (const path of [
      '/invitations/accept',
      '/account/security',
      `/w/${workspaceId}/account`,
    ])
      expect(authenticationReturnPathSchema.parse(path)).toBe(path);
    for (const path of [
      'https://evil.example/invitations/accept',
      '//evil.example/invitations/accept',
      '/\\evil.example',
      'javascript:alert(1)',
      '/invitations/accept?next=https://evil.example',
      '/invitations/accept#token=secret',
      '/account/security/../../admin',
      '/w/not-a-workspace/account',
      `/w/${workspaceId}/settings`,
      '/workspaces',
      'invitations/accept',
      '',
    ])
      expect(authenticationReturnPathSchema.safeParse(path).success).toBe(
        false,
      );
  });
});
