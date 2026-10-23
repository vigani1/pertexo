import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@pertexo/workflow-model';

import {
  forEachGraph,
  nestedForEachGraph,
  pairedParallelGraph,
} from '../../support/executable-workflow.js';
import { drive } from '../../support/transition/structured-control.js';

describe('structured control continuation', () => {
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
    expect(plans.at(-1)?.checkpoint.loops[0]?.completedPrefix).toBe(1);
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
    expect(plans.at(-1)?.checkpoint.loops[0]?.completedPrefix).toBe(1);
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
        ?.completedPrefix,
    ).toBe(1);
  });
});
