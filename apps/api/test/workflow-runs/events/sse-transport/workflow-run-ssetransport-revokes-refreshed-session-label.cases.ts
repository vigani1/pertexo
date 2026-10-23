import { expect, it, vi } from 'vitest';

import { createActorContext } from '../../../../src/authorization/index.js';

import {
  createStreamAuthorizationLifetime,
  nextFrameOrAuthorizationLoss,
} from '../../../../src/workflow-runs/events/sse-authorization-lifetime.js';

import { actorId, sessionId, workspaceId } from './fixture.js';

export function registerWorkflowRunSSETransportRevokesRefreshedSessionLabel(): void {
  it.each([
    {
      label: 'different user',
      session: {
        userId: '11111111-1111-4111-8111-111111111111',
        sessionId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    },
    {
      label: 'different session',
      session: {
        userId: actorId,
        sessionId: '11111111-1111-4111-8111-111111111111',
        expiresAt: new Date(Date.now() + 60_000),
      },
    },
    {
      label: 'invalid expiry',
      session: {
        userId: actorId,
        sessionId,
        expiresAt: new Date(Number.NaN),
      },
    },
    {
      label: 'expired session',
      session: {
        userId: actorId,
        sessionId,
        expiresAt: new Date(Date.now() - 1),
      },
    },
  ])('revokes a refreshed session with $label', async ({ session }) => {
    const abortStream = vi.fn();
    const lifetimeController = new AbortController();
    const lifetime = createStreamAuthorizationLifetime(
      {
        actor: createActorContext({
          actorId,
          workspaceId,
          sessionId,
          requestId: 'request-42',
        }),
        routeWorkspaceId: workspaceId,
        sessionExpiresAt: new Date(Date.now() + 60_000),
        reauthorizeSession: vi.fn().mockResolvedValue(session),
        abortStream,
        signal: new AbortController().signal,
      },
      { findAccess: vi.fn() },
      60_000,
      lifetimeController,
    );

    await expect(lifetime.reauthorize()).rejects.toThrow(
      'session is no longer authorized',
    );
    expect(lifetime.authorizationLost.aborted).toBe(true);
    expect(abortStream).toHaveBeenCalledOnce();
    await lifetime.stop();
  });

  it('coalesces concurrent explicit authorization refreshes', async () => {
    const deferred = Promise.withResolvers<{
      userId: string;
      sessionId: string;
      expiresAt: Date;
    }>();
    const reauthorizeSession = vi.fn(() => deferred.promise);
    const access = {
      findAccess: vi.fn().mockResolvedValue({
        actorId,
        workspaceId,
        role: 'viewer' as const,
        membershipStatus: 'active' as const,
        workspaceStatus: 'active' as const,
      }),
    };
    const lifetime = createStreamAuthorizationLifetime(
      {
        actor: createActorContext({
          actorId,
          workspaceId,
          sessionId,
          requestId: 'request-42',
        }),
        routeWorkspaceId: workspaceId,
        sessionExpiresAt: new Date(Date.now() + 60_000),
        reauthorizeSession,
        abortStream: vi.fn(),
        signal: new AbortController().signal,
      },
      access,
      60_000,
      new AbortController(),
    );

    const first = lifetime.reauthorize();
    const second = lifetime.reauthorize();
    expect(reauthorizeSession).toHaveBeenCalledOnce();
    deferred.resolve({
      userId: actorId,
      sessionId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await Promise.all([first, second]);

    expect(access.findAccess).toHaveBeenCalledOnce();
    await lifetime.stop();
  });

  it('stops without revoking when an explicit refresh is still pending', async () => {
    const deferred = Promise.withResolvers<{
      userId: string;
      sessionId: string;
      expiresAt: Date;
    }>();
    const abortStream = vi.fn();
    const lifetime = createStreamAuthorizationLifetime(
      {
        actor: createActorContext({
          actorId,
          workspaceId,
          sessionId,
          requestId: 'request-42',
        }),
        routeWorkspaceId: workspaceId,
        sessionExpiresAt: new Date(Date.now() + 60_000),
        reauthorizeSession: vi.fn(() => deferred.promise),
        abortStream,
        signal: new AbortController().signal,
      },
      { findAccess: vi.fn() },
      60_000,
      new AbortController(),
    );
    const refreshing = lifetime.reauthorize();

    await lifetime.stop();
    await expect(refreshing).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortStream).not.toHaveBeenCalled();

    deferred.resolve({
      userId: actorId,
      sessionId,
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  it('removes the losing authorization observer after every produced frame', async () => {
    const authorizationLost = new AbortController();
    const add = vi.spyOn(authorizationLost.signal, 'addEventListener');
    const remove = vi.spyOn(authorizationLost.signal, 'removeEventListener');
    let sequence = 0;
    const iterator: AsyncIterator<number> = {
      next: () =>
        Promise.resolve({ done: false as const, value: (sequence += 1) }),
    };

    for (let expected = 1; expected <= 10_000; expected += 1) {
      await expect(
        nextFrameOrAuthorizationLoss(iterator, authorizationLost.signal),
      ).resolves.toMatchObject({
        kind: 'frame',
        result: { done: false, value: expected },
      });
    }

    expect(add).toHaveBeenCalledTimes(10_000);
    expect(remove).toHaveBeenCalledTimes(10_000);
  });
}
