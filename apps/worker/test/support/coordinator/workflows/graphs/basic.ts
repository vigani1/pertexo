import { edgesFromTuples, manualNode, setNode } from '../nodes.js';

/** Manual, then Set, then Terminate: the linear proof workflow. */
export function linearGraph() {
  const node = (id: string, key: string, x: number) => ({
    id,
    definition: { key, version: 1 },
    position: { x, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  });
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      node('manual', 'core.manual', 0),
      {
        ...node('set', 'core.set', 10),
        inputMappings: {
          literal: { kind: 'literal', value: 1 },
          fromRun: { kind: 'run_input', path: '$.name' },
        },
      },
      {
        ...node('terminate', 'core.terminate', 20),
        inputMappings: {
          result: { kind: 'node_output', nodeId: 'set', path: '$' },
        },
      },
    ],
    edges: edgesFromTuples([
      ['manual-set', 'manual', 'out', 'set', 'in'],
      ['set-terminate', 'set', 'out', 'terminate', 'in'],
    ]),
  };
}

export function branchGraph(kind: 'condition' | 'switch') {
  const control =
    kind === 'condition'
      ? {
          id: 'condition',
          definition: { key: 'core.condition', version: 1 },
          position: { x: 10, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {
            condition: { kind: 'literal' as const, value: true },
          },
          connectionRefs: {},
        }
      : {
          id: 'switch',
          definition: { key: 'core.switch', version: 1 },
          position: { x: 10, y: 0 },
          configVersion: 1,
          config: { cases: [{ id: 'case-01', equals: 'selected' }] },
          inputMappings: {
            value: { kind: 'literal' as const, value: 'selected' },
          },
          connectionRefs: {},
        };
  const controlId = control.id;
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      manualNode,
      control,
      setNode('selected', -10),
      setNode('unselected', 10),
    ],
    edges: [
      {
        id: `manual-${controlId}`,
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: controlId, port: 'in' },
      },
      {
        id: `${controlId}-selected`,
        source: {
          nodeId: controlId,
          port: kind === 'condition' ? 'true' : 'case-01',
        },
        target: { nodeId: 'selected', port: 'in' },
      },
      {
        id: `${controlId}-unselected`,
        source: {
          nodeId: controlId,
          port: kind === 'condition' ? 'false' : 'default',
        },
        target: { nodeId: 'unselected', port: 'in' },
      },
    ],
  };
}

export function parallelGraph() {
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      manualNode,
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
      {
        id: 'terminate',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 40, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: edgesFromTuples([
      ['manual-parallel', 'manual', 'out', 'parallel', 'in'],
      ['parallel-left', 'parallel', 'branch-01', 'left', 'in'],
      ['parallel-right', 'parallel', 'branch-02', 'right', 'in'],
      ['left-merge', 'left', 'out', 'merge', 'branch-01'],
      ['right-merge', 'right', 'out', 'merge', 'branch-02'],
      ['merge-terminate', 'merge', 'out', 'terminate', 'in'],
    ]),
  };
}

export function waitGraph() {
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      manualNode,
      {
        id: 'wait',
        definition: { key: 'core.wait', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: { durationSeconds: 3_600 },
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'terminate',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 20, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'manual-wait',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'wait', port: 'in' },
      },
      {
        id: 'wait-terminate',
        source: { nodeId: 'wait', port: 'out' },
        target: { nodeId: 'terminate', port: 'in' },
      },
    ],
  };
}
