import type { NodeAttemptRunStore } from '@pertexo/core/testing';

import { expect, it, vi } from 'vitest';
import {
  createNodeAttemptHandler,
  type PreparedNodeAttempt,
} from '../../../src/testing.js';
import {
  ATTEMPT_ID,
  NODE_RUN_ID,
  RUN_ID,
  WORKFLOW_ID,
  delivery,
  executionStore,
  lease,
  projection,
} from '../../support/attempts/handler.js';

export function registerHandsResolvedInputStoreBeforeExecuting(): void {
  it.each([
    ['records', () => Promise.resolve({ recorded: true })],
    ['fails to record', () => Promise.reject(new Error('database is down'))],
  ] as const)(
    'hands the resolved input to the store before executing, and commits when it %s',
    async (_case, outcome) => {
      const order: string[] = [];
      const recordInput = vi.fn(() => {
        order.push('recorded');
        return outcome();
      });
      const complete = vi
        .fn<NodeAttemptRunStore['complete']>()
        .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
      const store = executionStore({ recordInput, complete });
      const prepared: PreparedNodeAttempt = {
        upstreamNodeOutputs: [],
        execute: async ({ onInputResolved, registry, signal }) => {
          await onInputResolved?.({ orderId: 'A-17' });
          order.push('executed');
          const result = await registry.execute({
            config: {},
            definition: { key: 'core.manual', version: 1 },
            executor: { key: 'core.manual', version: 1 },
            input: { orderId: 'A-17' },
            signal,
          });
          return {
            runId: RUN_ID,
            nodeRunId: NODE_RUN_ID,
            attemptId: ATTEMPT_ID,
            invocationKey: lease().invocationKey,
            nodeId: 'manual',
            kind: result.kind,
            output: result.output,
          };
        },
      };
      const handler = createNodeAttemptHandler({
        engine: { prepare: vi.fn().mockReturnValue(prepared) },
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 30,
        reader: {
          close: vi.fn(),
          readForExecution: vi.fn().mockResolvedValue(projection()),
        },
        registry: {
          execute: vi
            .fn()
            .mockResolvedValue({ kind: 'succeeded', output: null }),
        },
        runStore: store,
        workerId: 'worker-1',
      });

      await expect(
        handler.handle(delivery(), { signal: new AbortController().signal }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(order).toEqual(['recorded', 'executed']);
      expect(recordInput).toHaveBeenCalledWith(
        expect.objectContaining({
          lease: expect.objectContaining({ attemptId: ATTEMPT_ID }) as unknown,
          input: { orderId: 'A-17' },
        }),
      );
      expect(complete).toHaveBeenCalledOnce();
    },
  );
}
