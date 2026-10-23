import type { WorkflowGraph } from '../../src/graph/contract.js';

export const node = (id: string) => ({
  id,
  definition: { key: 'core.set', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
});
export const forEachNode = (id: string, bodyNodes = [node(`${id}-body`)]) => ({
  ...node(id),
  definition: { key: 'core.foreach', version: 1 },
  structured: {
    kind: 'for_each' as const,
    maxIterations: 10,
    maxConcurrency: 2,
    body: {
      ...graph(bodyNodes),
      inputPorts: ['item', 'ordinal'],
      outputPorts: ['result'],
    },
  },
});
export const graph = (
  nodes: WorkflowGraph['nodes'],
  edges: WorkflowGraph['edges'] = [],
): WorkflowGraph => ({ nodes, edges, settings: {} });
