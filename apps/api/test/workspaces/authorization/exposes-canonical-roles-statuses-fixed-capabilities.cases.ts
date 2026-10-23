import { expect, it } from 'vitest';
import {
  AUTHORIZATION_CAPABILITIES,
  MEMBERSHIP_STATUSES,
  ROLES,
  WORKSPACE_STATUSES,
  assertAuthorizedWorkspaceContext,
  authorizeWorkspace,
  capabilitiesForRole,
  hasCapability,
} from '../../../src/authorization/index.js';
import { workspaceId, actor, access } from './fixture.js';

export function registerExposesCanonicalRolesStatusesFixedCapabilities(): void {
  it('exposes the canonical roles, statuses, and fixed capabilities', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'builder', 'operator', 'viewer']);
    expect(MEMBERSHIP_STATUSES).toEqual(['active', 'suspended', 'removed']);
    expect(WORKSPACE_STATUSES).toEqual([
      'active',
      'suspended',
      'pending_deletion',
      'purging',
      'deleted',
    ]);
    expect(AUTHORIZATION_CAPABILITIES).toEqual([
      'workspace:read',
      'workspace:manage',
      'audit:read',
      'governance:manage',
      'variable:manage',
      'artifact:read',
      'artifact:upload',
      'workflow:read',
      'workflow:create',
      'workflow:update',
      'workflow:publish',
      'run:read',
      'run:start',
      'run:cancel',
      'run:replay',
      'connection:read',
      'connection:use',
      'connection:manage',
      'member:read',
      'member:manage',
      'notification:read',
      'notification:manage_defaults',
    ]);
  });

  it('maps roles to capabilities with least privilege boundaries', () => {
    for (const capability of AUTHORIZATION_CAPABILITIES) {
      expect(hasCapability('owner', capability)).toBe(true);
    }

    expect(hasCapability('admin', 'workflow:publish')).toBe(true);
    expect(hasCapability('admin', 'member:manage')).toBe(true);
    expect(hasCapability('admin', 'workspace:manage')).toBe(false);
    expect(hasCapability('builder', 'workflow:update')).toBe(true);
    expect(hasCapability('builder', 'run:start')).toBe(true);
    expect(hasCapability('builder', 'connection:manage')).toBe(false);
    expect(hasCapability('operator', 'run:start')).toBe(true);
    expect(hasCapability('operator', 'connection:use')).toBe(true);
    expect(hasCapability('operator', 'workflow:update')).toBe(false);
    expect(hasCapability('viewer', 'workflow:read')).toBe(true);
    expect(hasCapability('viewer', 'run:start')).toBe(false);
    expect(hasCapability('viewer', 'connection:use')).toBe(false);
    // ADR 055: the inbox is for people who act on failed runs.
    expect(hasCapability('operator', 'notification:read')).toBe(true);
    expect(hasCapability('builder', 'notification:read')).toBe(false);
    expect(hasCapability('viewer', 'notification:read')).toBe(false);
  });

  it('keeps the complete role policy explicit and duplicate-free', () => {
    expect(capabilitiesForRole('owner')).toEqual(AUTHORIZATION_CAPABILITIES);
    expect(capabilitiesForRole('admin')).toEqual([
      'audit:read',
      'governance:manage',
      'variable:manage',
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
      'notification:read',
      'notification:manage_defaults',
    ]);
    expect(capabilitiesForRole('builder')).toEqual([
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
    ]);
    expect(capabilitiesForRole('operator')).toEqual([
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
      'notification:read',
    ]);
    expect(capabilitiesForRole('viewer')).toEqual([
      'artifact:read',
      'workspace:read',
      'workflow:read',
      'run:read',
      'connection:read',
    ]);
  });

  it.each(['suspended', 'removed'] as const)(
    'does not authorize a %s membership',
    async (membershipStatus) => {
      await expect(
        authorizeWorkspace({
          actor: actor(),
          routeWorkspaceId: workspaceId,
          capability: 'workflow:read',
          access: () => Promise.resolve(access({ membershipStatus })),
        }),
      ).rejects.toMatchObject({ code: 'auth.forbidden' });
    },
  );

  it.each(['suspended', 'pending_deletion', 'purging', 'deleted'] as const)(
    'does not authorize a %s workspace for normal operations',
    async (workspaceStatus) => {
      await expect(
        authorizeWorkspace({
          actor: actor(),
          routeWorkspaceId: workspaceId,
          capability: 'workflow:read',
          access: () => Promise.resolve(access({ workspaceStatus })),
        }),
      ).rejects.toMatchObject({ code: 'auth.forbidden' });
    },
  );

  it('returns an immutable authorized context after checking explicit route scope', async () => {
    const authorized = await authorizeWorkspace({
      actor: actor(),
      routeWorkspaceId: workspaceId,
      capability: 'workflow:read',
      access: () => Promise.resolve(access({ role: 'builder' })),
    });

    expect(authorized).toMatchObject({
      workspaceId,
      role: 'builder',
      capability: 'workflow:read',
      actor: actor(),
    });
    expect(Object.isFrozen(authorized)).toBe(true);
    expect(Object.isFrozen(authorized.actor)).toBe(true);

    expect(
      assertAuthorizedWorkspaceContext({
        context: authorized,
        actor: authorized.actor,
        routeWorkspaceId: workspaceId,
        capability: 'workflow:read',
      }),
    ).toBe(authorized);
  });

  it('rejects fabricated and mismatched guard authorization contexts', async () => {
    const authorized = await authorizeWorkspace({
      actor: actor(),
      routeWorkspaceId: workspaceId,
      capability: 'workflow:read',
      access: () => Promise.resolve(access()),
    });

    expect(() =>
      assertAuthorizedWorkspaceContext({
        context: { ...authorized },
        actor: authorized.actor,
        routeWorkspaceId: workspaceId,
        capability: 'workflow:read',
      }),
    ).toThrow('authorization context was not established by the guard seam');
    expect(() =>
      assertAuthorizedWorkspaceContext({
        context: authorized,
        actor: authorized.actor,
        routeWorkspaceId: workspaceId,
        capability: 'workflow:update',
      }),
    ).toThrow('authorization context does not match the operation');
  });
}
