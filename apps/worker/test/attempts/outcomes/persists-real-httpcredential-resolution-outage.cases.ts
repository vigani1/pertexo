import type { NodeAttemptRunStore } from '@pertexo/database/testing';

import { createHttpRequestExecutorRegistration } from '@pertexo/integrations/server';

import { expect, it, vi } from 'vitest';
import {
  createNodeAttemptHandler,
  type PreparedNodeAttempt,
} from '../../../src/testing.js';
import {
  WORKFLOW_ID,
  delivery,
  executionStore,
  lease,
  projection,
} from '../../support/attempts/handler.js';
import { STORED_CHECKPOINT, heartbeatCancellationHandler } from './fixture.js';

export function registerPersistsRealHTTPCredentialResolutionOutage(): void {
  it('persists a real HTTP credential-resolution outage as a durable retry', async () => {
    const attemptLease = { ...lease(), sideEffectClass: 'unsafe' as const };
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const markDispatched = vi
      .fn<NodeAttemptRunStore['markDispatched']>()
      .mockResolvedValue({ dispatchedAt: new Date() });
    const store = executionStore({
      claimDelivery: vi
        .fn()
        .mockResolvedValue({ kind: 'claimed', lease: attemptLease }),
      complete,
      markDispatched,
    });
    const providerIo = vi.fn();
    const registration = createHttpRequestExecutorRegistration({
      httpClient: { executeStreaming: providerIo },
    });
    const resolveFailure = new Error('temporary connection-store outage');
    const resolve = vi.fn().mockRejectedValue(resolveFailure);
    const execute: PreparedNodeAttempt['execute'] = async ({
      registry,
      signal,
    }) => {
      const result = await registry.execute({
        definition: { key: 'http.request', version: 1 },
        executor: { key: 'http.request', version: 1 },
        config: {
          method: 'POST',
          url: 'https://provider.example.test/v1/items',
          headers: {},
          timeoutMillis: 10_000,
          maxRedirects: 0,
          maxResponseBytes: 1_048_576,
          inlineResponseBytes: 65_536,
        },
        input: {},
        connectionRefs: {
          http_headers: '88888888-8888-4888-8888-888888888888',
        },
        signal,
      });
      return {
        runId: attemptLease.runId,
        nodeRunId: attemptLease.nodeRunId,
        attemptId: attemptLease.attemptId,
        invocationKey: attemptLease.invocationKey,
        nodeId: attemptLease.nodeId,
        kind: result.kind,
        output: result.output,
      };
    };
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({
          upstreamNodeOutputs: [],
          execute,
        }),
      },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn().mockResolvedValue(undefined),
        readForExecution: vi.fn().mockResolvedValue(projection()),
      },
      registry: {
        dispatchMode: () => 'executor_controlled',
        execute: async (request) => {
          await registration.execute({
            ...request,
            connectionRefs: request.connectionRefs ?? {},
          });
          return { kind: 'succeeded', output: null };
        },
      },
      runStore: store,
      runtimeCapabilities: {
        connections: () => ({
          assertCurrent: vi.fn().mockResolvedValue(undefined),
          resolve,
        }),
      },
      workerId: 'worker-1',
    });

    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(resolve).toHaveBeenCalledOnce();
    expect(providerIo).not.toHaveBeenCalled();
    expect(markDispatched).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: attemptLease,
        outcome: {
          status: 'executor_failure',
          failureKind: 'retry',
          errorKind: 'provider',
          possiblyDispatched: false,
          safeErrorCode: 'execution.provider',
        },
      }),
    );
  });

  it.each([
    ['canceled', 'unsafe', 'outcome_unknown', 'execution.outcome_unknown'],
    ['timed_out', 'unsafe', 'outcome_unknown', 'execution.outcome_unknown'],
    ['canceled', 'safe', 'canceled', 'execution.canceled'],
    [
      'canceled',
      'idempotent_with_key',
      'outcome_unknown',
      'execution.outcome_unknown',
    ],
    [
      'timed_out',
      'idempotent_with_key',
      'outcome_unknown',
      'execution.outcome_unknown',
    ],
  ] as const)(
    'classifies post-dispatch durable %s for %s work as %s',
    async (abortReason, sideEffectClass, status, safeErrorCode) => {
      const attemptLease = {
        ...lease(),
        sideEffectClass,
        ...(sideEffectClass === 'idempotent_with_key'
          ? { providerIdempotencyKey: 'stable-provider-key' }
          : {}),
      };
      const complete = vi
        .fn<NodeAttemptRunStore['complete']>()
        .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
      const heartbeat = vi
        .fn<NodeAttemptRunStore['heartbeat']>()
        .mockResolvedValue({
          leaseExpiresAt: new Date('2026-08-21T00:02:00.000Z'),
          control: { kind: 'abort', reason: abortReason },
        });
      const store = {
        claimDelivery: vi
          .fn()
          .mockResolvedValue({ kind: 'claimed', lease: attemptLease }),
        close: vi.fn().mockResolvedValue(undefined),
        complete,
        heartbeat,
        loadInputs: vi.fn().mockResolvedValue({
          checkpoint: STORED_CHECKPOINT,
          control: { kind: 'none' },
          completedNodeOutputs: [],
          runInput: null,
        }),
        readAttemptOutputs: vi.fn().mockResolvedValue([]),
        listNodeOutcomes: vi.fn().mockResolvedValue([]),
        readNodeOutputs: vi.fn().mockResolvedValue([]),
        readLoopDeclaration: vi.fn(),
        markDispatched: vi.fn(),
      } satisfies NodeAttemptRunStore;
      const handler = heartbeatCancellationHandler(store);

      await expect(
        handler.handle(delivery(), { signal: new AbortController().signal }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(heartbeat).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0]?.[0]).toMatchObject({
        lease: attemptLease,
        outcome: { status, safeErrorCode },
      });
      expect(complete.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    },
  );
}
