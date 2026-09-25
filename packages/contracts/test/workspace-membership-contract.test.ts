import { describe, expect, it } from 'vitest';

import {
  API_PROBLEM_CODES,
  API_PROBLEM_MANIFEST,
} from '../src/errors/api-problem.js';
import {
  workspaceLeaveRequestSchema,
  workspaceLeaveResponseSchema,
  workspaceMemberStatusRequestSchema,
  workspaceMemberStatusResponseSchema,
  workspaceOwnershipTransferRequestSchema,
  workspaceOwnershipTransferResponseSchema,
} from '../src/http/identity-workspace.js';
import { identityWorkspaceOpenApiDocument } from '../src/identity-workspace.js';

const ownerId = '0199a4a2-5c1e-7000-8000-000000000001';
const memberId = '0199a4a2-5c1e-7000-8000-000000000002';

describe('membership lifecycle contracts (ADR 047)', () => {
  it('leaves with a strict empty body and a small receipt', () => {
    expect(workspaceLeaveRequestSchema.parse({})).toEqual({});
    expect(
      workspaceLeaveRequestSchema.safeParse({ expectedRoleRevision: 1 })
        .success,
    ).toBe(false);
    expect(
      workspaceLeaveResponseSchema.parse({
        userId: memberId,
        roleRevision: 2,
        replayed: false,
      }),
    ).toEqual({ userId: memberId, roleRevision: 2, replayed: false });
    expect(
      workspaceLeaveResponseSchema.safeParse({
        userId: memberId,
        roleRevision: 2,
        replayed: false,
        role: 'viewer',
      }).success,
    ).toBe(false);
  });

  it('fences suspension and reactivation by the member role revision', () => {
    expect(
      workspaceMemberStatusRequestSchema.parse({ expectedRoleRevision: 4 }),
    ).toEqual({ expectedRoleRevision: 4 });
    for (const body of [
      {},
      { expectedRoleRevision: 0 },
      { expectedRoleRevision: 2, membershipStatus: 'suspended' },
    ])
      expect(workspaceMemberStatusRequestSchema.safeParse(body).success).toBe(
        false,
      );
    for (const membershipStatus of ['active', 'suspended'])
      expect(
        workspaceMemberStatusResponseSchema.safeParse({
          userId: memberId,
          roleRevision: 5,
          membershipStatus,
          replayed: true,
        }).success,
      ).toBe(true);
    expect(
      workspaceMemberStatusResponseSchema.safeParse({
        userId: memberId,
        roleRevision: 5,
        membershipStatus: 'removed',
        replayed: false,
      }).success,
    ).toBe(false);
  });

  it('fences an ownership transfer by both memberships', () => {
    expect(
      workspaceOwnershipTransferRequestSchema.parse({
        expectedRoleRevision: 2,
        expectedOwnerRoleRevision: 1,
      }),
    ).toEqual({ expectedRoleRevision: 2, expectedOwnerRoleRevision: 1 });
    for (const body of [
      { expectedRoleRevision: 2 },
      { expectedOwnerRoleRevision: 1 },
      { expectedRoleRevision: 2, expectedOwnerRoleRevision: 1, role: 'owner' },
    ])
      expect(
        workspaceOwnershipTransferRequestSchema.safeParse(body).success,
      ).toBe(false);
    expect(
      workspaceOwnershipTransferResponseSchema.parse({
        ownerUserId: memberId,
        ownerRoleRevision: 3,
        previousOwnerUserId: ownerId,
        previousOwnerRoleRevision: 2,
        replayed: false,
      }),
    ).toMatchObject({ ownerUserId: memberId, previousOwnerUserId: ownerId });
  });

  it('publishes each command with the member command responses', () => {
    const paths = identityWorkspaceOpenApiDocument.paths;
    const commands = [
      [
        paths['/v1/workspaces/{workspaceId}/members/{userId}/suspend'].post,
        'suspendWorkspaceMember',
        'WorkspaceMemberStatusRequest',
      ],
      [
        paths['/v1/workspaces/{workspaceId}/members/{userId}/reactivate'].post,
        'reactivateWorkspaceMember',
        'WorkspaceMemberStatusRequest',
      ],
      [
        paths[
          '/v1/workspaces/{workspaceId}/members/{userId}/transfer-ownership'
        ].post,
        'transferWorkspaceOwnership',
        'WorkspaceOwnershipTransferRequest',
      ],
    ] as const;
    for (const [route, operationId, request] of commands) {
      expect(route.operationId).toBe(operationId);
      expect(route.requestBody).toEqual({
        required: true,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${request}` },
          },
        },
      });
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
    }
    const leave = paths['/v1/workspaces/{workspaceId}/leave'].post;
    expect(leave.operationId).toBe('leaveWorkspace');
    expect(Object.keys(leave.responses)).not.toContain('404');
  });

  it('names a stale sign-in and a member in the wrong state', () => {
    expect(API_PROBLEM_CODES).toContain('auth.session_not_fresh');
    expect(API_PROBLEM_MANIFEST['auth.session_not_fresh']).toMatchObject({
      status: 403,
      exposeDetail: true,
    });
    expect(
      API_PROBLEM_MANIFEST['workspace.member_status_conflict'],
    ).toMatchObject({ status: 409, exposeDetail: true });
  });
});
