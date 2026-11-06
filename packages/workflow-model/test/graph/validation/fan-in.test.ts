import { expect, it } from 'vitest';
import { validateWorkflowGraph } from '../../../src/graph/validation/validate-workflow-graph.js';
import { graph } from '../../support/authoring-owner.js';

it.each([100, 101])(
  'reports unsupported fan-in at the receiving step (%i predecessors)',
  (count) => {
    const base = graph();
    const step = base.nodes[0];
    if (step === undefined) throw new Error('Missing step fixture');
    const predecessors = Array.from({ length: count }, (_, n) => ({
      ...step,
      id: `source-${String(n)}`,
      inputMappings: {},
    }));
    const result = validateWorkflowGraph({
      ...base,
      nodes: [...predecessors, { ...step, id: 'sink', inputMappings: {} }],
      edges: predecessors.map((source) => ({
        id: `${source.id}-sink`,
        source: { nodeId: source.id, port: 'out' },
        target: { nodeId: 'sink', port: 'in' },
      })),
    });
    expect(result.ok).toBe(count === 100);
    if (count === 101)
      expect(result.issues).toEqual([
        {
          code: 'graph_limit',
          path: '$.nodes.sink',
          message:
            'A step can have at most 100 direct predecessors. Add an intermediate step to combine their outputs.',
        },
      ]);
  },
);
