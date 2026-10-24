import type { WorkflowNode } from '@pertexo/workflow-model';
import { workflowNode } from '../../support/workflow-node.js';
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
        workflowNode('manual', 'core.manual'),
        workflowNode('terminate', 'core.terminate', {
          position: { x: 10, y: 0 },
          inputMappings: {
            result: { kind: 'node_output', nodeId: 'manual', path: '$' },
          },
        }),
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
  const setNode = (id: string, inputMappings: WorkflowNode['inputMappings']) =>
    workflowNode(id, 'core.set', { inputMappings });
  return {
    catalog,
    compiled: buildWorkflowExecutable({
      catalog,
      graph: {
        settings: { maxRunDurationMs: 60_000 },
        nodes: [
          workflowNode('manual', 'core.manual'),
          workflowNode('loop', 'core.foreach', {
            position: { x: 10, y: 0 },
            inputMappings: { items: { kind: 'literal', value: [1, 2] } },
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
          }),
          workflowNode('terminate', 'core.terminate', {
            position: { x: 20, y: 0 },
            inputMappings: {
              result: { kind: 'node_output', nodeId: 'loop', path: '$' },
            },
          }),
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
  const ordinaryNode = (id: string) =>
    workflowNode(id, 'core.set', {
      position: { x: 20, y: 0 },
      inputMappings: { value: { kind: 'literal', value: id } },
    });
  return {
    catalog,
    compiled: buildWorkflowExecutable({
      catalog,
      graph: {
        settings: { maxRunDurationMs: 60_000 },
        nodes: [
          workflowNode('manual', 'core.manual'),
          workflowNode('parallel', 'core.parallel', {
            position: { x: 10, y: 0 },
            config: {
              branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
              maxConcurrency: 1,
            },
          }),
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
          workflowNode('terminate', 'core.terminate', {
            position: { x: 40, y: 0 },
            inputMappings: {
              result: {
                kind: 'node_output',
                nodeId: 'merge',
                path: '$',
              },
            },
          }),
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
