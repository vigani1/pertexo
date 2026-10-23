import { graph } from '../executable-workflow.js';

export function forEachGraph(reverse = false) {
  const base = graph();
  const bodyNodes = [
    {
      ...base.nodes[1],
      id: 'body-first',
      inputMappings: {
        value: {
          kind: 'structured_input' as const,
          port: 'item',
          path: '$',
        },
      },
    },
    {
      ...base.nodes[1],
      id: 'body-sink',
      inputMappings: {
        value: {
          kind: 'node_output' as const,
          nodeId: 'body-first',
          path: '$',
        },
      },
    },
  ];
  const bodyEdges = [
    {
      id: 'body-edge',
      source: { nodeId: 'body-first', port: 'out' },
      target: { nodeId: 'body-sink', port: 'in' },
    },
  ];
  const loop = {
    ...base.nodes[1],
    id: 'loop',
    definition: { key: 'core.foreach', version: 1 },
    inputMappings: {
      items: { kind: 'literal' as const, value: [1, 2] },
    },
    structured: {
      kind: 'for_each' as const,
      maxIterations: 2,
      maxConcurrency: 1,
      body: {
        settings: {},
        nodes: reverse ? [...bodyNodes].reverse() : bodyNodes,
        edges: reverse ? [...bodyEdges].reverse() : bodyEdges,
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
      },
    },
  };
  const nodes = [
    base.nodes[0],
    loop,
    {
      ...base.nodes[2],
      inputMappings: {
        result: {
          kind: 'node_output' as const,
          nodeId: 'loop',
          path: '$',
        },
      },
    },
  ];
  const edges = [
    {
      id: 'manual-loop',
      source: { nodeId: 'manual', port: 'out' },
      target: { nodeId: 'loop', port: 'in' },
    },
    {
      id: 'loop-terminate',
      source: { nodeId: 'loop', port: 'out' },
      target: { nodeId: 'terminate', port: 'in' },
    },
  ];
  return {
    settings: base.settings,
    nodes: reverse ? [...nodes].reverse() : nodes,
    edges: reverse ? [...edges].reverse() : edges,
  };
}

export function nestedForEachGraph() {
  const result = structuredClone(forEachGraph());
  const outer = result.nodes.find(({ id }) => id === 'loop');
  if (outer === undefined || !('structured' in outer))
    throw new Error('outer For Each missing');
  const inner = outer.structured.body.nodes.find(
    ({ id }) => id === 'body-first',
  );
  if (inner === undefined) throw new Error('inner For Each missing');
  Object.assign(inner, {
    definition: { key: 'core.foreach', version: 1 },
    inputMappings: {
      items: { kind: 'structured_input', port: 'item', path: '$' },
    },
    structured: {
      kind: 'for_each',
      maxIterations: 2,
      maxConcurrency: 1,
      body: {
        settings: {},
        nodes: [
          {
            ...outer.structured.body.nodes[1],
            id: 'nested-body',
            inputMappings: {
              value: {
                kind: 'structured_input',
                port: 'item',
                path: '$',
              },
            },
          },
        ],
        edges: [],
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
      },
    },
  });
  return result;
}
