import { NODE_JSON_LIMITS_V1 } from '@pertexo/node-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  parseCompletedOutputItems,
  parseCompletedOutputItemsV3,
} from '../src/observation/coordinator-output.js';
import { advanceWorkflow } from '../src/operations.js';
import { createWorkflowCheckpointV3 } from '../src/checkpoint/checkpoint-v3.js';
import { invocationKey } from '../src/transition/scheduling.js';
import { occurredAt } from './support/advance-workflow.fixture.js';
import {
  executable,
  workflowVersionId,
  otherId,
} from './support/workflow-call.fixture.js';

const invalid: unknown = expect.objectContaining({
  code: 'observation_invalid',
});
const manualKey = invocationKey({ workflowVersionId, nodeId: 'manual' });
function descriptor(value: unknown = {}, patch: Record<string, unknown> = {}) {
  return {
    sequence: 1,
    attemptId: otherId,
    invocationKey: manualKey,
    value,
    ...patch,
  };
}
function exactValue() {
  return { padding: 'x'.repeat(NODE_JSON_LIMITS_V1.bytes - 14) };
}

describe('V3 coordinator source-local output budgets', () => {
  it('accepts exact-limit sources independently of batch and descriptor overhead', () => {
    const value = exactValue();
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(
      NODE_JSON_LIMITS_V1.bytes,
    );
    const batch = [descriptor(value), descriptor(value, { sequence: 2 })];
    const parsed = parseCompletedOutputItemsV3(batch);
    expect(parsed).toEqual(batch);
    expect(parsed[0]).not.toBe(batch[0]);
    expect(() => parseCompletedOutputItems(batch)).toThrow(invalid);
  });

  it('rejects one oversized source even if its other sources are small', () => {
    const value = exactValue();
    value.padding += 'x';
    expect(() =>
      parseCompletedOutputItemsV3([descriptor({}), descriptor(value)]),
    ).toThrow(invalid);
  });

  it('keeps aggregate metadata bounded independently of small values', () => {
    const metadata = Array.from({ length: NODE_JSON_LIMITS_V1.members }, () =>
      descriptor(),
    );
    expect(() => parseCompletedOutputItemsV3(metadata)).toThrow(invalid);
  });

  it('rejects unsafe source containers without invoking their accessors', () => {
    const getter = vi.fn(() => ({}));
    const accessor = descriptor();
    Object.defineProperty(accessor, 'value', { enumerable: true, get: getter });
    const symbol = descriptor();
    Object.defineProperty(symbol, Symbol('hidden'), { value: true });
    const hidden = descriptor();
    Object.defineProperty(hidden, 'extra', { value: true });
    const sparse = new Array<unknown>(1);
    for (const candidate of [
      [accessor],
      [symbol],
      [hidden],
      sparse,
      [new Proxy(descriptor(), {})],
      [
        Object.assign(
          Object.create({ inherited: true }) as object,
          descriptor(),
        ),
      ],
      [descriptor({}, { extra: true })],
      [descriptor({}, { sequence: 0 })],
      [descriptor({}, { attemptId: 'invalid' })],
      [descriptor({}, { invocationKey: null })],
      {},
    ])
      expect(() => parseCompletedOutputItemsV3(candidate)).toThrow(invalid);
    expect(getter).not.toHaveBeenCalled();
  });

  it('validates every metadata identity before traversing source values', () => {
    const getter = vi.fn(() => null);
    const value = Object.defineProperty({}, 'unsafe', {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      parseCompletedOutputItemsV3([
        descriptor(value),
        descriptor({}, { sequence: 0 }),
      ]),
    ).toThrow(invalid);
    expect(getter).not.toHaveBeenCalled();
  });

  it('admits a maximum-size persisted source through actual V3 coordinator advance', async () => {
    const checkpoint = {
      ...createWorkflowCheckpointV3({
        engineVersion: 'test',
        workflowVersionId,
        iterationBudget: 10,
      }),
      runStatus: 'running' as const,
      admittedInvocationKeys: [manualKey],
      invocations: [
        {
          invocationKey: manualKey,
          nodeId: 'manual',
          attemptNumber: 1,
          status: 'running' as const,
        },
      ],
    };
    const observations = [
      {
        kind: 'outcome',
        sequence: checkpoint.nextEventSequence,
        occurredAt,
        invocationKey: manualKey,
        attemptId: otherId,
        attemptNumber: 1,
        status: 'succeeded',
        output: { kind: 'inline', attemptId: otherId },
      },
    ];
    const input = {
      runId: 'run',
      executable,
      workflowVersionId,
      checkpoint,
      observations,
      completedOutputs: [
        descriptor(exactValue(), { sequence: checkpoint.nextEventSequence }),
      ],
      occurredAt,
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    };
    const plan = await advanceWorkflow(input);
    expect(plan.nodeRunAdmissions).toHaveLength(1);
    await expect(
      advanceWorkflow({ ...input, observations: [] }),
    ).rejects.toThrow(invalid);
  });

  it('accepts absent material as an empty batch', () => {
    expect(parseCompletedOutputItemsV3(undefined)).toEqual([]);
  });

  it('rejects an array-shaped completed-output descriptor through public V3 advance', async () => {
    const input = {
      runId: 'run',
      executable,
      workflowVersionId,
      checkpoint: createWorkflowCheckpointV3({
        engineVersion: 'test',
        workflowVersionId,
        iterationBudget: 10,
      }),
      observations: [],
      completedOutputs: [],
      occurredAt,
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    };
    const admitted = await advanceWorkflow(input);
    expect(admitted.nodeRunAdmissions).toHaveLength(1);
    await expect(
      advanceWorkflow({ ...input, completedOutputs: [[]] }),
    ).rejects.toThrow(invalid);
    expect(input.checkpoint.runStatus).toBe('queued');
    expect(input.checkpoint.revision).toBe(0);
  });
});
