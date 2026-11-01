import type {
  NodeAttemptLease,
  PublishedWorkflow,
} from '@pertexo/core/testing';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';

import {
  RUN_ID,
  VERSION_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  graph,
} from '../../support/attempts/execution-engine.js';

const NODE_RUN_ID = '55555555-5555-4555-8555-555555555555';

export const ATTEMPT_ID = '66666666-6666-4666-8666-666666666666';

export const OUTBOX_ID = '77777777-7777-4777-8777-777777777777';

export function forEachGraph() {
  const base = graph();
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'loop',
        definition: { key: 'core.foreach', version: 1 },
        inputMappings: {
          items: { kind: 'literal' as const, value: ['first', 'second'] },
        },
        structured: {
          kind: 'for_each' as const,
          maxIterations: 2,
          maxConcurrency: 1,
          body: {
            settings: {},
            inputPorts: ['item', 'ordinal'],
            outputPorts: ['result'],
            nodes: [
              {
                ...base.nodes[1],
                id: 'body-first',
                definition: { key: 'core.set', version: 1 },
                inputMappings: {
                  value: {
                    kind: 'structured_input' as const,
                    port: 'item' as const,
                    path: '$',
                  },
                },
              },
              {
                ...base.nodes[1],
                id: 'body-sink',
                definition: { key: 'core.set', version: 1 },
                inputMappings: {
                  value: {
                    kind: 'node_output' as const,
                    nodeId: 'body-first',
                    path: '$',
                  },
                },
              },
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
        ...base.nodes[1],
        inputMappings: {
          result: {
            kind: 'node_output' as const,
            nodeId: 'loop',
            path: '$',
          },
        },
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

export function branchGraph(kind: 'condition' | 'switch') {
  const base = graph();
  const branchNode = (id: string) => ({
    ...base.nodes[1],
    id,
    definition: { key: 'core.set', version: 1 },
    inputMappings: { value: { kind: 'literal' as const, value: id } },
  });
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...branchNode(kind),
        definition: { key: `core.${kind}`, version: 1 },
        config:
          kind === 'condition'
            ? {}
            : { cases: [{ id: 'case-01', equals: 'selected' }] },
        inputMappings:
          kind === 'condition'
            ? { condition: { kind: 'literal' as const, value: true } }
            : { value: { kind: 'literal' as const, value: 'selected' } },
      },
      branchNode('selected'),
      branchNode('unselected'),
    ],
    edges: [
      {
        id: `manual-${kind}`,
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: kind, port: 'in' },
      },
      {
        id: `${kind}-selected`,
        source: {
          nodeId: kind,
          port: kind === 'condition' ? 'true' : 'case-01',
        },
        target: { nodeId: 'selected', port: 'in' },
      },
      {
        id: `${kind}-unselected`,
        source: {
          nodeId: kind,
          port: kind === 'condition' ? 'false' : 'default',
        },
        target: { nodeId: 'unselected', port: 'in' },
      },
    ],
  };
}

export function parallelMergeGraph() {
  const base = graph();
  const setNode = (id: string) => ({
    ...base.nodes[1],
    id,
    definition: { key: 'core.set', version: 1 },
    inputMappings: {
      value: { kind: 'literal' as const, value: id },
    },
  });
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...setNode('parallel'),
        definition: { key: 'core.parallel', version: 1 },
        config: {
          branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
          maxConcurrency: 1,
        },
        inputMappings: {},
      },
      setNode('left'),
      setNode('right'),
      {
        ...setNode('merge'),
        definition: { key: 'core.merge', version: 1 },
        config: {
          parallelNodeId: 'parallel',
          policy: { kind: 'all' as const },
        },
        inputMappings: {},
      },
      {
        ...base.nodes[1],
        id: 'terminate',
        inputMappings: {
          result: {
            kind: 'node_output' as const,
            nodeId: 'merge',
            path: '$',
          },
        },
      },
    ],
    edges: (
      [
        ['manual-parallel', 'manual', 'out', 'parallel', 'in'],
        ['parallel-left', 'parallel', 'branch-01', 'left', 'in'],
        ['parallel-right', 'parallel', 'branch-02', 'right', 'in'],
        ['left-merge', 'left', 'out', 'merge', 'branch-01'],
        ['right-merge', 'right', 'out', 'merge', 'branch-02'],
        ['merge-terminate', 'merge', 'out', 'terminate', 'in'],
      ] as const
    ).map(([id, sourceNodeId, sourcePort, targetNodeId, targetPort]) => ({
      id,
      source: { nodeId: sourceNodeId, port: sourcePort },
      target: { nodeId: targetNodeId, port: targetPort },
    })),
  };
}

export function nestedBranchGraph() {
  const base = graph();
  const setNode = (id: string) => ({
    ...base.nodes[1],
    id,
    definition: { key: 'core.set', version: 1 },
    inputMappings: {
      value: { kind: 'literal' as const, value: id },
    },
  });
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...setNode('condition'),
        definition: { key: 'core.condition', version: 1 },
        inputMappings: {
          condition: { kind: 'literal' as const, value: true },
        },
      },
      {
        ...setNode('switch'),
        definition: { key: 'core.switch', version: 1 },
        config: { cases: [{ id: 'case-01', equals: 'selected' }] },
        inputMappings: {
          value: { kind: 'literal' as const, value: 'selected' },
        },
      },
      setNode('selected'),
      setNode('condition-other'),
      setNode('switch-other'),
    ],
    edges: (
      [
        ['manual-condition', 'manual', 'out', 'condition', 'in'],
        ['condition-switch', 'condition', 'true', 'switch', 'in'],
        ['condition-other', 'condition', 'false', 'condition-other', 'in'],
        ['switch-selected', 'switch', 'case-01', 'selected', 'in'],
        ['switch-other', 'switch', 'default', 'switch-other', 'in'],
      ] as const
    ).map(([id, sourceNodeId, sourcePort, targetNodeId, targetPort]) => ({
      id,
      source: { nodeId: sourceNodeId, port: sourcePort },
      target: { nodeId: targetNodeId, port: targetPort },
    })),
  };
}

export function compiledProjection(
  workflowGraph: Parameters<typeof buildWorkflowExecutable>[0]['graph'],
  catalog: ReturnType<typeof composeExecutableCatalog>,
): PublishedWorkflow {
  const executable = buildWorkflowExecutable({
    graph: workflowGraph,
    catalog,
  });
  return {
    id: VERSION_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 1,
    checksum: executable.checksum,
    executableJson: executable.envelope,
  };
}

export function fixture(nodeId: 'manual' | 'terminate') {
  const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);
  const executable = buildWorkflowExecutable({ graph: graph(), catalog });
  const projection: PublishedWorkflow = {
    id: VERSION_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 1,
    checksum: executable.checksum,
    executableJson: executable.envelope,
  };
  const lease: NodeAttemptLease = {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    workflowVersionId: VERSION_ID,
    nodeRunId: NODE_RUN_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    admissionKind: 'execute',
    invocationKey: `${VERSION_ID}|${nodeId}|b:|i:`,
    nodeId,
    sideEffectClass: 'safe',
    workerId: 'worker-1',
    fenceToken: 1,
    leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
    delivery: { outboxEventId: OUTBOX_ID, payloadChecksum: 'a'.repeat(64) },
  };
  return { catalog, projection, lease };
}
