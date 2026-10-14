import { describe, expect, it } from 'vitest';
import {
  authorizeWorkspace,
  assertAuthorizedWorkspaceContext,
  commandIdempotencyScope,
  createActorContext,
  createApiTokenActorContext,
} from '../../src/authorization/index.js';
import type { ApiTokenScope } from '@pertexo/contracts';

const actorId = '0194a800-0000-7000-8000-000000000001';
const workspaceId = '0194a800-0000-7000-8000-000000000002';
const tokenId = '0194a800-0000-7000-8000-000000000003';
const requestId = 'token-request';
const token = (scopes: readonly ApiTokenScope[] = ['run:read']) =>
  createApiTokenActorContext({
    actorId,
    workspaceId,
    tokenId,
    requestId,
    scopes,
  });
const access = () =>
  Promise.resolve({
    actorId,
    workspaceId,
    role: 'owner' as const,
    membershipStatus: 'active' as const,
    workspaceStatus: 'active' as const,
  });

describe('shared token authorization', () => {
  it('requires the scope even when the owner has every role capability', async () => {
    await expect(
      authorizeWorkspace({
        actor: token(),
        routeWorkspaceId: workspaceId,
        capability: 'run:start',
        access,
      }),
    ).rejects.toMatchObject({ code: 'auth.forbidden' });
    await expect(
      authorizeWorkspace({
        actor: token(),
        routeWorkspaceId: workspaceId,
        capability: 'run:read',
        access,
      }),
    ).resolves.toMatchObject({ capability: 'run:read' });
  });
  it('requires the current role even when a scope was granted', async () => {
    await expect(
      authorizeWorkspace({
        actor: token(['run:start']),
        routeWorkspaceId: workspaceId,
        capability: 'run:start',
        access: async () => ({ ...(await access()), role: 'viewer' as const }),
      }),
    ).rejects.toMatchObject({ code: 'auth.forbidden' });
  });
  it('does not transfer guard authority across credentials or expanded scopes', async () => {
    const actor = token();
    const context = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'run:read',
      access,
    });
    const input = {
      context,
      routeWorkspaceId: workspaceId,
      capability: 'run:read' as const,
    };
    expect(assertAuthorizedWorkspaceContext({ ...input, actor })).toBe(context);
    expect(() =>
      assertAuthorizedWorkspaceContext({
        ...input,
        actor: createActorContext({
          actorId,
          workspaceId,
          requestId,
          sessionId: tokenId,
        }),
      }),
    ).toThrow();
    expect(() =>
      assertAuthorizedWorkspaceContext({
        ...input,
        actor: token(['run:read', 'run:start']),
      }),
    ).toThrow();
    expect(() =>
      assertAuthorizedWorkspaceContext({
        ...input,
        actor: { ...actor, tokenId: workspaceId },
      }),
    ).toThrow();
  });
  it('isolates receipt scopes while preserving the browser scope', () => {
    const key = 'deployment-command-1';
    const actor = token();
    const scoped = commandIdempotencyScope(actor, key);
    expect(scoped).toMatch(/^api_token:[0-9a-f]{64}$/u);
    expect(commandIdempotencyScope(actor, key)).toBe(scoped);
    expect(
      commandIdempotencyScope({ ...actor, tokenId: workspaceId }, key),
    ).not.toBe(scoped);
    expect(commandIdempotencyScope(actor, key + '-changed')).not.toBe(scoped);
    expect(
      commandIdempotencyScope(
        createActorContext({
          actorId,
          workspaceId,
          requestId,
          sessionId: tokenId,
        }),
        key,
      ),
    ).toBe(key);
  });
});
