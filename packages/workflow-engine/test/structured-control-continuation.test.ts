import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import type {
  WorkflowGraph,
  WorkflowNode,
} from '@pertexo/workflow-model/graph';

import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpointV2,
  type WorkflowCheckpoint,
} from '../src/index.js';
import {
  forEachGraph,
  nestedForEachGraph,
  nodeRelease,
  pairedParallelGraph,
} from './executable-workflow.fixtures.js';

async function drive(
  graph: WorkflowGraph,
  values: Readonly<Record<string, unknown>>,
  stopAtNodeId?: string,
  stopKind: 'cancel' | 'deadline' | 'failure' = 'cancel',
) {
  const workflowVersionId = randomUUID();
  const executable = buildWorkflowExecutableV2({
    graph,
    release: composeExecutableCompatibilityRelease(
      nodeRelease({
        forEach: true,
        condition: true,
        switch: true,
        parallel: true,
        merge: true,
      }),
    ),
  });
  let checkpoint: WorkflowCheckpoint = createCheckpointV2({
    engineVersion: 'engine-v1',
    workflowVersionId,
    iterationBudget: 100,
  });
  let observations: unknown[] = [];
  let completedOutputs: unknown[] = [];
  const plans: Awaited<ReturnType<typeof advanceWorkflow>>[] = [];
  for (let pass = 0; pass < 40; pass += 1) {
    const plan = await advanceWorkflow({
      runId: 'structured-continuation',
      executable,
      workflowVersionId,
      checkpoint,
      observations,
      completedOutputs,
      occurredAt: '2026-09-27T12:00:00.000Z',
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    });
    plans.push(plan);
    checkpoint = plan.checkpoint;
    if (plan.attempts.length > 0) expect(checkpoint.runStatus).toBe('running');
    if (
      ['succeeded', 'failed', 'canceled', 'timed_out'].includes(
        checkpoint.runStatus,
      )
    )
      return plans;
    observations = [];
    completedOutputs = [];
    const canceledAttempt = plan.attempts.find(
      (attempt) => attempt.nodeId === stopAtNodeId,
    );
    if (canceledAttempt !== undefined) {
      const attemptId = randomUUID();
      if (stopKind !== 'failure')
        observations.push({
          kind: stopKind === 'cancel' ? 'cancel_requested' : 'deadline_expired',
          ...(stopKind === 'cancel'
            ? { sequence: checkpoint.nextEventSequence }
            : {}),
          occurredAt: '2026-09-27T12:00:00.000Z',
        });
      observations.push({
        kind: 'outcome',
        sequence:
          checkpoint.nextEventSequence + (stopKind === 'cancel' ? 1 : 0),
        occurredAt: '2026-09-27T12:00:00.000Z',
        invocationKey: canceledAttempt.invocationKey,
        attemptId,
        attemptNumber: canceledAttempt.attemptNumber,
        status:
          stopKind === 'cancel'
            ? 'canceled'
            : stopKind === 'deadline'
              ? 'timed_out'
              : 'failed',
      });
      continue;
    }
    for (const [index, attempt] of plan.attempts.entries()) {
      const attemptId = randomUUID();
      const sequence = checkpoint.nextEventSequence + index;
      observations.push({
        kind: 'outcome',
        sequence,
        occurredAt: '2026-09-27T12:00:00.000Z',
        invocationKey: attempt.invocationKey,
        attemptId,
        attemptNumber: attempt.attemptNumber,
        status: 'succeeded',
        output: { kind: 'inline', attemptId },
      });
      completedOutputs.push({
        sequence,
        attemptId,
        invocationKey: attempt.invocationKey,
        value: values[attempt.nodeId] ?? {},
      });
    }
    if (plan.attempts.length === 0)
      expect(plan.immediateContinuation).toBe(true);
  }
  throw new Error('workflow did not settle within its bounded passes');
}

describe('structured control continuation', () => {
  it('settles a selected Condition sink with its exact branch and iteration identity', async () => {
    const graph = forEachGraph();
    const loop = graph.nodes.find((node) => node.id === 'loop');
    if (loop === undefined || !('structured' in loop))
      throw new Error('For Each body missing');
    const body = loop.structured.body;
    const condition = body.nodes.find((node) => node.id === 'body-first');
    if (condition === undefined) throw new Error('condition missing');
    Object.assign(condition, {
      definition: { key: 'core.condition', version: 1 },
      inputMappings: { condition: { kind: 'literal', value: true } },
    });
    const bodyEdge = body.edges[0];
    if (bodyEdge === undefined) throw new Error('body edge missing');
    bodyEdge.source.port = 'true';
    const plans = await drive(graph, {
      loop: { items: ['first', 'second'], iterationCount: 2 },
      'body-first': { selectedPort: 'true' },
    });
    expect(plans.at(-1)?.checkpoint.runStatus).toBe('succeeded');
    expect(plans.at(-1)?.checkpoint.loops[0]?.terminalOrdinals).toEqual([0, 1]);
    expect(
      plans
        .flatMap((plan) => plan.attempts)
        .filter((attempt) => attempt.nodeId === 'body-sink'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branchPath: [{ nodeId: 'body-first', outputPort: 'true' }],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        }),
        expect.objectContaining({
          branchPath: [{ nodeId: 'body-first', outputPort: 'true' }],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
        }),
      ]),
    );
  });

  it('does not mistake an inner For Each declaration for outer settlement', async () => {
    const graph = nestedForEachGraph();
    const loop = graph.nodes.find((node) => node.id === 'loop');
    if (loop === undefined || !('structured' in loop))
      throw new Error('outer body missing');
    const body = loop.structured.body;
    body.nodes = body.nodes.filter((node) => node.id !== 'body-sink');
    body.edges = [];
    const plans = await drive(graph, {
      loop: { items: [['inner']], iterationCount: 1 },
      'body-first': { items: ['inner'], iterationCount: 1 },
    });
    expect(plans.at(-1)?.checkpoint.runStatus).toBe('succeeded');
    const declaration = plans.find((plan) =>
      plan.attempts.some((attempt) => attempt.nodeId === 'nested-body'),
    );
    expect(
      declaration?.checkpoint.loops.find((loop) => loop.loopId === 'loop')
        ?.activeOrdinals,
    ).toEqual([0]);
    expect(
      plans.at(-1)?.checkpoint.loops.find((loop) => loop.loopId === 'loop')
        ?.terminalOrdinals,
    ).toEqual([0]);
  });

  it.each([
    ['false', 0],
    ['true', 1],
  ] as const)(
    'settles a Condition %s path without inventing an attempt',
    async (selectedPort, expectedSinkAttempts) => {
      const graph = forEachGraph();
      const loop = graph.nodes.find((node) => node.id === 'loop');
      if (loop === undefined || !('structured' in loop))
        throw new Error('body missing');
      const condition = loop.structured.body.nodes.find(
        (node) => node.id === 'body-first',
      );
      if (condition === undefined) throw new Error('condition missing');
      Object.assign(condition, {
        definition: { key: 'core.condition', version: 1 },
        inputMappings: { condition: { kind: 'literal', value: true } },
      });
      const bodyEdge = loop.structured.body.edges[0];
      if (bodyEdge === undefined) throw new Error('body edge missing');
      bodyEdge.source.port = 'true';
      const plans = await drive(graph, {
        loop: { items: ['item'], iterationCount: 1 },
        'body-first': { selectedPort },
      });
      expect(plans.at(-1)?.checkpoint.runStatus).toBe('succeeded');
      expect(
        plans
          .flatMap((plan) => plan.attempts)
          .filter((attempt) => attempt.nodeId === 'body-sink'),
      ).toHaveLength(expectedSinkAttempts);
      expect(plans.at(-1)?.checkpoint.loops[0]?.terminalOrdinals).toEqual([0]);
    },
  );

  it('preserves inherited and body-local branch scopes across loop iterations', async () => {
    const graph = forEachGraph();
    const loop = graph.nodes.find((node) => node.id === 'loop');
    if (loop === undefined || !('structured' in loop))
      throw new Error('body missing');
    const bodyBranch = loop.structured.body.nodes.find(
      (node) => node.id === 'body-first',
    );
    if (bodyBranch === undefined) throw new Error('body branch missing');
    Object.assign(bodyBranch, {
      definition: { key: 'core.condition', version: 1 },
      inputMappings: { condition: { kind: 'literal', value: true } },
    });
    const bodyEdge = loop.structured.body.edges[0];
    if (bodyEdge === undefined) throw new Error('body edge missing');
    bodyEdge.source.port = 'true';
    const manual: WorkflowNode | undefined = graph.nodes[0];
    if (manual === undefined) throw new Error('manual missing');
    const rootBranch: WorkflowNode = {
      ...manual,
      id: 'outer-condition',
      definition: { key: 'core.condition', version: 1 },
      inputMappings: { condition: { kind: 'literal' as const, value: true } },
    };
    const scopedGraph: WorkflowGraph = {
      ...graph,
      nodes: [manual, rootBranch, ...graph.nodes.slice(1)],
      edges: [
        {
          id: 'manual-condition',
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: 'outer-condition', port: 'in' },
        },
        {
          id: 'condition-loop',
          source: { nodeId: 'outer-condition', port: 'true' },
          target: { nodeId: 'loop', port: 'in' },
        },
        ...graph.edges.slice(1),
      ],
    };
    const plans = await drive(scopedGraph, {
      'outer-condition': { selectedPort: 'true' },
      loop: { items: ['first', 'second'], iterationCount: 2 },
      'body-first': { selectedPort: 'true' },
    });
    expect(plans.at(-1)?.checkpoint.runStatus).toBe('succeeded');
    const sinkAttempts = plans
      .flatMap((plan) => plan.attempts)
      .filter((attempt) => attempt.nodeId === 'body-sink');
    expect(sinkAttempts).toHaveLength(2);
    for (const attempt of sinkAttempts)
      expect(attempt.branchPath).toEqual([
        { nodeId: 'outer-condition', outputPort: 'true' },
        { nodeId: 'body-first', outputPort: 'true' },
      ]);
  });

  it.each([
    ['case-02', 1],
    ['default', 0],
  ] as const)(
    'settles a Switch %s path in the loop body',
    async (selectedPort, expectedSinkAttempts) => {
      const graph = forEachGraph();
      const loop = graph.nodes.find((node) => node.id === 'loop');
      if (loop === undefined || !('structured' in loop))
        throw new Error('body missing');
      const branch = loop.structured.body.nodes.find(
        (node) => node.id === 'body-first',
      );
      if (branch === undefined) throw new Error('Switch missing');
      Object.assign(branch, {
        definition: { key: 'core.switch', version: 1 },
        config: { cases: [{ id: 'case-02', equals: 'selected' }] },
        inputMappings: { value: { kind: 'literal', value: 'selected' } },
      });
      const bodyEdge = loop.structured.body.edges[0];
      if (bodyEdge === undefined) throw new Error('body edge missing');
      bodyEdge.source.port = 'case-02';
      const plans = await drive(graph, {
        loop: { items: ['item'], iterationCount: 1 },
        'body-first': { selectedPort },
      });
      expect(plans.at(-1)?.checkpoint.runStatus).toBe('succeeded');
      expect(
        plans
          .flatMap((plan) => plan.attempts)
          .filter((attempt) => attempt.nodeId === 'body-sink'),
      ).toHaveLength(expectedSinkAttempts);
    },
  );

  it('settles an empty inner For Each before the outer iteration', async () => {
    const graph = nestedForEachGraph();
    const loop = graph.nodes.find((node) => node.id === 'loop');
    if (loop === undefined || !('structured' in loop))
      throw new Error('outer body missing');
    loop.structured.body.nodes = loop.structured.body.nodes.filter(
      (node) => node.id !== 'body-sink',
    );
    loop.structured.body.edges = [];
    const plans = await drive(graph, {
      loop: { items: [[]], iterationCount: 1 },
      'body-first': { items: [], iterationCount: 0 },
    });
    expect(plans.at(-1)?.checkpoint.runStatus).toBe('succeeded');
    expect(
      plans
        .flatMap((plan) => plan.attempts)
        .some((attempt) => attempt.nodeId === 'nested-body'),
    ).toBe(false);
    expect(
      plans.at(-1)?.checkpoint.loops.find((item) => item.loopId === 'loop')
        ?.terminalOrdinals,
    ).toEqual([0]);
  });

  it('cancels an active nested sole-sink loop without a continuation wakeup', async () => {
    const graph = nestedForEachGraph();
    const loop = graph.nodes.find((node) => node.id === 'loop');
    if (loop === undefined || !('structured' in loop))
      throw new Error('outer body missing');
    loop.structured.body.nodes = loop.structured.body.nodes.filter(
      (node) => node.id !== 'body-sink',
    );
    loop.structured.body.edges = [];
    const plans = await drive(
      graph,
      {
        loop: { items: [['inner']], iterationCount: 1 },
        'body-first': { items: ['inner'], iterationCount: 1 },
      },
      'nested-body',
    );
    expect(plans.at(-1)?.checkpoint.runStatus).toBe('canceled');
    expect(plans.at(-1)?.immediateContinuation).toBeUndefined();
  });

  it('times out an active nested sole-sink loop without another admission', async () => {
    const graph = nestedForEachGraph();
    const loop = graph.nodes.find((node) => node.id === 'loop');
    if (loop === undefined || !('structured' in loop))
      throw new Error('outer body missing');
    loop.structured.body.nodes = loop.structured.body.nodes.filter(
      (node) => node.id !== 'body-sink',
    );
    loop.structured.body.edges = [];
    const plans = await drive(
      graph,
      {
        loop: { items: [['inner']], iterationCount: 1 },
        'body-first': { items: ['inner'], iterationCount: 1 },
      },
      'nested-body',
      'deadline',
    );
    expect(plans.at(-1)?.checkpoint.runStatus).toBe('timed_out');
    expect(plans.at(-1)?.immediateContinuation).toBeUndefined();
  });

  it('propagates an inner body failure through both loop controls', async () => {
    const graph = nestedForEachGraph();
    const loop = graph.nodes.find((node) => node.id === 'loop');
    if (loop === undefined || !('structured' in loop))
      throw new Error('outer body missing');
    loop.structured.body.nodes = loop.structured.body.nodes.filter(
      (node) => node.id !== 'body-sink',
    );
    loop.structured.body.edges = [];
    const plans = await drive(
      graph,
      {
        loop: { items: [['inner']], iterationCount: 1 },
        'body-first': { items: ['inner'], iterationCount: 1 },
      },
      'nested-body',
      'failure',
    );
    expect(plans.at(-1)?.checkpoint.runStatus).toBe('failed');
    expect(
      plans.at(-1)?.checkpoint.loops.find((item) => item.loopId === 'loop')
        ?.terminalStatus,
    ).toBe('failed');
  });

  it('settles a paired Parallel/Merge body within one loop iteration', async () => {
    const outer = forEachGraph();
    const paired = pairedParallelGraph();
    const loop = outer.nodes.find((node) => node.id === 'loop');
    if (loop === undefined || !('structured' in loop))
      throw new Error('outer body missing');
    const graph: WorkflowGraph = {
      ...outer,
      nodes: outer.nodes.map((node) =>
        node.id === 'loop'
          ? {
              ...loop,
              structured: {
                ...loop.structured,
                body: {
                  ...loop.structured.body,
                  nodes: paired.nodes.filter((node) =>
                    ['parallel', 'left', 'right', 'merge'].includes(node.id),
                  ),
                  edges: paired.edges.filter(
                    (edge) =>
                      edge.source.nodeId !== 'manual' &&
                      edge.target.nodeId !== 'terminate',
                  ),
                },
              },
            }
          : node,
      ),
    };
    const plans = await drive(graph, {
      loop: { items: ['item'], iterationCount: 1 },
      parallel: { branchIds: ['branch-02', 'branch-01'] },
    });
    expect(plans.at(-1)?.checkpoint.runStatus).toBe('succeeded');
    expect(plans.at(-1)?.checkpoint.loops[0]?.terminalOrdinals).toEqual([0]);
    expect(
      plans
        .flatMap((plan) => plan.attempts)
        .some((attempt) => attempt.nodeId === 'merge'),
    ).toBe(true);
  });

  it('returns a continuation only for immediate scheduler work without attempts', async () => {
    const graph = forEachGraph();
    const loop = graph.nodes.find((node) => node.id === 'loop');
    if (loop === undefined || !('structured' in loop))
      throw new Error('body missing');
    const body = loop.structured.body;
    for (const node of body.nodes) Object.assign(node, { disabled: true });
    const plans = await drive(graph, {
      loop: { items: ['first'], iterationCount: 1 },
    });
    expect(plans.at(-1)?.checkpoint.runStatus).toBe('succeeded');
    expect(plans.some((plan) => plan.immediateContinuation === true)).toBe(
      true,
    );
    expect(plans.at(-1)?.immediateContinuation).toBeUndefined();
    expect(
      plans
        .flatMap((plan) => plan.attempts)
        .some((attempt) =>
          ['body-first', 'body-sink'].includes(attempt.nodeId),
        ),
    ).toBe(false);
    expect(
      plans
        .flatMap((plan) => plan.events)
        .filter(
          (event) =>
            event.name === 'node.skipped' &&
            ['body-first', 'body-sink'].includes(event.nodeId ?? ''),
        )
        .map((event) => event.nodeId),
    ).toEqual(['body-first', 'body-sink']);
    expect(plans.at(-1)?.checkpoint.loops[0]?.terminalOrdinals).toEqual([0]);
  });

  it('skips a disabled inner control and settles its outer sole-sink iteration', async () => {
    const graph = nestedForEachGraph();
    const loop = graph.nodes.find((node) => node.id === 'loop');
    if (loop === undefined || !('structured' in loop))
      throw new Error('outer body missing');
    const inner = loop.structured.body.nodes.find(
      (node) => node.id === 'body-first',
    );
    if (inner === undefined) throw new Error('inner control missing');
    Object.assign(inner, { disabled: true });
    loop.structured.body.nodes = loop.structured.body.nodes.filter(
      (node) => node.id !== 'body-sink',
    );
    loop.structured.body.edges = [];
    const plans = await drive(graph, {
      loop: { items: [['inner']], iterationCount: 1 },
    });
    expect(plans.at(-1)?.checkpoint.runStatus).toBe('succeeded');
    expect(
      plans
        .flatMap((plan) => plan.attempts)
        .some((attempt) =>
          ['body-first', 'nested-body'].includes(attempt.nodeId),
        ),
    ).toBe(false);
    expect(
      plans
        .flatMap((plan) => plan.events)
        .filter(
          (event) =>
            event.name === 'node.skipped' && event.nodeId === 'body-first',
        ),
    ).toHaveLength(1);
    expect(
      plans.at(-1)?.checkpoint.loops.find((item) => item.loopId === 'loop')
        ?.terminalOrdinals,
    ).toEqual([0]);
  });
});
