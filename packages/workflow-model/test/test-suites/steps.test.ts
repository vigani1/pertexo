import { expect, it } from 'vitest';
import type { WorkflowGraph, WorkflowNode } from '../../src/graph/contract.js';
import { workflowTestStepChoices } from '../../src/authoring/test-suites/steps.js';
function node(id: string, label?: string): WorkflowNode {
  return {
    id,
    definition: { key: 'core.set', version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    ...(label === undefined ? {} : { label }),
  };
}
it('names current and frozen nested steps consistently and bounds Unicode labels without breaking a character', () => {
  const graph: WorkflowGraph = {
    settings: {},
    edges: [],
    nodes: [
      {
        ...node('loop', '  Items  '),
        structured: {
          kind: 'for_each',
          maxIterations: 1,
          maxConcurrency: 1,
          body: {
            settings: {},
            inputPorts: ['in'],
            outputPorts: ['out'],
            edges: [],
            nodes: [node('inner', '🧵'.repeat(200))],
          },
        },
      },
      node('plain', '   '),
    ],
  };
  expect(workflowTestStepChoices(graph)).toEqual([
    { nodeId: 'loop', label: 'Items' },
    { nodeId: 'inner', label: '🧵'.repeat(128) },
    { nodeId: 'plain', label: 'core.set' },
  ]);
});
