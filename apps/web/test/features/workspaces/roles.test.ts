import { describe, expect, it } from 'vitest';
import type { WorkspaceMember } from '@pertexo/contracts';
import {
  describeInvitationDelivery,
  describeInvitationExpiry,
} from '@/features/workspaces/model/invitation-words';
import { absorbAddresses } from '@/features/workspaces/model/invite-addresses';
import {
  assignableRoles,
  canChangeRoleOf,
  canLeaveWorkspace as canLeave,
  canSuspendMember,
  canTransferOwnershipTo,
  ROLE_MATRIX,
  roleLimitSentence,
  rolesAllowedTo,
  WORKSPACE_ROLES,
} from '@/features/workspaces/model/workspace-roles';
// The platform policy is dependency-free; the matrix must never drift from it.
import {
  canChangeWorkspaceMemberRole,
  canInviteWorkspaceRole,
  canLeaveWorkspace,
  canSuspendWorkspaceMember,
  canTransferWorkspaceOwnership,
  ROLES,
} from '@pertexo/workflow-model';

function member(
  role: WorkspaceMember['role'],
  userId = '11111111-1111-4111-8111-111111111111',
): WorkspaceMember {
  return {
    userId,
    email: 'member@example.test',
    displayName: 'Member',
    role,
    roleRevision: 1,
    membershipStatus: 'active',
    createdAt: '2026-09-15T10:00:00.000Z',
    updatedAt: '2026-09-15T10:00:00.000Z',
  };
}

describe('roles matrix', () => {
  it('lists the same roles, in the same order, as the platform policy', () => {
    expect([...WORKSPACE_ROLES]).toEqual([...ROLES]);
  });

  it('grants each ability to the roles the role summaries describe', () => {
    expect(ROLE_MATRIX.map(({ ability, roles }) => [ability, roles])).toEqual([
      [
        'See workflows, runs and connections',
        ['owner', 'admin', 'builder', 'operator', 'viewer'],
      ],
      ['Start runs', ['owner', 'admin', 'builder', 'operator']],
      ['Cancel and replay runs', ['owner', 'admin', 'operator']],
      ['Manage notification email defaults', ['owner', 'admin']],
      ['Get operational notices by default', ['owner', 'admin', 'operator']],
      ['Build, test and publish workflows', ['owner', 'admin', 'builder']],
      ['Read the audit log and manage audit retention', ['owner', 'admin']],
      ['Manage workspace variables', ['owner', 'admin']],
      ['Manage connections', ['owner', 'admin']],
      ['Manage members and invitations', ['owner', 'admin']],
      ['Rename, delete or hand over the workspace', ['owner']],
    ]);
  });

  it('names who holds a capability, most senior first', () => {
    expect(rolesAllowedTo('connection:manage')).toEqual(['owner', 'admin']);
    expect(rolesAllowedTo('run:cancel')).toEqual([
      'owner',
      'admin',
      'operator',
    ]);
    expect(rolesAllowedTo('workflow:publish')).toEqual([
      'owner',
      'admin',
      'builder',
    ]);
    expect(rolesAllowedTo('workspace:manage')).toEqual(['owner']);
    expect(
      roleLimitSentence('operator', 'connection:manage', 'manage connections'),
    ).toBe(
      'Your role (Operator) can’t manage connections. Admins and owners can.',
    );
  });

  it('offers only role changes and invitations the policy allows', () => {
    for (const actor of ROLES) {
      const invitable = ROLES.filter((role) =>
        canInviteWorkspaceRole(actor, role),
      );
      expect([...assignableRoles(actor)]).toEqual(invitable);
      for (const target of ROLES) {
        const changeable = ROLES.some((next) =>
          canChangeWorkspaceMemberRole(actor, target, next),
        );
        expect(
          canChangeRoleOf(
            { role: actor, userId: '22222222-2222-4222-8222-222222222222' },
            member(target),
          ),
        ).toBe(changeable);
      }
    }
  });

  it('offers suspension, ownership transfer and leaving only as the policy allows', () => {
    const other = '22222222-2222-4222-8222-222222222222';
    for (const actor of ROLES) {
      expect(canLeave(actor)).toBe(canLeaveWorkspace(actor));
      for (const target of ROLES) {
        const actorView = { role: actor, userId: other };
        expect(canSuspendMember(actorView, member(target))).toBe(
          canSuspendWorkspaceMember(actor, target),
        );
        expect(canTransferOwnershipTo(actorView, member(target))).toBe(
          canTransferWorkspaceOwnership(actor, target),
        );
      }
    }
    expect(
      canTransferOwnershipTo(
        { role: 'owner', userId: other },
        { ...member('admin'), membershipStatus: 'suspended' },
      ),
    ).toBe(false);
    expect(
      canTransferOwnershipTo(
        { role: 'owner', userId: 'self' },
        member('admin', 'self'),
      ),
    ).toBe(false);
  });

  it('never offers changing your own role', () => {
    expect(
      canChangeRoleOf(
        { role: 'owner', userId: 'self' },
        member('viewer', 'self'),
      ),
    ).toBe(false);
  });
});

describe('invitation words', () => {
  const now = Date.parse('2026-09-24T12:00:00.000Z');

  it('says when a pending invitation expires', () => {
    expect(
      describeInvitationExpiry(
        { status: 'pending', expiresAt: '2026-09-30T13:00:00.000Z' },
        now,
      ),
    ).toBe('expires in 6 days');
    expect(
      describeInvitationExpiry(
        { status: 'pending', expiresAt: '2026-09-25T13:00:00.000Z' },
        now,
      ),
    ).toBe('expires in 1 day');
    expect(
      describeInvitationExpiry(
        { status: 'pending', expiresAt: '2026-09-24T18:00:00.000Z' },
        now,
      ),
    ).toBe('expires today');
    expect(
      describeInvitationExpiry(
        { status: 'accepted', expiresAt: '2026-09-30T13:00:00.000Z' },
        now,
      ),
    ).toBeUndefined();
  });

  it('puts delivery in words', () => {
    expect(describeInvitationDelivery('queued').label).toBe('Sending');
    expect(describeInvitationDelivery('submitted').label).toBe('Sent');
    expect(describeInvitationDelivery('failed')).toEqual({
      label: 'Couldn’t send',
      problem: true,
    });
  });

  it('turns typed text into unique addresses and keeps what needs fixing', () => {
    expect(
      absorbAddresses(
        ['a@example.test'],
        'b@example.test, A@example.test nope',
      ),
    ).toEqual({
      emails: ['a@example.test', 'b@example.test'],
      rest: 'nope',
      error: '“nope” isn’t a complete email address, like name@company.com.',
    });
  });
});
