import { describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_CAPABILITIES,
  ROLES,
  capabilitiesForRole,
  canChangeWorkspaceMemberRole,
  canInviteWorkspaceRole,
  canLeaveWorkspace,
  canRemoveWorkspaceMember,
  canSuspendWorkspaceMember,
  canTransferWorkspaceOwnership,
  hasCapability,
  rolesForCapability,
  type AuthorizationCapability,
  type Role,
} from '../src/tenant-access/workspace-policy.js';

const expectedCapabilitiesByRole = {
  owner: AUTHORIZATION_CAPABILITIES,
  admin: [
    'artifact:read',
    'workspace:read',
    'workflow:read',
    'run:read',
    'connection:read',
    'artifact:upload',
    'workflow:create',
    'workflow:update',
    'workflow:publish',
    'run:start',
    'run:cancel',
    'run:replay',
    'connection:use',
    'connection:manage',
    'member:read',
    'member:manage',
  ],
  builder: [
    'artifact:read',
    'workspace:read',
    'workflow:read',
    'run:read',
    'connection:read',
    'artifact:upload',
    'workflow:create',
    'workflow:update',
    'workflow:publish',
    'run:start',
    'connection:use',
  ],
  operator: [
    'artifact:read',
    'workspace:read',
    'workflow:read',
    'run:read',
    'connection:read',
    'artifact:upload',
    'run:start',
    'run:cancel',
    'run:replay',
    'connection:use',
  ],
  viewer: [
    'artifact:read',
    'workspace:read',
    'workflow:read',
    'run:read',
    'connection:read',
  ],
} as const satisfies Record<Role, readonly AuthorizationCapability[]>;

function includesCapability(
  capabilities: readonly AuthorizationCapability[],
  capability: AuthorizationCapability,
): boolean {
  return capabilities.some((candidate) => candidate === capability);
}

describe('workspace authorization policy', () => {
  it('exposes the exact capability set for every role', () => {
    for (const role of ROLES) {
      const capabilities: readonly AuthorizationCapability[] =
        expectedCapabilitiesByRole[role];
      expect(capabilitiesForRole(role)).toEqual(capabilities);
      for (const capability of AUTHORIZATION_CAPABILITIES) {
        expect(hasCapability(role, capability)).toBe(
          includesCapability(capabilities, capability),
        );
      }
    }
  });

  it('derives the exact role set for every capability', () => {
    for (const capability of AUTHORIZATION_CAPABILITIES) {
      const expectedRoles = ROLES.filter((role) =>
        includesCapability(expectedCapabilitiesByRole[role], capability),
      );
      expect(rolesForCapability(capability)).toEqual(expectedRoles);
    }
  });

  it('encodes the complete approved existing-member role transition matrix', () => {
    const delegated = new Set<Role>(['builder', 'operator', 'viewer']);
    for (const actor of ROLES) {
      for (const current of ROLES) {
        for (const next of ROLES) {
          const expected =
            current !== 'owner' &&
            next !== 'owner' &&
            (actor === 'owner' ||
              (actor === 'admin' &&
                delegated.has(current) &&
                delegated.has(next)));
          expect(
            canChangeWorkspaceMemberRole(actor, current, next),
            `${actor}: ${current} -> ${next}`,
          ).toBe(expected);
        }
      }
    }
  });

  it('encodes the complete approved member removal matrix', () => {
    const delegated = new Set<Role>(['builder', 'operator', 'viewer']);
    for (const actor of ROLES) {
      for (const target of ROLES) {
        const expected =
          target !== 'owner' &&
          (actor === 'owner' || (actor === 'admin' && delegated.has(target)));
        expect(
          canRemoveWorkspaceMember(actor, target),
          `${actor} removes ${target}`,
        ).toBe(expected);
      }
    }
  });

  it('encodes the leave, suspension and ownership transfer matrices', () => {
    for (const actor of ROLES) {
      expect(canLeaveWorkspace(actor), `${actor} leaves`).toBe(
        actor !== 'owner',
      );
      for (const target of ROLES) {
        expect(
          canSuspendWorkspaceMember(actor, target),
          `${actor} suspends ${target}`,
        ).toBe(canRemoveWorkspaceMember(actor, target));
        expect(
          canTransferWorkspaceOwnership(actor, target),
          `${actor} transfers to ${target}`,
        ).toBe(actor === 'owner' && target !== 'owner');
      }
    }
  });

  it('encodes the complete approved invitation role matrix', () => {
    const delegated = new Set<Role>(['builder', 'operator', 'viewer']);
    for (const actor of ROLES) {
      for (const invited of ROLES) {
        const expected =
          invited !== 'owner' &&
          (actor === 'owner' || (actor === 'admin' && delegated.has(invited)));
        expect(
          canInviteWorkspaceRole(actor, invited),
          `${actor} invites ${invited}`,
        ).toBe(expected);
      }
    }
  });
});
