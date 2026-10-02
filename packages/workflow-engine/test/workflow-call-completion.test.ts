import { NODE_JSON_LIMITS_V1 } from '@pertexo/node-sdk';
import type { WorkflowCallableDeclarationV1 } from '@pertexo/workflow-model/callable-graph-contract';
import type { ValueSource } from '@pertexo/workflow-model/graph-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityReleaseV3,
} from '../src/executable-workflow.js';
import { createWorkflowCheckpointV3 } from '../src/checkpoint/checkpoint-v3.js';
import { advanceWorkflow } from '../src/operations.js';
import { completeCallableTransition } from '../src/observation/workflow-call-completion.js';
import { invocationKey } from '../src/transition/scheduling.js';
import type { WorkflowTransitionPlan, InvocationState } from '../src/types.js';
import {
  graph,
  nodeRelease,
  pairedParallelGraph,
} from './executable-workflow.fixtures.js';
import { occurredAt } from './support/advance-workflow.fixture.js';
import {
  workflowVersionId,
  otherId,
  declarationAttemptId,
} from './support/workflow-call.fixture.js';

const invalid: unknown = expect.objectContaining({
  code: 'observation_invalid',
});
const output = { kind: 'inline' as const, attemptId: otherId };
const key = invocationKey({ workflowVersionId, nodeId: 'manual' });
const signal = () => new AbortController().signal;
function declaration(
  resultSelector: ValueSource,
): WorkflowCallableDeclarationV1 {
  const type = {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  } as const;
  return { schemaVersion: 1, input: type, result: type, resultSelector };
}
function executable(
  selector: ValueSource = { kind: 'node_output', nodeId: 'manual', path: '$' },
) {
  return buildWorkflowExecutableV3({
    graph: {
      schemaVersion: 2,
      settings: {},
      nodes: [graph().nodes[0]],
      edges: [],
      callable: declaration(selector),
    },
    release: composeExecutableCompatibilityReleaseV3(nodeRelease()),
  });
}
function checkpoint() {
  return {
    ...createWorkflowCheckpointV3({
      engineVersion: 'test',
      workflowVersionId,
      iterationBudget: 10,
    }),
    runStatus: 'running' as const,
    admittedInvocationKeys: [key],
    invocations: [
      {
        invocationKey: key,
        nodeId: 'manual',
        attemptNumber: 1,
        status: 'running' as const,
      },
    ],
  };
}
function input(selector?: ValueSource, value: unknown = { name: 'accepted' }) {
  const cp = checkpoint();
  return {
    runId: 'child',
    workflowVersionId,
    executable: executable(selector),
    checkpoint: cp,
    observations: [
      {
        kind: 'outcome',
        sequence: cp.nextEventSequence,
        occurredAt,
        invocationKey: key,
        attemptId: otherId,
        attemptNumber: 1,
        status: 'succeeded',
        output,
      },
    ],
    callableCompletion: {
      runInput: { name: 'input' },
      outputs: [{ invocationKey: key, output, value }],
    },
    occurredAt,
    maximumAdmissions: 10,
    signal: signal(),
  };
}
function withoutCompletion(value: ReturnType<typeof input>) {
  const { callableCompletion: _completion, ...rest } = value;
  return rest;
}
function candidate(
  invocations: readonly InvocationState[],
): WorkflowTransitionPlan {
  const cp = createWorkflowCheckpointV3({
    engineVersion: 'test',
    workflowVersionId,
    iterationBudget: 10,
  });
  return {
    expectedRevision: 0,
    expectedNextEventSequence: cp.nextEventSequence,
    consumedThroughEventSequence: cp.nextEventSequence,
    checkpoint: {
      ...cp,
      revision: 1,
      runStatus: 'succeeded',
      nextEventSequence: cp.nextEventSequence + 1,
      invocations,
      admittedInvocationKeys: invocations.map(
        ({ invocationKey }) => invocationKey,
      ),
    },
    events: [
      {
        schemaVersion: 1,
        sequence: cp.nextEventSequence,
        name: 'run.succeeded',
        occurredAt,
      },
    ],
    attempts: [],
    nodeRunAdmissions: [],
  };
}
function scopedCandidate(
  count: number,
  selector: ValueSource = { kind: 'node_output', nodeId: 'left', path: '$' },
) {
  const invocations = Array.from({ length: count }, (_, index) => {
    const branchPath = [
      {
        nodeId: 'parallel',
        outputPort: index === 0 ? 'branch-01' : 'branch-02',
      },
    ];
    return {
      invocationKey: invocationKey({
        workflowVersionId,
        nodeId: 'left',
        branchPath: branchPath.map(
          ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
        ),
      }),
      nodeId: 'left',
      attemptNumber: 1,
      status: 'succeeded' as const,
      output:
        index === 0
          ? output
          : { kind: 'inline' as const, attemptId: declarationAttemptId },
      branchPath,
    };
  });
  const compiled = buildWorkflowExecutableV3({
    graph: {
      ...pairedParallelGraph(),
      schemaVersion: 2,
      callable: declaration(selector),
    },
    release: composeExecutableCompatibilityReleaseV3(
      nodeRelease({ parallel: true, merge: true }),
    ),
  });
  return {
    compiled,
    plan: candidate(invocations),
    material: {
      runInput: {},
      outputs: invocations.map(({ invocationKey, output }) => ({
        invocationKey,
        output,
        value: { name: 'equal' },
      })),
    },
  };
}

describe('callable completion through authenticated advance', () => {
  it('returns one bounded transient result with its immutable invocation/output identity at the existing CAS', async () => {
    const before = input();
    const plan = await advanceWorkflow(before);
    expect(plan.callableResult).toEqual({
      kind: 'succeeded',
      value: { name: 'accepted' },
      sources: [{ invocationKey: key, output }],
    });
    expect(plan.checkpoint.revision).toBe(before.checkpoint.revision + 1);
    expect(plan.checkpoint.runStatus).toBe('succeeded');
    expect(plan.checkpoint.invocations[0]?.output).toEqual(output);
    expect(
      plan.events.filter(({ name }) => name.startsWith('run.')),
    ).toMatchObject([{ name: 'run.succeeded' }]);
    expect(plan.attempts).toEqual([]);
    expect(JSON.stringify(plan.checkpoint)).not.toContain('accepted');
    expect(await advanceWorkflow(before)).toEqual(plan);
    const recovered = await advanceWorkflow({
      ...withoutCompletion(before),
      checkpoint: plan.checkpoint,
      observations: [],
    });
    expect(recovered.callableResult).toBeUndefined();
    expect(recovered.events).toEqual([]);
  });

  it.each([
    [
      { kind: 'node_output', nodeId: 'manual', path: '$.missing' },
      { name: 'accepted' },
      'workflow.child_result_missing',
    ],
    [
      { kind: 'node_output', nodeId: 'manual', path: '$' },
      { name: 1 },
      'workflow.child_result_invalid',
    ],
    [
      { kind: 'node_output', nodeId: 'manual', path: '$' },
      { name: 'accepted', extra: true },
      'workflow.child_result_invalid',
    ],
  ] as const)(
    'fails only the run for missing path or invalid typed result %#',
    async (selector, value, reasonCode) => {
      const before = input(selector, value);
      const plan = await advanceWorkflow(before);
      expect(plan.checkpoint.runStatus).toBe('failed');
      expect(plan.checkpoint.invocations[0]).toMatchObject({
        status: 'succeeded',
        output,
      });
      expect(plan.callableResult).toEqual({ kind: 'failed', reasonCode });
      expect(plan.events.at(-1)).toMatchObject({
        name: 'run.failed',
        reasonCode,
      });
      expect(plan.checkpoint.revision).toBe(before.checkpoint.revision + 1);
      expect(plan.checkpoint.nextEventSequence).toBe(
        before.checkpoint.nextEventSequence + 2,
      );
    },
  );

  it('resolves explicit literal/run-input selectors without last-node fallback', async () => {
    const literal = input({ kind: 'literal', value: { name: 'literal' } });
    expect(
      (await advanceWorkflow(withoutCompletion(literal))).callableResult,
    ).toEqual({ kind: 'succeeded', value: { name: 'literal' }, sources: [] });
    expect(
      (await advanceWorkflow(input({ kind: 'run_input', path: '$' })))
        .callableResult,
    ).toEqual({ kind: 'succeeded', value: { name: 'input' }, sources: [] });
  });

  it('preserves the exact independent 1MiB selected-value limit', async () => {
    const value = { name: 'x'.repeat(NODE_JSON_LIMITS_V1.bytes - 11) };
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(
      NODE_JSON_LIMITS_V1.bytes,
    );
    expect(
      (await advanceWorkflow(input(undefined, value))).callableResult?.kind,
    ).toBe('succeeded');
    value.name += 'x';
    expect(
      (await advanceWorkflow(input(undefined, value))).callableResult,
    ).toEqual({ kind: 'failed', reasonCode: 'workflow.child_result_invalid' });
  });

  it('treats unavailable hydration and mismatched immutable reference as operational failures', async () => {
    const before = input();
    await expect(advanceWorkflow(withoutCompletion(before))).rejects.toThrow(
      invalid,
    );
    for (const outputs of [
      [],
      [
        {
          invocationKey: key,
          output: { kind: 'inline', attemptId: declarationAttemptId },
          value: { name: 'accepted' },
        },
      ],
      [{ invocationKey: 'wrong', output, value: {} }],
    ])
      await expect(
        advanceWorkflow({
          ...before,
          callableCompletion: { runInput: {}, outputs },
        }),
      ).rejects.toThrow(invalid);
  });

  it('does not evaluate results for an unsuccessful run or fabricate another attempt', async () => {
    const before = input();
    const first = before.observations[0];
    if (first === undefined) throw new Error('Expected fixture observation');
    const { output: _output, ...observation } = first;
    const plan = await advanceWorkflow({
      ...withoutCompletion(before),
      observations: [
        {
          ...observation,
          status: 'outcome_unknown',
        },
      ],
    });
    expect(plan.checkpoint.runStatus).toBe('outcome_unknown');
    expect(plan.callableResult).toBeUndefined();
    expect(plan.attempts).toEqual([]);
  });

  it('preserves evaluator infrastructure failures and cancellation rather than committing result failure', async () => {
    const before = input({
      kind: 'expression',
      language: 'jsonata',
      policyVersion: 1,
      expression: 'nodeOutputs.manual',
    });
    const unavailable = new Error('expression infrastructure unavailable');
    const evaluate = vi.fn().mockRejectedValue(unavailable);
    await expect(
      advanceWorkflow({
        ...before,
        callableCompletion: {
          ...before.callableCompletion,
          expressionEvaluator: { evaluate },
        },
      }),
    ).rejects.toBe(unavailable);
    const controller = new AbortController();
    evaluate.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({
        kind: 'value',
        value: { name: 'accepted' },
        canonicalBytes: 19,
      });
    });
    await expect(
      advanceWorkflow({
        ...before,
        signal: controller.signal,
        callableCompletion: {
          ...before.callableCompletion,
          expressionEvaluator: { evaluate },
        },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'attempt_aborted' }));
  });
});

describe('single successful durable scope selection', () => {
  it.each([0, 1, 2])(
    'applies the same uniqueness rule to static expression references (%i)',
    async (count) => {
      const { compiled, plan, material } = scopedCandidate(count, {
        kind: 'expression',
        language: 'jsonata',
        expression: 'nodeOutputs.left',
        policyVersion: 1,
      });
      const evaluate = vi.fn().mockResolvedValue({
        kind: 'value',
        value: { name: 'equal' },
        canonicalBytes: 16,
      });
      const completed = await completeCallableTransition(
        compiled,
        plan,
        { ...material, expressionEvaluator: { evaluate } },
        signal(),
      );
      expect(completed.callableResult?.kind).toBe(
        count === 1 ? 'succeeded' : 'failed',
      );
      expect(evaluate).toHaveBeenCalledTimes(count === 1 ? 1 : 0);
    },
  );

  it('does not reject ambiguity in unreferenced outputs for a run-input-only expression', async () => {
    const { compiled, plan, material } = scopedCandidate(2, {
      kind: 'expression',
      language: 'jsonata',
      expression: 'runInput',
      policyVersion: 1,
    });
    const evaluate = vi.fn().mockResolvedValue({
      kind: 'value',
      value: { name: 'input' },
      canonicalBytes: 16,
    });
    const completed = await completeCallableTransition(
      compiled,
      plan,
      {
        ...material,
        runInput: { name: 'input' },
        expressionEvaluator: { evaluate },
      },
      signal(),
    );
    expect(completed.callableResult).toEqual({
      kind: 'succeeded',
      value: { name: 'input' },
      sources: [],
    });
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
      context: { nodeOutputs: {}, runInput: { name: 'input' } },
    });
  });

  it('does not silently hide ambiguous outputs behind dynamic expression lookup', async () => {
    const { compiled, plan, material } = scopedCandidate(2, {
      kind: 'expression',
      language: 'jsonata',
      expression: '$lookup(nodeOutputs, runInput.key)',
      policyVersion: 1,
    });
    const evaluate = vi.fn();
    const completed = await completeCallableTransition(
      compiled,
      plan,
      { ...material, expressionEvaluator: { evaluate } },
      signal(),
    );
    expect(completed.callableResult).toEqual({
      kind: 'failed',
      reasonCode: 'workflow.child_result_invalid',
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('rejects hostile completion/value containers without executing accessors', async () => {
    const before = input();
    const getter = vi.fn(() => []);
    const material = Object.defineProperty({ runInput: {} }, 'outputs', {
      enumerable: true,
      get: getter,
    });
    await expect(
      advanceWorkflow({
        ...before,
        callableCompletion: material as typeof before.callableCompletion,
      }),
    ).rejects.toThrow(invalid);
    const value = Object.defineProperty({}, 'name', {
      enumerable: true,
      get: getter,
    });
    expect(
      (await advanceWorkflow(input(undefined, value))).callableResult,
    ).toEqual({ kind: 'failed', reasonCode: 'workflow.child_result_invalid' });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])(
    'selects one scope and rejects zero/multiple equal-valued scopes (%i)',
    async (count) => {
      const { compiled, plan, material } = scopedCandidate(count);
      const completed = await completeCallableTransition(
        compiled,
        plan,
        material,
        signal(),
      );
      expect(completed.callableResult?.kind).toBe(
        count === 1 ? 'succeeded' : 'failed',
      );
      if (count !== 1)
        expect(completed.callableResult).toEqual({
          kind: 'failed',
          reasonCode: 'workflow.child_result_invalid',
        });
      else
        expect(completed.callableResult).toMatchObject({
          sources: [
            {
              invocationKey: plan.checkpoint.invocations[0]?.invocationKey,
              output,
            },
          ],
        });
    },
  );

  it.each(['skipped', 'failed'] as const)(
    'does not substitute a %s selected invocation',
    async (status) => {
      const { compiled, plan, material } = scopedCandidate(1);
      const invocations = plan.checkpoint.invocations.map(
        ({ output: _output, ...invocation }) => ({
          ...invocation,
          status,
        }),
      );
      expect(
        (
          await completeCallableTransition(
            compiled,
            { ...plan, checkpoint: { ...plan.checkpoint, invocations } },
            material,
            signal(),
          )
        ).callableResult,
      ).toEqual({
        kind: 'failed',
        reasonCode: 'workflow.child_result_invalid',
      });
    },
  );
});
