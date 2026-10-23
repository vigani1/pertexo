import { expect, it, vi } from 'vitest';
import {
  AuthorizationError,
  authorizeWorkspace,
  authorizeWorkspaceOperation,
} from '../../../src/authorization/index.js';
import { workspaceId, actor, access } from './fixture.js';

export function registerReusesMatchingGuardAuthorizationWithoutSecond(): void {
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
}
