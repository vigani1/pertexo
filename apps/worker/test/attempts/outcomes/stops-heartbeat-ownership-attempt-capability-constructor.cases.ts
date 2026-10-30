import type { NodeAttemptRunStore } from '@pertexo/database/testing';

import { NodeExecutorFailure } from '@pertexo/node-sdk/server';

import { expect, it, vi } from 'vitest';
import { createNodeAttemptHandler } from '../../../src/testing.js';
import {
  delivery,
  executionHandler,
  executionStore,
  lease,
  projection,
  registryPreparedAttempt,
} from '../../support/attempts/handler.js';
import { heartbeatCancellationHandler } from './fixture.js';

export function registerStopsHeartbeatOwnershipAttemptCapabilityConstructor(): void {
  it('stops heartbeat ownership when an attempt capability constructor fails', async () => {
    vi.useFakeTimers();
    try {
      const heartbeat = vi
        .fn<NodeAttemptRunStore['heartbeat']>()
        .mockResolvedValue({
          control: { kind: 'none' },
          leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
        });
      const constructorError = new Error('connection capability failed');
      const runStore = executionStore({ heartbeat });
      const handler = createNodeAttemptHandler({
        engine: {
          prepare: vi.fn().mockReturnValue(registryPreparedAttempt()),
        },
        heartbeatIntervalMillis: 10,
        leaseDurationSeconds: 1,
        reader: {
          close: vi.fn(),
          readForExecution: vi.fn().mockResolvedValue(projection()),
        },
        registry: { execute: vi.fn() },
        runStore,
        runtimeCapabilities: {
          connections: () => {
            throw constructorError;
          },
        },
        workerId: 'worker-1',
      });

      await expect(
        handler.handle(delivery(), {
          signal: new AbortController().signal,
        }),
      ).rejects.toBe(constructorError);
      await vi.advanceTimersByTimeAsync(50);
      expect(heartbeat).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['resolve', 'reject'] as const)(
    'awaits a cancellation-ignoring heartbeat that settles late by %s',
    async (settlement) => {
      vi.useFakeTimers();
      try {
        const heartbeatResult = Promise.withResolvers<{
          control: { kind: 'none' };
          leaseExpiresAt: Date;
        }>();
        const heartbeat = vi
          .fn<NodeAttemptRunStore['heartbeat']>()
          .mockReturnValue(heartbeatResult.promise);
        const contextAbort = new AbortController();
        const handled = heartbeatCancellationHandler(
          executionStore({ heartbeat }),
        ).handle(delivery(), { signal: contextAbort.signal });
        const settled = vi.fn();
        void handled.then(settled, settled);

        await vi.advanceTimersByTimeAsync(10);
        expect(heartbeat).toHaveBeenCalledOnce();
        contextAbort.abort();
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        if (settlement === 'resolve')
          heartbeatResult.resolve({
            control: { kind: 'none' },
            leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
          });
        else heartbeatResult.reject(new Error('late heartbeat failure'));
        await expect(handled).rejects.toMatchObject({
          code: 'attempt_aborted',
        });
        expect(settled).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(50);
        expect(heartbeat).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('normalizes a heartbeat rejection whose prototype inspection is hostile', async () => {
    vi.useFakeTimers();
    try {
      const hostile = new Proxy(Object.create(null) as object, {
        getPrototypeOf: () => {
          throw new Error('hostile prototype');
        },
      });
      const heartbeat = vi
        .fn<NodeAttemptRunStore['heartbeat']>()
        .mockRejectedValue(hostile);
      const handled = heartbeatCancellationHandler(
        executionStore({ heartbeat }),
      ).handle(delivery(), { signal: new AbortController().signal });
      const outcome = handled.then(
        () => undefined,
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(10);
      const failure = await outcome;
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        message: 'Node attempt heartbeat failed',
      });
      expect((failure as Error).cause).toBe(hostile);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['succeeds', 'rejects'] as const)(
    'gives a heartbeat authority failure precedence when execution ignores abort and %s',
    async (executionSettlement) => {
      vi.useFakeTimers();
      try {
        const heartbeatError = new Error('heartbeat authority unavailable');
        const execution = Promise.withResolvers<{
          runId: string;
          nodeRunId: string;
          attemptId: string;
          invocationKey: string;
          nodeId: string;
          kind: 'succeeded';
          output: null;
        }>();
        const complete = vi.fn<NodeAttemptRunStore['complete']>();
        const runStore = executionStore({
          complete,
          heartbeat: vi.fn().mockRejectedValue(heartbeatError),
        });
        const handler = createNodeAttemptHandler({
          engine: {
            prepare: vi.fn().mockReturnValue({
              upstreamNodeOutputs: [],
              execute: vi.fn().mockReturnValue(execution.promise),
            }),
          },
          heartbeatIntervalMillis: 10,
          leaseDurationSeconds: 1,
          reader: {
            close: vi.fn(),
            readForExecution: vi.fn().mockResolvedValue(projection()),
          },
          registry: { execute: vi.fn() },
          runStore,
          workerId: 'worker-1',
        });
        const handled = handler.handle(delivery(), {
          signal: new AbortController().signal,
        });
        const outcome = handled.then(
          () => undefined,
          (error: unknown) => error,
        );

        await vi.advanceTimersByTimeAsync(10);
        if (executionSettlement === 'succeeds')
          execution.resolve({
            runId: lease().runId,
            nodeRunId: lease().nodeRunId,
            attemptId: lease().attemptId,
            invocationKey: lease().invocationKey,
            nodeId: lease().nodeId,
            kind: 'succeeded',
            output: null,
          });
        else execution.reject(new Error('executor also failed'));
        await expect(outcome).resolves.toBe(heartbeatError);
        expect(complete).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('does not reinterpret a completion-store rejection as an executor outcome', async () => {
    const persistenceError = new NodeExecutorFailure({
      kind: 'retry',
      errorKind: 'provider',
      possiblyDispatched: false,
    });
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockRejectedValue(persistenceError);
    const runStore = executionStore({ complete });

    await expect(
      executionHandler(runStore).handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(persistenceError);
    expect(complete).toHaveBeenCalledOnce();
  });
}
