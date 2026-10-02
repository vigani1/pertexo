import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow as advancePublicWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  createCheckpointV2,
  parseCheckpoint,
} from '../src/index.js';
import { createWorkflowCheckpointV3 } from '../src/checkpoint/checkpoint-v3.js';
import {
  advanceWorkflowFromSchedulerState,
  type AdvanceWorkflowFromSchedulerStateInput,
} from '../src/transition/advance-workflow.js';
import type { SchedulerState } from '../src/transition/graph-scheduler.js';
import { invocationKey } from '../src/transition/scheduling.js';
import type { WorkflowCallControlDecisionV1 } from '../src/workflow-call-control.js';
import type {
  WorkflowCallInvocationStateV1,
  WorkflowCallStateV1,
  WorkflowCheckpointV3,
} from '../src/workflow-call-state.js';
import type { WorkflowCheckpoint } from '../src/types.js';
import { graph, nodeRelease } from './executable-workflow.fixtures.js';
import { occurredAt } from './support/advance-workflow.fixture.js';

const workflowVersionId = '00000000-0000-4000-8000-000000000001';
const declarationAttemptId = '00000000-0000-4000-8000-000000000002';
const childRunId = '00000000-0000-4000-8000-000000000003';
const key = invocationKey({ workflowVersionId, nodeId: 'call' });
const baseCall = {
  invocationKey: key,
  nodeId: 'call',
  declarationAttemptId,
  pin: {
    workflowId: workflowVersionId,
    versionId: workflowVersionId,
    checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
    callableContractIdentity: `callable:v1:sha256:${'b'.repeat(64)}`,
  },
  input: { kind: 'inline' as const, attemptId: declarationAttemptId },
  inputChecksum: 'c'.repeat(64),
};
const waiting: WorkflowCallInvocationStateV1 = {
  invocationKey: key,
  nodeId: 'call',
  status: 'waiting',
  attemptNumber: 1,
};
const callOnly: SchedulerState = {
  deriveReadiness: false,
  nodes: [{ id: 'call', sideEffectClass: 'unsafe' }],
  edges: [],
};
const chain: SchedulerState = {
  deriveReadiness: true,
  nodes: [
    { id: 'call', sideEffectClass: 'unsafe' },
    { id: 'next', sideEffectClass: 'safe' },
  ],
  edges: [
    {
      source: { nodeId: 'call', port: 'out' },
      target: { nodeId: 'next', port: 'in' },
    },
  ],
};
function initial(): WorkflowCheckpointV3 {
  return {
    ...createWorkflowCheckpointV3({
      engineVersion: 'test',
      workflowVersionId,
      iterationBudget: 10,
    }),
    runStatus: 'running',
    admittedInvocationKeys: [key],
    invocations: [{ ...waiting, status: 'running' }],
  };
}
function v3(checkpoint: WorkflowCheckpoint): WorkflowCheckpointV3 {
  if (checkpoint.schemaVersion !== 3) throw new Error('Expected checkpoint V3');
  return checkpoint;
}
function control(
  call: WorkflowCallStateV1,
  invocation: WorkflowCallInvocationStateV1 = waiting,
  patch: Partial<WorkflowCallControlDecisionV1> = {},
): WorkflowCallControlDecisionV1 {
  return {
    call,
    invocation,
    declarationIntent: false,
    admissionIntent: false,
    ...patch,
  };
}
function advance(
  checkpoint: WorkflowCheckpoint,
  workflowCallControls: readonly WorkflowCallControlDecisionV1[],
  patch: Partial<AdvanceWorkflowFromSchedulerStateInput> = {},
) {
  return advanceWorkflowFromSchedulerState({
    checkpoint,
    workflowCallControls,
    schedulerState: callOnly,
    occurredAt,
    maximumAdmissions: 0,
    ...patch,
  });
}
function declared() {
  const call: WorkflowCallStateV1 = {
    ...baseCall,
    status: 'awaiting_admission',
  };
  return advance(initial(), [
    control(call, waiting, { declarationIntent: true, admissionIntent: true }),
  ]);
}
function accepted() {
  const call: WorkflowCallStateV1 = {
    ...baseCall,
    status: 'admitted',
    childRunId,
  };
  return advance(declared().checkpoint, [control(call)]);
}
type Stop = 'cancel_requested' | 'deadline_expired';
function stopInput(
  stop: Stop,
): Partial<AdvanceWorkflowFromSchedulerStateInput> {
  return stop === 'cancel_requested'
    ? { observations: [{ kind: 'cancel_requested' }] }
    : { deadlineExpiration: { occurredAt } };
}
function stopped(stop: Stop) {
  const call: WorkflowCallStateV1 = {
    ...baseCall,
    status: 'admitted',
    childRunId,
  };
  return advance(
    accepted().checkpoint,
    [control(call, waiting, { cancelChild: { childRunId, reason: stop } })],
    stopInput(stop),
  );
}

describe('checkpoint V3 shared Call transitions', () => {
  it('journals a new declaration and dedicated wait without a timer or another attempt', () => {
    const plan = declared();
    expect(plan.checkpoint.schemaVersion).toBe(3);
    expect(plan.checkpoint.runStatus).toBe('waiting');
    expect(plan.checkpoint.invocations).toEqual([waiting]);
    expect(plan.checkpoint.invocations[0]).not.toHaveProperty('resumeAt');
    expect(plan.checkpoint.invocations[0]).not.toHaveProperty('waitKind');
    expect(plan.checkpoint.invocations[0]).not.toHaveProperty('output');
    expect(plan.events.map(({ name }) => name)).toEqual([
      'node.waiting',
      'run.waiting',
    ]);
    expect(plan.events.every((event) => event.dueAt === undefined)).toBe(true);
    expect(plan.workflowCalls).toEqual({
      declarations: [{ ...baseCall, status: 'awaiting_admission' }],
      cancelChildren: [],
    });
    expect(plan.attempts).toEqual([]);
    expect(plan.nodeRunAdmissions).toEqual([]);
    expect(plan.checkpoint.readySet).toEqual([]);
    expect(plan.checkpoint.admittedInvocationKeys).toEqual([key]);
    expect(plan.immediateContinuation).toBe(true);
  });
  it('defers new sibling attempts until the durable admission fact is consumed', () => {
    const siblingKey = invocationKey({ workflowVersionId, nodeId: 'sibling' });
    const source = initial();
    const checkpoint = {
      ...source,
      readySet: [siblingKey],
      invocations: [
        ...source.invocations,
        {
          invocationKey: siblingKey,
          nodeId: 'sibling',
          status: 'ready' as const,
          attemptNumber: 0,
        },
      ],
    };
    const schedulerState: SchedulerState = {
      deriveReadiness: false,
      nodes: [...callOnly.nodes, { id: 'sibling', sideEffectClass: 'safe' }],
      edges: [],
    };
    const plan = advance(
      checkpoint,
      [
        control({ ...baseCall, status: 'awaiting_admission' }, waiting, {
          declarationIntent: true,
          admissionIntent: true,
        }),
      ],
      { schedulerState, maximumAdmissions: 10 },
    );
    expect(plan.attempts).toEqual([]);
    expect(plan.checkpoint.readySet).toEqual([siblingKey]);
    expect(plan.checkpoint.admittedInvocationKeys).not.toContain(siblingKey);
    expect(plan.immediateContinuation).toBe(true);
    const next = advance(
      plan.checkpoint,
      [control({ ...baseCall, status: 'admitted', childRunId })],
      { schedulerState, maximumAdmissions: 10 },
    );
    expect(next.attempts).toEqual([
      expect.objectContaining({ invocationKey: siblingKey, attemptNumber: 1 }),
    ]);
    expect(next.workflowCalls?.declarations).toEqual([]);
    expect(next.immediateContinuation).toBeUndefined();
  });
  it('reconciles accepted admission without declaration replay, timer, event or retry', () => {
    const plan = accepted();
    expect(v3(plan.checkpoint).calls).toEqual([
      { ...baseCall, status: 'admitted', childRunId },
    ]);
    expect(plan.checkpoint.invocations).toEqual([waiting]);
    expect(plan.events).toEqual([]);
    expect(plan.attempts).toEqual([]);
    expect(plan.workflowCalls).toEqual({
      declarations: [],
      cancelChildren: [],
    });
  });
  it('consumes the persisted declaration attempt cursor without emitting a fake child success', () => {
    const source = initial();
    const call: WorkflowCallStateV1 = {
      ...baseCall,
      status: 'awaiting_admission',
    };
    const plan = advance(
      source,
      [
        control(call, waiting, {
          declarationIntent: true,
          admissionIntent: true,
        }),
      ],
      {
        observations: [{ kind: 'cursor_only' }],
        persistedObservationCursor: {
          expectedNextEventSequence: source.nextEventSequence,
          consumedThroughEventSequence: source.nextEventSequence,
        },
      },
    );
    expect(plan.events.map(({ name }) => name)).toEqual([
      'node.waiting',
      'run.waiting',
    ]);
    expect(plan.events[0]?.sequence).toBe(source.nextEventSequence + 1);
    expect(plan.consumedThroughEventSequence).toBe(source.nextEventSequence);
    expect(plan.attempts).toEqual([]);
    expect(plan.checkpoint.invocations[0]?.output).toBeUndefined();
  });
  it.each(['cancel_requested', 'deadline_expired'] as const)(
    'keeps accepted child waiting after %s until durable settlement',
    (stop) => {
      const plan = stopped(stop);
      expect(plan.checkpoint.runStatus).toBe('waiting');
      expect(plan.checkpoint.invocations).toEqual([waiting]);
      expect(plan.workflowCalls).toEqual({
        declarations: [],
        cancelChildren: [{ childRunId, reason: stop }],
      });
      expect(plan.attempts).toEqual([]);
      expect(
        plan.events.some(
          ({ name }) =>
            name === 'node.canceled' ||
            name === 'node.timed_out' ||
            name === 'run.canceled' ||
            name === 'run.timed_out',
        ),
      ).toBe(false);
      const status = stop === 'cancel_requested' ? 'canceled' : 'timed_out';
      const settled: WorkflowCallStateV1 = {
        ...baseCall,
        status: 'settled',
        childRunId,
        childStatus: 'succeeded',
      };
      const reconciled = advance(plan.checkpoint, [
        control(settled, { ...waiting, status }),
      ]);
      expect(reconciled.checkpoint.runStatus).toBe(status);
      expect(reconciled.checkpoint.invocations[0]?.status).toBe(status);
      expect(reconciled.checkpoint.invocations[0]?.output).toBeUndefined();
      expect(reconciled.attempts).toEqual([]);
      expect(reconciled.workflowCalls?.cancelChildren).toEqual([]);
      expect(reconciled.events.map(({ name }) => name)).toEqual([
        `node.${status}`,
        `run.${status}`,
      ]);
    },
  );
  it.each(['cancel_requested', 'deadline_expired'] as const)(
    'settled unknown child outranks parent %s',
    (stop) => {
      const call: WorkflowCallStateV1 = {
        ...baseCall,
        status: 'settled',
        childRunId,
        childStatus: 'outcome_unknown',
      };
      const plan = advance(stopped(stop).checkpoint, [
        control(
          call,
          { ...waiting, status: 'outcome_unknown' },
          { reasonCode: 'workflow.child_outcome_unknown' },
        ),
      ]);
      expect(plan.checkpoint.runStatus).toBe('outcome_unknown');
      expect(plan.checkpoint.invocations[0]?.status).toBe('outcome_unknown');
      expect(plan.checkpoint.invocations[0]?.output).toBeUndefined();
      expect(plan.events.map(({ name }) => name)).toEqual([
        'node.outcome_unknown',
        'run.outcome_unknown',
      ]);
      expect(plan.events[0]?.reasonCode).toBe('workflow.child_outcome_unknown');
      expect(plan.attempts).toEqual([]);
      expect(plan.workflowCalls?.cancelChildren).toEqual([]);
    },
  );
  it('separates settled child result from declaration output and admits actual downstream work', () => {
    const call: WorkflowCallStateV1 = {
      ...baseCall,
      status: 'settled',
      childRunId,
      childStatus: 'succeeded',
    };
    const result = {
      kind: 'workflow_call' as const,
      invocationKey: key,
      childRunId,
    };
    const plan = advance(
      accepted().checkpoint,
      [control(call, { ...waiting, status: 'succeeded', output: result })],
      { schedulerState: chain, maximumAdmissions: 1 },
    );
    expect(
      plan.checkpoint.invocations.find(({ nodeId }) => nodeId === 'call')
        ?.output,
    ).toEqual(result);
    expect(v3(plan.checkpoint).calls[0]?.input).toEqual(baseCall.input);
    expect(plan.events.map(({ name }) => name)).toEqual([
      'node.succeeded',
      'node.ready',
    ]);
    expect(plan.attempts).toEqual([
      {
        invocationKey: invocationKey({ workflowVersionId, nodeId: 'next' }),
        nodeId: 'next',
        attemptNumber: 1,
        admissionKind: 'execute',
        sideEffectClass: 'safe',
      },
    ]);
    expect(plan.nodeRunAdmissions.map(({ nodeId }) => nodeId)).toEqual([
      'next',
    ]);
    expect(plan.checkpoint.runStatus).toBe('running');
    expect(plan.workflowCalls?.declarations).toEqual([]);
    expect(parseCheckpoint(plan.checkpoint)).toEqual(plan.checkpoint);
    expect(
      parseCheckpoint(plan.checkpoint).invocations.find(
        ({ nodeId }) => nodeId === 'call',
      )?.output,
    ).toEqual(result);
  });
  it('retains downstream readiness across admission cap zero without retrying Call', () => {
    const call: WorkflowCallStateV1 = {
      ...baseCall,
      status: 'settled',
      childRunId,
      childStatus: 'succeeded',
    };
    const completed = control(call, {
      ...waiting,
      status: 'succeeded',
      output: { kind: 'workflow_call', invocationKey: key, childRunId },
    });
    const ready = advance(accepted().checkpoint, [completed], {
      schedulerState: chain,
    });
    expect(ready.checkpoint.readySet).toEqual([
      invocationKey({ workflowVersionId, nodeId: 'next' }),
    ]);
    expect(ready.attempts).toEqual([]);
    const admitted = advance(ready.checkpoint, [completed], {
      schedulerState: chain,
      maximumAdmissions: 1,
    });
    expect(admitted.attempts.map(({ nodeId }) => nodeId)).toEqual(['next']);
    expect(admitted.events).toEqual([]);
    expect(
      admitted.checkpoint.invocations.find(({ nodeId }) => nodeId === 'call')
        ?.attemptNumber,
    ).toBe(1);
    expect(admitted.workflowCalls?.declarations).toEqual([]);
  });
  it.each(['cancel_requested', 'deadline_expired'] as const)(
    'does not terminalize a ForEach ordinal containing an accepted Call on %s',
    (stop) => {
      const iterationPath = [{ loopNodeId: 'loop', ordinal: 0 }];
      const scopedKey = invocationKey({
        workflowVersionId,
        nodeId: 'call',
        iterationPath,
      });
      const loopKey = invocationKey({ workflowVersionId, nodeId: 'loop' });
      const sinkKey = invocationKey({
        workflowVersionId,
        nodeId: 'sink',
        iterationPath,
      });
      const call: WorkflowCallStateV1 = {
        ...baseCall,
        invocationKey: scopedKey,
        status: 'admitted',
        childRunId,
      };
      const scopedWait: WorkflowCallInvocationStateV1 = {
        ...waiting,
        invocationKey: scopedKey,
        branchPath: [],
        iterationPath,
      };
      const source: WorkflowCheckpointV3 = {
        ...initial(),
        runStatus: 'waiting',
        calls: [call],
        admittedInvocationKeys: [loopKey, scopedKey],
        remainingIterationBudget: 9,
        invocations: [
          scopedWait,
          {
            invocationKey: loopKey,
            nodeId: 'loop',
            status: 'waiting',
            attemptNumber: 1,
          },
          {
            invocationKey: sinkKey,
            nodeId: 'sink',
            status: 'pending',
            attemptNumber: 0,
            branchPath: [],
            iterationPath,
          },
        ],
        loops: [
          {
            loopId: 'loop',
            controlInvocationKey: loopKey,
            branchPath: [],
            iterationPath: [],
            collection: { kind: 'inline', attemptId: declarationAttemptId },
            collectionChecksum: 'd'.repeat(64),
            collectionSize: 1,
            maxConcurrency: 1,
            maxIterations: 1,
            nextOrdinal: 1,
            activeOrdinals: [0],
            terminalOrdinals: [],
            bodyRootNodeIds: ['call'],
            bodySinkNodeId: 'sink',
          },
        ],
      };
      const plan = advance(
        parseCheckpoint(source),
        [
          control(call, scopedWait, {
            cancelChild: { childRunId, reason: stop },
          }),
        ],
        stopInput(stop),
      );
      expect(plan.checkpoint.loops[0]?.activeOrdinals).toEqual([0]);
      expect(plan.checkpoint.loops[0]?.terminalOrdinals).toEqual([]);
      expect(plan.checkpoint.loops[0]?.terminalStatus).toBeUndefined();
      expect(
        plan.checkpoint.invocations.find(({ nodeId }) => nodeId === 'call'),
      ).toEqual(scopedWait);
      expect(
        plan.checkpoint.invocations.find(({ nodeId }) => nodeId === 'loop')
          ?.status,
      ).toBe('waiting');
      expect(
        plan.checkpoint.invocations.find(({ nodeId }) => nodeId === 'sink')
          ?.status,
      ).toBe('canceled');
      expect(plan.checkpoint.runStatus).toBe('waiting');
      expect(plan.workflowCalls?.cancelChildren).toEqual([
        { childRunId, reason: stop },
      ]);
      expect(plan.attempts).toEqual([]);
    },
  );
  it.each([1, 2] as const)(
    'retained checkpoint V%s rejects Call result references and control decisions',
    (schemaVersion) => {
      const legacy = (
        schemaVersion === 1 ? createCheckpoint : createCheckpointV2
      )({ engineVersion: 'test', workflowVersionId, iterationBudget: 10 });
      expect(() =>
        parseCheckpoint({
          ...legacy,
          runStatus: 'running',
          admittedInvocationKeys: [key],
          invocations: [
            {
              ...waiting,
              status: 'succeeded',
              output: { kind: 'workflow_call', invocationKey: key, childRunId },
            },
          ],
        }),
      ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
      expect(() =>
        advance(
          {
            ...legacy,
            runStatus: 'running',
            admittedInvocationKeys: [key],
            invocations: [{ ...waiting, status: 'running' }],
          },
          [
            control({ ...baseCall, status: 'awaiting_admission' }, waiting, {
              declarationIntent: true,
              admissionIntent: true,
            }),
          ],
        ),
      ).toThrow(expect.objectContaining({ code: 'observation_invalid' }));
    },
  );
  it('legacy public advance with authenticated V2 executable rejects native checkpoint V3', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: graph(),
      release: composeExecutableCompatibilityRelease(nodeRelease()),
    });
    await expect(
      advancePublicWorkflow({
        executable,
        runId: 'run-1',
        workflowVersionId,
        checkpoint: initial(),
        occurredAt,
        maximumAdmissions: 1,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'workflow_identity_invalid',
      message: 'checkpoint format does not match the executable runtime',
    });
  });
});
