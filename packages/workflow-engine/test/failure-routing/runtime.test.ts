import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  invocationKey,
  type WorkflowTransitionPlan,
} from '../../src/index.js';
import { graph, nodeCatalog } from '../support/executable-workflow.js';
const version = '00000000-0000-4000-8000-000000000001';
const at = '2026-10-14T00:00:00.000Z';
const id = '00000000-0000-4000-8000-000000000002';
const key = (nodeId: string) =>
  invocationKey({ workflowVersionId: version, nodeId });
function fixture() {
  const base = graph();
  const routed: WorkflowGraph = {
    ...base,
    nodes: [
      ...base.nodes,
      {
        ...base.nodes[1],
        id: 'handler',
        inputMappings: {
          reason: {
            kind: 'node_failure',
            nodeId: 'set',
            path: '$.safeErrorCode',
          },
        },
      },
      { ...base.nodes[2], id: 'handler-stop', inputMappings: {} },
    ],
    edges: [
      ...base.edges,
      {
        id: 'failure',
        source: { nodeId: 'set', port: '__failure' },
        target: { nodeId: 'handler', port: 'in' },
      },
      {
        id: 'handler-end',
        source: { nodeId: 'handler', port: 'out' },
        target: { nodeId: 'handler-stop', port: 'in' },
      },
    ],
  };
  const executable = buildWorkflowExecutable({
    graph: routed,
    catalog: composeExecutableCatalog(nodeCatalog()),
  });
  let checkpoint = createCheckpoint({
    workflowVersionId: version,
    iterationBudget: 100,
  });
  async function step(
    observations: unknown = [],
    occurredAt = at,
  ): Promise<WorkflowTransitionPlan> {
    const plan = await advanceWorkflow({
      runId: id,
      executable,
      workflowVersionId: version,
      checkpoint,
      observations,
      occurredAt,
      maximumAdmissions: 5,
      signal: new AbortController().signal,
    });
    checkpoint = plan.checkpoint;
    return plan;
  }
  async function success(nodeId: string) {
    return step([
      {
        sequence: checkpoint.nextEventSequence,
        occurredAt: at,
        kind: 'outcome',
        invocationKey: key(nodeId),
        status: 'succeeded',
        output: { kind: 'inline', attemptId: id },
        attemptId: id,
        attemptNumber: 1,
      },
    ]);
  }
  async function fail(
    nodeId = 'set',
    failureKind = 'failed',
    errorKind = 'authentication',
    attemptNumber = 1,
    safeErrorCode = `execution.${errorKind}`,
  ) {
    return step([
      {
        occurredAt: at,
        kind: 'attempt_failure',
        invocationKey: key(nodeId),
        attemptId: id,
        attemptNumber,
        failureKind,
        errorKind,
        possiblyDispatched: false,
        safeErrorCode,
      },
    ]);
  }
  return { executable, step, success, fail, checkpoint: () => checkpoint };
}
describe('failure routing through public engine transitions', () => {
  it.each(['utility.xml_malformed', 'file.create_data'])(
    'routes the definite data failure %s to the authored handler',
    async (code) => {
      const f = fixture();
      await f.step();
      await f.success('manual');
      const routed = await f.fail('set', 'failed', 'configuration', 1, code);
      expect(routed.attempts.map((attempt) => attempt.nodeId)).toEqual([
        'handler',
      ]);
      expect(routed.failureValues).toMatchObject([
        { value: { errorKind: 'configuration', safeErrorCode: code } },
      ]);
      expect(routed.checkpoint.runStatus).toBe('running');
      await f.success('handler');
      expect((await f.success('handler-stop')).checkpoint.runStatus).toBe(
        'succeeded',
      );
    },
  );
  it.each([
    'utility.xml_size',
    'utility.xml_depth',
    'utility.html_size',
    'utility.html_depth',
    'utility.result_too_large',
    'utility.too_many_items',
    'utility.hmac_unavailable',
    'file.create_size',
    'file.create_storage',
  ])('leaves platform and storage refusal %s unhandled', async (code) => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    const failed = await f.fail('set', 'failed', 'configuration', 1, code);
    expect(failed.attempts).toEqual([]);
    expect(failed.checkpoint.runStatus).toBe('failed');
    expect(failed.failureValues ?? []).toEqual([]);
  });

  it('keeps the source failed, skips normal continuation, selects one handler and only succeeds at its sink', async () => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    const routed = await f.fail();
    expect(routed.attempts.map((a) => a.nodeId)).toEqual(['handler']);
    expect(routed.failureValues).toEqual([
      {
        entryInvocationKey: key('handler'),
        value: {
          nodeId: 'set',
          invocationKey: key('set'),
          attemptNumber: 1,
          errorKind: 'authentication',
          safeErrorCode: 'execution.authentication',
        },
      },
    ]);
    expect(
      routed.checkpoint.invocations.find((n) => n.nodeId === 'set'),
    ).toMatchObject({
      status: 'failed',
      failureHandling: {
        disposition: 'pending',
        sinkInvocationKey: key('handler-stop'),
      },
    });
    expect(
      routed.checkpoint.invocations.find((n) => n.nodeId === 'terminate')
        ?.status,
    ).toBe('skipped');
    expect(routed.checkpoint.runStatus).toBe('running');
    const duplicate = await f.step();
    expect(duplicate.failureValues).toBeUndefined();
    expect(duplicate.attempts).toEqual([]);
    await f.success('handler');
    const finished = await f.success('handler-stop');
    expect(finished.checkpoint.runStatus).toBe('succeeded');
    expect(
      finished.events.filter((e) => e.name === 'node.failure_handled'),
    ).toHaveLength(1);
    expect(
      finished.checkpoint.invocations.find((n) => n.nodeId === 'set')
        ?.failureHandling?.disposition,
    ).toBe('handled');
  });
  it('normal success never admits the handler', async () => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    const normal = await f.success('set');
    expect(normal.attempts.map((a) => a.nodeId)).toEqual(['terminate']);
    expect(
      normal.checkpoint.invocations
        .filter((n) => n.nodeId.startsWith('handler'))
        .map((n) => n.status),
    ).toEqual(['skipped', 'skipped']);
    expect((await f.success('terminate')).checkpoint.runStatus).toBe(
      'succeeded',
    );
  });
  it('a failed handler remains an unhandled failed run', async () => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    await f.fail();
    const failed = await f.fail('handler');
    expect(failed.checkpoint.runStatus).toBe('failed');
    expect(failed.failureValues).toBeUndefined();
    expect(
      failed.checkpoint.invocations.find((n) => n.nodeId === 'set')
        ?.failureHandling?.disposition,
    ).toBe('pending');
  });
  it.each(['outcome_unknown', 'canceled'])(
    'does not route %s outcomes',
    async (kind) => {
      const f = fixture();
      await f.step();
      await f.success('manual');
      const stopped = await f.fail('set', kind);
      expect(stopped.failureValues).toBeUndefined();
      expect(stopped.attempts).toEqual([]);
      expect(stopped.checkpoint.runStatus).toBe(kind);
    },
  );
  it.each([
    ['configuration', 'execution.attempt_invalid'],
    ['configuration', 'execution.table_key_conflict'],
    ['internal', 'code.runtime_error'],
  ])(
    'routes the step’s own %s failure %s to its handler',
    async (errorKind, safeErrorCode) => {
      const f = fixture();
      await f.step();
      await f.success('manual');
      const routed = await f.fail('set', 'failed', errorKind, 1, safeErrorCode);
      expect(routed.attempts.map((a) => a.nodeId)).toEqual(['handler']);
      expect(routed.failureValues?.[0]?.value).toMatchObject({
        errorKind,
        safeErrorCode,
      });
    },
  );
  it('does not route unapproved platform/internal classification', async () => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    const failed = await f.fail('set', 'failed', 'internal');
    expect(failed.failureValues).toBeUndefined();
    expect(failed.checkpoint.runStatus).toBe('failed');
  });
  it.each(['cancel', 'deadline'])(
    'does not select a handler after %s control',
    async (control) => {
      const f = fixture();
      await f.step();
      await f.success('manual');
      const cp = f.checkpoint();
      const failed = {
        kind: 'attempt_failure',
        occurredAt: at,
        invocationKey: key('set'),
        attemptId: id,
        attemptNumber: 1,
        failureKind: 'failed',
        errorKind: 'authentication',
        possiblyDispatched: false,
        safeErrorCode: 'execution.authentication',
      };
      const stop =
        control === 'cancel'
          ? {
              kind: 'cancel_requested',
              sequence: cp.nextEventSequence,
              occurredAt: at,
            }
          : { kind: 'deadline_expired', occurredAt: at };
      const plan = await f.step([failed, stop]);
      expect(plan.failureValues).toBeUndefined();
      expect(plan.attempts).toEqual([]);
      expect(plan.checkpoint.runStatus).toBe(
        control === 'cancel' ? 'canceled' : 'timed_out',
      );
    },
  );
  it('routes only after the final retry exhausts the existing policy', async () => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    let retry = await f.fail('set', 'retry', 'network', 1);
    for (let attempt = 2; attempt <= 3; attempt++) {
      const due = retry.checkpoint.invocations.find(
        (n) => n.nodeId === 'set',
      )?.resumeAt;
      if (due === undefined) throw new Error('Missing fixture retry date');
      const resumed = await f.step(
        [{ kind: 'due_at', occurredAt: due, invocationKey: key('set') }],
        due,
      );
      expect(resumed.attempts[0]).toMatchObject({
        nodeId: 'set',
        attemptNumber: attempt,
      });
      retry = await f.fail('set', 'retry', 'network', attempt);
      if (attempt < 3) expect(retry.failureValues).toBeUndefined();
    }
    expect(retry.failureValues?.[0]?.value.attemptNumber).toBe(3);
    expect(retry.attempts.map((a) => a.nodeId)).toEqual(['handler']);
  });
  it('retry backoff selects neither path', async () => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    const retry = await f.fail('set', 'retry', 'network');
    expect(
      retry.checkpoint.invocations.find((n) => n.nodeId === 'set')?.status,
    ).toBe('waiting');
    expect(retry.failureValues).toBeUndefined();
    expect(retry.attempts).toEqual([]);
  });
});

describe('handler input evidence', () => {
  it('requires exact safe failure data before executing the entry, separately from successful outputs', async () => {
    const { executeNodeAttempt } = await import('../../src/index.js');
    const f = fixture();
    const failure = {
      nodeId: 'set',
      invocationKey: key('set'),
      attemptNumber: 1,
      errorKind: 'authentication',
      safeErrorCode: 'execution.authentication',
    };
    const received: unknown[] = [];
    const input = {
      runId: id,
      nodeRunId: id,
      attemptId: id,
      executable: f.executable,
      workflowVersionId: version,
      invocationKey: key('handler'),
      nodeId: 'handler',
      runInput: null,
      completedNodeOutputs: [],
      registry: {
        execute: (request: { input: unknown }) => {
          received.push(request.input);
          return Promise.resolve({ kind: 'succeeded' as const, output: {} });
        },
      },
      signal: new AbortController().signal,
    };
    for (const sourceFailure of [
      undefined,
      { ...failure, nodeId: 'other' },
      { ...failure, invocationKey: 'other' },
      { ...failure, message: 'secret' },
    ]) {
      await expect(
        executeNodeAttempt({
          ...input,
          ...(sourceFailure === undefined ? {} : { sourceFailure }),
        }),
      ).rejects.toMatchObject({ code: 'attempt_invalid' });
    }
    expect(received).toEqual([]);
    await executeNodeAttempt({ ...input, sourceFailure: failure });
    expect(received).toEqual([{ reason: 'execution.authentication' }]);
    await expect(
      executeNodeAttempt({
        ...input,
        nodeId: 'set',
        invocationKey: key('set'),
        sourceFailure: failure,
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
  });
  it('rejects a forged selected sink when advancing a restored checkpoint', async () => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    await f.fail();
    const cp = f.checkpoint();
    const corrupted = {
      ...cp,
      invocations: cp.invocations.map((n) =>
        n.nodeId === 'set'
          ? {
              ...n,
              failureHandling: {
                disposition: 'pending',
                sinkInvocationKey: key('terminate'),
              },
            }
          : n,
      ),
    };
    await expect(
      advanceWorkflow({
        runId: id,
        executable: f.executable,
        workflowVersionId: version,
        checkpoint: corrupted,
        occurredAt: at,
        maximumAdmissions: 5,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
  });
});

it('refuses a successful sink paired with a skipped selected handler entry', async () => {
  const f = fixture();
  await f.step();
  await f.success('manual');
  await f.fail();
  const checkpoint = f.checkpoint();
  const corrupted = {
    ...checkpoint,
    invocations: [
      ...checkpoint.invocations.map((invocation) =>
        invocation.nodeId === 'handler'
          ? { ...invocation, status: 'skipped' as const }
          : invocation,
      ),
      {
        invocationKey: key('handler-stop'),
        nodeId: 'handler-stop',
        status: 'succeeded' as const,
        attemptNumber: 1,
        output: { kind: 'inline' as const, attemptId: id },
      },
    ],
    admittedInvocationKeys: [
      ...checkpoint.admittedInvocationKeys,
      key('handler-stop'),
    ],
  };
  await expect(
    advanceWorkflow({
      runId: id,
      workflowVersionId: version,
      executable: f.executable,
      checkpoint: corrupted,
      occurredAt: at,
      maximumAdmissions: 5,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
});
