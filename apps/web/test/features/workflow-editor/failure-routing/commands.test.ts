import {
  createWorkflowNodeFixture,
  createWorkflowEdgeFixture,
} from '../../../support/fixtures/graph';
import { describe, expect, it } from 'vitest';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { inspectWorkflowFailureRoutes } from '@pertexo/workflow-model';
import { failureRemoval } from '@/features/workflow-editor/model/failure-routing/commands';
import { canOwnFailureLink } from '@/features/workflow-editor/model/failure-routing/eligibility';
import {
  removeWorkflowElements,
  restoreWorkflowElements,
} from '@/features/workflow-editor/model/graph/removal';
import { linkWorkflowNodes } from '@/features/workflow-editor/model/graph/commands';
import { duplicateWorkflowNodes } from '@/features/workflow-editor/model/graph/copies';
import { projectWorkflowGraph } from '@/features/workflow-editor/model/graph/adapter';
import { createEditorStore } from '@/features/workflow-editor/model/state/store';
import {
  directPredecessorOptions,
  inputMappingRowsFor,
  validateInputMappingRows,
} from '@/features/workflow-editor/model/inspector/input-mappings/draft';

function graph(): WorkflowGraphContract {
  return {
    settings: {},
    nodes: [
      createWorkflowNodeFixture({
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
      }),
      createWorkflowNodeFixture({ id: 'source' }),
      createWorkflowNodeFixture({
        id: 'stop',
        definition: { key: 'core.terminate', version: 1 },
      }),
      {
        ...createWorkflowNodeFixture({ id: 'handler' }),
        inputMappings: {
          reason: {
            kind: 'node_failure',
            nodeId: 'source',
            path: '$.safeErrorCode',
          },
        },
      },
      createWorkflowNodeFixture({
        id: 'handler-stop',
        definition: { key: 'core.terminate', version: 1 },
      }),
    ],
    edges: [
      createWorkflowEdgeFixture({
        id: 'start',
        source: 'manual',
        target: 'source',
      }),
      createWorkflowEdgeFixture({
        id: 'normal',
        source: 'source',
        target: 'stop',
      }),
      createWorkflowEdgeFixture({
        id: 'failure',
        source: 'source',
        target: 'handler',
        sourcePort: '__failure',
      }),
      createWorkflowEdgeFixture({
        id: 'handler-end',
        source: 'handler',
        target: 'handler-stop',
      }),
    ],
  };
}
describe('failure path graph commands', () => {
  it('removes the owned chain with its link and restores its exact mappings in one undo', () => {
    const before = graph();
    const proposal = failureRemoval(before, {
      nodeIds: [],
      edgeIds: ['failure'],
    });
    expect(proposal.kind).toBe('handler');
    if (proposal.kind !== 'handler')
      throw new Error('Expected handler removal');
    expect(proposal.selection.nodeIds).toEqual(['handler', 'handler-stop']);
    const result = removeWorkflowElements(before, proposal.selection);
    expect(result.graph.nodes.map((n) => n.id)).toEqual([
      'manual',
      'source',
      'stop',
    ]);
    expect(inspectWorkflowFailureRoutes(result.graph)).toEqual({
      kind: 'ordinary',
    });
    expect(restoreWorkflowElements(result.graph, result.removed)).toEqual(
      before,
    );
    const store = createEditorStore({
      graph: before,
      etag: 'opaque',
      revision: 1,
    });
    store.getState().transact(result.graph);
    store.getState().undo();
    expect(store.getState().graph).toBe(before);
  });
  it('protects entry deletion and internal-link deletion from leaving ordinary handler roots', () => {
    for (const selection of [
      { nodeIds: ['handler'], edgeIds: [] },
      { nodeIds: [], edgeIds: ['handler-end'] },
      { nodeIds: ['source'], edgeIds: [] },
    ]) {
      const proposal = failureRemoval(graph(), selection);
      expect(proposal.kind).toBe('handler');
      if (proposal.kind !== 'handler') throw new Error('Expected owned chain');
      expect(proposal.selection.nodeIds).toContain('handler');
      expect(proposal.selection.nodeIds).toContain('handler-stop');
    }
    expect(
      failureRemoval(graph(), { nodeIds: ['handler-stop'], edgeIds: [] }).kind,
    ).toBe('ordinary');
  });
  it('does not guess ownership in a convergent invalid draft', () => {
    const invalid = {
      ...graph(),
      edges: [
        ...graph().edges,
        createWorkflowEdgeFixture({
          id: 'convergence',
          source: 'manual',
          target: 'handler',
        }),
      ],
    };
    expect(
      failureRemoval(invalid, { nodeIds: [], edgeIds: ['failure'] }),
    ).toMatchObject({ kind: 'blocked' });
  });
  it('remaps failure input references when source and handler are copied together', () => {
    let index = 0;
    const result = duplicateWorkflowNodes(
      graph(),
      ['source', 'handler', 'handler-stop'],
      () => `copy-${String(++index)}`,
    );
    const handler = result.graph.nodes.find((n) => n.id === result.nodeIds[1]);
    expect(handler?.inputMappings.reason).toEqual({
      kind: 'node_failure',
      nodeId: result.nodeIds[0],
      path: '$.safeErrorCode',
    });
  });
  it('keeps a failed source out of successful-output mappings and validates only safe fields', () => {
    const current = graph();
    expect(directPredecessorOptions(current, 'handler')).toEqual([]);
    const rows = inputMappingRowsFor(
      current.nodes.find((n) => n.id === 'handler')?.inputMappings ?? {},
    );
    expect(validateInputMappingRows(rows, current, 'handler').errors).toEqual(
      {},
    );
    expect(validateInputMappingRows(rows, current, 'stop').errors).not.toEqual(
      {},
    );
    expect(
      validateInputMappingRows(
        [
          {
            id: 'unsafe',
            destinationKey: 'secret',
            kind: 'node_failure',
            nodeId: 'source',
            path: '$.providerMessage',
          },
        ],
        current,
        'handler',
      ).errors,
    ).not.toEqual({});
  });
  it('labels an eligible failure output and frayed failure link while excluding handler and control sources', () => {
    const current = graph();
    expect(canOwnFailureLink(current, 'source')).toBe(true);
    expect(canOwnFailureLink(current, 'handler')).toBe(false);
    expect(canOwnFailureLink(current, 'manual')).toBe(false);
    const projection = projectWorkflowGraph(current, []);
    expect(
      projection.nodes.find((n) => n.id === 'source')?.data.failureEligible,
    ).toBe(true);
    expect(
      projection.nodes.find((n) => n.id === 'handler')?.data.failureEligible,
    ).toBe(false);
    expect(
      projection.edges.find((e) => e.id === 'failure')?.data?.failure,
    ).toBe(true);
  });
  it('uses shared validation for a handler link and refuses normal-path convergence', () => {
    const current = graph();
    const ordinary = {
      ...current,
      nodes: current.nodes.map((n) => ({ ...n, inputMappings: {} })),
      edges: current.edges.filter((e) => e.id !== 'failure'),
    };
    expect(
      linkWorkflowNodes(ordinary, {
        source: 'source',
        sourceHandle: '__failure',
        target: 'handler',
        targetHandle: 'in',
      }),
    ).not.toBeNull();
    expect(
      linkWorkflowNodes(current, {
        source: 'stop',
        sourceHandle: 'out',
        target: 'handler',
        targetHandle: 'in',
      }),
    ).toBeNull();
  });
});
