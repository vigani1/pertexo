import {
  addBodyStep,
  addDefinitionNode,
  addStepAfter,
  linkWorkflowNodes,
  moveWorkflowNodes,
  updateWorkflowNode,
} from '@/features/workflow-editor/model/graph/commands';

import { displayPositions } from '@/features/workflow-editor/model/graph/for-each-body-layout';

import {
  removeWorkflowElements,
  restoreWorkflowElements,
} from '@/features/workflow-editor/model/graph/removal';

import {
  canLinkSteps,
  levelAt,
  locateStep,
  mapLevel,
  scopeOf,
} from '@/features/workflow-editor/model/graph/scopes';

import { createEditorStore } from '@/features/workflow-editor/model/state/store';

import type { WorkflowGraphContract } from '@pertexo/contracts';

import { describe, expect, it } from 'vitest';

import {
  bodyStepDefinition,
  forEachDefinition,
  link,
  orderLoopGraph,
  step,
} from '../../../support/fixtures/for-each';

import { emptyGraph, etagA } from '../../../support/fixtures/workflow-editor';

import { bodyOf, ids } from './body/fixture';

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
    expect(canLinkSteps(graph, 'check', 'reserve')).toBe(true);
    expect(canLinkSteps(graph, 'start', 'check')).toBe(false);
    expect(canLinkSteps(graph, 'check', 'loop')).toBe(false);
    expect(canLinkSteps(graph, 'check', 'check')).toBe(false);
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
      maxIterations: 50,
      maxConcurrency: 1,
      body: {
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
    const next = addBodyStep({
      graph: bare,
      loopId: 'loop',
      definition: bodyStepDefinition,
      position: { x: 0, y: 0 },
      ids: {
        nodeId: 'first',
        edgeId: 'unused',
      },
    });
    if (next === null) throw new Error('expected a body step');
    expect(ids(bodyOf(next).nodes)).toEqual(['first']);
    expect(bodyOf(next).inputPorts).toEqual(['item', 'ordinal']);
    expect(
      addBodyStep({
        graph: bare,
        loopId: 'nope',
        definition: bodyStepDefinition,
        position: { x: 0, y: 0 },
      }),
    ).toBeNull();
    expect(
      addBodyStep({
        graph: orderLoopGraph(),
        loopId: 'start',
        definition: bodyStepDefinition,
        position: {
          x: 0,
          y: 0,
        },
      }),
    ).toBeNull();
  });
  it('moves the steps after a For each out of the way when its body grows', () => {
    const graph: WorkflowGraphContract = {
      ...emptyGraph,
      nodes: [
        {
          ...step('loop', 'Each'),
          definition: { key: 'core.foreach', version: 1 },
          position: { x: 0, y: 0 },
        },
        { ...step('next', 'After'), position: { x: 352, y: 0 } },
        { ...step('far', 'Far'), position: { x: 2400, y: 900 } },
      ],
    };
    const next = addBodyStep({
      graph,
      loopId: 'loop',
      definition: bodyStepDefinition,
      position: { x: 400, y: 0 },
      ids: { nodeId: 'wide', edgeId: 'unused' },
    });
    if (next === null) throw new Error('expected a body step');
    const after = next.nodes.find((node) => node.id === 'next');
    // The body step 400px in widens the frame by far more than the gap.
    expect(after?.position.x).toBeGreaterThan(352 + 300);
    expect(after?.position.y).toBe(0);
    // A step neither beside nor beneath the container stays where it was.
    expect(next.nodes.find((node) => node.id === 'far')?.position).toEqual({
      x: 2400,
      y: 900,
    });
  });
  it('adds after a body step inside the same body, never outside it', () => {
    const graph = orderLoopGraph();
    const after = addBodyStep({
      graph,
      loopId: 'loop',
      definition: bodyStepDefinition,
      position: { x: 400, y: 0 },
      ids: { nodeId: 'notify', edgeId: 'reserve-notify' },
      from: { nodeId: 'reserve', port: 'out' },
    });
    if (after === null) throw new Error('expected a body step');
    expect(ids(bodyOf(after).nodes)).toEqual(['check', 'reserve', 'notify']);
    expect(bodyOf(after).edges.at(-1)).toEqual(
      link('reserve-notify', 'reserve', 'notify'),
    );
    expect(ids(after.nodes)).toEqual(ids(graph.nodes));
    expect(after.edges).toBe(graph.edges);
    // Quick add from a body step's port stays in its body too.
    const dropped = addStepAfter({
      graph,
      definition: bodyStepDefinition,
      position: { x: 0, y: 200 },
      from: { nodeId: 'check', port: 'out' },
      ids: { nodeId: 'side', edgeId: 'check-side' },
    });
    expect(ids(dropped === null ? [] : bodyOf(dropped).nodes)).toContain(
      'side',
    );
    expect(
      addBodyStep({
        graph,
        loopId: 'loop',
        definition: bodyStepDefinition,
        position: { x: 0, y: 0 },
        ids: undefined,
        from: { nodeId: 'start', port: 'out' },
      }),
    ).toBeNull();
  });
  it('connects body steps to each other and refuses connections across the body’s edge', () => {
    const graph = orderLoopGraph();
    const wired = linkWorkflowNodes(
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
      linkWorkflowNodes(graph, {
        source: 'start',
        sourceHandle: 'out',
        target: 'check',
        targetHandle: 'in',
      }),
    ).toBeNull();
    expect(
      linkWorkflowNodes(graph, {
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
});
