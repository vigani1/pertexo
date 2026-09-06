import { describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_CAPABILITIES,
  ROLES,
  capabilitiesForRole,
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
});
