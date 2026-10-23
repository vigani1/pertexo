import { graph } from '../executable-workflow.js';

export function conditionGraph(sourcePort: string) {
  const base = graph();
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'condition',
        definition: { key: 'core.condition', version: 1 },
        inputMappings: {
          condition: { kind: 'literal' as const, value: true },
        },
      },
      {
        ...base.nodes[2],
        inputMappings: {
          result: {
            kind: 'node_output' as const,
            nodeId: 'condition',
            path: '$',
          },
        },
      },
    ],
    edges: [
      {
        id: 'manual-condition',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'condition', port: 'in' },
      },
      {
        id: 'condition-terminate',
        source: { nodeId: 'condition', port: sourcePort },
        target: { nodeId: 'terminate', port: 'in' },
      },
    ],
  };
}

export function switchGraph(sourcePort: string) {
  const base = graph();
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'switch',
        definition: { key: 'core.switch', version: 1 },
        config: {
          cases: [
            { id: 'case-02', equals: 'selected' },
            { id: 'case-01', equals: 'other' },
          ],
        },
        inputMappings: {
          value: { kind: 'literal' as const, value: 'selected' },
        },
      },
      {
        ...base.nodes[2],
        inputMappings: {
          result: {
            kind: 'node_output' as const,
            nodeId: 'switch',
            path: '$',
          },
        },
      },
    ],
    edges: [
      {
        id: 'manual-switch',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'switch', port: 'in' },
      },
      {
        id: 'switch-terminate',
        source: { nodeId: 'switch', port: sourcePort },
        target: { nodeId: 'terminate', port: 'in' },
      },
    ],
  };
}

export function parallelGraph(secondPort = 'branch-02') {
  const base = graph();
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'parallel',
        definition: { key: 'core.parallel', version: 1 },
        configVersion: 1,
        config: {
          branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
          maxConcurrency: 1,
        },
        inputMappings: {},
      },
      { ...base.nodes[1], id: 'left' },
      {
        ...base.nodes[2],
        id: 'right',
        inputMappings: {
          result: {
            kind: 'node_output' as const,
            nodeId: 'parallel',
            path: '$',
          },
        },
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
        source: { nodeId: 'parallel', port: secondPort },
        target: { nodeId: 'right', port: 'in' },
      },
    ],
  };
}

export function pairedParallelGraph() {
  const base = graph();
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'parallel',
        definition: { key: 'core.parallel', version: 1 },
        configVersion: 1,
        config: {
          branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
          maxConcurrency: 1,
        },
        inputMappings: {},
      },
      { ...base.nodes[1], id: 'left' },
      { ...base.nodes[1], id: 'right' },
      {
        ...base.nodes[1],
        id: 'merge',
        definition: { key: 'core.merge', version: 1 },
        configVersion: 1,
        config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
        inputMappings: {},
      },
      {
        ...base.nodes[2],
        inputMappings: {
          result: {
            kind: 'node_output' as const,
            nodeId: 'merge',
            path: '$',
          },
        },
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
  };
}

export function directPairedParallelGraph() {
  const paired = pairedParallelGraph();
  return {
    ...paired,
    nodes: paired.nodes.filter(({ id }) => id !== 'left' && id !== 'right'),
    edges: [
      paired.edges[0],
      {
        id: 'parallel-merge-01',
        source: { nodeId: 'parallel', port: 'branch-01' },
        target: { nodeId: 'merge', port: 'branch-01' },
      },
      {
        id: 'parallel-merge-02',
        source: { nodeId: 'parallel', port: 'branch-02' },
        target: { nodeId: 'merge', port: 'branch-02' },
      },
      paired.edges[5],
    ],
  };
}
