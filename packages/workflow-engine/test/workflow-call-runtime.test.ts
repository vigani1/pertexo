import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  advanceWorkflow,
  executeNodeAttempt,
  createCheckpoint,
  createCheckpointV2,
  buildWorkflowExecutableV3,
} from '../src/index.js';
import { createWorkflowCheckpointV3 } from '../src/checkpoint/checkpoint-v3.js';
import type { AdvanceWorkflowInput } from '../src/operations.js';
import type { ExecuteNodeAttemptInput } from '../src/attempt/node-attempt-contract.js';
import type {
  WorkflowCheckpointV3,
  WorkflowCallStateV1,
} from '../src/workflow-call-state.js';
import { invocationKey } from '../src/transition/scheduling.js';
import { occurredAt } from './support/advance-workflow.fixture.js';
import {
  workflowVersionId,
  declarationAttemptId,
  childRunId,
  otherId,
  key,
  declaration,
  pin,
  executable,
  release,
  callGraph,
} from './support/workflow-call.fixture.js';

const reference = { kind: 'inline' as const, attemptId: declarationAttemptId };
const material = {
  invocationKey: key,
  nodeId: 'call',
  declarationAttemptId,
  input: reference,
  inputChecksum: createHash('sha256').update('{"name":"input"}').digest('hex'),
  value: { name: 'input' },
};
const calleeDeclarations = new Map([[pin.versionId, declaration]]);
const manualKey = invocationKey({ workflowVersionId, nodeId: 'manual' });
function initial(): WorkflowCheckpointV3 {
  return {
    ...createWorkflowCheckpointV3({
      engineVersion: 'test',
      workflowVersionId,
      iterationBudget: 10,
    }),
    runStatus: 'running',
    admittedInvocationKeys: [manualKey, key],
    invocations: [
      {
        invocationKey: manualKey,
        nodeId: 'manual',
        attemptNumber: 1,
        status: 'succeeded',
        output: { kind: 'inline', attemptId: otherId },
      },
      {
        invocationKey: key,
        nodeId: 'call',
        attemptNumber: 1,
        status: 'running',
      },
    ],
  };
}
function advance(
  checkpoint = initial(),
  patch: Partial<AdvanceWorkflowInput> = {},
) {
  return advanceWorkflow({
    runId: 'run-1',
    executable,
    workflowVersionId,
    checkpoint,
    occurredAt,
    maximumAdmissions: 10,
    signal: new AbortController().signal,
    ...patch,
  });
}
function declarationObservation(checkpoint = initial()) {
  return {
    kind: 'outcome',
    sequence: checkpoint.nextEventSequence,
    occurredAt,
    invocationKey: key,
    attemptId: declarationAttemptId,
    attemptNumber: 1,
    status: 'succeeded',
    output: reference,
  };
}
async function declare() {
  const cp = initial();
  return advance(cp, {
    observations: [declarationObservation(cp)],
    workflowCalls: { declarations: [material], facts: [], calleeDeclarations },
  });
}
function cp3(value: unknown): WorkflowCheckpointV3 {
  return value as WorkflowCheckpointV3;
}
function retainedCall(checkpoint: WorkflowCheckpointV3): WorkflowCallStateV1 {
  const call = checkpoint.calls[0];
  if (call === undefined) throw new Error('Expected retained Call');
  return call;
}
function journal(
  checkpoint: WorkflowCheckpointV3,
  fact: WorkflowCallStateV1,
  patch: Partial<AdvanceWorkflowInput> = {},
) {
  return advance(checkpoint, {
    workflowCalls: { declarations: [], facts: [fact], calleeDeclarations },
    ...patch,
  });
}
function attempt(patch: Partial<ExecuteNodeAttemptInput> = {}) {
  const execute = vi
    .fn<ExecuteNodeAttemptInput['registry']['execute']>()
    .mockResolvedValue({ kind: 'succeeded', output: { name: 'input' } });
  const input: ExecuteNodeAttemptInput = {
    runId: 'run-1',
    nodeRunId: 'node-run-1',
    attemptId: declarationAttemptId,
    executable,
    workflowVersionId,
    invocationKey: key,
    nodeId: 'call',
    runInput: { name: 'untrusted' },
    completedNodeOutputs: [],
    calleeDeclarations,
    registry: { execute },
    signal: new AbortController().signal,
    ...patch,
  };
  return { input, execute };
}

describe('public Call coordinator projection', () => {
  it('consumes the immutable physical declaration once and retains a dedicated wait', async () => {
    const result = await declare();
    const checkpoint = cp3(result.checkpoint);
    expect(checkpoint.calls[0]).toMatchObject({
      status: 'awaiting_admission',
      declarationAttemptId,
      input: reference,
      pin,
    });
    expect(
      checkpoint.invocations.find((node) => node.nodeId === 'call'),
    ).toEqual({
      invocationKey: key,
      nodeId: 'call',
      attemptNumber: 1,
      status: 'waiting',
    });
    expect(checkpoint.nextEventSequence).toBeGreaterThan(
      initial().nextEventSequence,
    );
    expect(result.consumedThroughEventSequence).toBe(
      initial().nextEventSequence,
    );
    expect(result.events.map((event) => event.name)).toEqual([
      'node.waiting',
      'run.waiting',
    ]);
    expect(result.events.every((event) => event.dueAt === undefined)).toBe(
      true,
    );
    expect(result.events[0]?.sequence).toBe(initial().nextEventSequence + 1);
    expect(result).toMatchObject({
      workflowCalls: {
        declarations: [checkpoint.calls[0]],
        cancelChildren: [],
      },
    });
    expect(result.attempts).toEqual([]);
    expect(checkpoint.runStatus).toBe('waiting');
  });

  it.each(['missing', 'mismatched', 'duplicate'] as const)(
    'refuses %s declaration material',
    async (kind) => {
      const declarations =
        kind === 'missing'
          ? []
          : kind === 'duplicate'
            ? [material, material]
            : [
                {
                  ...material,
                  input: { kind: 'inline' as const, attemptId: otherId },
                },
              ];
      await expect(
        advance(initial(), {
          observations: [declarationObservation()],
          workflowCalls: { declarations, facts: [], calleeDeclarations },
        }),
      ).rejects.toMatchObject({ code: 'observation_invalid' });
    },
  );

  it('requires exactly one matching physical success rather than accepting ambiguous facts', async () => {
    const observation = declarationObservation();
    await expect(
      advance(initial(), {
        observations: [
          observation,
          { ...observation, sequence: observation.sequence + 1 },
        ],
        workflowCalls: {
          declarations: [material],
          facts: [],
          calleeDeclarations,
        },
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it('progresses admission and successful settlement to a distinct child reference', async () => {
    const waiting = cp3((await declare()).checkpoint);
    const admitted: WorkflowCallStateV1 = {
      ...retainedCall(waiting),
      status: 'admitted',
      childRunId,
    };
    const active = cp3((await journal(waiting, admitted)).checkpoint);
    expect(active.calls).toEqual([admitted]);
    const settled: WorkflowCallStateV1 = {
      ...admitted,
      status: 'settled',
      childStatus: 'succeeded',
    };
    const done = cp3((await journal(active, settled)).checkpoint);
    expect(done.runStatus).toBe('succeeded');
    expect(
      done.invocations.find((node) => node.nodeId === 'call')?.output,
    ).toEqual({ kind: 'workflow_call', invocationKey: key, childRunId });
    expect(done.calls[0]?.input).toEqual(reference);
  });

  it('projects a durable refusal as failure without inventing a child', async () => {
    const waiting = cp3((await declare()).checkpoint);
    const result = await journal(waiting, {
      ...retainedCall(waiting),
      status: 'refused',
      reasonCode: 'workflow.child_capacity_unavailable',
    });
    expect(result.checkpoint.runStatus).toBe('failed');
    expect(cp3(result.checkpoint).calls[0]).not.toHaveProperty('childRunId');
    expect(result.attempts).toEqual([]);
  });

  it('rejects typed declaration material before issuing any admission intent', async () => {
    await expect(
      advance(initial(), {
        observations: [declarationObservation()],
        workflowCalls: {
          declarations: [{ ...material, value: { name: 99 } }],
          facts: [],
          calleeDeclarations,
        },
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it.each(['cancel', 'deadline'] as const)(
    'keeps an admitted child waiting through parent %s and retains unknown settlement',
    async (stop) => {
      const waiting = cp3((await declare()).checkpoint);
      const admitted: WorkflowCallStateV1 = {
        ...retainedCall(waiting),
        status: 'admitted',
        childRunId,
      };
      const active = cp3((await journal(waiting, admitted)).checkpoint);
      const observation =
        stop === 'cancel'
          ? {
              kind: 'cancel_requested',
              sequence: active.nextEventSequence,
              occurredAt,
            }
          : { kind: 'deadline_expired', occurredAt };
      const stopping = await journal(active, admitted, {
        observations: [observation],
      });
      expect(stopping.checkpoint.runStatus).toBe('waiting');
      expect(stopping.workflowCalls?.cancelChildren).toHaveLength(1);
      const unknown = await journal(cp3(stopping.checkpoint), {
        ...admitted,
        status: 'settled',
        childStatus: 'outcome_unknown',
      });
      expect(unknown.checkpoint.runStatus).toBe('outcome_unknown');
      expect(
        unknown.checkpoint.invocations.find((node) => node.nodeId === 'call')
          ?.status,
      ).toBe('outcome_unknown');
    },
  );

  it.each([createCheckpoint, createCheckpointV2])(
    'cannot consume a retained checkpoint format',
    async (create) => {
      await expect(
        advance(initial(), {
          checkpoint: create({
            engineVersion: 'test',
            workflowVersionId,
            iterationBudget: 10,
          }),
        }),
      ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
    },
  );

  it.each(['failed', 'retry', 'outcome_unknown'] as const)(
    'never logically retries a physical %s Call declaration',
    async (failureKind) => {
      const result = await advance(initial(), {
        observations: [
          {
            kind: 'attempt_failure',
            occurredAt,
            invocationKey: key,
            attemptId: declarationAttemptId,
            attemptNumber: 1,
            failureKind,
            errorKind: 'rate_limit',
            possiblyDispatched: failureKind === 'outcome_unknown',
            safeErrorCode: 'execution.rate_limit',
          },
        ],
      });
      expect(result.attempts).toEqual([]);
      expect(cp3(result.checkpoint).calls).toEqual([]);
      expect(
        result.checkpoint.invocations.find((node) => node.nodeId === 'call'),
      ).toMatchObject({
        attemptNumber: 1,
        status:
          failureKind === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
      });
    },
  );
});

describe('public Call declaration attempt validation', () => {
  it('reuses a recorded declaration instead of changed mappings or run input', async () => {
    const changed = buildWorkflowExecutableV3({
      release,
      graph: {
        ...callGraph,
        nodes: callGraph.nodes.map((node) =>
          node.id === 'call'
            ? {
                ...node,
                inputMappings: { name: { kind: 'literal', value: 'changed' } },
              }
            : node,
        ),
      },
    });
    const onInputResolved = vi
      .fn<(value: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);
    const { input, execute } = attempt({
      executable: changed,
      runInput: { name: 'changed upstream' },
      recordedWorkflowCallInput: { name: 'input' },
      onInputResolved,
    });
    await executeNodeAttempt(input);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ input: { name: 'input' } }),
    );
    expect(onInputResolved).toHaveBeenCalledExactlyOnceWith({ name: 'input' });
  });

  it('propagates required snapshot persistence failure without dispatch', async () => {
    const failure = new Error('input transaction failed');
    const { input, execute } = attempt({
      onInputResolved: () => Promise.reject(failure),
    });
    await expect(executeNodeAttempt(input)).rejects.toBe(failure);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not persist a recovered input that violates the pinned contract', async () => {
    const onInputResolved = vi
      .fn<(value: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);
    const { input, execute } = attempt({
      recordedWorkflowCallInput: { name: 42 },
      onInputResolved,
    });
    await expect(executeNodeAttempt(input)).rejects.toBeInstanceOf(
      NodeExecutorFailure,
    );
    expect(onInputResolved).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a terminal shortcut from the pure declaration executor', async () => {
    const { input, execute } = attempt();
    execute.mockResolvedValue({
      kind: 'terminal_success',
      output: { name: 'input' },
    });
    await expect(executeNodeAttempt(input)).rejects.toMatchObject({
      code: 'attempt_invalid',
    });
  });

  it('rejects an executor that changes the immutable declaration input', async () => {
    const { input, execute } = attempt();
    execute.mockResolvedValue({
      kind: 'succeeded',
      output: { name: 'changed' },
    });
    await expect(executeNodeAttempt(input)).rejects.toMatchObject({
      code: 'attempt_invalid',
    });
  });

  it('honors abort after the pure registry resolves without creating a declaration outcome', async () => {
    const controller = new AbortController();
    const { input, execute } = attempt({ signal: controller.signal });
    execute.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ kind: 'succeeded', output: { name: 'input' } });
    });
    await expect(executeNodeAttempt(input)).rejects.toMatchObject({
      code: 'attempt_aborted',
    });
  });

  it('passes actual mapped input to the registry, not arbitrary run input', async () => {
    const { input, execute } = attempt();
    const outcome = await executeNodeAttempt(input);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      input: { name: 'input' },
      config: pin,
      definition: { key: 'core.workflow_call', version: 1 },
    });
    expect(Object.isFrozen(execute.mock.calls[0]?.[0]?.input)).toBe(true);
    expect(outcome).toMatchObject({
      kind: 'succeeded',
      output: { name: 'input' },
    });
    expect(outcome).not.toHaveProperty('childRunId');
  });

  it('rejects actual typed mapping before dispatch with a definite configuration failure', async () => {
    const invalid = buildWorkflowExecutableV3({
      release,
      graph: {
        ...callGraph,
        nodes: callGraph.nodes.map((node) =>
          node.id === 'call'
            ? {
                ...node,
                inputMappings: { name: { kind: 'literal', value: 42 } },
              }
            : node,
        ),
      },
    });
    const { input, execute } = attempt({ executable: invalid });
    await expect(executeNodeAttempt(input)).rejects.toBeInstanceOf(
      NodeExecutorFailure,
    );
    await expect(executeNodeAttempt(input)).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['missing', 'changed'] as const)(
    'fails closed for a %s retained descriptor',
    async (kind) => {
      const declarations =
        kind === 'missing'
          ? new Map()
          : new Map([
              [
                pin.versionId,
                {
                  ...declaration,
                  resultSelector: {
                    kind: 'run_input' as const,
                    path: '$.name',
                  },
                },
              ],
            ]);
      const { input, execute } = attempt({ calleeDeclarations: declarations });
      await expect(executeNodeAttempt(input)).rejects.toBeDefined();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('honors abort after mapping without dispatch', async () => {
    const controller = new AbortController();
    const { input, execute } = attempt({
      signal: controller.signal,
      onInputResolved: async () => {
        controller.abort();
        await Promise.resolve();
      },
    });
    await expect(executeNodeAttempt(input)).rejects.toMatchObject({
      code: 'attempt_aborted',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('honors an already aborted signal on both public operations', async () => {
    const controller = new AbortController();
    controller.abort();
    const { input, execute } = attempt({ signal: controller.signal });
    await expect(executeNodeAttempt(input)).rejects.toMatchObject({
      code: 'attempt_aborted',
    });
    await expect(
      advance(initial(), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'attempt_aborted' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['accessor', 'proxy'] as const)(
    'rejects a forged %s executable before inspecting its envelope',
    async (kind) => {
      const trap = vi.fn(() => {
        throw new Error('must not inspect forged input');
      });
      const forged =
        kind === 'accessor'
          ? Object.defineProperty({}, 'envelope', { get: trap })
          : new Proxy(executable, { get: trap });
      const unverified = forged as typeof executable;
      await expect(
        advance(initial(), { executable: unverified }),
      ).rejects.toMatchObject({ code: 'executable_invalid' });
      const { input, execute } = attempt({ executable: unverified });
      await expect(executeNodeAttempt(input)).rejects.toMatchObject({
        code: 'executable_invalid',
      });
      expect(trap).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
