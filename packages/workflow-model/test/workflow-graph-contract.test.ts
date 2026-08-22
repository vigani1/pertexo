import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_WORKFLOW_GRAPH_V1,
  InvalidWorkflowGraphError,
  WORKFLOW_GRAPH_LIMITS,
  WorkflowGraphContractError,
  parseWorkflowGraphDraft,
  parseWorkflowGraphForPublish,
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
  workflowExecutableChecksum as computeWorkflowExecutableChecksum,
  workflowIntegrationUsage,
  workflowRetainedExecutableChecksum,
  type WorkflowGraph,
} from '../src/graph.js';

const TEST_DEFINITION_CATALOG_V1 = {
  schemaVersion: 1 as const,
  definitions: [
    { key: 'core.other', version: 1 },
    { key: 'core.set', version: 1 },
    { key: 'core.set', version: 2 },
  ],
};
const workflowExecutableChecksum = (input: unknown): string =>
  computeWorkflowExecutableChecksum(input, TEST_DEFINITION_CATALOG_V1);

const node = (id: string) => ({
  id,
  definition: { key: 'core.set', version: 1 },
  position: { x: 10, y: 20 },
  configVersion: 1,
  config: { payload: { a: 1, b: 2 } },
  inputMappings: {
    value: { kind: 'run_input' as const, path: '$.value' },
  },
  connectionRefs: { primary: 'connection-1' },
  label: `Node ${id}`,
  disabled: false,
});

describe('workflow integration usage projection', () => {
  const catalog = {
    schemaVersion: 1 as const,
    definitions: [
      {
        key: 'core.set',
        version: 1,
        integration: {
          providerKey: 'http',
          operationKey: 'request',
          connectionSlots: ['primary'],
        },
      },
    ],
  };

  it('derives, deduplicates, and sorts nested provider operation connections', () => {
    const nested = node('nested');
    const outer = {
      ...node('outer'),
      connectionRefs: { primary: 'connection-2' },
      structured: {
        kind: 'for_each' as const,
        maxIterations: 2,
        maxConcurrency: 1,
        body: {
          schemaVersion: 1,
          nodes: [nested],
          edges: [],
          settings: {},
          inputPorts: ['item'],
          outputPorts: ['result'],
        },
      },
    };

    expect(
      workflowIntegrationUsage(
        { ...EMPTY_WORKFLOW_GRAPH_V1, nodes: [outer, node('duplicate')] },
        catalog,
      ),
    ).toEqual([
      {
        providerKey: 'http',
        operationKey: 'request',
        connectionId: 'connection-1',
      },
      {
        providerKey: 'http',
        operationKey: 'request',
        connectionId: 'connection-2',
      },
    ]);
  });

  it('fails closed when catalog metadata names an absent connection slot', () => {
    expect(() =>
      workflowIntegrationUsage(
        {
          ...EMPTY_WORKFLOW_GRAPH_V1,
          nodes: [{ ...node('missing'), connectionRefs: {} }],
        },
        catalog,
      ),
    ).toThrow(/requires connection slot primary/u);
  });

  it('does not let projection metadata change compatibility identity', () => {
    const withoutMetadata = {
      schemaVersion: 1 as const,
      definitions: [{ key: 'core.set', version: 1 }],
    };
    const graph = { ...EMPTY_WORKFLOW_GRAPH_V1, nodes: [node('usage')] };
    expect(workflowCompatibilityReport(graph, catalog).fingerprint).toBe(
      workflowCompatibilityReport(graph, withoutMetadata).fingerprint,
    );
  });
});

const fixture = (): WorkflowGraph => ({
  schemaVersion: 1,
  nodes: [node('a'), node('b')],
  edges: [
    {
      id: 'edge-1',
      source: { nodeId: 'a', port: 'out' },
      target: { nodeId: 'b', port: 'in' },
    },
    {
      id: 'edge-2',
      source: { nodeId: 'a', port: 'secondary' },
      target: { nodeId: 'b', port: 'secondary' },
    },
  ],
  settings: { maxRunDurationMs: 60_000 },
});

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('fixture must not be empty');
  return value;
}

function nestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let index = 1; index < depth; index += 1) value = { child: value };
  return value;
}

function nestedStructuredGraph(depth: number): unknown {
  let graph: unknown = EMPTY_WORKFLOW_GRAPH_V1;
  for (let index = 0; index < depth; index += 1) {
    graph = {
      ...EMPTY_WORKFLOW_GRAPH_V1,
      nodes: [
        {
          ...node(`loop-${String(index)}`),
          structured: {
            kind: 'for_each',
            maxIterations: 1,
            maxConcurrency: 1,
            body: {
              ...(graph as WorkflowGraph),
              inputPorts: ['item'],
              outputPorts: ['result'],
            },
          },
        },
      ],
    };
  }
  return graph;
}

function contractError(input: unknown): WorkflowGraphContractError {
  try {
    parseWorkflowGraphDraft(input);
  } catch (error) {
    if (error instanceof WorkflowGraphContractError) return error;
    throw error;
  }
  throw new Error('expected workflow graph contract rejection');
}

describe('workflow graph V1 public contract', () => {
  it('parses the V1 empty graph and reports deterministic empty-catalog compatibility', () => {
    expect(parseWorkflowGraphDraft(EMPTY_WORKFLOW_GRAPH_V1)).toEqual(
      EMPTY_WORKFLOW_GRAPH_V1,
    );
    expect(workflowCompatibilityReport(EMPTY_WORKFLOW_GRAPH_V1)).toEqual({
      compatible: true,
      fingerprint:
        'wf-compat:v1:sha256:1b272141677a1d308d454d2f22a9d00cfe040d48b54ef926e9c02132b206239e',
      issues: [],
    });
    expect(workflowCompatibilityReport(fixture())).toEqual({
      compatible: false,
      fingerprint:
        'wf-compat:v1:sha256:1b272141677a1d308d454d2f22a9d00cfe040d48b54ef926e9c02132b206239e',
      issues: [
        { code: 'unknown_definition', definitionKey: 'core.set', version: 1 },
      ],
    });
  });

  it('strictly rejects unknown schema versions, graph fields, settings, and nested fields', () => {
    for (const input of [
      { ...EMPTY_WORKFLOW_GRAPH_V1, schemaVersion: 2 },
      { ...EMPTY_WORKFLOW_GRAPH_V1, unknown: true },
      { ...EMPTY_WORKFLOW_GRAPH_V1, settings: { unknown: true } },
      {
        ...EMPTY_WORKFLOW_GRAPH_V1,
        nodes: [{ ...node('a'), secret: 'not part of the graph contract' }],
      },
    ]) {
      expect(() => parseWorkflowGraphDraft(input)).toThrow();
    }
  });

  it('accepts exact node, edge, duration, and byte limits and rejects one unit over', () => {
    const exactNodes = Array.from(
      { length: WORKFLOW_GRAPH_LIMITS.nodes },
      (_, index) => node(`n-${String(index)}`),
    );
    expect(
      parseWorkflowGraphDraft({
        ...EMPTY_WORKFLOW_GRAPH_V1,
        nodes: exactNodes,
      }),
    ).toHaveProperty('nodes.length', WORKFLOW_GRAPH_LIMITS.nodes);
    expect(() =>
      parseWorkflowGraphDraft({
        ...EMPTY_WORKFLOW_GRAPH_V1,
        nodes: [...exactNodes, node('over')],
      }),
    ).toThrow();

    const exactEdges = Array.from(
      { length: WORKFLOW_GRAPH_LIMITS.edges },
      (_, index) => ({
        id: `e-${String(index)}`,
        source: { nodeId: 'a', port: 'out' },
        target: { nodeId: 'b', port: 'in' },
      }),
    );
    expect(
      parseWorkflowGraphDraft({
        ...EMPTY_WORKFLOW_GRAPH_V1,
        nodes: [node('a'), node('b')],
        edges: exactEdges,
      }),
    ).toHaveProperty('edges.length', WORKFLOW_GRAPH_LIMITS.edges);
    expect(() =>
      parseWorkflowGraphDraft({
        ...EMPTY_WORKFLOW_GRAPH_V1,
        nodes: [node('a'), node('b')],
        edges: [...exactEdges, { ...exactEdges[0], id: 'over' }],
      }),
    ).toThrow();

    expect(
      parseWorkflowGraphDraft({
        ...EMPTY_WORKFLOW_GRAPH_V1,
        settings: { maxRunDurationMs: 3_600_000 },
      }),
    ).toHaveProperty('settings.maxRunDurationMs', 3_600_000);
    expect(() =>
      parseWorkflowGraphDraft({
        ...EMPTY_WORKFLOW_GRAPH_V1,
        settings: { maxRunDurationMs: 3_600_001 },
      }),
    ).toThrow();

    const byteTemplate = {
      ...EMPTY_WORKFLOW_GRAPH_V1,
      nodes: [{ ...node('s'), label: '' }],
    };
    const base = JSON.stringify(byteTemplate).length;
    const exactBytes = {
      ...byteTemplate,
      nodes: [
        {
          ...byteTemplate.nodes[0],
          label: 'x'.repeat(WORKFLOW_GRAPH_LIMITS.graphBytes - base),
        },
      ],
    };
    expect(parseWorkflowGraphDraft(exactBytes)).toHaveProperty(
      'nodes.0.label.length',
      WORKFLOW_GRAPH_LIMITS.graphBytes - base,
    );
    expect(() =>
      parseWorkflowGraphDraft({
        ...exactBytes,
        nodes: [
          {
            ...first(exactBytes.nodes),
            label: `${first(exactBytes.nodes).label}x`,
          },
        ],
      }),
    ).toThrow();
  });

  it('enforces structured-loop bounds through the parser seam', () => {
    const loop = {
      ...node('loop'),
      structured: {
        kind: 'for_each' as const,
        maxIterations: WORKFLOW_GRAPH_LIMITS.maxLoopIterations,
        maxConcurrency: WORKFLOW_GRAPH_LIMITS.maxLoopConcurrency,
        body: {
          ...EMPTY_WORKFLOW_GRAPH_V1,
          inputPorts: ['item'],
          outputPorts: ['result'],
        },
      },
    };
    expect(
      parseWorkflowGraphDraft({ ...EMPTY_WORKFLOW_GRAPH_V1, nodes: [loop] }),
    ).toHaveProperty(
      'nodes.0.structured.maxIterations',
      WORKFLOW_GRAPH_LIMITS.maxLoopIterations,
    );
    expect(() =>
      parseWorkflowGraphDraft({
        ...EMPTY_WORKFLOW_GRAPH_V1,
        nodes: [
          {
            ...loop,
            structured: {
              ...loop.structured,
              maxIterations: WORKFLOW_GRAPH_LIMITS.maxLoopIterations + 1,
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('preflights exact and over-limit structured and arbitrary JSON depth', () => {
    expect(
      parseWorkflowGraphDraft(
        nestedStructuredGraph(WORKFLOW_GRAPH_LIMITS.structuredDepth),
      ),
    ).toBeDefined();
    const overStructured = nestedStructuredGraph(
      WORKFLOW_GRAPH_LIMITS.structuredDepth + 1,
    );
    const overConfig = {
      ...EMPTY_WORKFLOW_GRAPH_V1,
      nodes: [
        {
          ...node('config-depth'),
          config: nestedObject(WORKFLOW_GRAPH_LIMITS.jsonValueDepth + 1),
        },
      ],
    };
    expect(contractError(overStructured).code).toBe('structured_depth');
    expect(contractError(overConfig).code).toBe('json_value_depth');
    for (const input of [
      overStructured,
      nestedStructuredGraph(500),
      overConfig,
      {
        ...EMPTY_WORKFLOW_GRAPH_V1,
        nodes: [{ ...node('deep-object'), config: nestedObject(500) }],
      },
      {
        ...EMPTY_WORKFLOW_GRAPH_V1,
        nodes: [
          {
            ...node('mapping-depth'),
            inputMappings: {
              value: {
                kind: 'literal',
                value: nestedObject(WORKFLOW_GRAPH_LIMITS.jsonValueDepth + 1),
              },
            },
          },
        ],
      },
    ]) {
      try {
        parseWorkflowGraphDraft(input);
        throw new Error('expected contract rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowGraphContractError);
        expect(error).not.toBeInstanceOf(RangeError);
      }
    }
    expect(
      parseWorkflowGraphDraft({
        ...EMPTY_WORKFLOW_GRAPH_V1,
        nodes: [
          {
            ...node('exact-json-depth'),
            config: nestedObject(WORKFLOW_GRAPH_LIMITS.jsonValueDepth),
          },
        ],
      }),
    ).toBeDefined();
  });

  it('keeps draft structure separate from publish semantics and compatibility', () => {
    const intermediate = {
      ...EMPTY_WORKFLOW_GRAPH_V1,
      nodes: [node('a'), node('b')],
      edges: [
        {
          id: 'ab',
          source: { nodeId: 'a', port: 'out' },
          target: { nodeId: 'b', port: 'in' },
        },
        {
          id: 'ba',
          source: { nodeId: 'b', port: 'out' },
          target: { nodeId: 'a', port: 'in' },
        },
        {
          id: 'dangling',
          source: { nodeId: 'a', port: 'out' },
          target: { nodeId: 'missing', port: 'in' },
        },
      ],
    };
    expect(parseWorkflowGraphDraft(intermediate)).toEqual(intermediate);
    expect(workflowCompatibilityReport(intermediate)).toMatchObject({
      compatible: false,
      issues: [{ code: 'unknown_definition' }],
    });
    expect(() =>
      parseWorkflowGraphForPublish(intermediate, TEST_DEFINITION_CATALOG_V1),
    ).toThrow(InvalidWorkflowGraphError);
    expect(() => parseWorkflowGraphForPublish(fixture())).toThrow(
      InvalidWorkflowGraphError,
    );
    expect(
      parseWorkflowGraphForPublish(fixture(), TEST_DEFINITION_CATALOG_V1),
    ).toEqual(fixture());
    expect(() => computeWorkflowExecutableChecksum(intermediate)).toThrow(
      InvalidWorkflowGraphError,
    );
  });
});

describe('workflow executable identity V1', () => {
  it('verifies retained identity without requiring an active definition', () => {
    const retained = fixture();
    expect(workflowCompatibilityReport(retained)).toMatchObject({
      compatible: false,
    });
    expect(workflowRetainedExecutableChecksum(retained)).toBe(
      workflowExecutableChecksum(retained),
    );
    expect(() => computeWorkflowExecutableChecksum(retained)).toThrow(
      InvalidWorkflowGraphError,
    );
  });

  it('is deterministic across key insertion, collection order, and processes', () => {
    const input = fixture();
    const reordered: WorkflowGraph = {
      settings: { maxRunDurationMs: 60_000 },
      edges: [...input.edges].reverse(),
      nodes: [...input.nodes]
        .reverse()
        .map((item) => ({ ...item, config: { payload: { b: 2, a: 1 } } })),
      schemaVersion: 1,
    };
    const checksum = workflowExecutableChecksum(input);
    expect(checksum).toBe(
      'wf:v1:sha256:278216ae19ed520bececca3c2b8475adc9cdfcd141693bd56fa5da6f0daf0752',
    );
    expect(workflowExecutableChecksum(reordered)).toBe(checksum);

    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import { workflowExecutableChecksum } from './src/graph.ts'; process.stdout.write(workflowExecutableChecksum(${JSON.stringify(
          reordered,
        )}, ${JSON.stringify(TEST_DEFINITION_CATALOG_V1)}))`,
      ],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
    );
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(checksum);
  });

  it('excludes only position, label, and node/edge collection order', () => {
    const input = fixture();
    const checksum = workflowExecutableChecksum(input);
    expect(
      workflowExecutableChecksum({
        ...input,
        nodes: input.nodes.map((item) => ({
          ...item,
          position: { x: item.position.x + 999, y: item.position.y - 999 },
          label: `Renamed ${item.id}`,
        })),
      }),
    ).toBe(checksum);
    expect(
      workflowExecutableChecksum({
        ...input,
        nodes: input.nodes.map((item) => {
          const copy = { ...item };
          delete copy.disabled;
          return copy;
        }),
      }),
    ).toBe(checksum);
  });

  it.each([
    [
      'definition key',
      (graph: WorkflowGraph) => ({
        ...graph.nodes[0],
        definition: { key: 'core.other', version: 1 },
      }),
    ],
    [
      'definition version',
      (graph: WorkflowGraph) => ({
        ...graph.nodes[0],
        definition: { key: 'core.set', version: 2 },
      }),
    ],
    [
      'config version',
      (graph: WorkflowGraph) => ({ ...graph.nodes[0], configVersion: 2 }),
    ],
    [
      'config',
      (graph: WorkflowGraph) => ({ ...graph.nodes[0], config: { value: 2 } }),
    ],
    [
      'mapping',
      (graph: WorkflowGraph) => ({
        ...graph.nodes[0],
        inputMappings: { value: { kind: 'run_input', path: '$.other' } },
      }),
    ],
    [
      'connection reference',
      (graph: WorkflowGraph) => ({
        ...graph.nodes[0],
        connectionRefs: { primary: 'connection-2' },
      }),
    ],
    [
      'disabled state',
      (graph: WorkflowGraph) => ({ ...graph.nodes[0], disabled: true }),
    ],
  ])('changes when the included %s changes', (_name, mutate) => {
    const input = fixture();
    expect(
      workflowExecutableChecksum({
        ...input,
        nodes: [mutate(input), input.nodes[1] ?? first(input.nodes)],
      }),
    ).not.toBe(workflowExecutableChecksum(input));
  });

  it('includes stable node identity', () => {
    const input = fixture();
    expect(
      workflowExecutableChecksum({
        ...input,
        nodes: [
          { ...first(input.nodes), id: 'changed' },
          input.nodes[1] ?? first(input.nodes),
        ],
        edges: input.edges.map((edge) => ({
          ...edge,
          source: { ...edge.source, nodeId: 'changed' },
        })),
      }),
    ).not.toBe(workflowExecutableChecksum(input));
  });

  it('includes topology, stable edge identity, and every V1 execution setting', () => {
    const input = fixture();
    const checksum = workflowExecutableChecksum(input);
    expect(
      workflowExecutableChecksum({
        ...input,
        edges: input.edges.map((edge, index) =>
          index === 0
            ? {
                ...edge,
                target: { ...edge.target, port: 'changed' },
              }
            : edge,
        ),
      }),
    ).not.toBe(checksum);
    expect(
      workflowExecutableChecksum({
        ...input,
        edges: input.edges.map((edge, index) =>
          index === 0 ? { ...edge, id: 'edge-changed' } : edge,
        ),
      }),
    ).not.toBe(checksum);
    expect(
      workflowExecutableChecksum({
        ...input,
        settings: { maxRunDurationMs: 60_001 },
      }),
    ).not.toBe(checksum);
  });

  it('includes every structured execution field and nested executable content', () => {
    const structuredGraph = {
      ...EMPTY_WORKFLOW_GRAPH_V1,
      nodes: [
        {
          ...node('loop'),
          structured: {
            kind: 'for_each' as const,
            maxIterations: 2,
            maxConcurrency: 1,
            body: {
              ...EMPTY_WORKFLOW_GRAPH_V1,
              nodes: [node('inner')],
              inputPorts: ['item'],
              outputPorts: ['result'],
            },
          },
        },
      ],
    };
    const loop = first(structuredGraph.nodes);
    const checksum = workflowExecutableChecksum(structuredGraph);
    const changedStructures = [
      { ...loop.structured, maxIterations: 3 },
      { ...loop.structured, maxConcurrency: 2 },
      {
        ...loop.structured,
        body: { ...loop.structured.body, inputPorts: ['changed'] },
      },
      {
        ...loop.structured,
        body: { ...loop.structured.body, outputPorts: ['changed'] },
      },
      {
        ...loop.structured,
        body: {
          ...loop.structured.body,
          nodes: [{ ...first(loop.structured.body.nodes), configVersion: 2 }],
        },
      },
    ];
    for (const structured of changedStructures) {
      expect(
        workflowExecutableChecksum({
          ...structuredGraph,
          nodes: [{ ...loop, structured }],
        }),
      ).not.toBe(checksum);
    }
  });
});

describe('workflow draft representation tag V1', () => {
  it('uses a supplied durable release fingerprint as authoring identity', () => {
    const graph = fixture();
    const releaseFingerprint =
      'node-compat:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const report = workflowCompatibilityReport(graph, {
      ...TEST_DEFINITION_CATALOG_V1,
      releaseFingerprint,
    });

    expect(report.fingerprint).toBe(releaseFingerprint);
  });

  it('has a stable opaque golden value and includes compatibility identity', () => {
    const graph = fixture();
    const fingerprint = workflowCompatibilityReport(
      graph,
      TEST_DEFINITION_CATALOG_V1,
    ).fingerprint;
    const input = {
      workflowId: '11111111-1111-4111-8111-111111111111',
      revision: 7,
      graph,
      compatibilityFingerprint: fingerprint,
    } as const;
    expect(workflowDraftRepresentationTag(input)).toBe(
      '"draft-v1.AFBYOY0XvOEWP2AEVMsJCblYcXq0biQBej1xbQP46YE"',
    );
    expect(
      workflowDraftRepresentationTag({
        ...input,
        compatibilityFingerprint: `${fingerprint}:changed`,
      }),
    ).not.toBe(workflowDraftRepresentationTag(input));
    expect(workflowDraftRepresentationTag({ ...input, revision: 8 })).not.toBe(
      workflowDraftRepresentationTag(input),
    );
  });
});
