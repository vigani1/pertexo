import { updateWorkflowNode } from '@/features/workflow-editor/model/graph/commands';

import { duplicateWorkflowNodes } from '@/features/workflow-editor/model/graph/copies';

import {
  BODY_ORIGIN,
  bodyFrame,
  levelPositions,
  LOOP_FRAME,
} from '@/features/workflow-editor/model/graph/for-each-body-layout';

import {
  bodyIssuesOf,
  forEachBodyIssues,
} from '@/features/workflow-editor/model/graph/for-each-body-rules';

import { removeWorkflowElements } from '@/features/workflow-editor/model/graph/removal';

import { createEditorStore } from '@/features/workflow-editor/model/state/store';

import type { WorkflowGraphContract } from '@pertexo/contracts';

import { describe, expect, it } from 'vitest';

import {
  link,
  orderLoopGraph,
  step,
} from '../../../../support/fixtures/for-each';

import {
  emptyGraph,
  etagA,
} from '../../../../support/fixtures/workflow-editor';

import { bodyOf, ids, withBody } from './fixture';

describe('body graph commands', () => {
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
          'The body ends in 2 steps: “B” and “C”. Link them into one last step; its output is each item’s result.',
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
