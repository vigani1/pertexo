import { expect, it, vi } from 'vitest';

import { createActorContext } from '../../../../src/authorization/index.js';

import {
  createStreamAuthorizationLifetime,
  nextFrameOrAuthorizationLoss,
} from '../../../../src/workflow-runs/events/sse-authorization-lifetime.js';

import { actorId, sessionId, workspaceId } from './fixture.js';

export function registerPerformsOneIdleRefreshWithoutSpinning(): void {
  it.each([
    { label: 'more than five seconds', remainingMs: 60_000, advanceMs: 4_000 },
    { label: 'exactly one second', remainingMs: 1_000, advanceMs: 0 },
    { label: '999 milliseconds', remainingMs: 999, advanceMs: 0 },
  ] as const)(
    'performs one idle refresh without spinning for a fixed expiry $label away',
    async ({ remainingMs, advanceMs }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
      const expiresAt = new Date(Date.now() + remainingMs);
      const reauthorizeSession = vi.fn().mockResolvedValue({
        userId: actorId,
        sessionId,
        expiresAt,
      });
      const access = {
        findAccess: vi.fn().mockResolvedValue({
          actorId,
          workspaceId,
          role: 'viewer' as const,
          membershipStatus: 'active' as const,
          workspaceStatus: 'active' as const,
        }),
      };
      const abortStream = vi.fn();
      const lifetime = createStreamAuthorizationLifetime(
        {
          actor: createActorContext({
            actorId,
            workspaceId,
            sessionId,
            requestId: 'fixed-expiry',
          }),
          routeWorkspaceId: workspaceId,
          sessionExpiresAt: expiresAt,
          reauthorizeSession,
          abortStream,
          signal: new AbortController().signal,
        },
        access,
        5_000,
        new AbortController(),
      );
      try {
        await vi.advanceTimersByTimeAsync(advanceMs);
        expect(reauthorizeSession).toHaveBeenCalledOnce();
        expect(access.findAccess).toHaveBeenCalledOnce();

        if (remainingMs > 5_000) {
          await vi.advanceTimersByTimeAsync(3_999);
          expect(reauthorizeSession).toHaveBeenCalledOnce();
          expect(abortStream).not.toHaveBeenCalled();
          expect(lifetime.authorizationLost.aborted).toBe(false);
        } else {
          const untilExpiry = remainingMs - advanceMs;
          if (untilExpiry > 1) {
            await vi.advanceTimersByTimeAsync(untilExpiry - 1);
            expect(reauthorizeSession).toHaveBeenCalledOnce();
            expect(abortStream).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
          }
          expect(lifetime.authorizationLost.aborted).toBe(true);
          expect(abortStream).toHaveBeenCalledOnce();
        }
      } finally {
        await lifetime.stop();
        vi.useRealTimers();
      }
    },
  );

  it('does not spin when the verified session is already at exact expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
    const expiresAt = new Date(Date.now());
    const reauthorizeSession = vi.fn().mockResolvedValue({
      userId: actorId,
      sessionId,
      expiresAt,
    });
    const abortStream = vi.fn();
    const lifetime = createStreamAuthorizationLifetime(
      {
        actor: createActorContext({
          actorId,
          workspaceId,
          sessionId,
          requestId: 'exact-expiry',
        }),
        routeWorkspaceId: workspaceId,
        sessionExpiresAt: expiresAt,
        reauthorizeSession,
        abortStream,
        signal: new AbortController().signal,
      },
      { findAccess: vi.fn() },
      5_000,
      new AbortController(),
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(reauthorizeSession.mock.calls.length).toBeLessThanOrEqual(1);
      expect(lifetime.authorizationLost.aborted).toBe(true);
      expect(abortStream).toHaveBeenCalledOnce();
    } finally {
      await lifetime.stop();
      vi.useRealTimers();
    }
  });

  it('schedules a later idle refresh only when authorization verifies a newer expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
    const initialExpiry = new Date(Date.now() + 999);
    const extendedExpiry = new Date(Date.now() + 60_000);
    const reauthorizeSession = vi.fn().mockResolvedValue({
      userId: actorId,
      sessionId,
      expiresAt: extendedExpiry,
    });
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
          requestId: 'extended-expiry',
        }),
        routeWorkspaceId: workspaceId,
        sessionExpiresAt: initialExpiry,
        reauthorizeSession,
        abortStream: vi.fn(),
        signal: new AbortController().signal,
      },
      access,
      5_000,
      new AbortController(),
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(reauthorizeSession).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3_999);
      expect(reauthorizeSession).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(reauthorizeSession).toHaveBeenCalledTimes(2);
      expect(access.findAccess).toHaveBeenCalledTimes(2);
    } finally {
      await lifetime.stop();
      vi.useRealTimers();
    }
  });

  it('returns authorization loss without reading when already revoked', async () => {
    const authorizationLost = new AbortController();
    const reason = new Error('revoked');
    authorizationLost.abort(reason);
    const next = vi.fn();

    await expect(
      nextFrameOrAuthorizationLoss({ next }, authorizationLost.signal),
    ).resolves.toEqual({ kind: 'authorization_lost', error: reason });
    expect(next).not.toHaveBeenCalled();
  });

  it('observes authorization loss that races listener registration', async () => {
    const authorizationLost = new AbortController();
    const reason = new Error('revoked while subscribing');
    const originalAdd = authorizationLost.signal.addEventListener.bind(
      authorizationLost.signal,
    );
    vi.spyOn(authorizationLost.signal, 'addEventListener').mockImplementation(
      (...arguments_) => {
        originalAdd(...arguments_);
        authorizationLost.abort(reason);
      },
    );

    await expect(
      nextFrameOrAuthorizationLoss(
        { next: () => new Promise<IteratorResult<never>>(() => undefined) },
        authorizationLost.signal,
      ),
    ).resolves.toEqual({ kind: 'authorization_lost', error: reason });
  });
}
