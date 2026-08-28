import {
  createRegistryRelease,
  type ExecutorLifecycle,
  type NodeManifest,
  type PolicyReference,
  type RegistryRelease,
} from '@pertexo/node-sdk';
import { NodeExecutionAbortedError } from '@pertexo/node-sdk/server';
import * as productionEngine from '../src/index.js';
import * as testingEngine from '../src/testing.js';
import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  computeWorkflowExecutableChecksumV2,
  createExecutableCompatibilityReleaseSupport,
  createExecutableCompatibilityReleaseHistory,
  createCheckpoint,
  createCheckpointV2,
  describeExecutableCompatibilityRelease,
  executeNodeAttempt,
  invocationKey,
  parseWorkflowExecutableV2,
  providerIdempotencyKey,
  resolveSingleNodePreviewInput,
  verifyWorkflowExecutableV2,
  WORKFLOW_EXECUTABLE_LIMITS_V2,
} from '../src/index.js';
import { createHash } from 'node:crypto';

export {
  createRegistryRelease,
  NodeExecutionAbortedError,
  productionEngine,
  testingEngine,
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  computeWorkflowExecutableChecksumV2,
  createExecutableCompatibilityReleaseSupport,
  createExecutableCompatibilityReleaseHistory,
  createCheckpoint,
  createCheckpointV2,
  describeExecutableCompatibilityRelease,
  executeNodeAttempt,
  invocationKey,
  parseWorkflowExecutableV2,
  providerIdempotencyKey,
  resolveSingleNodePreviewInput,
  verifyWorkflowExecutableV2,
  WORKFLOW_EXECUTABLE_LIMITS_V2,
  createHash,
};
export type {
  ExecutorLifecycle,
  NodeManifest,
  PolicyReference,
  RegistryRelease,
};

export const boundedPolicy = { key: 'node.json.bounded', version: 1 } as const;
export const jsonataPolicy = { key: 'jsonata.restricted', version: 1 } as const;
export const schema = { type: 'object', additionalProperties: true } as const;

export function manifest(
  key:
    | 'core.condition'
    | 'core.foreach'
    | 'core.manual'
    | 'core.merge'
    | 'core.parallel'
    | 'core.schedule'
    | 'core.set'
    | 'core.switch'
    | 'core.terminate'
    | 'core.webhook'
    | 'test.unrelated',
  policies: readonly PolicyReference[] = [boundedPolicy],
): NodeManifest {
  return {
    schemaVersion: 1,
    definition: { key, version: 1 },
    family:
      key === 'core.manual' || key === 'core.schedule' || key === 'core.webhook'
        ? 'trigger'
        : key === 'core.terminate'
          ? 'output'
          : key === 'core.condition' ||
              key === 'core.switch' ||
              key === 'core.foreach' ||
              key === 'core.parallel' ||
              key === 'core.merge'
            ? 'logic'
            : 'transform',
    configVersion: 1,
    configSchema: schema,
    inputSchema: schema,
    outputSchema: schema,
    ports: {
      inputs:
        key === 'core.manual' ||
        key === 'core.schedule' ||
        key === 'core.webhook'
          ? []
          : key === 'core.merge'
            ? [
                'branch-01',
                'branch-02',
                'branch-03',
                'branch-04',
                'branch-05',
                'branch-06',
                'branch-07',
                'branch-08',
                'branch-09',
                'branch-10',
                'branch-11',
                'branch-12',
                'branch-13',
                'branch-14',
                'branch-15',
                'branch-16',
              ]
            : ['in'],
      outputs:
        key === 'core.terminate'
          ? []
          : key === 'core.condition'
            ? ['true', 'false']
            : key === 'core.switch'
              ? [
                  'case-01',
                  'case-02',
                  'case-03',
                  'case-04',
                  'case-05',
                  'case-06',
                  'case-07',
                  'case-08',
                  'case-09',
                  'case-10',
                  'case-11',
                  'case-12',
                  'case-13',
                  'case-14',
                  'case-15',
                  'case-16',
                  'default',
                ]
              : key === 'core.parallel'
                ? [
                    'branch-01',
                    'branch-02',
                    'branch-03',
                    'branch-04',
                    'branch-05',
                    'branch-06',
                    'branch-07',
                    'branch-08',
                    'branch-09',
                    'branch-10',
                    'branch-11',
                    'branch-12',
                    'branch-13',
                    'branch-14',
                    'branch-15',
                    'branch-16',
                  ]
                : ['out'],
    },
    credentialRequirements: [],
    connectionRequirements: [],
    retryClass: 'safe',
    resourceClass: 'cpu',
    capabilities: key === 'core.terminate' ? ['terminates_run'] : [],
    lifecycle: 'active',
    executor: { key, version: 1 },
    executorAbi: 1,
    policyReferences: policies,
  };
}

export function nodeRelease(input?: {
  readonly epoch?: number;
  readonly executorLifecycle?: ExecutorLifecycle;
  readonly mutateSet?: boolean;
  readonly unrelated?: boolean;
  readonly driftCapability?: boolean;
  readonly manualRetryClass?: NodeManifest['retryClass'];
  readonly setRetryClass?: NodeManifest['retryClass'];
  readonly condition?: boolean;
  readonly switch?: boolean;
  readonly parallel?: boolean;
  readonly merge?: boolean;
  readonly forEach?: boolean;
  readonly schedule?: boolean;
  readonly webhook?: boolean;
}): RegistryRelease {
  const definitions = [
    manifest('core.manual'),
    manifest(
      'core.set',
      input?.mutateSet ? [jsonataPolicy] : [boundedPolicy, jsonataPolicy],
    ),
    manifest('core.terminate'),
    ...(input?.schedule ? [manifest('core.schedule')] : []),
    ...(input?.webhook ? [manifest('core.webhook')] : []),
    ...(input?.condition ? [manifest('core.condition')] : []),
    ...(input?.switch ? [manifest('core.switch')] : []),
    ...(input?.parallel ? [manifest('core.parallel')] : []),
    ...(input?.merge ? [manifest('core.merge')] : []),
    ...(input?.forEach ? [manifest('core.foreach')] : []),
    ...(input?.unrelated ? [manifest('test.unrelated')] : []),
  ];
  const manual = definitions.find(
    ({ definition }) => definition.key === 'core.manual',
  );
  const set = definitions.find(
    ({ definition }) => definition.key === 'core.set',
  );
  if (manual !== undefined && input?.manualRetryClass !== undefined)
    Object.assign(manual, { retryClass: input.manualRetryClass });
  if (set !== undefined && input?.setRetryClass !== undefined)
    Object.assign(set, { retryClass: input.setRetryClass });
  if (input?.driftCapability) {
    if (set !== undefined) Object.assign(set, { capabilities: ['drifted'] });
  }
  return createRegistryRelease({
    epoch: input?.epoch ?? 1,
    definitions,
    executors: definitions.map((definition) => ({
      executor: definition.executor,
      abiVersion: 1,
      definitions: [definition.definition],
      lifecycle: input?.executorLifecycle ?? 'active',
      policyReferences: definition.policyReferences,
    })),
    policies: [boundedPolicy, jsonataPolicy],
  });
}

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
      base.nodes[2],
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
      base.nodes[2],
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
        config: {
          branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
          maxConcurrency: 1,
        },
        inputMappings: {},
      },
      { ...base.nodes[1], id: 'left' },
      { ...base.nodes[2], id: 'right' },
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
        config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
        inputMappings: {},
      },
      base.nodes[2],
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
    schemaVersion: 1,
    settings: { maxRunDurationMs: 60_000 },
    nodes: reverse ? [...nodes].reverse() : nodes,
    edges: reverse ? [...edges].reverse() : edges,
  };
}

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
        schemaVersion: 1 as const,
        settings: {},
        nodes: reverse ? [...bodyNodes].reverse() : bodyNodes,
        edges: reverse ? [...bodyEdges].reverse() : bodyEdges,
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
      },
    },
  };
  const nodes = [base.nodes[0], loop, base.nodes[2]];
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
    schemaVersion: 1 as const,
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
        schemaVersion: 1,
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
