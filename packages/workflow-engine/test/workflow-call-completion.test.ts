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
  it('rejects malformed or accessor-bearing demand envelopes without executing getters', async () => {
    const getter = vi.fn();
    const accessor = Object.defineProperty({ kind: 'ready' }, 'material', {
      enumerable: true,
      get: getter,
    });
    for (const result of [
      null,
      {},
      { kind: 'unknown' },
      { kind: 'invalid_context', extra: true },
      { kind: 'stopped', stop: { kind: 'stale', revision: -1 } },
      { kind: 'stopped', stop: { kind: 'unavailable', reason: 'invented' } },
      { kind: 'stopped', stop: { kind: 'canceled', proof: 'not-authority' } },
      { kind: 'ready', material: { runInput: {}, outputs: [], extra: true } },
      accessor,
    ]) {
      const loadCallableCompletion = vi.fn().mockResolvedValue(result);
      await expect(
        advanceWorkflow({
          ...withoutCompletion(input()),
          loadCallableCompletion,
        }),
      ).rejects.toThrow(invalid);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['hydration', 'evaluation'] as const)(
    'propagates context abort during demand %s without a result plan',
    async (stage) => {
      const before = input({
        kind: 'expression',
        language: 'jsonata',
        policyVersion: 1,
        expression: 'nodeOutputs.manual',
      });
      const controller = new AbortController();
      await expect(
        advanceWorkflow({
          ...withoutCompletion(before),
          signal: controller.signal,
          loadCallableCompletion: () => {
            if (stage === 'hydration') controller.abort();
            return Promise.resolve({
              kind: 'ready',
              material: before.callableCompletion,
            });
          },
          callableExpressionEvaluator: {
            evaluate: () => {
              controller.abort();
              return Promise.resolve({
                kind: 'value',
                value: { name: 'accepted' },
                canonicalBytes: 19,
              });
            },
          },
        }),
      ).rejects.toMatchObject({
        name: 'CallableCompletionStoppedError',
        stop: { kind: 'context_aborted' },
      });
    },
  );
  it('refuses material for an unrequested source even if it is a valid successful output', async () => {
    const before = input({ kind: 'run_input', path: '$' });
    await expect(
      advanceWorkflow({
        ...withoutCompletion(before),
        loadCallableCompletion: () =>
          Promise.resolve({
            kind: 'ready',
            material: before.callableCompletion,
          }),
      }),
    ).rejects.toThrow(invalid);
  });

  it('does not let the provider mutate checkpoint output authority through its demand', async () => {
    const before = input();
    const loadCallableCompletion = vi.fn(
      (demand: {
        sources: readonly { output: { kind: string; attemptId?: string } }[];
      }) => {
        const selected = demand.sources[0];
        if (selected === undefined) throw new Error('Missing source');
        selected.output.attemptId = declarationAttemptId;
        return Promise.resolve({
          kind: 'ready' as const,
          material: {
            runInput: null,
            outputs: [
              {
                invocationKey: key,
                output: selected.output,
                value: { name: 'accepted' },
              },
            ],
          },
        });
      },
    );
    await expect(
      advanceWorkflow({ ...withoutCompletion(before), loadCallableCompletion }),
    ).rejects.toThrow(invalid);
    expect(before.observations[0]?.output).toEqual({
      kind: 'inline',
      attemptId: otherId,
    });
  });
  it('does not demand literal or non-success completion and retains the eager path', async () => {
    const loadCallableCompletion = vi.fn();
    const literal = withoutCompletion(
      input({ kind: 'literal', value: { name: 'literal' } }),
    );
    expect(
      (await advanceWorkflow({ ...literal, loadCallableCompletion }))
        .callableResult,
    ).toEqual({ kind: 'succeeded', value: { name: 'literal' }, sources: [] });
    expect(
      (
        await advanceWorkflow({
          ...withoutCompletion(input()),
          observations: [],
          loadCallableCompletion,
        })
      ).callableResult,
    ).toBeUndefined();
    expect(loadCallableCompletion).not.toHaveBeenCalled();
    expect((await advanceWorkflow(input())).callableResult).toMatchObject({
      kind: 'succeeded',
      value: { name: 'accepted' },
    });
  });

  it('uses the existing invalid-context completion but preserves adapter infrastructure errors', async () => {
    const before = withoutCompletion(input());
    expect(
      (
        await advanceWorkflow({
          ...before,
          loadCallableCompletion: () =>
            Promise.resolve({ kind: 'invalid_context' }),
        })
      ).callableResult,
    ).toEqual({ kind: 'failed', reasonCode: 'workflow.child_result_invalid' });
    const unavailable = new Error('source authority unavailable');
    await expect(
      advanceWorkflow({
        ...before,
        loadCallableCompletion: () => Promise.reject(unavailable),
      }),
    ).rejects.toBe(unavailable);
  });

  it('refuses an adapter-supplied evaluator instead of executing it', async () => {
    const before = input({
      kind: 'expression',
      language: 'jsonata',
      policyVersion: 1,
      expression: 'nodeOutputs.manual',
    });
    const evaluate = vi.fn();
    await expect(
      advanceWorkflow({
        ...withoutCompletion(before),
        loadCallableCompletion: () =>
          Promise.resolve({
            kind: 'ready',
            material: {
              ...before.callableCompletion,
              expressionEvaluator: { evaluate },
            },
          }),
      }),
    ).rejects.toThrow(invalid);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('uses the caller-owned evaluator with exact requested input scope', async () => {
    const before = input({
      kind: 'expression',
      language: 'jsonata',
      policyVersion: 1,
      expression: 'runInput',
    });
    const loadCallableCompletion = vi.fn().mockResolvedValue({
      kind: 'ready',
      material: { runInput: { name: 'input' }, outputs: [] },
    });
    const evaluate = vi.fn().mockResolvedValue({
      kind: 'value',
      value: { name: 'input' },
      canonicalBytes: 16,
    });
    expect(
      (
        await advanceWorkflow({
          ...withoutCompletion(before),
          loadCallableCompletion,
          callableExpressionEvaluator: { evaluate },
        })
      ).callableResult,
    ).toEqual({ kind: 'succeeded', value: { name: 'input' }, sources: [] });
    expect(loadCallableCompletion.mock.calls[0]?.[0]).toEqual({
      expectedRevision: 0,
      resultSelector: before.executable.envelope.graph.callable?.resultSelector,
      requiresRunInput: true,
      sources: [],
    });
  });
  it.each([
    { kind: 'canceled' },
    { kind: 'timed_out' },
    { kind: 'stale', revision: 2 },
    { kind: 'context_aborted' },
    { kind: 'unavailable', reason: 'control_read_failed' },
    { kind: 'unavailable', reason: 'value_work_timeout' },
    { kind: 'unavailable', reason: 'source_read_failed' },
  ] as const)(
    'propagates value work stop %j without a success or child failure plan',
    async (stop) => {
      await expect(
        advanceWorkflow({
          ...withoutCompletion(input()),
          loadCallableCompletion: () =>
            Promise.resolve({ kind: 'stopped', stop }),
        }),
      ).rejects.toMatchObject({ name: 'CallableCompletionStoppedError', stop });
    },
  );
  it.each([
    undefined,
    { kind: 'literal', value: { name: 'literal' } },
  ] as const)(
    'refuses eager plus demand before any material or provider work (%j)',
    async (selector) => {
      const before = input(selector);
      const loadCallableCompletion = vi.fn();
      await expect(
        advanceWorkflow({ ...before, loadCallableCompletion }),
      ).rejects.toThrow('eager and demand');
      await expect(
        advanceWorkflow({
          ...before,
          observations: [],
          loadCallableCompletion,
        }),
      ).rejects.toThrow('eager and demand');
      expect(loadCallableCompletion).not.toHaveBeenCalled();
    },
  );
  it('demands only the uniquely selected durable scope after success', async () => {
    const before = input();
    const loadCallableCompletion = vi.fn().mockResolvedValue({
      kind: 'ready',
      material: before.callableCompletion,
    });
    const activeSignal = signal();
    const plan = await advanceWorkflow({
      ...withoutCompletion(before),
      loadCallableCompletion,
      signal: activeSignal,
    });
    expect(plan.callableResult).toEqual({
      kind: 'succeeded',
      value: { name: 'accepted' },
      sources: [{ invocationKey: key, output }],
    });
    expect(loadCallableCompletion).toHaveBeenCalledExactlyOnceWith(
      {
        expectedRevision: 0,
        resultSelector: { kind: 'node_output', nodeId: 'manual', path: '$' },
        requiresRunInput: false,
        sources: [{ nodeId: 'manual', invocationKey: key, output }],
      },
      activeSignal,
    );
  });
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
    const loadCallableCompletion = vi.fn();
    const plan = await advanceWorkflow({
      ...withoutCompletion(before),
      loadCallableCompletion,
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
    expect(loadCallableCompletion).not.toHaveBeenCalled();
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
  it.each([0, 2])(
    'does not demand missing or ambiguous selected scope (%i)',
    async (count) => {
      const { compiled, plan } = scopedCandidate(count);
      const loadCallableCompletion = vi.fn();
      const completed = await completeCallableTransition(
        compiled,
        plan,
        undefined,
        signal(),
        loadCallableCompletion,
      );
      expect(completed.callableResult).toEqual({
        kind: 'failed',
        reasonCode: 'workflow.child_result_invalid',
      });
      expect(loadCallableCompletion).not.toHaveBeenCalled();
    },
  );

  it('preserves existing inspected expression source order rather than checkpoint invocation order', async () => {
    const { compiled, plan } = scopedCandidate(1, {
      kind: 'expression',
      language: 'jsonata',
      policyVersion: 1,
      expression: '[nodeOutputs.right, nodeOutputs.left]',
    });
    const left = plan.checkpoint.invocations[0];
    if (left === undefined) throw new Error('Missing fixture source');
    const right = {
      ...left,
      nodeId: 'right',
      invocationKey: invocationKey({
        workflowVersionId,
        nodeId: 'right',
        branchPath: (left.branchPath ?? []).map(
          ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
        ),
      }),
      output: { kind: 'inline' as const, attemptId: declarationAttemptId },
    };
    const loadCallableCompletion = vi
      .fn()
      .mockResolvedValue({ kind: 'invalid_context' });
    await completeCallableTransition(
      compiled,
      {
        ...plan,
        checkpoint: {
          ...plan.checkpoint,
          admittedInvocationKeys: [left.invocationKey, right.invocationKey],
          invocations: [right, left],
        },
      },
      undefined,
      signal(),
      loadCallableCompletion,
    );
    expect(loadCallableCompletion.mock.calls[0]?.[0]).toEqual({
      expectedRevision: 0,
      resultSelector: compiled.envelope.graph.callable?.resultSelector,
      requiresRunInput: true,
      sources: [left, right].map(({ nodeId, invocationKey, output }) => ({
        nodeId,
        invocationKey,
        output,
      })),
    });
  });
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
