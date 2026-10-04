import { describe, expect, it, vi } from 'vitest';
import { prepareWorkflowRunAcceptanceInput } from '../src/execution/runs/execution-acceptance-input.js';

import { parsePersistedWorkflowCheckpoint } from '../src/compatibility/persisted-workflow-checkpoint.js';
import {
  parseInitialWorkflowCheckpointV3,
  parsePersistedWorkflowCheckpointV3,
  serializePersistedWorkflowCheckpointV3,
} from '../src/compatibility/persisted-workflow-checkpoint-v3.js';
import { STORED_EXECUTION_VALUE_LIMITS_V1 } from '../src/execution/stored-execution-value.js';

const version = '00000000-0000-4000-8000-000000000101';
const attempt = '00000000-0000-4000-8000-000000000201';
const child = '00000000-0000-4000-8000-000000000301';
const artifact = '00000000-0000-4000-8000-000000000401';
const key = `${version}|call|b:|i:`;
const pin = {
  workflowId: version,
  versionId: version,
  checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
  callableContractIdentity: `callable:v1:sha256:${'b'.repeat(64)}`,
};
function initial() {
  return {
    schemaVersion: 3,
    engineVersion: 'engine-v3',
    workflowVersionId: version,
    revision: 0,
    runStatus: 'queued',
    nextEventSequence: 2,
    readySet: [],
    admittedInvocationKeys: [],
    invocations: [],
    joins: [],
    loops: [],
    remainingIterationBudget: 1_000,
    cancelRequested: false,
    deadlineExpired: false,
    branchSelections: [],
    calls: [],
  };
}

describe('canonical root acceptance checkpoint preparation', () => {
  it('keeps invalid data-only normalization classified by the retained checkpoint owner', () => {
    const getter = vi.fn(() => 3);
    const checkpoint = Object.defineProperty({}, 'schemaVersion', {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      prepareWorkflowRunAcceptanceInput({
        engineVersion: 'engine-v3',
        workflowVersionId: version,
        initialCheckpoint: checkpoint,
        triggerType: 'manual',
      }),
    ).toThrow(
      expect.objectContaining({
        name: 'PersistedWorkflowCheckpointInvalidError',
      }),
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it('uses the existing strict native initial checkpoint owner for an explicit V3 root', () => {
    const checkpoint = initial();
    const prepared = prepareWorkflowRunAcceptanceInput({
      engineVersion: checkpoint.engineVersion,
      workflowVersionId: version,
      initialCheckpoint: checkpoint,
      triggerType: 'manual',
    });
    expect(JSON.parse(prepared.initialCheckpointJson)).toEqual(checkpoint);
    expect(prepared.initialCheckpointJson).toBe(
      serializePersistedWorkflowCheckpointV3(checkpoint),
    );
  });
});
function declaration() {
  return {
    invocationKey: key,
    nodeId: 'call',
    declarationAttemptId: attempt,
    pin,
    input: { kind: 'inline', attemptId: attempt },
    inputChecksum: 'c'.repeat(64),
    status: 'awaiting_admission',
  };
}
function invocation() {
  return {
    invocationKey: key,
    nodeId: 'call',
    status: 'waiting',
    attemptNumber: 1,
    branchPath: [],
    iterationPath: [],
  };
}
function waiting() {
  return {
    ...initial(),
    revision: 1,
    runStatus: 'waiting',
    admittedInvocationKeys: [key],
    invocations: [invocation()],
    calls: [declaration()],
  };
}
function result() {
  return { kind: 'workflow_call', invocationKey: key, childRunId: child };
}
function successful() {
  return {
    ...waiting(),
    runStatus: 'succeeded',
    calls: [
      {
        ...declaration(),
        status: 'settled',
        childRunId: child,
        childStatus: 'succeeded',
      },
    ],
    invocations: [{ ...invocation(), status: 'succeeded', output: result() }],
  };
}
function invalid(value: unknown) {
  expect(() => parsePersistedWorkflowCheckpointV3(value)).toThrow(
    expect.objectContaining({
      name: 'PersistedWorkflowCheckpointInvalidError',
      message: 'Persisted workflow checkpoint is invalid',
    }),
  );
}

describe('standalone persisted CP3 codec', () => {
  it('validates initial CP3 and retains the explicit persistence grammar', () => {
    expect(
      parseInitialWorkflowCheckpointV3(initial(), {
        engineVersion: 'engine-v3',
        workflowVersionId: version,
      }),
    ).toEqual(initial());
    expect(Object.isFrozen(parsePersistedWorkflowCheckpointV3(initial()))).toBe(
      true,
    );
    invalid({ ...initial(), schemaVersion: 2 });
    expect(() => parsePersistedWorkflowCheckpoint(initial())).toThrow();
  });
  it.each([
    'schemaVersion',
    'engineVersion',
    'workflowVersionId',
    'deadlineExpired',
    'calls',
    'branchSelections',
    'invocations',
    'loops',
    'joins',
    'readySet',
    'admittedInvocationKeys',
  ])('rejects omitted root %s', (field) => {
    const value: Record<string, unknown> = initial();
    Reflect.deleteProperty(value, field);
    invalid(value);
  });
  it.each([
    undefined,
    null,
    [],
    'secret',
    { ...initial(), extra: 'secret' },
    { ...initial(), schemaVersion: 1 },
    { ...initial(), schemaVersion: 4 },
  ])('rejects non-CP3 roots without leaked input %#', invalid);
  it.each([
    { revision: 1 },
    { runStatus: 'running' },
    { nextEventSequence: 1 },
    { cancelRequested: true },
    { deadlineExpired: true },
    { engineVersion: 'other' },
    { workflowVersionId: child },
  ])('rejects noninitial checkpoint %#', (patch) => {
    expect(() =>
      parseInitialWorkflowCheckpointV3(
        { ...initial(), ...patch },
        {
          engineVersion: 'engine-v3',
          workflowVersionId: version,
        },
      ),
    ).toThrow('Persisted workflow checkpoint is invalid');
  });
  it('retains physical declaration input and dedicated wait without fabricating a timer', () => {
    expect(parsePersistedWorkflowCheckpointV3(waiting())).toEqual(waiting());
    expect(
      parsePersistedWorkflowCheckpointV3({
        ...waiting(),
        calls: [
          {
            ...declaration(),
            status: 'admitted',
            childRunId: child,
            input: { kind: 'artifact', artifactId: artifact },
          },
        ],
      }).calls[0]?.input,
    ).toEqual({ kind: 'artifact', artifactId: artifact });
  });
  it('keeps admitted children waiting under parent stop until a child terminal fact exists', () => {
    const value = {
      ...waiting(),
      cancelRequested: true,
      deadlineExpired: true,
      calls: [{ ...declaration(), status: 'admitted', childRunId: child }],
    };
    expect(parsePersistedWorkflowCheckpointV3(value)).toEqual(value);
    invalid({
      ...value,
      invocations: [{ ...invocation(), status: 'canceled' }],
    });
    invalid({
      ...value,
      invocations: [{ ...invocation(), status: 'timed_out' }],
    });
    const { calls: _calls, ...ordinary } = waiting();
    expect(() =>
      parsePersistedWorkflowCheckpoint({ ...ordinary, schemaVersion: 2 }),
    ).toThrow();
  });
  it('serializes real child result references, never validation projection references', () => {
    const parsed = parsePersistedWorkflowCheckpointV3(successful());
    expect(parsed.invocations[0]?.output).toEqual(result());
    expect(parsed.calls[0]?.input).toEqual({
      kind: 'inline',
      attemptId: attempt,
    });
    expect(
      JSON.parse(serializePersistedWorkflowCheckpointV3(successful())),
    ).toEqual(successful());
    expect(
      parsePersistedWorkflowCheckpointV3(
        JSON.parse(serializePersistedWorkflowCheckpointV3(parsed)),
      ),
    ).toEqual(parsed);
  });
  it.each(['resumeAt', 'waitKind'])(
    'rejects ordinary wait metadata %s on a Call',
    (field) => {
      invalid({
        ...waiting(),
        invocations: [
          {
            ...invocation(),
            [field]:
              field === 'resumeAt' ? '2026-10-02T00:00:00.000Z' : 'node_wait',
          },
        ],
      });
    },
  );
  it.each([
    { attemptNumber: 0 },
    { attemptNumber: 2 },
    { status: 'running' },
    { nodeId: 'other' },
    { output: { kind: 'inline', attemptId: attempt } },
    { branchPath: [{ nodeId: 'condition', outputPort: 'yes' }] },
  ])('rejects inexact declaration invocation %#', (patch) => {
    invalid({ ...waiting(), invocations: [{ ...invocation(), ...patch }] });
  });
  it('requires admitted first attempt indexes and a matching scoped invocation', () => {
    invalid({ ...waiting(), admittedInvocationKeys: [] });
    invalid({ ...waiting(), invocations: [] });
    const scopedKey = `${version}|call|b:condition%3Ayes|i:loop%3A0`;
    const scoped = {
      ...waiting(),
      admittedInvocationKeys: [scopedKey],
      calls: [{ ...declaration(), invocationKey: scopedKey }],
      invocations: [
        {
          ...invocation(),
          invocationKey: scopedKey,
          branchPath: [{ nodeId: 'condition', outputPort: 'yes' }],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        },
      ],
    };
    expect(parsePersistedWorkflowCheckpointV3(scoped)).toEqual(scoped);
  });
  it.each([
    'input',
    'inputChecksum',
    'pin',
    'declarationAttemptId',
    'invocationKey',
    'nodeId',
    'status',
  ])('requires exact declaration field %s', (field) => {
    const call: Record<string, unknown> = declaration();
    Reflect.deleteProperty(call, field);
    invalid({ ...waiting(), calls: [call] });
  });
  it.each([
    { extra: true },
    { inputChecksum: 'A'.repeat(64) },
    { inputChecksum: 'a'.repeat(63) },
    { declarationAttemptId: 'bad' },
    { input: { kind: 'inline', attemptId: child } },
    { input: result() },
    { input: { kind: 'artifact', artifactId: artifact, extra: true } },
    { pin: { ...pin, extra: true } },
    { pin: { ...pin, checksum: `wf:v2:sha256:${'a'.repeat(64)}` } },
    { childRunId: child },
    { status: 'admitted' },
    { status: 'refused', reasonCode: 'arbitrary' },
    { status: 'aborted', reasonCode: 'arbitrary' },
    { status: 'settled', childRunId: child, childStatus: 'running' },
  ])('rejects invalid declaration grammar %#', (patch) => {
    invalid({ ...waiting(), calls: [{ ...declaration(), ...patch }] });
  });
  it('rejects duplicate declaration, attempt and child identities', () => {
    const admitted = {
      ...declaration(),
      status: 'admitted',
      childRunId: child,
    };
    invalid({ ...waiting(), calls: [declaration(), declaration()] });
    invalid({
      ...waiting(),
      calls: [declaration(), { ...declaration(), invocationKey: 'different' }],
    });
    invalid({
      ...waiting(),
      calls: [
        admitted,
        {
          ...admitted,
          invocationKey: 'different',
          declarationAttemptId: artifact,
          input: { kind: 'inline', attemptId: artifact },
        },
      ],
    });
  });
  it('accepts 64 distinct declarations and rejects 65', () => {
    const many = (count: number) => {
      const calls = Array.from({ length: count }, (_, index) => {
        const nodeId = `call${String(index)}`;
        const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
        return {
          ...declaration(),
          nodeId,
          invocationKey: `${version}|${nodeId}|b:|i:`,
          declarationAttemptId: id,
          input: { kind: 'inline', attemptId: id },
        };
      });
      return {
        ...waiting(),
        calls,
        admittedInvocationKeys: calls.map(({ invocationKey }) => invocationKey),
        invocations: calls.map(({ invocationKey, nodeId }) => ({
          ...invocation(),
          invocationKey,
          nodeId,
        })),
      };
    };
    expect(parsePersistedWorkflowCheckpointV3(many(64)).calls).toHaveLength(64);
    invalid(many(65));
  });
  it.each(['succeeded', 'failed', 'canceled', 'timed_out', 'outcome_unknown'])(
    'rejects terminal parent with an unsettled Call: %s',
    (runStatus) => {
      invalid({ ...waiting(), runStatus });
    },
  );
  it.each(['failed', 'canceled', 'timed_out'])(
    'maps unsuccessful child %s to a definite invocation failure',
    (childStatus) => {
      const value = {
        ...waiting(),
        runStatus: 'failed',
        calls: [
          {
            ...declaration(),
            status: 'settled',
            childRunId: child,
            childStatus,
          },
        ],
        invocations: [{ ...invocation(), status: 'failed' }],
      };
      expect(parsePersistedWorkflowCheckpointV3(value)).toEqual(value);
      invalid({
        ...value,
        invocations: [
          { ...invocation(), status: 'succeeded', output: result() },
        ],
      });
    },
  );
  it.each(['canceled', 'timed_out'])(
    'requires matching durable parent stop for %s',
    (status) => {
      const stop =
        status === 'canceled'
          ? { cancelRequested: true }
          : { deadlineExpired: true };
      const aborted = {
        ...waiting(),
        ...stop,
        runStatus: status,
        invocations: [{ ...invocation(), status }],
        calls: [
          {
            ...declaration(),
            status: 'aborted',
            reasonCode: `workflow.${status}`,
          },
        ],
      };
      expect(parsePersistedWorkflowCheckpointV3(aborted)).toEqual(aborted);
      invalid({ ...aborted, cancelRequested: false, deadlineExpired: false });
      const settled = {
        ...aborted,
        calls: [
          {
            ...declaration(),
            status: 'settled',
            childRunId: child,
            childStatus: 'succeeded',
          },
        ],
      };
      expect(parsePersistedWorkflowCheckpointV3(settled)).toEqual(settled);
      invalid({
        ...settled,
        invocations: [{ ...invocation(), status, output: result() }],
      });
    },
  );
  it('validates terminal refusal and rejects result references on refusal', () => {
    const refused = {
      ...waiting(),
      runStatus: 'failed',
      invocations: [{ ...invocation(), status: 'failed' }],
      calls: [
        {
          ...declaration(),
          status: 'refused',
          reasonCode: 'workflow.child_capacity_unavailable',
        },
      ],
    };
    expect(parsePersistedWorkflowCheckpointV3(refused)).toEqual(refused);
    invalid({
      ...refused,
      invocations: [{ ...invocation(), status: 'failed', output: result() }],
    });
  });
  it('preserves unknown precedence even when the parent is stopped', () => {
    const unknown = {
      ...waiting(),
      runStatus: 'outcome_unknown',
      cancelRequested: true,
      deadlineExpired: true,
      calls: [
        {
          ...declaration(),
          status: 'settled',
          childRunId: child,
          childStatus: 'outcome_unknown',
        },
      ],
      invocations: [{ ...invocation(), status: 'outcome_unknown' }],
    };
    expect(parsePersistedWorkflowCheckpointV3(unknown)).toEqual(unknown);
    for (const runStatus of ['succeeded', 'failed', 'canceled', 'timed_out'])
      invalid({ ...unknown, runStatus });
    invalid({
      ...unknown,
      invocations: [{ ...invocation(), status: 'canceled' }],
    });
  });
  it.each([
    undefined,
    { kind: 'inline', attemptId: attempt },
    { ...result(), childRunId: artifact },
    { ...result(), invocationKey: 'missing' },
    { ...result(), extra: true },
  ])('requires own successful child result %#', (output) => {
    invalid({
      ...successful(),
      invocations: [
        {
          ...invocation(),
          status: 'succeeded',
          ...(output === undefined ? {} : { output }),
        },
      ],
    });
  });
  it('allows downstream and join references only to a successful settled origin', () => {
    const mergeKey = `${version}|merge|b:|i:`;
    const value = {
      ...successful(),
      admittedInvocationKeys: [key, mergeKey],
      invocations: [
        ...successful().invocations,
        {
          ...invocation(),
          nodeId: 'merge',
          invocationKey: mergeKey,
          status: 'succeeded',
          output: result(),
        },
      ],
      joins: [
        {
          joinId: 'merge',
          joinInvocationKey: mergeKey,
          branchPath: [],
          iterationPath: [],
          policy: { kind: 'all' },
          selectedBranchIds: ['a'],
          ledger: [{ branchId: 'a', disposition: 'arrived', output: result() }],
        },
      ],
    };
    const parsed = parsePersistedWorkflowCheckpointV3(value);
    expect(parsed.invocations[1]?.output).toEqual(result());
    expect(parsed.joins[0]?.ledger[0]?.output).toEqual(result());
    invalid({
      ...value,
      calls: [{ ...declaration(), status: 'admitted', childRunId: child }],
    });
    invalid({
      ...value,
      joins: [{ ...value.joins[0], selectedBranchIds: ['absent'] }],
    });
    invalid({ ...value, joins: [{ ...value.joins[0], joinId: 'call' }] });
  });
  it('retains ordinary V2 scope/index/loop-budget checks and undated wait rejection', () => {
    invalid({
      ...initial(),
      invocations: [{ ...invocation(), nodeId: 'ordinary' }],
    });
    invalid({ ...initial(), readySet: ['missing'] });
    invalid({ ...initial(), initialIterationBudget: 999 });
    invalid({
      ...successful(),
      branchSelections: [
        { invocationKey: 'missing', nodeId: 'call', selectedOutputPort: 'yes' },
      ],
    });
    invalid({ ...initial(), loops: [{ extra: true }] });
  });
  it('rejects hostile JSON without executing getters, proxy traps or toJSON', () => {
    const getter = vi.fn(() => {
      throw new Error('secret');
    });
    const accessor = initial();
    Object.defineProperty(accessor, 'calls', { enumerable: true, get: getter });
    invalid(accessor);
    const trap = vi.fn(() => {
      throw new Error('secret');
    });
    invalid(new Proxy(initial(), { ownKeys: trap, get: trap }));
    invalid({
      ...initial(),
      calls: [
        {
          ...declaration(),
          get pin() {
            return getter();
          },
        },
      ],
    });
    invalid({ ...initial(), toJSON: getter });
    invalid(
      Object.assign(Object.create({ inherited: true }) as object, initial()),
    );
    const cyclic: Record<string, unknown> = initial();
    cyclic.self = cyclic;
    invalid(cyclic);
    const hidden = initial();
    Object.defineProperty(hidden, 'secret', { value: 'secret' });
    invalid(hidden);
    invalid({ ...initial(), [Symbol('secret')]: true });
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });
  it('retains independent whole-checkpoint 256KiB/depth64/member10000 bounds', () => {
    expect(STORED_EXECUTION_VALUE_LIMITS_V1).toEqual({
      inlineBytes: 262_144,
      depth: 64,
      members: 10_000,
    });
    invalid({ ...initial(), engineVersion: 'x'.repeat(262_145) });
    let deep: unknown = null;
    for (let index = 0; index < 65; index += 1) deep = [deep];
    invalid({ ...initial(), calls: deep });
    invalid({
      ...initial(),
      calls: Array.from({ length: 10_001 }, () => null),
    });
    invalid({ ...initial(), remainingIterationBudget: Infinity });
    invalid({ ...initial(), calls: Array(1) });
  });
  it('rejects an otherwise-valid ordinary checkpoint exceeding the total persisted byte bound', () => {
    const entries = Array.from({ length: 1_000 }, (_, index) => {
      const nodeId = `node${String(index).padStart(4, '0')}${'x'.repeat(120)}`;
      return {
        ...invocation(),
        invocationKey: `${version}|${nodeId}|b:|i:`,
        nodeId,
        status: 'running',
      };
    });
    const withCount = (count: number) => ({
      ...initial(),
      runStatus: 'running',
      invocations: entries.slice(0, count),
      admittedInvocationKeys: entries
        .slice(0, count)
        .map(({ invocationKey }) => invocationKey),
    });
    let count = 1;
    while (
      Buffer.byteLength(JSON.stringify(withCount(count + 1)), 'utf8') <=
      STORED_EXECUTION_VALUE_LIMITS_V1.inlineBytes
    )
      count += 1;
    expect(
      parsePersistedWorkflowCheckpointV3(withCount(count)).invocations,
    ).toHaveLength(count);
    invalid(withCount(count + 1));
  });
  it('requires actual success for reusable results, not merely a settled child', () => {
    const nextKey = `${version}|next|b:|i:`;
    invalid({
      ...successful(),
      cancelRequested: true,
      invocations: [
        { ...invocation(), status: 'canceled' },
        {
          ...invocation(),
          nodeId: 'next',
          invocationKey: nextKey,
          status: 'succeeded',
          output: result(),
        },
      ],
    });
  });
});
