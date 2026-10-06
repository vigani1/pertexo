import { createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/workflow-model/canonical-json';
import { CallableCompletionStoppedError as SharedCallableCompletionStoppedError } from '@pertexo/workflow-model/workflow-call-contract';
import { expect, it, vi } from 'vitest';
import {
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityReleaseV3,
} from '../src/executable-workflow.js';
import { createWorkflowCheckpointV3 } from '../src/checkpoint/checkpoint-v3.js';
import { advanceWorkflow } from '../src/operations.js';
import { CallableCompletionStoppedError } from '../src/observation/workflow-call-demand.js';
import type { LoadCoordinatorControlDeclaration } from '../src/observation/control-declaration-demand.js';
import {
  conditionGraph,
  forEachGraph,
  nodeRelease,
  pairedParallelGraph,
} from './executable-workflow.fixtures.js';

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
it('preserves the exact shared typed-stop constructor identity', () => {
  expect(CallableCompletionStoppedError).toBe(
    SharedCallableCompletionStoppedError,
  );
  const stop = { kind: 'unavailable', reason: 'source_read_failed' } as const;
  const error = new SharedCallableCompletionStoppedError(stop);
  expect(error).toBeInstanceOf(CallableCompletionStoppedError);
  expect(error.name).toBe('CallableCompletionStoppedError');
  expect(error.message).toBe('Callable value work stopped: unavailable');
  expect(error.stop).toBe(stop);
});
async function fixture(kind: 'for_each' | 'branch' | 'parallel' = 'for_each') {
  const retained =
    kind === 'for_each'
      ? forEachGraph()
      : kind === 'branch'
        ? conditionGraph('true')
        : pairedParallelGraph();
  const nativeGraph = {
    ...retained,
    schemaVersion: 2,
    nodes: retained.nodes.map((node) =>
      'structured' in node
        ? {
            ...node,
            structured: {
              ...node.structured,
              body: { ...node.structured.body, schemaVersion: 2 },
            },
          }
        : node,
    ),
  };
  const base = {
    runId: id(1),
    workflowVersionId: id(2),
    executable: buildWorkflowExecutableV3({
      graph: nativeGraph,
      release: composeExecutableCompatibilityReleaseV3(
        nodeRelease({
          forEach: true,
          condition: true,
          parallel: true,
          merge: true,
        }),
      ),
    }),
    occurredAt: '2026-10-04T00:00:00.000Z',
    maximumAdmissions: 1,
    signal: new AbortController().signal,
  };
  const initial = await advanceWorkflow({
    ...base,
    checkpoint: createWorkflowCheckpointV3({
      engineVersion: 'test',
      workflowVersionId: id(2),
      iterationBudget: 10,
    }),
    observations: [],
  });
  const manual = initial.attempts[0];
  if (manual === undefined) throw new Error('manual attempt missing');
  const manualIdentity = {
    sequence: initial.checkpoint.nextEventSequence,
    attemptId: id(3),
    invocationKey: manual.invocationKey,
  };
  const started = await advanceWorkflow({
    ...base,
    checkpoint: initial.checkpoint,
    observations: [
      {
        ...manualIdentity,
        kind: 'outcome',
        occurredAt: base.occurredAt,
        attemptNumber: 1,
        status: 'succeeded',
        output: { kind: 'inline', attemptId: id(3) },
      },
    ],
    completedOutputs: [{ ...manualIdentity, value: {} }],
  });
  const control = started.attempts[0];
  if (control === undefined) throw new Error('control attempt missing');
  const identity = {
    sequence: started.checkpoint.nextEventSequence,
    attemptId: id(4),
    invocationKey: control.invocationKey,
  };
  const output =
    kind === 'parallel'
      ? { kind: 'inline' as const, attemptId: id(4) }
      : { kind: 'artifact' as const, artifactId: id(5) };
  const advance = {
    ...base,
    checkpoint: started.checkpoint,
    observations: [
      {
        ...identity,
        kind: 'outcome',
        occurredAt: base.occurredAt,
        attemptNumber: 1,
        status: 'succeeded',
        output,
      },
    ],
  };
  return { advance, identity, output };
}
function ready(
  identity: Parameters<LoadCoordinatorControlDeclaration>[0],
  output: Extract<
    Awaited<ReturnType<LoadCoordinatorControlDeclaration>>,
    { kind: 'ready' }
  >['material']['output'],
  value: unknown,
): Awaited<ReturnType<LoadCoordinatorControlDeclaration>> {
  const bytes = canonicalJson(value);
  return {
    kind: 'ready',
    material: {
      ...identity,
      output,
      value,
      valueIdentity: {
        reference:
          output.kind === 'inline'
            ? { schemaVersion: 1, kind: 'inline' }
            : {
                schemaVersion: 1,
                kind: 'artifact',
                artifactId: output.artifactId,
              },
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: Buffer.byteLength(bytes),
      },
    },
  };
}

it.each(['branch', 'parallel'] as const)(
  'keeps incremental %s declaration semantics equal to the existing scheduler',
  async (kind) => {
    const { advance, identity, output } = await fixture(kind);
    const value =
      kind === 'branch'
        ? { selectedPort: 'true' }
        : { branchIds: ['branch-02', 'branch-01'] };
    const expected = await advanceWorkflow({
      ...advance,
      completedOutputs: [{ ...identity, value }],
    });
    const load = vi.fn<LoadCoordinatorControlDeclaration>(() =>
      Promise.resolve(ready(identity, output, value)),
    );
    expect(
      await advanceWorkflow({
        ...advance,
        loadCoordinatorControlDeclaration: load,
      }),
    ).toEqual(expected);
    expect(load).toHaveBeenCalledTimes(1);
  },
);

it('does not substitute canonical re-encoding for original inline byte identity', async () => {
  const { advance, identity, output } = await fixture('parallel');
  const value = { branchIds: ['branch-02', 'branch-01'] };
  const original = ' { "branchIds" : [ "branch-02", "branch-01" ] }\n';
  const response = ready(identity, output, value);
  if (response.kind !== 'ready') throw new Error('ready fixture missing');
  const material = {
    ...response.material,
    valueIdentity: {
      reference: { schemaVersion: 1 as const, kind: 'inline' as const },
      sha256: createHash('sha256').update(original).digest('hex'),
      byteLength: Buffer.byteLength(original),
    },
  };
  expect(
    await advanceWorkflow({
      ...advance,
      loadCoordinatorControlDeclaration: () =>
        Promise.resolve({ kind: 'ready', material }),
    }),
  ).toEqual(
    await advanceWorkflow({
      ...advance,
      completedOutputs: [{ ...identity, value }],
    }),
  );
});

it('preserves the parallel inline-only reference invariant', async () => {
  const { advance, identity } = await fixture('parallel');
  const output = { kind: 'artifact' as const, artifactId: id(5) };
  await expect(
    advanceWorkflow({
      ...advance,
      observations: advance.observations.map((observation) => ({
        ...observation,
        output,
      })),
      loadCoordinatorControlDeclaration: () =>
        Promise.resolve(
          ready(identity, output, { branchIds: ['branch-02', 'branch-01'] }),
        ),
    }),
  ).rejects.toMatchObject({ code: 'observation_invalid' });
});

it.each([
  { items: [] },
  { items: ['x'.repeat(300_000)] },
  { items: ['a', 'b', 'c'] },
])(
  'keeps empty, large artifact and rejected-bound settlements equal to existing reducers',
  async ({ items }) => {
    const { advance, identity, output } = await fixture();
    const value = { items, iterationCount: items.length };
    const expected = await advanceWorkflow({
      ...advance,
      completedOutputs: [{ ...identity, value }],
    });
    const load = vi.fn<LoadCoordinatorControlDeclaration>(
      (requested, signal) => {
        expect(requested).toEqual(identity);
        expect(signal).toBe(advance.signal);
        return Promise.resolve(ready(identity, output, value));
      },
    );
    const actual = await advanceWorkflow({
      ...advance,
      loadCoordinatorControlDeclaration: load,
    });
    expect(actual).toEqual(expected);
    expect(load).toHaveBeenCalledTimes(1);
  },
);

it('preserves typed control stops and does not settle a plan', async () => {
  const { advance } = await fixture();
  await expect(
    advanceWorkflow({
      ...advance,
      loadCoordinatorControlDeclaration: () =>
        Promise.resolve({
          kind: 'stopped',
          stop: { kind: 'unavailable', reason: 'source_read_failed' },
        }),
    }),
  ).rejects.toBeInstanceOf(CallableCompletionStoppedError);
});

it.each(['canceled', 'timed_out'] as const)(
  'preserves active descendants before %s run settlement and unknown-effect priority',
  async (status) => {
    const { advance, identity, output } = await fixture();
    const running = await advanceWorkflow({
      ...advance,
      loadCoordinatorControlDeclaration: () =>
        Promise.resolve(
          ready(identity, output, { items: ['one'], iterationCount: 1 }),
        ),
    });
    const body = running.attempts[0];
    if (body === undefined) throw new Error('body attempt missing');
    const stopped =
      status === 'canceled'
        ? {
            kind: 'cancel_requested',
            sequence: running.checkpoint.nextEventSequence,
            occurredAt: advance.occurredAt,
          }
        : { kind: 'deadline_expired', occurredAt: advance.occurredAt };
    const load = vi.fn<LoadCoordinatorControlDeclaration>();
    const waiting = await advanceWorkflow({
      ...advance,
      checkpoint: running.checkpoint,
      observations: [stopped],
      loadCoordinatorControlDeclaration: load,
    });
    expect(load).not.toHaveBeenCalled();
    expect(waiting.checkpoint.runStatus).toBe('running');
    expect(waiting.checkpoint.loops[0]?.activeOrdinals).toEqual([0]);
    expect(waiting.checkpoint.remainingIterationBudget).toBe(9);
    const unknown = await advanceWorkflow({
      ...advance,
      checkpoint: waiting.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: waiting.checkpoint.nextEventSequence,
          occurredAt: advance.occurredAt,
          attemptId: id(8),
          attemptNumber: 1,
          invocationKey: body.invocationKey,
          status: 'outcome_unknown',
        },
      ],
      loadCoordinatorControlDeclaration: load,
    });
    expect(unknown.checkpoint.runStatus).toBe('outcome_unknown');
    expect(unknown.checkpoint.loops[0]?.activeOrdinals).toEqual([]);
    expect(unknown.checkpoint.remainingIterationBudget).toBe(9);
    expect(load).not.toHaveBeenCalled();
  },
);

it.each(['for_each', 'branch', 'parallel'] as const)(
  'settles fresh %s cancellation without demand, new work or declaration budget debit',
  async (kind) => {
    const { advance, identity, output } = await fixture(kind);
    const load = vi.fn<LoadCoordinatorControlDeclaration>(() =>
      Promise.resolve({ kind: 'stopped', stop: { kind: 'canceled' } }),
    );
    const plan = await advanceWorkflow({
      ...advance,
      observations: [
        ...advance.observations,
        {
          kind: 'cancel_requested',
          sequence: identity.sequence + 1,
          occurredAt: advance.occurredAt,
        },
      ],
      loadCoordinatorControlDeclaration: load,
    });
    expect(load).not.toHaveBeenCalled();
    expect(plan.checkpoint.runStatus).toBe('canceled');
    expect(plan.consumedThroughEventSequence).toBe(identity.sequence + 1);
    expect(plan.checkpoint.loops).toEqual([]);
    expect(plan.checkpoint.joins).toEqual([]);
    expect(plan.checkpoint.remainingIterationBudget).toBe(10);
    expect(plan.attempts).toEqual([]);
    expect(plan.nodeRunAdmissions).toEqual([]);
    expect(
      plan.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === identity.invocationKey,
      ),
    ).toMatchObject({
      status: kind === 'for_each' ? 'canceled' : 'succeeded',
      output,
    });
    expect(plan.events.map(({ name }) => name)).toEqual(
      kind === 'for_each'
        ? ['node.canceled', 'run.canceled']
        : ['run.canceled'],
    );
  },
);

it.each(['for_each', 'branch', 'parallel'] as const)(
  'settles fresh %s deadline without demand, unused loop/join or declaration budget debit',
  async (kind) => {
    const { advance, identity, output } = await fixture(kind);
    const load = vi.fn<LoadCoordinatorControlDeclaration>(() =>
      Promise.resolve({ kind: 'stopped', stop: { kind: 'timed_out' } }),
    );
    const plan = await advanceWorkflow({
      ...advance,
      observations: [
        ...advance.observations,
        { kind: 'deadline_expired', occurredAt: advance.occurredAt },
      ],
      loadCoordinatorControlDeclaration: load,
    });
    expect(load).not.toHaveBeenCalled();
    expect(plan.checkpoint.runStatus).toBe('timed_out');
    expect(plan.consumedThroughEventSequence).toBe(identity.sequence);
    expect(plan.checkpoint.loops).toEqual([]);
    expect(plan.checkpoint.joins).toEqual([]);
    expect(plan.checkpoint.remainingIterationBudget).toBe(10);
    expect(plan.attempts).toEqual([]);
    expect(plan.nodeRunAdmissions).toEqual([]);
    expect(
      plan.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === identity.invocationKey,
      ),
    ).toMatchObject({
      status: kind === 'for_each' ? 'timed_out' : 'succeeded',
      output,
    });
    expect(plan.events.map(({ name }) => name)).toEqual(
      kind === 'for_each'
        ? ['node.timed_out', 'run.timed_out']
        : ['run.timed_out'],
    );
  },
);

it.each(['sequence', 'output', 'snapshot', 'shape', 'extra'])(
  'rejects %s material drift as invalid, not unavailable',
  async (kind) => {
    const { advance, identity, output } = await fixture();
    const reply = ready(identity, output, {
      items: ['one'],
      iterationCount: 1,
    });
    if (reply.kind !== 'ready') throw new Error('ready fixture missing');
    const material = structuredClone(reply.material);
    if (kind === 'sequence')
      Object.assign(material, { sequence: identity.sequence + 1 });
    if (kind === 'output')
      Object.assign(material, {
        output: { kind: 'artifact', artifactId: id(6) },
      });
    if (kind === 'snapshot')
      Object.assign(material.valueIdentity, {
        reference: { schemaVersion: 1, kind: 'artifact', artifactId: id(6) },
      });
    if (kind === 'shape')
      Object.assign(material, { value: { items: ['one'], iterationCount: 0 } });
    if (kind === 'extra') Object.assign(material, { validated: true });
    await expect(
      advanceWorkflow({
        ...advance,
        loadCoordinatorControlDeclaration: () =>
          Promise.resolve({ kind: 'ready', material }),
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  },
);

it('joins a selected read before observing its abort, without accepting material', async () => {
  const { advance, identity, output } = await fixture();
  const controller = new AbortController();
  let joined = false;
  await expect(
    advanceWorkflow({
      ...advance,
      signal: controller.signal,
      loadCoordinatorControlDeclaration: async () => {
        controller.abort();
        await Promise.resolve();
        joined = true;
        return ready(identity, output, { items: [], iterationCount: 0 });
      },
    }),
  ).rejects.toBeInstanceOf(CallableCompletionStoppedError);
  expect(joined).toBe(true);
});
