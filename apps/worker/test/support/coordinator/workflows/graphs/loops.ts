import { edgesFromTuples, manualNode, setNode } from '../nodes.js';

export function forEachGraph(maxConcurrency = 2) {
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      manualNode,
      {
        id: 'for-each',
        definition: { key: 'core.foreach', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {
          items: {
            kind: 'literal' as const,
            value: [
              { id: 'alpha', value: 11 },
              { id: 'beta', value: 22 },
              { id: 'gamma', value: 33 },
            ],
          },
        },
        connectionRefs: {},
        structured: {
          kind: 'for_each' as const,
          maxIterations: 3,
          maxConcurrency,
          body: {
            settings: {},
            inputPorts: ['item', 'ordinal'],
            outputPorts: ['result'],
            nodes: [
              {
                ...setNode('body-map', 0),
                position: { x: 0, y: 0 },
                inputMappings: {
                  item: {
                    kind: 'structured_input' as const,
                    port: 'item' as const,
                    path: '$',
                  },
                  ordinal: {
                    kind: 'structured_input' as const,
                    port: 'ordinal' as const,
                    path: '$',
                  },
                },
              },
              {
                ...setNode('body-sink', 0),
                position: { x: 10, y: 0 },
                inputMappings: {
                  result: {
                    kind: 'node_output' as const,
                    nodeId: 'body-map',
                    path: '$',
                  },
                },
              },
            ],
            edges: [
              {
                id: 'body-map-sink',
                source: { nodeId: 'body-map', port: 'out' },
                target: { nodeId: 'body-sink', port: 'in' },
              },
            ],
          },
        },
      },
      {
        id: 'outer-successor',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 20, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {
          result: {
            kind: 'node_output' as const,
            nodeId: 'for-each',
            path: '$',
          },
        },
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'manual-for-each',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'for-each', port: 'in' },
      },
      {
        id: 'for-each-outer',
        source: { nodeId: 'for-each', port: 'out' },
        target: { nodeId: 'outer-successor', port: 'in' },
      },
    ],
  };
}

export function nestedParallelGraph() {
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      manualNode,
      {
        id: 'loop',
        definition: { key: 'core.foreach', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {
          items: { kind: 'literal' as const, value: [1, 2] },
        },
        connectionRefs: {},
        structured: {
          kind: 'for_each' as const,
          maxIterations: 2,
          maxConcurrency: 2,
          body: {
            settings: {},
            inputPorts: ['item', 'ordinal'],
            outputPorts: ['result'],
            nodes: [
              {
                id: 'parallel',
                definition: { key: 'core.parallel', version: 1 },
                position: { x: 10, y: 0 },
                configVersion: 1,
                config: {
                  branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
                  maxConcurrency: 1,
                },
                inputMappings: {},
                connectionRefs: {},
              },
              setNode('left', -10),
              setNode('right', 10),
              {
                id: 'merge',
                definition: { key: 'core.merge', version: 1 },
                position: { x: 30, y: 0 },
                configVersion: 1,
                config: {
                  parallelNodeId: 'parallel',
                  policy: { kind: 'all' as const },
                },
                inputMappings: {},
                connectionRefs: {},
              },
            ],
            edges: edgesFromTuples([
              ['parallel-left', 'parallel', 'branch-01', 'left', 'in'],
              ['parallel-right', 'parallel', 'branch-02', 'right', 'in'],
              ['left-merge', 'left', 'out', 'merge', 'branch-01'],
              ['right-merge', 'right', 'out', 'merge', 'branch-02'],
            ]),
          },
        },
      },
      {
        id: 'terminate',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 20, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {
          result: {
            kind: 'node_output' as const,
            nodeId: 'loop',
            path: '$',
          },
        },
        connectionRefs: {},
      },
    ],
    edges: [
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
    ],
  };
}
