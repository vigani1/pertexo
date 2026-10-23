import { invocationKey } from '../../src/transition/scheduling/loops.js';

export {
  boundedPolicy,
  jsonataPolicy,
  schema,
  manifest,
  nodeCatalog,
} from './catalog.js';
export {
  conditionGraph,
  switchGraph,
  parallelGraph,
  pairedParallelGraph,
  directPairedParallelGraph,
} from './graphs/branches.js';
export { forEachGraph, nestedForEachGraph } from './graphs/loops.js';
export function graph(reverse = false) {
  const nodes = [
    {
      id: 'manual',
      definition: { key: 'core.manual', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    },
    {
      id: 'set',
      definition: { key: 'core.set', version: 1 },
      position: { x: 10, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {
        literal: { kind: 'literal', value: 1 },
        fromRun: { kind: 'run_input', path: '$.name' },
      },
      connectionRefs: {},
    },
    {
      id: 'terminate',
      definition: { key: 'core.terminate', version: 1 },
      position: { x: 20, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {
        result: { kind: 'node_output', nodeId: 'set', path: '$' },
      },
      connectionRefs: {},
    },
  ] as const;
  const edges = [
    {
      id: 'manual-set',
      source: { nodeId: 'manual', port: 'out' },
      target: { nodeId: 'set', port: 'in' },
    },
    {
      id: 'set-terminate',
      source: { nodeId: 'set', port: 'out' },
      target: { nodeId: 'terminate', port: 'in' },
    },
  ] as const;
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: reverse ? [...nodes].reverse() : nodes,
    edges: reverse ? [...edges].reverse() : edges,
  };
}

/** Completed root-scoped upstream outputs, as the database hands them to an attempt. */
export function completedOutputs(
  outputs: Readonly<Record<string, unknown>>,
  workflowVersionId = '00000000-0000-4000-8000-000000000001',
) {
  return Object.entries(outputs).map(([nodeId, value]) => ({
    nodeId,
    invocationKey: invocationKey({ workflowVersionId, nodeId }),
    value,
  }));
}
