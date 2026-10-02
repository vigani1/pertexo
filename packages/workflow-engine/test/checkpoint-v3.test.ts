import { describe, expect, it } from 'vitest';
import {
  createCheckpointV2,
  parseCheckpoint,
} from '../src/checkpoint/checkpoint.js';
import {
  createWorkflowCheckpointV3,
  parseWorkflowCallStateV1,
  parseWorkflowCheckpointV3,
} from '../src/checkpoint/checkpoint-v3.js';
import { invocationKey } from '../src/transition/scheduling.js';

const workflowVersionId = '00000000-0000-4000-8000-000000000001';
const declarationAttemptId = '00000000-0000-4000-8000-000000000002';
const childRunId = '00000000-0000-4000-8000-000000000003';
const key = invocationKey({ workflowVersionId, nodeId: 'call' });
const pin = {
  workflowId: workflowVersionId,
  versionId: workflowVersionId,
  checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
  callableContractIdentity: `callable:v1:sha256:${'b'.repeat(64)}`,
};
const baseCall = {
  invocationKey: key,
  nodeId: 'call',
  declarationAttemptId,
  pin,
  input: { kind: 'inline', attemptId: declarationAttemptId },
  inputChecksum: 'c'.repeat(64),
};
function checkpoint(
  call: Record<string, unknown> = { status: 'awaiting_admission' },
  node: Record<string, unknown> = {},
) {
  return {
    ...createWorkflowCheckpointV3({
      engineVersion: 'test',
      workflowVersionId,
      iterationBudget: 10,
    }),
    runStatus: 'running',
    admittedInvocationKeys: [key],
    invocations: [
      {
        invocationKey: key,
        nodeId: 'call',
        status: 'waiting',
        attemptNumber: 1,
        ...node,
      },
    ],
    calls: [{ ...baseCall, status: 'awaiting_admission', ...call }],
  };
}
function successful() {
  return checkpoint(
    { status: 'settled', childRunId, childStatus: 'succeeded' },
    {
      status: 'succeeded',
      output: { kind: 'workflow_call', invocationKey: key, childRunId },
    },
  );
}

describe('checkpoint V3 wire boundary', () => {
  it('creates explicit empty V3 without modifying V2 dispatch', () => {
    const input = {
      engineVersion: 'test',
      workflowVersionId,
      iterationBudget: 10,
    };
    const v3 = createWorkflowCheckpointV3(input);
    expect(parseWorkflowCheckpointV3(v3)).toEqual(v3);
    expect(createCheckpointV2(input).schemaVersion).toBe(2);
    expect(() => parseCheckpoint(v3)).toThrow(/Unsupported/);
    expect(() =>
      parseWorkflowCheckpointV3(createCheckpointV2(input)),
    ).toThrow();
  });
  it.each(['awaiting_admission', 'admitted'])(
    'retains dedicated %s waits, not projected running state',
    (status) => {
      const source = checkpoint({
        status,
        ...(status === 'admitted' ? { childRunId } : {}),
      });
      const parsed = parseWorkflowCheckpointV3(source);
      expect(parsed.invocations[0]?.status).toBe('waiting');
      expect(parsed.calls[0]?.status).toBe(status);
      expect(parsed).toEqual(source);
    },
  );
  it('retains child result references on call, downstream output and join ledger', () => {
    const source = successful();
    const joinKey = invocationKey({ workflowVersionId, nodeId: 'join' });
    const result = { kind: 'workflow_call', invocationKey: key, childRunId };
    const parsed = parseWorkflowCheckpointV3({
      ...source,
      invocations: [
        ...source.invocations,
        {
          invocationKey: joinKey,
          nodeId: 'join',
          status: 'succeeded',
          attemptNumber: 1,
          output: result,
        },
        {
          invocationKey: 'merge',
          nodeId: 'merge',
          status: 'succeeded',
          attemptNumber: 1,
          output: result,
        },
      ],
      joins: [
        {
          joinId: 'join',
          joinInvocationKey: joinKey,
          policy: { kind: 'all' },
          ledger: [
            { branchId: 'branch', disposition: 'arrived', output: result },
          ],
          selectedBranchIds: ['branch'],
        },
      ],
    });
    expect(
      parsed.invocations.every(
        (entry) => entry.output?.kind === 'workflow_call',
      ),
    ).toBe(true);
    expect(parsed.joins[0]?.ledger[0]?.output).toEqual(result);
    expect(parsed.invocations[0]?.output?.kind).not.toBe('inline');
  });
  it.each(['failed', 'canceled', 'timed_out'])(
    'accepts settled child %s with failed Call',
    (childStatus) => {
      expect(
        parseWorkflowCheckpointV3(
          checkpoint(
            { status: 'settled', childRunId, childStatus },
            { status: 'failed' },
          ),
        ).calls,
      ).toHaveLength(1);
    },
  );
  it('accepts refusal and stop-matched abort without a child', () => {
    expect(
      parseWorkflowCheckpointV3(
        checkpoint(
          {
            status: 'refused',
            reasonCode: 'workflow.child_capacity_unavailable',
          },
          { status: 'failed' },
        ),
      ).calls,
    ).toHaveLength(1);
    const canceled = checkpoint(
      { status: 'aborted', reasonCode: 'workflow.canceled' },
      { status: 'canceled' },
    );
    expect(
      parseWorkflowCheckpointV3({
        ...canceled,
        cancelRequested: true,
        runStatus: 'canceled',
      }).calls,
    ).toHaveLength(1);
    const timeout = checkpoint(
      { status: 'aborted', reasonCode: 'workflow.timed_out' },
      { status: 'timed_out' },
    );
    expect(
      parseWorkflowCheckpointV3({
        ...timeout,
        deadlineExpired: true,
        runStatus: 'timed_out',
      }).calls,
    ).toHaveLength(1);
  });
  it.each(['canceled', 'timed_out'])(
    'accepts succeeded child discarded by matching parent %s stop',
    (status) => {
      const source = checkpoint(
        { status: 'settled', childRunId, childStatus: 'succeeded' },
        { status },
      );
      expect(
        parseWorkflowCheckpointV3({
          ...source,
          cancelRequested: status === 'canceled',
          deadlineExpired: status === 'timed_out',
          runStatus: status,
        }).invocations[0]?.output,
      ).toBeUndefined();
    },
  );
  it.each(['succeeded', 'failed', 'canceled', 'timed_out'])(
    'never masks unknown child with terminal parent %s',
    (runStatus) => {
      const source = checkpoint(
        { status: 'settled', childRunId, childStatus: 'outcome_unknown' },
        { status: 'outcome_unknown' },
      );
      expect(() =>
        parseWorkflowCheckpointV3({
          ...source,
          runStatus,
          cancelRequested: true,
          deadlineExpired: true,
        }),
      ).toThrow(/mask unknown/);
      expect(
        parseWorkflowCheckpointV3({ ...source, runStatus: 'outcome_unknown' })
          .invocations[0]?.status,
      ).toBe('outcome_unknown');
    },
  );
  it.each(['succeeded', 'failed', 'canceled', 'timed_out', 'outcome_unknown'])(
    'rejects unsettled Call in terminal parent %s',
    (runStatus) => {
      expect(() =>
        parseWorkflowCheckpointV3({ ...checkpoint(), runStatus }),
      ).toThrow(/unsettled/);
    },
  );
  it.each([
    { attemptNumber: 2 },
    { attemptNumber: 0 },
    { status: 'running' },
    { status: 'ready' },
    { resumeAt: '2026-10-02T00:00:00.000Z', waitKind: 'node_wait' },
    { output: { kind: 'inline', attemptId: declarationAttemptId } },
  ])('rejects invalid dedicated Call invocation %j', (node) => {
    expect(() =>
      parseWorkflowCheckpointV3(checkpoint(undefined, node)),
    ).toThrow();
  });
  it('requires admission, exact node identity, exact scoped key and no ready membership', () => {
    expect(() =>
      parseWorkflowCheckpointV3({
        ...checkpoint(),
        admittedInvocationKeys: [],
      }),
    ).toThrow(/admitted/);
    expect(() =>
      parseWorkflowCheckpointV3(checkpoint(undefined, { nodeId: 'different' })),
    ).toThrow();
    const source = checkpoint(
      { invocationKey: 'legacy' },
      { invocationKey: 'legacy' },
    );
    expect(() =>
      parseWorkflowCheckpointV3({
        ...source,
        admittedInvocationKeys: ['legacy'],
      }),
    ).toThrow(/scope/);
    expect(() =>
      parseWorkflowCheckpointV3({ ...checkpoint(), readySet: [key] }),
    ).toThrow();
  });
  it('retains canonical branch and iteration scope and validates ordinary budget', () => {
    const branchPath = [{ nodeId: 'if', outputPort: 'true' }];
    const scopedKey = invocationKey({
      workflowVersionId,
      nodeId: 'call',
      branchPath: ['if:true'],
    });
    const source = checkpoint(
      { invocationKey: scopedKey },
      { invocationKey: scopedKey, branchPath },
    );
    expect(
      parseWorkflowCheckpointV3({
        ...source,
        admittedInvocationKeys: [scopedKey],
      }).invocations[0]?.branchPath,
    ).toEqual(branchPath);
    expect(() =>
      parseWorkflowCheckpointV3({
        ...checkpoint(),
        remainingIterationBudget: 11,
      }),
    ).toThrow(/budget/);
  });
  it('retains iteration-scoped Call waits alongside ordinary loop control and budget checks', () => {
    const iterationPath = [{ loopNodeId: 'loop', ordinal: 0 }];
    const scopedKey = invocationKey({
      workflowVersionId,
      nodeId: 'call',
      iterationPath,
    });
    const loopKey = invocationKey({ workflowVersionId, nodeId: 'loop' });
    const source = checkpoint(
      { invocationKey: scopedKey },
      { invocationKey: scopedKey, iterationPath },
    );
    const loop = {
      loopId: 'loop',
      controlInvocationKey: loopKey,
      collection: { kind: 'inline', attemptId: declarationAttemptId },
      collectionChecksum: 'collection',
      collectionSize: 1,
      maxConcurrency: 1,
      maxIterations: 2,
      nextOrdinal: 1,
      activeOrdinals: [0],
      terminalOrdinals: [],
      bodyRootNodeIds: ['call'],
      bodySinkNodeId: 'sink',
    };
    const scoped = {
      ...source,
      admittedInvocationKeys: [scopedKey],
      invocations: [
        ...source.invocations,
        {
          invocationKey: loopKey,
          nodeId: 'loop',
          status: 'waiting',
          attemptNumber: 1,
        },
      ],
      loops: [loop],
      remainingIterationBudget: 9,
    };
    expect(
      parseWorkflowCheckpointV3(scoped).invocations.find(
        (entry) => entry.nodeId === 'call',
      )?.iterationPath,
    ).toEqual(iterationPath);
    expect(() =>
      parseWorkflowCheckpointV3({ ...scoped, remainingIterationBudget: 10 }),
    ).toThrow(/budget/);
    expect(() =>
      parseWorkflowCheckpointV3({
        ...scoped,
        loops: [{ ...loop, activeOrdinals: [0, 0] }],
      }),
    ).toThrow();
    expect(() =>
      parseWorkflowCheckpointV3({
        ...scoped,
        loops: [
          {
            ...loop,
            collection: {
              kind: 'workflow_call',
              invocationKey: scopedKey,
              childRunId,
            },
          },
        ],
      }),
    ).toThrow();
    const overlap = {
      ...scoped,
      calls: [
        {
          ...baseCall,
          nodeId: 'loop',
          invocationKey: loopKey,
          status: 'awaiting_admission',
        },
      ],
      admittedInvocationKeys: [loopKey],
    };
    expect(() => parseWorkflowCheckpointV3(overlap)).toThrow();
  });
  it('does not exempt ordinary waiting nodes or malformed ledgers from V2 validation', () => {
    const source = successful();
    expect(() =>
      parseWorkflowCheckpointV3({
        ...source,
        invocations: [
          ...source.invocations,
          {
            invocationKey: 'ordinary',
            nodeId: 'ordinary',
            status: 'waiting',
            attemptNumber: 1,
          },
        ],
      }),
    ).toThrow(/ordinary waiting/);
    const joinKey = invocationKey({ workflowVersionId, nodeId: 'join' });
    const joined = {
      ...source,
      invocations: [
        ...source.invocations,
        {
          invocationKey: joinKey,
          nodeId: 'join',
          status: 'succeeded',
          attemptNumber: 1,
        },
      ],
      joins: [
        {
          joinId: 'join',
          joinInvocationKey: joinKey,
          policy: { kind: 'all' },
          ledger: [
            {
              branchId: 'b',
              disposition: 'arrived',
              output: {
                kind: 'workflow_call',
                invocationKey: 'missing',
                childRunId,
              },
            },
          ],
          selectedBranchIds: ['b'],
        },
      ],
    };
    expect(() => parseWorkflowCheckpointV3(joined)).toThrow(
      /successful settled/,
    );
    expect(() =>
      parseWorkflowCheckpointV3(
        checkpoint(
          { status: 'settled', childRunId, childStatus: 'succeeded' },
          {
            status: 'succeeded',
            output: {
              kind: 'workflow_call',
              invocationKey: key,
              childRunId,
              attemptId: declarationAttemptId,
            },
          },
        ),
      ),
    ).toThrow(/unknown fields/);
  });
  it('returns independent canonical references and rejects Call metadata accessors before reading', () => {
    const source = successful();
    const parsed = parseWorkflowCheckpointV3(source);
    expect(Object.getPrototypeOf(parsed.invocations[0]?.output)).toBe(
      Object.prototype,
    );
    expect(parsed.invocations[0]?.output).not.toBe(
      Object.getOwnPropertyDescriptor(source.invocations[0] ?? {}, 'output')
        ?.value,
    );
    let touched = false;
    const fact = { ...baseCall, status: 'awaiting_admission' };
    Object.defineProperty(fact, 'status', {
      enumerable: true,
      get() {
        touched = true;
        return 'awaiting_admission';
      },
    });
    expect(() => parseWorkflowCallStateV1(fact)).toThrow();
    expect(touched).toBe(false);
  });
  it('rejects duplicate calls, child identities, and Call/control overlap', () => {
    const source = checkpoint({ status: 'admitted', childRunId });
    expect(() =>
      parseWorkflowCheckpointV3({
        ...source,
        calls: [source.calls[0], source.calls[0]],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      parseWorkflowCheckpointV3({
        ...source,
        calls: [
          ...source.calls,
          {
            ...baseCall,
            invocationKey: 'other',
            declarationAttemptId: '00000000-0000-4000-8000-000000000004',
            input: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000004',
            },
            status: 'admitted',
            childRunId,
          },
        ],
      }),
    ).toThrow(/child run/);
    expect(() =>
      parseWorkflowCheckpointV3({
        ...source,
        calls: [
          ...source.calls,
          { ...baseCall, invocationKey: 'other', status: 'awaiting_admission' },
        ],
      }),
    ).toThrow(/duplicate call declaration attempt/);
    const success = successful();
    expect(() =>
      parseWorkflowCheckpointV3({
        ...success,
        joins: [
          {
            joinId: 'call',
            joinInvocationKey: key,
            policy: { kind: 'all' },
            ledger: [{ branchId: 'b', disposition: 'arrived' }],
            selectedBranchIds: ['b'],
          },
        ],
      }),
    ).toThrow(/join or loop/);
  });
  it('bounds declarations to the conservative family Call limit', () => {
    const source = checkpoint();
    const calls = Array.from({ length: 64 }, (_, index) => {
      const nodeId = `call${String(index)}`;
      const invocation = invocationKey({ workflowVersionId, nodeId });
      const attemptId = `00000000-0000-4000-8000-${(index + 10).toString(16).padStart(12, '0')}`;
      return {
        ...baseCall,
        nodeId,
        invocationKey: invocation,
        declarationAttemptId: attemptId,
        input: { kind: 'inline', attemptId },
        status: 'awaiting_admission',
      };
    });
    const bounded = {
      ...source,
      calls,
      admittedInvocationKeys: calls.map((call) => call.invocationKey),
      invocations: calls.map((call) => ({
        nodeId: call.nodeId,
        invocationKey: call.invocationKey,
        status: 'waiting',
        attemptNumber: 1,
      })),
    };
    expect(parseWorkflowCheckpointV3(bounded).calls).toHaveLength(64);
    expect(() =>
      parseWorkflowCheckpointV3({ ...bounded, calls: [...calls, calls[0]] }),
    ).toThrow(/maximum Call declarations/);
  });
  it.each([
    {
      status: 'refused',
      reasonCode: 'workflow.child_capacity_unavailable',
      childRunId,
    },
    { status: 'awaiting_admission', reasonCode: 'workflow.canceled' },
    { status: 'admitted' },
    { status: 'settled', childRunId, childStatus: 'ready' },
    { status: 'refused', reasonCode: 'other' },
    { status: 'aborted', reasonCode: 'other' },
    {
      declarationAttemptId: declarationAttemptId
        .toUpperCase()
        .replace('000002', '00000A'),
    },
    { input: { kind: 'inline', attemptId: childRunId } },
    { input: { kind: 'workflow_call', invocationKey: key, childRunId } },
    { inputChecksum: 'C'.repeat(64) },
    { pin: { ...pin, checksum: `wf:v2:sha256:${'a'.repeat(64)}` } },
    { pin: { ...pin, extra: true } },
    { extra: true },
  ])('rejects invalid strict Call fact %j', (patch) => {
    expect(() =>
      parseWorkflowCallStateV1({
        ...baseCall,
        status: 'awaiting_admission',
        ...patch,
      }),
    ).toThrow();
  });
  it('accepts independently bounded artifact input fact and snapshots pin', () => {
    const source = {
      ...baseCall,
      status: 'admitted',
      childRunId,
      input: { kind: 'artifact', artifactId: declarationAttemptId },
    };
    const parsed = parseWorkflowCallStateV1(source);
    expect(parsed).toEqual(source);
    expect(parsed.pin).not.toBe(source.pin);
  });
  it.each([
    { status: 'refused', reasonCode: 'workflow.child_capacity_unavailable' },
    { status: 'settled', childRunId, childStatus: 'failed' },
    { status: 'settled', childRunId, childStatus: 'outcome_unknown' },
  ])('rejects fabricated success output for %j', (call) => {
    expect(() =>
      parseWorkflowCheckpointV3(
        checkpoint(call, {
          status: 'succeeded',
          output: { kind: 'workflow_call', invocationKey: key, childRunId },
        }),
      ),
    ).toThrow();
  });
  it('rejects unbound, mismatched and declaration output masquerading as child result', () => {
    expect(() =>
      parseWorkflowCheckpointV3(
        checkpoint(
          { status: 'settled', childRunId, childStatus: 'succeeded' },
          {
            status: 'succeeded',
            output: { kind: 'inline', attemptId: declarationAttemptId },
          },
        ),
      ),
    ).toThrow(/own child result/);
    expect(() =>
      parseWorkflowCheckpointV3(
        checkpoint(
          { status: 'settled', childRunId, childStatus: 'succeeded' },
          {
            status: 'succeeded',
            output: {
              kind: 'workflow_call',
              invocationKey: 'missing',
              childRunId,
            },
          },
        ),
      ),
    ).toThrow(/successful settled/);
    expect(() =>
      parseWorkflowCheckpointV3(
        checkpoint(
          { status: 'settled', childRunId, childStatus: 'succeeded' },
          {
            status: 'succeeded',
            output: {
              kind: 'workflow_call',
              invocationKey: key,
              childRunId: declarationAttemptId,
            },
          },
        ),
      ),
    ).toThrow(/successful settled/);
  });
  it('rejects stop mismatches and output on stopped/unknown nodes', () => {
    expect(() =>
      parseWorkflowCheckpointV3(
        checkpoint(
          { status: 'aborted', reasonCode: 'workflow.canceled' },
          { status: 'canceled' },
        ),
      ),
    ).toThrow(/parent stop/);
    expect(() =>
      parseWorkflowCheckpointV3(
        checkpoint(
          { status: 'settled', childRunId, childStatus: 'succeeded' },
          { status: 'canceled' },
        ),
      ),
    ).toThrow(/stop-matched/);
    expect(() =>
      parseWorkflowCheckpointV3(
        checkpoint(
          { status: 'settled', childRunId, childStatus: 'outcome_unknown' },
          { status: 'failed' },
        ),
      ),
    ).toThrow(/remain outcome unknown/);
  });
  it('guards hostile input without invoking accessors or proxy traps', () => {
    let touched = false;
    const getter = { ...checkpoint() };
    Object.defineProperty(getter, 'calls', {
      enumerable: true,
      get() {
        touched = true;
        throw new Error('secret');
      },
    });
    expect(() => parseWorkflowCheckpointV3(getter)).toThrow();
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          touched = true;
          throw new Error('secret');
        },
      },
    );
    expect(() => parseWorkflowCheckpointV3(proxy)).toThrow();
    expect(touched).toBe(false);
    expect(() => parseWorkflowCallStateV1(proxy)).toThrow();
  });
  it('preserves bounded JSON limits and strict root fields', () => {
    const source = checkpoint();
    expect(() =>
      parseWorkflowCheckpointV3({ ...source, extra: true }),
    ).toThrow();
    expect(() =>
      parseWorkflowCheckpointV3({
        ...source,
        engineVersion: 'x'.repeat(262_144),
      }),
    ).toThrow(/maximum bytes/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseWorkflowCheckpointV3(cyclic)).toThrow();
    expect(() =>
      parseWorkflowCheckpointV3({ ...source, calls: Array(2) }),
    ).toThrow();
    expect(() =>
      parseWorkflowCheckpointV3({ ...source, cancelRequested: undefined }),
    ).toThrow();
  });
});
