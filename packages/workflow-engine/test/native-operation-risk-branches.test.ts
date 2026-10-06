import { describe, expect, it, vi } from 'vitest';
import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityRelease,
  composeExecutableCompatibilityReleaseV3,
  createCheckpointV2,
} from '../src/index.js';
import { createWorkflowCheckpointV3 } from '../src/checkpoint/checkpoint-v3.js';
import { prepareNodeAttemptInput } from '../src/attempt/node-attempt-input.js';
import type { ExecuteNodeAttemptInput } from '../src/attempt/node-attempt-contract.js';
import { sameOutputReference } from '../src/output-reference.js';
import type { OutputReference } from '../src/types.js';
import { invocationKey } from '../src/transition/scheduling.js';
import { graph, nodeRelease } from './executable-workflow.fixtures.js';

const workflowVersionId = '00000000-0000-4000-8000-000000000001';
const checkpointInput = {
  engineVersion: 'test',
  workflowVersionId,
  iterationBudget: 10,
};
const retained = buildWorkflowExecutableV2({
  graph: graph(),
  release: composeExecutableCompatibilityRelease(nodeRelease()),
});
const native = buildWorkflowExecutableV3({
  graph: { ...graph(), schemaVersion: 2 },
  release: composeExecutableCompatibilityReleaseV3(nodeRelease()),
});
const advanceInput = {
  runId: 'run',
  workflowVersionId,
  executable: native,
  checkpoint: createWorkflowCheckpointV3(checkpointInput),
  occurredAt: '2026-09-28T00:00:00.000Z',
  maximumAdmissions: 0,
  signal: new AbortController().signal,
};

describe('native operation boundary identities', () => {
  it('rejects mixed eager and demand control input and retained demand before calling its loader', async () => {
    const loadCoordinatorControlDeclaration = vi.fn();
    for (const input of [
      { ...advanceInput, completedOutputs: [] },
      {
        ...advanceInput,
        executable: retained,
        checkpoint: createCheckpointV2(checkpointInput),
      },
    ])
      await expect(
        advanceWorkflow({ ...input, loadCoordinatorControlDeclaration }),
      ).rejects.toMatchObject({
        code: 'observation_invalid',
        message:
          'native control demand conflicts with eager or retained material',
      });
    expect(loadCoordinatorControlDeclaration).not.toHaveBeenCalled();
  });

  it('rejects both checkpoint format substitutions before advancing', async () => {
    for (const input of [
      { ...advanceInput, checkpoint: createCheckpointV2(checkpointInput) },
      { ...advanceInput, executable: retained },
    ])
      await expect(advanceWorkflow(input)).rejects.toMatchObject({
        code: 'workflow_identity_invalid',
        message: 'checkpoint format does not match the executable runtime',
      });
  });

  it('rejects Call materials on retained execution rather than silently discarding them', async () => {
    await expect(
      advanceWorkflow({
        ...advanceInput,
        executable: retained,
        checkpoint: createCheckpointV2(checkpointInput),
        workflowCalls: {
          declarations: [],
          facts: [],
          calleeDeclarations: new Map(),
        },
      }),
    ).rejects.toMatchObject({
      code: 'observation_invalid',
      message: 'Call materials require executable V3',
    });
  });

  it('does not request completion material for a non-callable native graph', async () => {
    const loadCallableCompletion = vi.fn();
    await expect(
      advanceWorkflow({
        ...advanceInput,
        loadCallableCompletion,
      }),
    ).rejects.toMatchObject({
      code: 'observation_invalid',
      message: 'callable completion requires a callable V3 executable',
    });
    expect(loadCallableCompletion).not.toHaveBeenCalled();
  });
});

function attempt(completedNodeOutputs: unknown): ExecuteNodeAttemptInput {
  return {
    runId: 'run',
    nodeRunId: 'node-run',
    attemptId: 'attempt',
    executable: native,
    workflowVersionId,
    nodeId: 'set',
    invocationKey: invocationKey({ workflowVersionId, nodeId: 'set' }),
    runInput: {},
    completedNodeOutputs,
    registry: { execute: vi.fn() },
    signal: new AbortController().signal,
  };
}

describe('native source descriptor validation', () => {
  it('rejects an array in place of an upstream descriptor', () => {
    expect(() => prepareNodeAttemptInput(attempt([[]]))).toThrow(
      expect.objectContaining({
        code: 'attempt_invalid',
        message: 'completed output must be an object',
      }),
    );
  });

  it('accepts independently allocated equal sources while owning one frozen snapshot', () => {
    const first = { value: 42, nested: { keep: true } };
    const second = { nested: { keep: true }, value: 42 };
    const identity = {
      nodeId: 'manual',
      invocationKey: invocationKey({ workflowVersionId, nodeId: 'manual' }),
    };
    const prepared = prepareNodeAttemptInput(
      attempt([
        { ...identity, value: first },
        { ...identity, value: second },
      ]),
    );
    expect(Object.keys(prepared.completedOutputs)).toEqual(['manual']);
    expect(prepared.completedOutputs.manual).toEqual({
      value: 42,
      nested: { keep: true },
    });
    expect(prepared.completedOutputs.manual).not.toBe(first);
    expect(prepared.completedOutputs.manual).not.toBe(second);
    expect(Object.isFrozen(prepared.completedOutputs.manual)).toBe(true);
    first.nested.keep = false;
    second.nested.keep = false;
    expect(prepared.completedOutputs.manual).toEqual({
      value: 42,
      nested: { keep: true },
    });
  });
});

describe('workflow Call output-reference identity', () => {
  const reference: OutputReference = {
    kind: 'workflow_call',
    invocationKey: 'call:original',
    childRunId: workflowVersionId,
  };
  it('requires both the exact invocation and child run', () => {
    expect(sameOutputReference(reference, { ...reference })).toBe(true);
    expect(
      sameOutputReference(reference, {
        ...reference,
        invocationKey: 'call:other',
      }),
    ).toBe(false);
    expect(
      sameOutputReference(reference, {
        ...reference,
        childRunId: '00000000-0000-4000-8000-000000000002',
      }),
    ).toBe(false);
  });
  it('never equates a Call result with a physical inline or artifact reference', () => {
    const physical: readonly OutputReference[] = [
      { kind: 'inline', attemptId: workflowVersionId },
      { kind: 'artifact', artifactId: workflowVersionId },
    ];
    for (const value of physical) {
      expect(sameOutputReference(reference, value)).toBe(false);
      expect(sameOutputReference(value, reference)).toBe(false);
    }
  });
});
