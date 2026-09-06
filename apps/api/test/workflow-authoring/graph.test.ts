import { describe, expect, it } from 'vitest';

import {
  parseWorkflowGraphDraft,
  validateWorkflowGraph,
} from '../../src/workflow-authoring/graph.js';

describe('workflow authoring validation seam', () => {
  it('accepts the canonical empty draft and rejects malformed graph input', () => {
    expect(
      parseWorkflowGraphDraft({
        schemaVersion: 1,
        nodes: [],
        edges: [],
        settings: {},
      }),
    ).toEqual({ schemaVersion: 1, nodes: [], edges: [], settings: {} });
    expect(() =>
      parseWorkflowGraphDraft({ schemaVersion: 1, nodes: [], edges: [] }),
    ).toThrow();
  });

  it('reports cycles and dangling edges', () => {
    const graph = parseWorkflowGraphDraft({
      schemaVersion: 1,
      nodes: [
        {
          id: 'a',
          definition: { key: 'manual', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {},
          connectionRefs: {},
        },
        {
          id: 'b',
          definition: { key: 'manual', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {},
          connectionRefs: {},
        },
      ],
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
