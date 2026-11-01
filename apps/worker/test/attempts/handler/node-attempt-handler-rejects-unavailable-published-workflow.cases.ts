import type { NodeAttemptRunStore } from '@pertexo/core/testing';

import { expect, it, vi } from 'vitest';
import { createNodeAttemptHandler } from '../../../src/testing.js';
import {
  WORKFLOW_ID,
  delivery,
  lease,
  projection,
} from '../../support/attempts/handler.js';
import { STORED_CHECKPOINT } from './fixture.js';

export function registerNodeAttemptHandlerRejectsUnavailablePublishedWorkflow(): void {
  it('rejects an unavailable published workflow', async () => {
    const handler = createNodeAttemptHandler({
      engine: { prepare: vi.fn() },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn(),
        readForExecution: vi.fn().mockResolvedValue(null),
      },
      registry: { execute: vi.fn() },
      runStore: {
        claimDelivery: vi
          .fn()
          .mockResolvedValue({ kind: 'claimed', lease: lease() }),
        close: vi.fn(),
        complete: vi.fn(),
        heartbeat: vi.fn(),
        loadInputs: vi.fn(),
        readAttemptOutputs: vi.fn().mockResolvedValue([]),
        listNodeOutcomes: vi.fn().mockResolvedValue([]),
        readNodeOutputs: vi.fn().mockResolvedValue([]),
        readLoopDeclaration: vi.fn(),
        markDispatched: vi.fn(),
      },
      workerId: 'worker-1',
    });
    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'workflow_not_found' });
  });

  it('fails the step, without running it, when the loop results feeding it are too large', async () => {
    const loopKey = 'v|each|b:|i:';
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const execute = vi.fn();
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({
          upstreamNodeOutputs: [{ nodeId: 'each', invocationKey: loopKey }],
          forEachUpstreams: [
            { nodeId: 'each', invocationKey: loopKey, sinkNodeId: 'shape' },
          ],
          execute,
        }),
      },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn(),
        readForExecution: vi.fn().mockResolvedValue(projection()),
      },
      registry: { execute: vi.fn() },
      runStore: {
        claimDelivery: vi
          .fn()
          .mockResolvedValue({ kind: 'claimed', lease: lease() }),
        close: vi.fn(),
        complete,
        heartbeat: vi.fn(),
        loadInputs: vi.fn().mockResolvedValue({
          checkpoint: STORED_CHECKPOINT,
          control: { kind: 'none' },
          completedNodeOutputs: [
            {
              nodeId: 'each',
              invocationKey: loopKey,
              value: { items: [1, 2], iterationCount: 2 },
            },
          ],
          runInput: null,
        }),
        readAttemptOutputs: vi.fn().mockResolvedValue([]),
        listNodeOutcomes: vi.fn().mockResolvedValue(
          [0, 1].map((ordinal) => ({
            invocationKey: `v|shape|b:|i:each%3A${String(ordinal)}`,
            status: 'succeeded',
            outputBytes: 600_000,
          })),
        ),
        readNodeOutputs: vi.fn(),
        readLoopDeclaration: vi.fn(),
        markDispatched: vi.fn(),
      },
      workerId: 'worker-1',
    });
    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: {
          status: 'executor_failure',
          failureKind: 'failed',
          errorKind: 'configuration',
          possiblyDispatched: false,
          safeErrorCode: 'execution.loop_results_too_large',
        },
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires output for a resumed Wait admission', async () => {
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi
          .fn()
          .mockReturnValue({ upstreamNodeOutputs: [], execute: vi.fn() }),
      },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn(),
        readForExecution: vi.fn().mockResolvedValue(projection()),
      },
      registry: { execute: vi.fn() },
      runStore: {
        claimDelivery: vi.fn().mockResolvedValue({
          kind: 'claimed',
          lease: { ...lease(), admissionKind: 'wait_resume' },
        }),
        close: vi.fn(),
        complete: vi.fn(),
        heartbeat: vi.fn(),
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
      },
      workerId: 'worker-1',
    });
    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'wait_resume_output_missing' });
  });
}
