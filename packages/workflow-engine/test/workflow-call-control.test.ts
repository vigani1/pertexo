import { createHash } from 'node:crypto';
import { createRegistryRelease, type NodeManifest } from '@pertexo/node-sdk';
import type { WorkflowCallableDeclarationV1 } from '@pertexo/workflow-model/callable-graph-contract';
import { canonicalJson } from '@pertexo/workflow-model/canonical-json';
import { workflowCallableContractIdentityV1 } from '@pertexo/workflow-model/workflow-call-closure';
import { workflowCallPinSchemaV1 } from '@pertexo/workflow-model/workflow-call-contract';
import { describe, expect, it, vi } from 'vitest';
import { createWorkflowCheckpointV3 } from '../src/checkpoint/checkpoint-v3.js';
import {
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityReleaseV3,
} from '../src/executable-workflow.js';
import { invocationKey } from '../src/transition/scheduling.js';
import {
  deriveWorkflowCallControlsV1,
  type WorkflowCallDeclarationMaterialV1,
} from '../src/workflow-call-control.js';
import type {
  WorkflowCallStateV1,
  WorkflowCheckpointV3,
} from '../src/workflow-call-state.js';
import {
  boundedPolicy,
  graph,
  nodeRelease,
} from './executable-workflow.fixtures.js';

const workflowVersionId = '00000000-0000-4000-8000-000000000001';
const declarationAttemptId = '00000000-0000-4000-8000-000000000002';
const childRunId = '00000000-0000-4000-8000-000000000003';
const otherId = '00000000-0000-4000-8000-000000000004';
const key = invocationKey({ workflowVersionId, nodeId: 'call' });
const callPolicy = { key: 'workflow.call', version: 1 } as const;
const objectType = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
} as const;
const declaration: WorkflowCallableDeclarationV1 = {
  schemaVersion: 1,
  input: objectType,
  result: objectType,
  resultSelector: { kind: 'run_input', path: '$' },
};
const pin = workflowCallPinSchemaV1.parse({
  workflowId: otherId,
  versionId: otherId,
  checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
  callableContractIdentity: workflowCallableContractIdentityV1(declaration),
});
// Local compatibility fixture: engine tests must not depend on nodes-core.
const callManifest: NodeManifest = {
  schemaVersion: 1,
  definition: { key: 'core.workflow_call', version: 1 },
  family: 'logic',
  configVersion: 1,
  configSchema: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', format: 'uuid' },
      versionId: { type: 'string', format: 'uuid' },
      checksum: { type: 'string', pattern: '^wf:v3:sha256:[0-9a-f]{64}$' },
      callableContractIdentity: {
        type: 'string',
        pattern: '^callable:v1:sha256:[0-9a-f]{64}$',
      },
    },
    required: [
      'workflowId',
      'versionId',
      'checksum',
      'callableContractIdentity',
    ],
    additionalProperties: false,
  },
  inputSchema: { type: 'object', additionalProperties: true },
  outputSchema: { type: 'object', additionalProperties: true },
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [],
  connectionRequirements: [],
  retryClass: 'unsafe',
  resourceClass: 'cpu',
  capabilities: [],
  lifecycle: 'active',
  executor: { key: 'core.workflow_call', version: 1 },
  executorAbi: 1,
  policyReferences: [boundedPolicy, callPolicy],
};
const baseRelease = nodeRelease();
const release = composeExecutableCompatibilityReleaseV3(
  createRegistryRelease({
    epoch: 1,
    definitions: [...baseRelease.definitions, callManifest],
    executors: [
      ...baseRelease.executors,
      {
        executor: callManifest.executor,
        abiVersion: 1,
        definitions: [callManifest.definition],
        lifecycle: 'active',
        policyReferences: callManifest.policyReferences,
      },
    ],
    policies: [...baseRelease.policies, callPolicy],
  }),
);
const executable = buildWorkflowExecutableV3({
  release,
  graph: {
    schemaVersion: 2,
    settings: {},
    nodes: [
      graph().nodes[0],
      {
        ...graph().nodes[1],
        id: 'call',
        definition: callManifest.definition,
        config: pin,
        inputMappings: { name: { kind: 'literal', value: 'input' } },
      },
    ],
    edges: [
      {
        id: 'manual-call',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'call', port: 'in' },
      },
    ],
  },
});

function checksum(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function material(
  patch: Partial<WorkflowCallDeclarationMaterialV1> = {},
): WorkflowCallDeclarationMaterialV1 {
  return {
    invocationKey: key,
    nodeId: 'call',
    declarationAttemptId,
    input: { kind: 'inline', attemptId: declarationAttemptId },
    value: { name: 'input' },
    ...patch,
  };
}

function call(patch: Record<string, unknown> = {}): WorkflowCallStateV1 {
  return {
    invocationKey: key,
    nodeId: 'call',
    declarationAttemptId,
    pin,
    input: { kind: 'inline', attemptId: declarationAttemptId },
    inputChecksum: checksum({ name: 'input' }),
    status: 'awaiting_admission',
    ...patch,
  };
}

function checkpoint(
  retained?: WorkflowCallStateV1,
  patch: Partial<WorkflowCheckpointV3> = {},
): WorkflowCheckpointV3 {
  const terminal =
    retained?.status === 'refused' || retained?.status === 'aborted';
  const settled = retained?.status === 'settled';
  const status =
    retained?.status === 'aborted'
      ? retained.reasonCode === 'workflow.canceled'
        ? 'canceled'
        : 'timed_out'
      : terminal
        ? 'failed'
        : settled
          ? retained.childStatus === 'succeeded'
            ? 'succeeded'
            : retained.childStatus === 'outcome_unknown'
              ? 'outcome_unknown'
              : 'failed'
          : retained === undefined
            ? 'running'
            : 'waiting';
  return {
    ...createWorkflowCheckpointV3({
      engineVersion: 'test',
      workflowVersionId,
      iterationBudget: 10,
    }),
    runStatus: 'running',
    cancelRequested: status === 'canceled',
    deadlineExpired: status === 'timed_out',
    admittedInvocationKeys: [key],
    invocations: [
      {
        invocationKey: key,
        nodeId: 'call',
        attemptNumber: 1,
        status,
        ...(settled && retained.childStatus === 'succeeded'
          ? {
              output: {
                kind: 'workflow_call' as const,
                invocationKey: key,
                childRunId: retained.childRunId,
              },
            }
          : {}),
      },
    ],
    calls: retained === undefined ? [] : [retained],
    ...patch,
  };
}

type DeriveInput = Parameters<typeof deriveWorkflowCallControlsV1>[0];
function derive(patch: Partial<DeriveInput> = {}) {
  return deriveWorkflowCallControlsV1({
    executable,
    checkpoint: checkpoint(),
    declarations: [material()],
    facts: [],
    calleeDeclarations: new Map([[pin.versionId, declaration]]),
    cancelRequested: false,
    deadlineExpired: false,
    ...patch,
  });
}

function reconcile(
  retained: WorkflowCallStateV1,
  fact: unknown = retained,
  patch: Partial<DeriveInput> = {},
) {
  return derive({
    checkpoint: checkpoint(retained),
    declarations: [],
    facts: [fact],
    ...patch,
  });
}

const observationInvalid: unknown = expect.objectContaining({
  code: 'observation_invalid',
});

describe('pure workflow Call control', () => {
  it('bounds physical declaration and journal projections before processing values', () => {
    expect(() =>
      derive({ declarations: Array.from({ length: 65 }, () => material()) }),
    ).toThrow(observationInvalid);
    expect(() =>
      derive({ facts: Array.from({ length: 65 }, () => call()) }),
    ).toThrow(observationInvalid);
  });
  it('requires an authenticated executable and selects workflow.call policy 1', () => {
    expect(
      executable.envelope.graph.nodes.find(({ id }) => id === 'call')
        ?.policyReferences,
    ).toContainEqual(callPolicy);
    expect(() => derive({ executable: { ...executable } })).toThrow(
      expect.objectContaining({ code: 'executable_invalid' }),
    );
  });

  it('creates one admission intent and dedicated wait from the running first attempt', () => {
    const decisions = derive();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toEqual({
      call: call(),
      invocation: {
        invocationKey: key,
        nodeId: 'call',
        status: 'waiting',
        attemptNumber: 1,
      },
      declarationIntent: true,
      admissionIntent: true,
    });
    expect(decisions[0]?.invocation).not.toHaveProperty('waitKind');
    expect(decisions[0]?.invocation).not.toHaveProperty('resumeAt');
    expect(decisions[0]?.invocation).not.toHaveProperty('output');
  });

  it('deduplicates identical fresh declarations into one logical intent', () => {
    expect(derive({ declarations: [material(), material()] })).toHaveLength(1);
    expect(
      derive({ declarations: [material(), material()] })[0]?.admissionIntent,
    ).toBe(true);
  });

  it('replays a committed declaration without admitting a second child', () => {
    const admitted = call({ status: 'admitted', childRunId });
    const decisions = derive({
      checkpoint: checkpoint(call()),
      declarations: [material()],
      facts: [admitted],
    });
    expect(decisions[0]).toMatchObject({
      call: admitted,
      invocation: { status: 'waiting', attemptNumber: 1 },
      declarationIntent: false,
      admissionIntent: false,
    });
  });

  it('retains the canonical input checksum separately from artifact storage identity', () => {
    const input = { kind: 'artifact' as const, artifactId: otherId };
    const [decision] = derive({ declarations: [material({ input })] });
    expect(decision?.call.input).toEqual(input);
    expect(decision?.call.inputChecksum).toBe(checksum({ name: 'input' }));
    expect(decision?.call.inputChecksum).not.toBe(checksum(input));
  });

  it.each([
    ['workflow ID', { pin: { ...pin, workflowId: workflowVersionId } }],
    ['version ID', { pin: { ...pin, versionId: workflowVersionId } }],
    [
      'checksum',
      { pin: { ...pin, checksum: `wf:v3:sha256:${'b'.repeat(64)}` } },
    ],
    [
      'contract identity',
      {
        pin: {
          ...pin,
          callableContractIdentity: `callable:v1:sha256:${'b'.repeat(64)}`,
        },
      },
    ],
  ])('rejects retained %s pin drift from the executable', (_label, patch) => {
    const retained = call(patch);
    expect(() =>
      reconcile(retained, call({ ...patch, status: 'admitted', childRunId })),
    ).toThrow(observationInvalid);
  });

  it.each([
    ['value checksum', { value: { name: 'changed' } }],
    [
      'storage kind',
      { input: { kind: 'artifact' as const, artifactId: otherId } },
    ],
    [
      'declaration attempt',
      {
        declarationAttemptId: otherId,
        input: { kind: 'inline' as const, attemptId: otherId },
      },
    ],
  ])('rejects replayed declaration %s drift', (_label, patch) => {
    expect(() =>
      derive({
        checkpoint: checkpoint(call()),
        declarations: [material(patch)],
        facts: [call({ status: 'admitted', childRunId })],
      }),
    ).toThrow(observationInvalid);
  });

  it.each([
    ['input checksum', { inputChecksum: 'b'.repeat(64) }],
    [
      'artifact reference',
      { input: { kind: 'artifact', artifactId: otherId } },
    ],
    ['node identity', { nodeId: 'other' }],
    [
      'declaration attempt',
      {
        declarationAttemptId: otherId,
        input: { kind: 'inline', attemptId: otherId },
      },
    ],
    ['pin', { pin: { ...pin, workflowId: workflowVersionId } }],
  ])('rejects durable admission %s identity drift', (_label, patch) => {
    expect(() =>
      reconcile(call(), call({ status: 'admitted', childRunId, ...patch })),
    ).toThrow(observationInvalid);
  });

  it('rejects changed artifact identity on replay even when the input value is unchanged', () => {
    const retained = call({ input: { kind: 'artifact', artifactId: otherId } });
    expect(() =>
      derive({
        checkpoint: checkpoint(retained),
        declarations: [
          material({ input: { kind: 'artifact', artifactId: childRunId } }),
        ],
        facts: [call({ ...retained, status: 'admitted', childRunId })],
      }),
    ).toThrow(observationInvalid);
  });

  it('requires a definite durable admission fact for committed waits', () => {
    for (const retained of [call(), call({ status: 'admitted', childRunId })])
      expect(() => reconcile(retained, undefined, { facts: [] })).toThrow(
        observationInvalid,
      );
    expect(() => reconcile(call())).toThrow(observationInvalid);
  });

  it('rejects duplicate, orphan, and uncommitted fresh declaration facts', () => {
    const admitted = call({ status: 'admitted', childRunId });
    expect(() =>
      reconcile(call(), admitted, { facts: [admitted, admitted] }),
    ).toThrow(observationInvalid);
    expect(() => derive({ declarations: [], facts: [admitted] })).toThrow(
      observationInvalid,
    );
    expect(() => derive({ facts: [admitted] })).toThrow(observationInvalid);
  });

  it.each(['ready', 'waiting', 'failed', 'succeeded'] as const)(
    'rejects a fresh declaration from a %s invocation',
    (status) => {
      const source = checkpoint();
      expect(() =>
        derive({
          checkpoint: {
            ...source,
            invocations: [
              {
                ...source.invocations[0],
                status,
                ...(status === 'succeeded'
                  ? {
                      output: {
                        kind: 'inline',
                        attemptId: declarationAttemptId,
                      },
                    }
                  : {}),
                ...(status === 'waiting'
                  ? {
                      resumeAt: '2026-10-02T00:00:00.000Z',
                      waitKind: 'node_wait',
                    }
                  : {}),
              },
            ],
            ...(status === 'ready' ? { readySet: [key] } : {}),
          },
        }),
      ).toThrow();
    },
  );

  it('never turns a retrying physical attempt into a new logical child call', () => {
    const source = checkpoint();
    expect(() =>
      derive({
        checkpoint: {
          ...source,
          invocations: [{ ...source.invocations[0], attemptNumber: 2 }],
        },
      }),
    ).toThrow(observationInvalid);
    expect(() =>
      reconcile(call({ status: 'admitted', childRunId }), undefined, {
        checkpoint: {
          ...checkpoint(call({ status: 'admitted', childRunId })),
          invocations: [
            {
              invocationKey: key,
              nodeId: 'call',
              status: 'waiting',
              attemptNumber: 2,
            },
          ],
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it('applies a definite refusal without a child or retry intent', () => {
    const refused = call({
      status: 'refused',
      reasonCode: 'workflow.child_capacity_unavailable',
    });
    expect(reconcile(call(), refused)[0]).toMatchObject({
      call: refused,
      invocation: { status: 'failed', attemptNumber: 1 },
      admissionIntent: false,
      reasonCode: 'workflow.child_capacity_unavailable',
    });
    expect(reconcile(call(), refused)[0]).not.toHaveProperty('cancelChild');
  });

  it.each([
    ['canceled', 'workflow.canceled', true, false],
    ['timed_out', 'workflow.timed_out', false, true],
  ] as const)(
    'applies a definite %s abort without child admission',
    (status, reasonCode, cancelRequested, deadlineExpired) => {
      const aborted = call({ status: 'aborted', reasonCode });
      expect(
        reconcile(call(), aborted, { cancelRequested, deadlineExpired })[0],
      ).toMatchObject({
        call: aborted,
        invocation: { status },
        declarationIntent: false,
        admissionIntent: false,
        reasonCode,
      });
    },
  );

  it.each([
    ['canceled', true, false],
    ['timed_out', false, true],
    ['canceled', true, true],
  ] as const)(
    'does not request a fresh child under parent %s stop',
    (status, cancelRequested, deadlineExpired) => {
      expect(derive({ cancelRequested, deadlineExpired })[0]).toMatchObject({
        call: { status: 'aborted', reasonCode: `workflow.${status}` },
        invocation: { status },
        declarationIntent: true,
        admissionIntent: false,
      });
    },
  );

  it.each([
    ['cancelRequested', 'cancel_requested'],
    ['deadlineExpired', 'deadline_expired'],
  ] as const)(
    'keeps an admitted child waiting with monotonic %s cancellation intent',
    (flag, reason) => {
      const admitted = call({ status: 'admitted', childRunId });
      const source = checkpoint(admitted, { [flag]: true });
      const [decision] = reconcile(admitted, admitted, {
        checkpoint: source,
        cancelRequested: false,
        deadlineExpired: false,
      });
      expect(decision).toMatchObject({
        call: admitted,
        invocation: { status: 'waiting' },
        admissionIntent: false,
        cancelChild: { childRunId, reason },
      });
      expect(decision?.invocation).not.toHaveProperty('output');
    },
  );

  it('prioritizes cancellation when both parent stops are present', () => {
    const admitted = call({ status: 'admitted', childRunId });
    expect(
      reconcile(admitted, admitted, {
        cancelRequested: true,
        deadlineExpired: true,
      })[0]?.cancelChild,
    ).toEqual({ childRunId, reason: 'cancel_requested' });
  });

  it.each([
    ['cancelRequested', 'cancel_requested'],
    ['deadlineExpired', 'deadline_expired'],
  ] as const)(
    'waits for an admitted child discovered after the checkpoint parent %s stop',
    (flag, reason) => {
      const admitted = call({ status: 'admitted', childRunId });
      const [decision] = reconcile(call(), admitted, {
        checkpoint: checkpoint(call(), { [flag]: true }),
      });
      expect(decision).toMatchObject({
        call: admitted,
        invocation: { status: 'waiting' },
        declarationIntent: false,
        admissionIntent: false,
        cancelChild: { childRunId, reason },
      });
    },
  );

  it.each([
    ['cancelRequested', 'canceled'],
    ['deadlineExpired', 'timed_out'],
  ] as const)(
    'matches a newly refused call to parent %s without losing refusal provenance',
    (flag, status) => {
      const refused = call({
        status: 'refused',
        reasonCode: 'workflow.child_capacity_unavailable',
      });
      const [decision] = reconcile(call(), refused, { [flag]: true });
      expect(decision).toMatchObject({
        call: refused,
        invocation: { status },
        reasonCode: 'workflow.child_capacity_unavailable',
        declarationIntent: false,
        admissionIntent: false,
      });
      expect(decision).not.toHaveProperty('cancelChild');
    },
  );

  it('distinguishes child timeout failure from the parent deadline stop', () => {
    const admitted = call({ status: 'admitted', childRunId });
    const timedOut = call({
      status: 'settled',
      childRunId,
      childStatus: 'timed_out',
    });
    expect(reconcile(admitted, timedOut)[0]).toMatchObject({
      invocation: { status: 'failed' },
      reasonCode: 'workflow.child_timed_out',
    });
    expect(
      reconcile(admitted, timedOut, { deadlineExpired: true })[0],
    ).toMatchObject({
      invocation: { status: 'timed_out' },
      reasonCode: 'workflow.child_timed_out',
    });
  });

  it('exposes only the explicit child result reference after child success', () => {
    const admitted = call({ status: 'admitted', childRunId });
    const settled = call({
      status: 'settled',
      childRunId,
      childStatus: 'succeeded',
    });
    const [decision] = reconcile(admitted, settled);
    expect(decision).toMatchObject({
      call: settled,
      invocation: {
        status: 'succeeded',
        output: { kind: 'workflow_call', invocationKey: key, childRunId },
      },
      admissionIntent: false,
    });
    expect(decision?.invocation.output).not.toEqual(settled.input);
    expect(decision).not.toHaveProperty('cancelChild');
    expect(decision).not.toHaveProperty('reasonCode');
  });

  it.each(['failed', 'canceled', 'timed_out'] as const)(
    'turns child %s into definite Call failure without retry',
    (childStatus) => {
      const admitted = call({ status: 'admitted', childRunId });
      const [decision] = reconcile(
        admitted,
        call({ status: 'settled', childRunId, childStatus }),
      );
      expect(decision).toMatchObject({
        invocation: { status: 'failed', attemptNumber: 1 },
        admissionIntent: false,
        reasonCode: `workflow.child_${childStatus}`,
      });
      expect(decision?.invocation).not.toHaveProperty('output');
    },
  );

  it.each([
    ['canceled', true, false],
    ['timed_out', false, true],
  ] as const)(
    'discards a newly completed child result under parent %s',
    (status, cancelRequested, deadlineExpired) => {
      const [decision] = reconcile(
        call({ status: 'admitted', childRunId }),
        call({ status: 'settled', childRunId, childStatus: 'succeeded' }),
        { cancelRequested, deadlineExpired },
      );
      expect(decision?.invocation.status).toBe(status);
      expect(decision?.invocation).not.toHaveProperty('output');
      expect(decision).not.toHaveProperty('cancelChild');
    },
  );

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'preserves child outcome_unknown over parent stops %j/%j',
    (cancelRequested, deadlineExpired) => {
      const [decision] = reconcile(
        call({ status: 'admitted', childRunId }),
        call({ status: 'settled', childRunId, childStatus: 'outcome_unknown' }),
        { cancelRequested, deadlineExpired },
      );
      expect(decision).toMatchObject({
        invocation: { status: 'outcome_unknown' },
        reasonCode: 'workflow.child_outcome_unknown',
        admissionIntent: false,
      });
      expect(decision?.invocation).not.toHaveProperty('output');
    },
  );

  it('rejects changing an admitted child identity or replacing it with refusal/abort', () => {
    const admitted = call({ status: 'admitted', childRunId });
    for (const fact of [
      call({ status: 'admitted', childRunId: otherId }),
      call({
        status: 'settled',
        childRunId: otherId,
        childStatus: 'succeeded',
      }),
      call({
        status: 'refused',
        reasonCode: 'workflow.child_queue_unavailable',
      }),
      call({ status: 'aborted', reasonCode: 'workflow.canceled' }),
    ])
      expect(() =>
        reconcile(admitted, fact, { cancelRequested: true }),
      ).toThrow(observationInvalid);
  });

  it.each([
    [
      { status: 'refused', reasonCode: 'workflow.child_capacity_unavailable' },
      { status: 'refused', reasonCode: 'workflow.child_queue_unavailable' },
    ],
    [
      { status: 'refused', reasonCode: 'workflow.child_capacity_unavailable' },
      { status: 'admitted', childRunId },
    ],
    [
      { status: 'aborted', reasonCode: 'workflow.canceled' },
      { status: 'aborted', reasonCode: 'workflow.timed_out' },
    ],
    [
      { status: 'settled', childRunId, childStatus: 'succeeded' },
      { status: 'settled', childRunId, childStatus: 'failed' },
    ],
    [
      { status: 'settled', childRunId, childStatus: 'failed' },
      { status: 'settled', childRunId, childStatus: 'succeeded' },
    ],
    [
      { status: 'settled', childRunId, childStatus: 'outcome_unknown' },
      { status: 'settled', childRunId, childStatus: 'failed' },
    ],
    [
      { status: 'settled', childRunId, childStatus: 'succeeded' },
      { status: 'settled', childRunId: otherId, childStatus: 'succeeded' },
    ],
  ])('rejects rewriting immutable terminal outcome %#', (before, after) => {
    expect(() => reconcile(call(before), call(after))).toThrow(
      observationInvalid,
    );
  });

  it('replays settled success unchanged even when a later parent stop arrives', () => {
    const settled = call({
      status: 'settled',
      childRunId,
      childStatus: 'succeeded',
    });
    expect(
      reconcile(settled, settled, {
        cancelRequested: true,
        deadlineExpired: true,
      })[0]?.invocation,
    ).toEqual(checkpoint(settled).invocations[0]);
    expect(
      reconcile(settled, undefined, { facts: [] })[0]?.admissionIntent,
    ).toBe(false);
  });

  it.each([
    { status: 'refused', reasonCode: 'workflow.child_capacity_unavailable' },
    { status: 'aborted', reasonCode: 'workflow.canceled' },
    { status: 'settled', childRunId, childStatus: 'failed' },
    { status: 'settled', childRunId, childStatus: 'outcome_unknown' },
  ])(
    'retains terminal state without requesting fresh declaration, child, or facts %#',
    (terminal) => {
      const retained = call(terminal);
      const [decision] = reconcile(retained, undefined, {
        facts: [],
        cancelRequested: true,
        deadlineExpired: true,
      });
      expect(decision?.call).toEqual(retained);
      expect(decision?.invocation).toEqual(checkpoint(retained).invocations[0]);
      expect(decision?.declarationIntent).toBe(false);
      expect(decision?.admissionIntent).toBe(false);
      expect(decision).not.toHaveProperty('cancelChild');
    },
  );

  it.each([
    { nodeId: 'manual' },
    { invocationKey: 'missing' },
    { declarationAttemptId: otherId },
  ])('rejects mismatched physical declaration ownership %#', (patch) => {
    expect(() => derive({ declarations: [material(patch)] })).toThrow();
  });

  it('rejects a missing or identity-mismatched retained callee declaration', () => {
    expect(() => derive({ calleeDeclarations: new Map() })).toThrow(
      observationInvalid,
    );
    const changed: WorkflowCallableDeclarationV1 = {
      ...declaration,
      resultSelector: { kind: 'literal', value: { name: 'changed' } },
    };
    expect(() =>
      derive({ calleeDeclarations: new Map([[pin.versionId, changed]]) }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it.each([
    {},
    { name: 1 },
    { name: 'input', extra: true },
    { name: Number.POSITIVE_INFINITY },
  ])('rejects invalid typed input without value leakage %#', (value) => {
    expect(() => derive({ declarations: [material({ value })] })).toThrow(
      observationInvalid,
    );
    expect(() => derive({ declarations: [material({ value })] })).toThrow(
      'succeeded call declaration contains invalid input',
    );
  });

  it('admits exactly 1MiB typed input independently of checkpoint storage bytes', () => {
    const value = { name: 'x'.repeat(1_048_576 - 11) };
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(1_048_576);
    expect(
      derive({
        declarations: [
          material({ value, input: { kind: 'artifact', artifactId: otherId } }),
        ],
      })[0]?.call.inputChecksum,
    ).toBe(checksum(value));
    expect(() =>
      derive({
        declarations: [material({ value: { name: `${value.name}x` } })],
      }),
    ).toThrow(observationInvalid);
  });

  it('rejects hostile input values without executing value getters', () => {
    const accessor = vi.fn(() => {
      throw new Error('private input');
    });
    const value = Object.defineProperty({}, 'name', {
      enumerable: true,
      get: accessor,
    });
    const trap = vi.fn(() => {
      throw new Error('private input');
    });
    const proxy = new Proxy({}, { ownKeys: trap });
    for (const hostile of [value, proxy])
      expect(() =>
        derive({ declarations: [material({ value: hostile })] }),
      ).toThrow(observationInvalid);
    expect(accessor).not.toHaveBeenCalled();
  });
});
