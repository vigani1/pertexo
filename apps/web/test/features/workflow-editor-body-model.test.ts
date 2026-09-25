import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { describe, expect, it } from 'vitest';
import {
  BODY_ORIGIN,
  bodyFrame,
  displayPositions,
  levelPositions,
  LOOP_FRAME,
} from '@/features/workflow-editor/model/body-layout';
import {
  bodyIssuesOf,
  forEachBodyIssues,
} from '@/features/workflow-editor/model/body-rules';
import { createEditorStore } from '@/features/workflow-editor/model/editor.store';
import {
  addBodyStep,
  addDefinitionNode,
  addStepAfter,
  connectWorkflowNodes,
  moveWorkflowNodes,
  removeWorkflowElements,
  restoreWorkflowElements,
  updateWorkflowNode,
} from '@/features/workflow-editor/model/graph-commands';
import { duplicateWorkflowNodes } from '@/features/workflow-editor/model/graph-copies';
import {
  canConnectSteps,
  levelAt,
  locateStep,
  mapLevel,
  scopeOf,
} from '@/features/workflow-editor/model/graph-scopes';
import {
  bodyStepDefinition,
  forEachDefinition,
  link,
  loopStep,
  orderLoopGraph,
  step,
} from '../support/for-each-fixtures';
import { emptyGraph, etagA } from '../support/workflow-editor-fixtures';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

function bodyOf(graph: WorkflowGraphContract, loopId = 'loop') {
  const body = graph.nodes.find((node) => node.id === loopId)?.structured?.body;
  if (body === undefined) throw new Error(`${loopId} has no body`);
  return body;
}

function ids(nodes: readonly Pick<WorkflowNode, 'id'>[]) {
  return nodes.map((node) => node.id);
}

describe('the nested graph layer', () => {
  it('finds steps and levels inside bodies and keeps unchanged levels', () => {
    const graph = orderLoopGraph();
    expect(scopeOf(graph, 'reserve')).toEqual(['loop']);
    expect(scopeOf(graph, 'start')).toEqual([]);
    expect(levelAt(graph, ['loop'])).toBe(bodyOf(graph));
    expect(levelAt(graph, ['gone'])).toBeUndefined();
    expect(locateStep(graph, 'check')).toMatchObject({
      node: { id: 'check' },
      loopPorts: ['item', 'ordinal'],
    });
    expect(locateStep(graph, 'start')?.loopPorts).toEqual([]);
    expect(mapLevel(graph, ['loop'], (level) => level)).toBe(graph);
    expect(
      mapLevel(graph, ['gone'], (level) => ({ ...level, nodes: [] })),
    ).toBe(graph);
    expect(canConnectSteps(graph, 'check', 'reserve')).toBe(true);
    expect(canConnectSteps(graph, 'start', 'check')).toBe(false);
    expect(canConnectSteps(graph, 'check', 'loop')).toBe(false);
    expect(canConnectSteps(graph, 'check', 'check')).toBe(false);
  });

  it('gives a new For each an empty body with the exact ports and default bounds', () => {
    const placed = addDefinitionNode(
      emptyGraph,
      forEachDefinition,
      { x: 0, y: 0 },
      'loop',
    );
    expect(placed.nodes[0]?.structured).toEqual({
      kind: 'for_each',
      maxIterations: 100,
      maxConcurrency: 1,
      body: {
        schemaVersion: 1,
        nodes: [],
        edges: [],
        settings: {},
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
      },
    });
  });
});

describe('body graph commands', () => {
  it('adds a first body step, creating a body the For each lacked', () => {
    const bare: WorkflowGraphContract = {
      ...emptyGraph,
      nodes: [
        {
          ...step('loop', 'Each'),
          definition: { key: 'core.foreach', version: 1 },
        },
      ],
    };
    const next = addBodyStep(
      bare,
      'loop',
      bodyStepDefinition,
      { x: 0, y: 0 },
      {
        nodeId: 'first',
        edgeId: 'unused',
      },
    );
    if (next === null) throw new Error('expected a body step');
    expect(ids(bodyOf(next).nodes)).toEqual(['first']);
    expect(bodyOf(next).inputPorts).toEqual(['item', 'ordinal']);
    expect(
      addBodyStep(bare, 'nope', bodyStepDefinition, { x: 0, y: 0 }),
    ).toBeNull();
    expect(
      addBodyStep(orderLoopGraph(), 'start', bodyStepDefinition, {
        x: 0,
        y: 0,
      }),
    ).toBeNull();
  });

  it('adds after a body step inside the same body, never outside it', () => {
    const graph = orderLoopGraph();
    const after = addBodyStep(
      graph,
      'loop',
      bodyStepDefinition,
      { x: 400, y: 0 },
      { nodeId: 'notify', edgeId: 'reserve-notify' },
      { nodeId: 'reserve', port: 'out' },
    );
    if (after === null) throw new Error('expected a body step');
    expect(ids(bodyOf(after).nodes)).toEqual(['check', 'reserve', 'notify']);
    expect(bodyOf(after).edges.at(-1)).toEqual(
      link('reserve-notify', 'reserve', 'notify'),
    );
    expect(ids(after.nodes)).toEqual(ids(graph.nodes));
    expect(after.edges).toBe(graph.edges);
    // Quick add from a body step's port stays in its body too.
    const dropped = addStepAfter(
      graph,
      bodyStepDefinition,
      { x: 0, y: 200 },
      { nodeId: 'check', port: 'out' },
      { nodeId: 'side', edgeId: 'check-side' },
    );
    expect(ids(dropped === null ? [] : bodyOf(dropped).nodes)).toContain(
      'side',
    );
    expect(
      addBodyStep(
        graph,
        'loop',
        bodyStepDefinition,
        { x: 0, y: 0 },
        undefined,
        { nodeId: 'start', port: 'out' },
      ),
    ).toBeNull();
  });

  it('connects body steps to each other and refuses connections across the body’s edge', () => {
    const graph = orderLoopGraph();
    const wired = connectWorkflowNodes(
      graph,
      {
        source: 'reserve',
        sourceHandle: 'out',
        target: 'check',
        targetHandle: 'in',
      },
      'back',
    );
    expect(wired === null ? [] : ids(bodyOf(wired).edges)).toEqual([
      'check-reserve',
      'back',
    ]);
    expect(
      connectWorkflowNodes(graph, {
        source: 'start',
        sourceHandle: 'out',
        target: 'check',
        targetHandle: 'in',
      }),
    ).toBeNull();
    expect(
      connectWorkflowNodes(graph, {
        source: 'check',
        sourceHandle: 'out',
        target: 'reserve',
        targetHandle: 'in',
      }),
    ).toBeNull();
  });

  it('removes body steps with their connections and restores them into the body', () => {
    const graph = orderLoopGraph();
    const result = removeWorkflowElements(graph, {
      nodeIds: ['check'],
      edgeIds: [],
    });
    expect(ids(bodyOf(result.graph).nodes)).toEqual(['reserve']);
    expect(bodyOf(result.graph).edges).toEqual([]);
    expect(result.graph.edges).toBe(graph.edges);
    expect(result.removed.scopes).toEqual({
      check: ['loop'],
      'check-reserve': ['loop'],
    });
    // Another edit happened meanwhile, so Undo restores rather than rewinds.
    const renamed = updateWorkflowNode(result.graph, 'reserve', {
      label: 'Hold item',
    });
    const restored = restoreWorkflowElements(renamed, result.removed);
    expect(ids(bodyOf(restored).nodes)).toEqual(['reserve', 'check']);
    expect(ids(bodyOf(restored).edges)).toEqual(['check-reserve']);
    expect(bodyOf(restored).nodes[0]?.label).toBe('Hold item');
    expect(restoreWorkflowElements(restored, result.removed)).toBe(restored);
  });

  it('takes a For each’s body with it, and restores nothing into a body that’s gone', () => {
    const graph = orderLoopGraph();
    const both = removeWorkflowElements(graph, {
      nodeIds: ['check', 'loop'],
      edgeIds: [],
    });
    expect(ids(both.graph.nodes)).toEqual(['start', 'after']);
    expect(ids(both.removed.nodes)).toEqual(['loop']);
    expect(ids(both.removed.edges)).toEqual(['start-loop', 'loop-after']);
    expect(bodyOf(restoreWorkflowElements(both.graph, both.removed))).toEqual(
      bodyOf(graph),
    );

    const inner = removeWorkflowElements(graph, {
      nodeIds: ['check'],
      edgeIds: [],
    });
    const loopGone = removeWorkflowElements(inner.graph, {
      nodeIds: ['loop'],
      edgeIds: [],
    }).graph;
    expect(restoreWorkflowElements(loopGone, inner.removed)).toBe(loopGone);
  });

  it('moves and updates body steps in body coordinates', () => {
    const graph = orderLoopGraph();
    const moved = moveWorkflowNodes(
      graph,
      new Map([
        ['reserve', { x: 300, y: 20 }],
        ['after', { x: 900, y: 80 }],
      ]),
    );
    expect(bodyOf(moved).nodes[1]?.position).toEqual({ x: 300, y: 20 });
    expect(moved.nodes[2]?.position).toEqual({ x: 900, y: 80 });
    const labelled = updateWorkflowNode(graph, 'check', { label: 'Check' });
    expect(bodyOf(labelled).nodes[0]?.label).toBe('Check');
    expect(updateWorkflowNode(graph, 'check', { label: 'Check stock' })).toBe(
      graph,
    );
  });

  it('stores a body in the layout it’s shown in before its first change', () => {
    const graph = orderLoopGraph();
    // Both steps were stored at the body's corner; the second is shown in
    // the next execution column instead.
    const shown = displayPositions(bodyOf(graph));
    expect(shown.get('check')).toEqual({ x: 0, y: 0 });
    expect(shown.get('reserve')).toEqual({ x: 288, y: 0 });
    const labelled = updateWorkflowNode(graph, 'check', { label: 'Check' });
    expect(bodyOf(labelled).nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 288, y: 0 },
    ]);
    // Undo in the store takes the whole change back.
    const store = createEditorStore({ graph, etag: etagA, revision: 1 });
    store.getState().transact(labelled);
    store.getState().undo();
    expect(store.getState().graph).toBe(graph);
  });

  it('duplicates body steps in their body and gives a copied For each a fresh body', () => {
    let counter = 0;
    const createId = () => {
      counter += 1;
      return `copy-${String(counter)}`;
    };
    const graph = orderLoopGraph();
    const inBody = duplicateWorkflowNodes(graph, ['reserve'], createId);
    expect(inBody.nodeIds).toEqual(['copy-1']);
    expect(ids(bodyOf(inBody.graph).nodes)).toEqual([
      'check',
      'reserve',
      'copy-1',
    ]);

    const loops = duplicateWorkflowNodes(graph, ['loop'], createId);
    const copy = loops.graph.nodes.at(-1);
    const copiedBody = copy?.structured?.body;
    expect(copy?.id).toBe('copy-2');
    expect(ids(copiedBody?.nodes ?? [])).toEqual(['copy-3', 'copy-4']);
    expect(copiedBody?.edges).toEqual([link('copy-5', 'copy-3', 'copy-4')]);
  });
});

describe('body layout', () => {
  it('sizes a container around its steps, and grows with a step being dragged', () => {
    const body = bodyOf(orderLoopGraph());
    const frame = bodyFrame(body);
    expect(frame.width).toBe(288 + 224 + 2 * LOOP_FRAME.padding);
    expect(frame.height).toBe(80 + 2 * LOOP_FRAME.padding);
    const dragged = bodyFrame(body, new Map([['reserve', { x: 600, y: 200 }]]));
    expect(dragged.width).toBe(600 + 224 + 2 * LOOP_FRAME.padding);
    expect(dragged.positions.get('reserve')).toEqual({ x: 600, y: 200 });
    expect(bodyFrame(undefined)).toMatchObject({
      width: LOOP_FRAME.minWidth,
      height: LOOP_FRAME.minHeight,
    });
  });

  it('turns canvas positions inside a container into body positions', () => {
    const positions = levelPositions(
      orderLoopGraph(),
      new Map([
        ['check', { x: BODY_ORIGIN.x + 40, y: BODY_ORIGIN.y + 12.4 }],
        ['start', { x: -10, y: 5 }],
        ['reserve', { x: 0, y: 0 }],
      ]),
    );
    expect(positions.get('check')).toEqual({ x: 40, y: 12 });
    expect(positions.get('start')).toEqual({ x: -10, y: 5 });
    expect(positions.get('reserve')).toEqual({ x: 0, y: 0 });
  });
});

describe('body rules (ADR 020) as issues', () => {
  function withBody(
    nodes: WorkflowNode[],
    edges: WorkflowGraphContract['edges'] = [],
  ): WorkflowGraphContract {
    return {
      ...emptyGraph,
      nodes: [loopStep('loop', 'Each', { nodes, edges: [...edges] })],
    };
  }

  it('asks for a first step in an empty or missing body', () => {
    expect(
      bodyIssuesOf(withBody([]), 'loop').map((issue) => issue.code),
    ).toEqual(['empty']);
    const bare: WorkflowGraphContract = {
      ...emptyGraph,
      nodes: [
        {
          ...step('loop', 'Each'),
          definition: { key: 'core.foreach', version: 1 },
        },
      ],
    };
    expect(bodyIssuesOf(bare, 'loop')[0]?.message).toBe(
      'The body is empty. Add the step each item should run through.',
    );
  });

  it('accepts one path to one last step, and names extra endings', () => {
    expect(
      bodyIssuesOf(
        withBody([step('a', 'A'), step('b', 'B')], [link('ab', 'a', 'b')]),
        'loop',
      ),
    ).toEqual([]);
    const forked = bodyIssuesOf(
      withBody(
        [step('a', 'A'), step('b', 'B'), step('c', 'C')],
        [link('ab', 'a', 'b'), link('ac', 'a', 'c')],
      ),
      'loop',
    );
    expect(forked).toEqual([
      {
        code: 'sinks',
        message:
          'The body ends in 2 steps: “B” and “C”. Connect them into one last step; its output is each item’s result.',
        nodeIds: ['b', 'c'],
      },
    ]);
  });

  it('points out steps off the way from the start to the last step', () => {
    const looped = bodyIssuesOf(
      withBody(
        [step('a', 'A'), step('b', 'B'), step('c', 'C'), step('end', 'End')],
        [
          link('a-end', 'a', 'end'),
          link('b-c', 'b', 'c'),
          link('c-b', 'c', 'b'),
        ],
      ),
      'loop',
    );
    expect(looped.map((issue) => [issue.code, issue.nodeIds])).toEqual([
      ['unreachable', ['b', 'c']],
    ]);
    expect(looped[0]?.message).toMatch(/^“B” and “C” aren’t on the way/u);
  });

  it('reports connections that cross a body’s edge, for every body they touch', () => {
    const graph = orderLoopGraph();
    const crossing: WorkflowGraphContract = {
      ...graph,
      edges: [...graph.edges, link('into-body', 'start', 'check')],
    };
    const issues = forEachBodyIssues(crossing).get('loop') ?? [];
    expect(issues.map((issue) => [issue.code, issue.nodeIds])).toEqual([
      ['crossing', ['check']],
    ]);
    expect(forEachBodyIssues(crossing)).toBe(forEachBodyIssues(crossing));
  });
});

describe('selection inside bodies', () => {
  it('keeps selected body steps and drops ones that are gone', () => {
    const store = createEditorStore({
      graph: orderLoopGraph(),
      etag: etagA,
      revision: 1,
    });
    store.getState().selectNodes(['check']);
    store.getState().selectEdges(['check-reserve']);
    store
      .getState()
      .transact(
        updateWorkflowNode(store.getState().graph, 'check', { label: 'C' }),
      );
    expect(store.getState().selectedNodeId).toBe('check');
    expect(store.getState().selectedEdgeIds).toEqual(['check-reserve']);
    store.getState().transact(
      removeWorkflowElements(store.getState().graph, {
        nodeIds: ['loop'],
        edgeIds: [],
      }).graph,
    );
    expect(store.getState().selectedNodeIds).toEqual([]);
    expect(store.getState().selectedEdgeIds).toEqual([]);
  });
});
