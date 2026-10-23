import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';

export function executable() {
  const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
  return buildWorkflowExecutable({
    catalog,
    graph: {
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
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
          id: 'terminate',
          definition: { key: 'core.terminate', version: 1 },
          position: { x: 10, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {
            result: { kind: 'node_output', nodeId: 'manual', path: '$' },
          },
          connectionRefs: {},
        },
      ],
      edges: [
        {
          id: 'manual-terminate',
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: 'terminate', port: 'in' },
        },
      ],
    },
  });
}

export function forEachExecutable() {
  const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
  const setNode = (id: string, inputMappings: Record<string, unknown>) => ({
    id,
    definition: { key: 'core.set', version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings,
    connectionRefs: {},
  });
  return {
    catalog,
    compiled: buildWorkflowExecutable({
      catalog,
      graph: {
        settings: { maxRunDurationMs: 60_000 },
        nodes: [
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
            id: 'loop',
            definition: { key: 'core.foreach', version: 1 },
            position: { x: 10, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: { items: { kind: 'literal', value: [1, 2] } },
            connectionRefs: {},
            structured: {
              kind: 'for_each',
              maxIterations: 2,
              maxConcurrency: 1,
              body: {
                settings: {},
                inputPorts: ['item', 'ordinal'],
                outputPorts: ['result'],
                nodes: [
                  setNode('body-first', {
                    value: {
                      kind: 'structured_input',
                      port: 'item',
                      path: '$',
                    },
                  }),
                  setNode('body-sink', {
                    value: {
                      kind: 'node_output',
                      nodeId: 'body-first',
                      path: '$',
                    },
                  }),
                ],
                edges: [
                  {
                    id: 'body-edge',
                    source: { nodeId: 'body-first', port: 'out' },
                    target: { nodeId: 'body-sink', port: 'in' },
                  },
                ],
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
              result: { kind: 'node_output', nodeId: 'loop', path: '$' },
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
      },
    }),
  };
}

export function parallelExecutable() {
  const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
  const ordinaryNode = (id: string) => ({
    id,
    definition: { key: 'core.set', version: 1 },
    position: { x: 20, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: { value: { kind: 'literal' as const, value: id } },
    connectionRefs: {},
  });
  return {
    catalog,
    compiled: buildWorkflowExecutable({
      catalog,
      graph: {
        settings: { maxRunDurationMs: 60_000 },
        nodes: [
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
            id: 'parallel',
            definition: { key: 'core.parallel', version: 1 },
            position: { x: 10, y: 0 },
            configVersion: 1,
            config: {
              branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
              maxConcurrency: 1,
            },
            inputMappings: {},
            connectionRefs: {},
          },
          ordinaryNode('left'),
          ordinaryNode('right'),
          {
            ...ordinaryNode('merge'),
            definition: { key: 'core.merge', version: 1 },
            configVersion: 1,
            config: {
              parallelNodeId: 'parallel',
              policy: { kind: 'all' },
            },
            inputMappings: {},
          },
          {
            id: 'terminate',
            definition: { key: 'core.terminate', version: 1 },
            position: { x: 40, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {
              result: {
                kind: 'node_output',
                nodeId: 'merge',
                path: '$',
              },
            },
            connectionRefs: {},
          },
        ],
        edges: [
          {
            id: 'manual-parallel',
            source: { nodeId: 'manual', port: 'out' },
            target: { nodeId: 'parallel', port: 'in' },
          },
          {
            id: 'parallel-left',
            source: { nodeId: 'parallel', port: 'branch-01' },
            target: { nodeId: 'left', port: 'in' },
          },
          {
            id: 'parallel-right',
            source: { nodeId: 'parallel', port: 'branch-02' },
            target: { nodeId: 'right', port: 'in' },
          },
          {
            id: 'left-merge',
            source: { nodeId: 'left', port: 'out' },
            target: { nodeId: 'merge', port: 'branch-01' },
          },
          {
            id: 'right-merge',
            source: { nodeId: 'right', port: 'out' },
            target: { nodeId: 'merge', port: 'branch-02' },
          },
          {
            id: 'merge-terminate',
            source: { nodeId: 'merge', port: 'out' },
            target: { nodeId: 'terminate', port: 'in' },
          },
        ],
      },
    }),
  };
}
