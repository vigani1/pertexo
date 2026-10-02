import { describe, expect, it, vi } from 'vitest';

import {
  coordinatorExecutableFormat,
  parseCoordinatorCheckpoint,
} from '../src/execution/coordinator/coordinator-checkpoint.js';
import {
  parseTransitionPlan,
  transitionFingerprint,
  validateTransitionPlan,
} from '../src/execution/coordinator/coordinator-run-store-plan.js';

const version = '00000000-0000-4000-8000-000000000101';
const attempt = '00000000-0000-4000-8000-000000000201';
const key = `${version}|manual|b:|i:`;
const output = { kind: 'inline', attemptId: attempt };
function plan() {
  return {
    expectedRevision: 0,
    expectedNextEventSequence: 2,
    consumedThroughEventSequence: 1,
    checkpoint: {
      schemaVersion: 3,
      engineVersion: 'engine-v3',
      workflowVersionId: version,
      revision: 1,
      runStatus: 'succeeded',
      nextEventSequence: 3,
      readySet: [],
      admittedInvocationKeys: [key],
      invocations: [
        {
          invocationKey: key,
          nodeId: 'manual',
          status: 'succeeded',
          attemptNumber: 1,
          output,
        },
      ],
      joins: [],
      loops: [],
      calls: [],
      branchSelections: [],
      remainingIterationBudget: 1_000,
      cancelRequested: false,
      deadlineExpired: false,
    },
    events: [
      {
        schemaVersion: 1,
        sequence: 2,
        name: 'run.succeeded',
        occurredAt: '2026-10-03T00:00:00.000Z',
      },
    ],
    nodeRunAdmissions: [],
    attempts: [],
    callableResult: {
      kind: 'succeeded',
      value: { name: 'result' },
      sources: [{ invocationKey: key, output }],
    },
  };
}
function valid(value: unknown) {
  const parsed = parseTransitionPlan(value);
  validateTransitionPlan(parsed, version);
  return parsed;
}

describe('native coordinator plan boundary', () => {
  it.each([
    [1, 2, 2, 2],
    [2, 3, 3, 3],
    [1, 3, 3, undefined],
    [2, 2, 2, undefined],
    [2, 3, 2, undefined],
    [1, 2, 3, undefined],
  ] as const)(
    'selects only the exact stored graph/executable/checksum pair %s/%s/v%s',
    (graph, executable, checksum, expected) => {
      expect(
        coordinatorExecutableFormat({
          graph_schema_version: graph,
          executable_schema_version: executable,
          executable_checksum: `wf:v${String(checksum)}:sha256:${'a'.repeat(64)}`,
        }),
      ).toBe(expected);
    },
  );
  it('keeps the selected result budget independent of the retained plan budget', () => {
    const source = plan();
    source.callableResult.value.name = 'x'.repeat(1_048_576 - 11);
    const parsed = valid(source);
    expect(parsed.callableResult).toEqual(source.callableResult);
    const fingerprint = transitionFingerprint({
      plan: parsed,
      workflowVersionId: version,
      traceparent: undefined,
    });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    source.callableResult.value.name += 'x';
    expect(() => parseTransitionPlan(source)).toThrow();
  });

  it('fingerprints the result content rather than just its byte length', () => {
    const left = plan(),
      right = plan();
    right.callableResult.value.name = 'change';
    expect(
      transitionFingerprint({
        plan: valid(left),
        workflowVersionId: version,
        traceparent: undefined,
      }),
    ).not.toBe(
      transitionFingerprint({
        plan: valid(right),
        workflowVersionId: version,
        traceparent: undefined,
      }),
    );
  });

  it.each([
    'mismatched reference',
    'missing invocation',
    'duplicate source',
    'unsuccessful invocation',
  ])('rejects %s result ownership', (kind) => {
    const source = plan();
    const resultSource = source.callableResult.sources[0];
    const invocation = source.checkpoint.invocations[0];
    if (resultSource === undefined || invocation === undefined)
      throw new Error('Expected native plan fixture source');
    if (kind === 'mismatched reference')
      resultSource.output = {
        kind: 'inline',
        attemptId: version,
      };
    if (kind === 'missing invocation')
      resultSource.invocationKey = `${version}|missing|b:|i:`;
    if (kind === 'duplicate source')
      source.callableResult.sources.push(resultSource);
    if (kind === 'unsuccessful invocation') invocation.status = 'failed';
    expect(() => valid(source)).toThrow();
  });

  it('rejects a successful result without the corresponding terminal transition', () => {
    const source = plan();
    const event = source.events[0];
    if (event === undefined)
      throw new Error('Expected native plan fixture event');
    event.name = 'run.waiting';
    expect(() => valid(source)).toThrow();
  });

  it('rejects fabricated child cancellation intent', () => {
    expect(() =>
      valid({
        ...plan(),
        workflowCalls: {
          declarations: [],
          cancelChildren: [{ childRunId: attempt, reason: 'cancel_requested' }],
        },
      }),
    ).toThrow();
  });

  it('never evaluates accessor or proxy result values', () => {
    const getter = vi.fn(() => 'secret');
    const source = plan();
    Object.defineProperty(source.callableResult.value, 'name', {
      enumerable: true,
      get: getter,
    });
    expect(() => parseTransitionPlan(source)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const trap = vi.fn(() => []);
    expect(() =>
      parseTransitionPlan({
        ...plan(),
        callableResult: new Proxy({}, { ownKeys: trap }),
      }),
    ).toThrow();
    expect(trap).not.toHaveBeenCalled();
  });

  it('does not upgrade or downgrade checkpoint formats', () => {
    const source = plan().checkpoint;
    expect(() => parseCoordinatorCheckpoint(source, 2)).toThrow();
    const { calls: _calls, ...retained } = source;
    expect(() =>
      parseCoordinatorCheckpoint({ ...retained, schemaVersion: 2 }, 3),
    ).toThrow();
    expect(() =>
      parseTransitionPlan({
        ...plan(),
        checkpoint: { ...retained, schemaVersion: 2 },
      }),
    ).toThrow();
  });
});
