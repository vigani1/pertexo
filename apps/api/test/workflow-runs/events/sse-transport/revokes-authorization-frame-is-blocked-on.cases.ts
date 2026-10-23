import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

import { createActorContext } from '../../../../src/authorization/index.js';

import { writeSseFrames } from '../../../../src/workflow-runs/events/sse-transport.js';

import { StreamRunEventsUseCase } from '../../../../src/workflow-runs/use-cases.js';
import { actorId, sessionId, workspaceId, runId, frame } from './fixture.js';

export function registerRevokesAuthorizationFrameIsBlockedOn(): void {
  it('revokes authorization while a frame is blocked on transport backpressure', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let producerCleanedUp = false;
    let producerSignal: AbortSignal | undefined;
    let reauthorizationSignal: AbortSignal | undefined;
    const expiresAt = new Date(Date.now() + 5_000);
    const stalledLookup = Promise.withResolvers<{
      userId: string;
      sessionId: string;
      expiresAt: Date;
    }>();
    const authorizedSession = {
      userId: actorId,
      sessionId,
      expiresAt,
    };
    const reauthorizeSession = vi
      .fn()
      .mockResolvedValueOnce(authorizedSession)
      .mockImplementation((signal: AbortSignal) => {
        reauthorizationSignal = signal;
        return stalledLookup.promise;
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
    const useCase = new StreamRunEventsUseCase(
      {
        canRead: () => Promise.resolve(true),
        get: vi.fn().mockResolvedValue({ run: {}, nodes: [] }),
      },
      access,
      {
        stream: ({ signal }) => {
          producerSignal = signal;
          return {
            async *[Symbol.asyncIterator]() {
              try {
                await Promise.resolve();
                yield frame(1);
                yield frame(2);
              } finally {
                producerCleanedUp = true;
              }
            },
          };
        },
      },
    );
    const streamInput = {
      actor: createActorContext({
        actorId,
        workspaceId,
        sessionId,
        requestId: 'request-42',
      }),
      routeWorkspaceId: workspaceId,
      runId,
      lastEventId: 0,
      sessionExpiresAt: expiresAt,
      reauthorizeSession,
      signal: controller.signal,
      abortStream: (reason?: unknown) => {
        controller.abort(reason);
      },
    };
    const destination = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn<(chunk: string) => boolean>>;
      end: ReturnType<typeof vi.fn<() => void>>;
      destroy: ReturnType<typeof vi.fn<(error?: Error) => void>>;
      destroyed: boolean;
    };
    destination.write = vi
      .fn<(chunk: string) => boolean>()
      .mockReturnValue(false);
    destination.end = vi.fn<() => void>();
    destination.destroy = vi.fn<(error?: Error) => void>();
    destination.destroyed = false;

    let writing: Promise<void> | undefined;
    try {
      const frames = await useCase.execute(streamInput);
      writing = writeSseFrames(frames, destination, {
        controller: controller,
        visibilityMetrics: { recordFirstEligibleFrame: vi.fn() },
        fallbackPath: 'live_wakeup',
      });
      await vi.waitFor(() => {
        expect(destination.listenerCount('drain')).toBe(1);
      });

      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();

      expect(controller.signal.aborted).toBe(true);
      const cleanup = Promise.race([
        writing.then(() => 'settled' as const),
        new Promise<'timed_out'>((resolve) => {
          setTimeout(() => {
            resolve('timed_out');
          }, 1);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await cleanup).toBe('settled');
      expect(destination.write).toHaveBeenCalledOnce();
      expect(reauthorizeSession).toHaveBeenCalledTimes(2);
      expect(reauthorizationSignal?.aborted).toBe(true);
      expect(producerSignal?.aborted).toBe(true);
      expect(producerCleanedUp).toBe(true);
      expect(destination.listenerCount('drain')).toBe(0);
      expect(destination.listenerCount('close')).toBe(0);
      expect(destination.listenerCount('error')).toBe(0);
      expect(destination.end).toHaveBeenCalledOnce();
    } finally {
      stalledLookup.resolve(authorizedSession);
      if (!controller.signal.aborted) controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      await writing;
      vi.useRealTimers();
    }
  });
}
