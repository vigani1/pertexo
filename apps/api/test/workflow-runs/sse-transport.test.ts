import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createActorContext } from '../../src/workspaces/index.js';
import { writeSseFrames } from '../../src/workflow-runs/controllers.js';
import { StreamRunEventsUseCase } from '../../src/workflow-runs/use-cases.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function frame(id: number) {
  return {
    id,
    event: 'run.started',
    data: JSON.stringify({
      sequence: id,
      type: 'run.started',
      createdAt: '2026-08-21T12:00:00.000Z',
      payload: { schemaVersion: 1 },
    }),
    visibilityPath: 'initial_backfill' as const,
  };
}

describe('workflow run SSE transport', () => {
  it('does not read ahead while the transport is backpressured', async () => {
    let produced = 0;
    const frames = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        for (let id = 1; id <= 1_000; id += 1) {
          produced += 1;
          yield frame(id);
        }
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
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    destination.end = vi.fn<() => void>();
    destination.destroy = vi.fn<(error?: Error) => void>();
    destination.destroyed = false;
    const writing = writeSseFrames(
      frames,
      destination,
      new AbortController(),
      { recordFirstEligibleFrame: vi.fn() },
      'initial_backfill',
    );

    await vi.waitFor(() => {
      expect(destination.write).toHaveBeenCalledOnce();
    });
    expect(produced).toBe(1);
    destination.emit('drain');
    await writing;

    expect(produced).toBe(1_000);
    expect(destination.write).toHaveBeenCalledTimes(1_000);
    expect(
      destination.write.mock.calls.map(([chunk]) =>
        Number(/^id: (\d+)/u.exec(chunk)?.[1]),
      ),
    ).toEqual(Array.from({ length: 1_000 }, (_, index) => index + 1));
    expect(destination.end).toHaveBeenCalledOnce();
  });

  it('stops a blocked producer on disconnect and leaves replay to the durable cursor', async () => {
    let returned = false;
    let produced = 0;
    const frames = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          produced += 1;
          return Promise.resolve({
            done: false as const,
            value: frame(produced),
          });
        },
        return: () => {
          returned = true;
          return Promise.resolve({ done: true as const, value: undefined });
        },
      }),
    };
    const destination = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => boolean;
      end: () => void;
      destroy: (error?: Error) => void;
      destroyed: boolean;
    };
    destination.write = vi
      .fn<(chunk: string) => boolean>()
      .mockReturnValue(false);
    destination.end = vi.fn<() => void>();
    destination.destroy = vi.fn<(error?: Error) => void>();
    destination.destroyed = false;
    const controller = new AbortController();
    const writing = writeSseFrames(
      frames,
      destination,
      controller,
      { recordFirstEligibleFrame: vi.fn() },
      'reconnect_backfill',
    );
    await vi.waitFor(() => {
      expect(destination.listenerCount('drain')).toBe(1);
    });

    controller.abort();
    await writing;

    expect(produced).toBe(1);
    expect(returned).toBe(true);
    expect(destination.listenerCount('drain')).toBe(0);
    expect(destination.listenerCount('close')).toBe(0);
    expect(destination.listenerCount('error')).toBe(0);
    expect(destination.end).toHaveBeenCalledOnce();
  });

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
        get: vi.fn().mockResolvedValue({ run: {}, nodes: [] }),
      } as never,
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
      writing = writeSseFrames(
        frames,
        destination,
        controller,
        { recordFirstEligibleFrame: vi.fn() },
        'live_wakeup',
      );
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
});
