import { workflowNode } from '../support/workflow-node.js';
import { describe, expect, it } from 'vitest';

import {
  parseWorkflowGraphDraft,
  validateWorkflowGraph,
} from '../../src/workflow-authoring/graph.js';

describe('workflow authoring validation seam', () => {
  it('accepts the canonical empty draft and rejects malformed graph input', () => {
    expect(
      parseWorkflowGraphDraft({
        nodes: [],
        edges: [],
        settings: {},
      }),
    ).toEqual({ nodes: [], edges: [], settings: {} });
    expect(() => parseWorkflowGraphDraft({ nodes: [], edges: [] })).toThrow();
  });

  it('reports cycles and dangling edges', () => {
    const graph = parseWorkflowGraphDraft({
      nodes: [workflowNode('a', 'manual'), workflowNode('b', 'manual')],
      edges: [
        {
          id: 'ab',
          source: { nodeId: 'a', port: 'out' },
          target: { nodeId: 'b', port: 'in' },
        },
        {
          id: 'ba',
          source: { nodeId: 'b', port: 'out' },
          target: { nodeId: 'a', port: 'in' },
        },
        {
          id: 'missing',
          source: { nodeId: 'missing', port: 'out' },
          target: { nodeId: 'a', port: 'in' },
        },
      ],
      settings: {},
    });
    const result = validateWorkflowGraph(graph);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['cycle', 'dangling_edge']),
    );
  });
});
