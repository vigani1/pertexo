import { describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_CAPABILITIES,
  MEMBERSHIP_STATUSES,
  ROLES,
  WORKSPACE_STATUSES,
  AuthorizationError,
  authorizeWorkspace,
  capabilitiesForRole,
  createActorContext,
  hasCapability,
  type WorkspaceAccess,
} from '../../src/workspaces/index.js';

const workspaceId = 'workspace-a';
const actorId = 'user-a';

function actor() {
  return createActorContext({
    actorId,
    workspaceId,
    sessionId: 'session-a',
    requestId: 'request-a',
    traceId: 'trace-a',
  });
}

function access(overrides: Partial<WorkspaceAccess> = {}): WorkspaceAccess {
  return {
    actorId,
    workspaceId,
    role: 'viewer',
    membershipStatus: 'active',
    workspaceStatus: 'active',
    ...overrides,
  };
}

describe('workspace authorization policy', () => {
  it('exposes the canonical roles, statuses, and fixed capabilities', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'builder', 'operator', 'viewer']);
    expect(MEMBERSHIP_STATUSES).toEqual(['active', 'suspended', 'removed']);
    expect(WORKSPACE_STATUSES).toEqual([
      'active',
      'suspended',
      'pending_deletion',
      'deleted',
    ]);
    expect(AUTHORIZATION_CAPABILITIES).toEqual([
      'workspace:read',
      'workspace:manage',
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
  });

  it('keeps the complete role policy explicit and duplicate-free', () => {
    expect(capabilitiesForRole('owner')).toEqual(AUTHORIZATION_CAPABILITIES);
    expect(capabilitiesForRole('admin')).toEqual([
      'workspace:read',
      'workflow:read',
      'run:read',
      'connection:read',
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
    ]);
    expect(capabilitiesForRole('builder')).toEqual([
      'workspace:read',
      'workflow:read',
      'run:read',
      'connection:read',
      'workflow:create',
      'workflow:update',
      'workflow:publish',
      'run:start',
      'connection:use',
    ]);
    expect(capabilitiesForRole('operator')).toEqual([
      'workspace:read',
      'workflow:read',
      'run:read',
      'connection:read',
      'run:start',
      'run:cancel',
      'run:replay',
      'connection:use',
    ]);
    expect(capabilitiesForRole('viewer')).toEqual([
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

  it.each(['suspended', 'pending_deletion', 'deleted'] as const)(
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
  });

  it('re-freezes a structurally valid actor supplied by an untrusted adapter', async () => {
    const mutableActor = { ...actor() };
    const authorized = await authorizeWorkspace({
      actor: mutableActor,
      routeWorkspaceId: workspaceId,
      capability: 'workflow:read',
      access: () => Promise.resolve(access({ role: 'viewer' })),
    });

    expect(Object.isFrozen(authorized.actor)).toBe(true);
    expect(authorized.actor).not.toBe(mutableActor);
  });

  it('rejects a forged route workspace without asking a tenant transaction to prove it', async () => {
    let lookups = 0;
    await expect(
      authorizeWorkspace({
        actor: actor(),
        routeWorkspaceId: 'workspace-forged',
        capability: 'workflow:read',
        access: () => {
          lookups += 1;
          return Promise.resolve(access());
        },
      }),
    ).rejects.toMatchObject({ code: 'auth.forbidden' });
    expect(lookups).toBe(0);
  });

  it('supports not-found disclosure for missing or unauthorized workspace access', async () => {
    await expect(
      authorizeWorkspace({
        actor: actor(),
        routeWorkspaceId: workspaceId,
        capability: 'workflow:read',
        disclosure: 'not_found',
        access: () => Promise.resolve(undefined),
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
  });

  it('uses stable typed errors for missing actor and denied capabilities', async () => {
    await expect(
      authorizeWorkspace({
        actor: undefined,
        routeWorkspaceId: workspaceId,
        capability: 'workflow:read',
        access: () => Promise.resolve(access()),
      }),
    ).rejects.toMatchObject({ code: 'auth.unauthenticated' });

    await expect(
      authorizeWorkspace({
        actor: actor(),
        routeWorkspaceId: workspaceId,
        capability: 'workflow:update',
        access: () => Promise.resolve(access({ role: 'viewer' })),
      }),
    ).rejects.toMatchObject({ code: 'auth.forbidden' });

    try {
      await authorizeWorkspace({
        actor: actor(),
        routeWorkspaceId: workspaceId,
        capability: 'workflow:update',
        access: () => Promise.resolve(access({ role: 'viewer' })),
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error).toMatchObject({ code: 'auth.forbidden' });
    }
  });
});

describe('immutable actor context', () => {
  it('freezes actor identity and rejects invalid actor kinds', () => {
    const context = actor();
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => {
      (context as { workspaceId: string }).workspaceId = 'other';
    }).toThrow();
    expect(() =>
      createActorContext({
        actorId,
        kind: 'service_account',
        workspaceId,
        sessionId: 'session-a',
        requestId: 'request-a',
      }),
    ).toThrow(/kind/u);
  });
});
