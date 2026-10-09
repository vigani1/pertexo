import { describe, expect, it, vi } from 'vitest';

import {
  AUTHORIZATION_CAPABILITIES,
  MEMBERSHIP_STATUSES,
  ROLES,
  WORKSPACE_STATUSES,
  AuthorizationError,
  assertAuthorizedWorkspaceContext,
  authorizeWorkspace,
  authorizeWorkspaceOperation,
  capabilitiesForRole,
  createActorContext,
  hasCapability,
  type WorkspaceAccess,
} from '../../src/authorization/index.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function actor() {
  return createActorContext({
    actorId,
    workspaceId,
    sessionId: '22222222-2222-4222-8222-222222222222',
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
      'purging',
      'deleted',
    ]);
    expect(AUTHORIZATION_CAPABILITIES).toEqual([
      'workspace:read',
      'workspace:manage',
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

  it('reuses a matching guard authorization without a second access lookup', async () => {
    const lookup = vi.fn(() => Promise.resolve(access()));
    const authorized = await authorizeWorkspace({
      actor: actor(),
      routeWorkspaceId: workspaceId,
      capability: 'workflow:read',
      access: lookup,
    });

    await expect(
      authorizeWorkspaceOperation({
        actor: authorized.actor,
        routeWorkspaceId: workspaceId,
        capability: 'workflow:read',
        access: lookup,
        authorizedWorkspace: authorized,
      }),
    ).resolves.toBe(authorized);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('rejects a suspended proof when reuse requests the default active-only policy', async () => {
    const lookup = vi.fn(() =>
      Promise.resolve(access({ workspaceStatus: 'suspended' })),
    );
    const authorized = await authorizeWorkspace({
      actor: actor(),
      routeWorkspaceId: workspaceId,
      capability: 'workflow:read',
      allowedWorkspaceStatuses: ['suspended'],
      access: lookup,
    });

    await expect(
      authorizeWorkspaceOperation({
        actor: authorized.actor,
        routeWorkspaceId: workspaceId,
        capability: 'workflow:read',
        access: lookup,
        authorizedWorkspace: authorized,
      }),
    ).rejects.toMatchObject({ code: 'auth.forbidden' });
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('reuses matching and broader lifecycle policies without another lookup', async () => {
    const suspendedLookup = vi.fn(() =>
      Promise.resolve(access({ workspaceStatus: 'suspended' })),
    );
    const suspended = await authorizeWorkspace({
      actor: actor(),
      routeWorkspaceId: workspaceId,
      capability: 'workflow:read',
      allowedWorkspaceStatuses: ['suspended'],
      access: suspendedLookup,
    });
    await expect(
      authorizeWorkspaceOperation({
        actor: suspended.actor,
        routeWorkspaceId: workspaceId,
        capability: 'workflow:read',
        allowedWorkspaceStatuses: ['suspended'],
        access: suspendedLookup,
        authorizedWorkspace: suspended,
      }),
    ).resolves.toBe(suspended);
    expect(suspendedLookup).toHaveBeenCalledOnce();

    const activeLookup = vi.fn(() => Promise.resolve(access()));
    const active = await authorizeWorkspace({
      actor: actor(),
      routeWorkspaceId: workspaceId,
      capability: 'workflow:read',
      access: activeLookup,
    });
    await expect(
      authorizeWorkspaceOperation({
        actor: active.actor,
        routeWorkspaceId: workspaceId,
        capability: 'workflow:read',
        allowedWorkspaceStatuses: ['active', 'suspended'],
        access: activeLookup,
        authorizedWorkspace: active,
      }),
    ).resolves.toBe(active);
    expect(activeLookup).toHaveBeenCalledOnce();
  });

  it('preserves an existing abort reason before reusing a valid proof', async () => {
    const lookup = vi.fn(() => Promise.resolve(access()));
    const authorized = await authorizeWorkspace({
      actor: actor(),
      routeWorkspaceId: workspaceId,
      capability: 'workflow:read',
      access: lookup,
    });
    const reason = new Error('request disconnected');
    const controller = new AbortController();
    controller.abort(reason);

    await expect(
      authorizeWorkspaceOperation({
        actor: authorized.actor,
        routeWorkspaceId: workspaceId,
        capability: 'workflow:read',
        access: lookup,
        authorizedWorkspace: authorized,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('rejects a forged route workspace without asking a tenant transaction to prove it', async () => {
    let lookups = 0;
    await expect(
      authorizeWorkspace({
        actor: actor(),
        routeWorkspaceId: '33333333-3333-4333-8333-333333333333',
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

    const denied = authorizeWorkspace({
      actor: actor(),
      routeWorkspaceId: workspaceId,
      capability: 'workflow:update',
      access: () => Promise.resolve(access({ role: 'viewer' })),
    });
    await expect(denied).rejects.toBeInstanceOf(AuthorizationError);
    await expect(denied).rejects.toMatchObject({ code: 'auth.forbidden' });
  });
});

describe('immutable actor context', () => {
  it('freezes actor identity', () => {
    const context = actor();
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => {
      (context as { workspaceId: string }).workspaceId = 'other';
    }).toThrow();
  });
});
