import {
  createRegistryRelease,
  type ExecutorLifecycle,
  type NodeManifest,
  type NodeManifestV2,
  type PolicyReference,
  type RegistryRelease,
} from '@pertexo/node-sdk';

export const boundedPolicy = { key: 'node.json.bounded', version: 1 } as const;
export const jsonataPolicy = { key: 'jsonata.restricted', version: 1 } as const;
export const schema = { type: 'object', additionalProperties: true } as const;

type FixtureDefinitionKey =
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
  | 'test.unrelated';

const branchPorts = Array.from(
  { length: 16 },
  (_, index) => `branch-${String(index + 1).padStart(2, '0')}`,
);
const switchPorts = [
  ...Array.from(
    { length: 16 },
    (_, index) => `case-${String(index + 1).padStart(2, '0')}`,
  ),
  'default',
];
const fixtureDefinitions: Readonly<
  Record<
    FixtureDefinitionKey,
    Readonly<{
      capabilities: readonly string[];
      family: NodeManifest['family'];
      inputs: readonly string[];
      outputs: readonly string[];
    }>
  >
> = {
  'core.condition': {
    capabilities: [],
    family: 'logic',
    inputs: ['in'],
    outputs: ['true', 'false'],
  },
  'core.foreach': {
    capabilities: [],
    family: 'logic',
    inputs: ['in'],
    outputs: ['out'],
  },
  'core.manual': {
    capabilities: [],
    family: 'trigger',
    inputs: [],
    outputs: ['out'],
  },
  'core.merge': {
    capabilities: [],
    family: 'logic',
    inputs: branchPorts,
    outputs: ['out'],
  },
  'core.parallel': {
    capabilities: [],
    family: 'logic',
    inputs: ['in'],
    outputs: branchPorts,
  },
  'core.schedule': {
    capabilities: [],
    family: 'trigger',
    inputs: [],
    outputs: ['out'],
  },
  'core.set': {
    capabilities: [],
    family: 'transform',
    inputs: ['in'],
    outputs: ['out'],
  },
  'core.switch': {
    capabilities: [],
    family: 'logic',
    inputs: ['in'],
    outputs: switchPorts,
  },
  'core.terminate': {
    capabilities: ['terminates_run'],
    family: 'output',
    inputs: ['in'],
    outputs: [],
  },
  'core.webhook': {
    capabilities: [],
    family: 'trigger',
    inputs: [],
    outputs: ['out'],
  },
  'test.unrelated': {
    capabilities: [],
    family: 'transform',
    inputs: ['in'],
    outputs: ['out'],
  },
};

export function manifest(
  key: FixtureDefinitionKey,
  policies: readonly PolicyReference[] = [boundedPolicy],
  version: 1 | 2 | 3 = 1,
): NodeManifest | NodeManifestV2 {
  const fixture = fixtureDefinitions[key];
  return {
    schemaVersion: version === 1 ? 1 : 2,
    definition: { key, version },
    family: fixture.family,
    configVersion: version,
    configSchema: schema,
    inputSchema: schema,
    outputSchema: schema,
    ports: {
      inputs: fixture.inputs,
      outputs: fixture.outputs,
    },
    credentialRequirements: [],
    connectionRequirements: [],
    retryClass: 'safe',
    resourceClass: 'cpu',
    capabilities: fixture.capabilities,
    lifecycle: 'active',
    executor: { key, version },
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
  readonly scheduleVersion?: 1 | 2 | 3;
  readonly webhook?: boolean;
  readonly extraPolicyVersion?: number;
  readonly structuredVersion?: 1 | 2 | 3;
}): RegistryRelease {
  const definitions = [
    manifest('core.manual'),
    manifest(
      'core.set',
      input?.mutateSet ? [jsonataPolicy] : [boundedPolicy, jsonataPolicy],
    ),
    manifest('core.terminate'),
    ...(input?.schedule
      ? [manifest('core.schedule', [boundedPolicy], input.scheduleVersion)]
      : []),
    ...(input?.webhook ? [manifest('core.webhook')] : []),
    ...(input?.condition ? [manifest('core.condition')] : []),
    ...(input?.switch ? [manifest('core.switch')] : []),
    ...(input?.parallel
      ? [manifest('core.parallel', [boundedPolicy], input.structuredVersion)]
      : []),
    ...(input?.merge
      ? [manifest('core.merge', [boundedPolicy], input.structuredVersion)]
      : []),
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
    policies: [
      boundedPolicy,
      jsonataPolicy,
      ...(input?.extraPolicyVersion === undefined
        ? []
        : [{ key: 'test.rollout', version: input.extraPolicyVersion }]),
    ],
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

export function parallelGraph(
  secondPort = 'branch-02',
  version: 1 | 2 | 3 = 1,
) {
  const base = graph();
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'parallel',
        definition: { key: 'core.parallel', version },
        configVersion: version,
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

export function pairedParallelGraph(version: 1 | 2 | 3 = 1) {
  const base = graph();
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'parallel',
        definition: { key: 'core.parallel', version },
        configVersion: version,
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
        definition: { key: 'core.merge', version },
        configVersion: version,
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

export function directPairedParallelGraph(version: 1 | 2 | 3 = 1) {
  const paired = pairedParallelGraph(version);
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
