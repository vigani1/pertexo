import {
  NodeExecutorFailure,
  type NodeConnectionHealthObservation,
} from '@pertexo/node-sdk/server';
import { describe, expect, it, vi } from 'vitest';
import type { NodeAttemptRunStore } from '@pertexo/database/execution';

import { createNodeAttemptHandler } from '../src/execution/node-attempt-handler.js';
import { createNodeExecutionEnvironment } from '../src/execution/node-attempt-execution-environment.js';
import {
  delivery,
  executionStore,
  projection,
  registryPreparedAttempt,
  lease,
} from './support/node-attempt-handler.fixture.js';

describe('atomic attempt connection health forwarding', () => {
  it('defaults direct environment construction to off even after accepted dispatch', async () => {
    const environment = createNodeExecutionEnvironment({
      executionSignal: new AbortController().signal,
      lease: lease(),
      registry: { execute: vi.fn() },
      runStore: executionStore(),
    });
    await environment.runtime.beforeDispatch();
    environment.runtime.observeConnectionHealth?.({ kind: 'healthy' });
    expect(environment.wasDispatched()).toBe(true);
    expect(environment.connectionHealthObservation()).toBeUndefined();
  });

  it('honors durable cancellation after an executor ignores abort and returns success, preserving captured evidence', async () => {
    vi.useFakeTimers();
    try {
      const heartbeat = vi
        .fn<NodeAttemptRunStore['heartbeat']>()
        .mockResolvedValue({
          abortRequested: true,
          abortReason: 'canceled',
          leaseExpiresAt: new Date('2026-10-01T01:00:00Z'),
        });
      const complete = vi
        .fn<NodeAttemptRunStore['complete']>()
        .mockResolvedValue({
          kind: 'committed',
          outboxEventId: '77777777-7777-4777-8777-777777777777',
        });
      const handler = createNodeAttemptHandler({
        connectionRunHealthMode: 'enforce',
        engine: { prepare: () => registryPreparedAttempt() },
        heartbeatIntervalMillis: 10,
        leaseDurationSeconds: 1,
        reader: {
          close: vi.fn(),
          readForExecution: vi.fn().mockResolvedValue({
            kind: 'v2_projection',
            workflowVersion: projection(),
          }),
        },
        registry: {
          dispatchMode: () => 'executor_controlled',
          execute: async ({ runtime, signal }) => {
            await runtime?.beforeDispatch();
            runtime?.observeConnectionHealth?.({ kind: 'healthy' });
            await new Promise<undefined>((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  resolve(undefined);
                },
                {
                  once: true,
                },
              );
            });
            return { kind: 'succeeded', output: null };
          },
        },
        runStore: executionStore({ heartbeat, complete }),
        workerId: 'worker-1',
      });
      const handled = handler.handle(delivery(), {
        signal: new AbortController().signal,
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(handled).resolves.toEqual({ kind: 'committed' });
      expect(complete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          outcome: {
            status: 'canceled',
            safeErrorCode: 'execution.canceled',
          },
          connectionHealthObservation: { kind: 'healthy' },
          connectionRunHealthMode: 'enforce',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['off', 'observe', 'enforce'] as const)(
    'passes only post-dispatch capture to completion in %s',
    async (mode) => {
      const complete = vi
        .fn<NodeAttemptRunStore['complete']>()
        .mockResolvedValue({
          kind: 'committed',
          outboxEventId: '77777777-7777-4777-8777-777777777777',
        });
      const runStore = executionStore({ complete });
      const observation: NodeConnectionHealthObservation = { kind: 'healthy' };
      const handler = createNodeAttemptHandler({
        connectionRunHealthMode: mode,
        engine: { prepare: () => registryPreparedAttempt() },
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 30,
        reader: {
          close: vi.fn(),
          readForExecution: vi.fn().mockResolvedValue({
            kind: 'v2_projection',
            workflowVersion: projection(),
          }),
        },
        registry: {
          dispatchMode: () => 'executor_controlled',
          execute: async ({ runtime }) => {
            runtime?.observeConnectionHealth?.({
              kind: 'reauthorization_required',
              reasonCode: 'connection.slack_token_revoked',
            });
            await runtime?.beforeDispatch();
            runtime?.observeConnectionHealth?.(observation);
            return { kind: 'succeeded', output: null };
          },
        },
        runStore,
        workerId: 'worker-1',
      });
      await expect(
        handler.handle(delivery(), { signal: new AbortController().signal }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(complete).toHaveBeenCalledOnce();
      const completion = complete.mock.calls[0]?.[0];
      expect(completion).toMatchObject({
        outcome: { status: 'succeeded', output: null },
      });
      if (mode === 'off') {
        expect(completion).not.toHaveProperty('connectionHealthObservation');
        expect(completion).not.toHaveProperty('connectionRunHealthMode');
      } else {
        expect(completion).toMatchObject({
          connectionHealthObservation: observation,
          connectionRunHealthMode: mode,
        });
      }
    },
  );

  it('persists definitive rejection beside the unchanged executor outcome; completion failure propagates', async () => {
    const durableFailure = new Error('completion unavailable');
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockRejectedValue(durableFailure);
    const runStore = executionStore({ complete });
    const observation: NodeConnectionHealthObservation = {
      kind: 'reauthorization_required',
      reasonCode: 'connection.slack_token_expired',
    };
    const handler = createNodeAttemptHandler({
      connectionRunHealthMode: 'enforce',
      engine: { prepare: () => registryPreparedAttempt() },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn(),
        readForExecution: vi.fn().mockResolvedValue({
          kind: 'v2_projection',
          workflowVersion: projection(),
        }),
      },
      registry: {
        dispatchMode: () => 'executor_controlled',
        execute: async ({ runtime }) => {
          await runtime?.beforeDispatch();
          runtime?.observeConnectionHealth?.(observation);
          throw new NodeExecutorFailure({
            kind: 'outcome_unknown',
            errorKind: 'provider',
            possiblyDispatched: true,
          });
        },
      },
      runStore,
      workerId: 'worker-1',
    });
    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).rejects.toBe(durableFailure);
    expect(complete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        connectionHealthObservation: observation,
        connectionRunHealthMode: 'enforce',
        outcome: {
          status: 'executor_failure',
          failureKind: 'outcome_unknown',
          errorKind: 'provider',
          possiblyDispatched: true,
          safeErrorCode: 'execution.provider',
        },
      }),
    );
  });
});
