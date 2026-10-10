import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { workflowGraphSchema } from '../../src/graph/contract.js';
import {
  EMPTY_WORKFLOW_GRAPH,
  type WorkflowGraph,
} from '../../src/graph/contract.js';
import {
  parseWorkflowGraphForPublish,
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
  workflowIntegrationUsage,
} from '../../src/graph/identity.js';
import { parseWorkflowGraphDraft } from '../../src/graph/validation/preflight.js';
import {
  InvalidWorkflowGraphError,
  WORKFLOW_GRAPH_LIMITS,
  WorkflowGraphContractError,
} from '../../src/graph/validation/contract.js';

const TEST_DEFINITION_CATALOG_V1 = {
  schemaVersion: 1 as const,
  definitions: [
    { key: 'core.other', version: 1 },
    { key: 'core.set', version: 1 },
    { key: 'core.set', version: 2 },
  ],
};
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
        { ...EMPTY_WORKFLOW_GRAPH, nodes: [outer, node('duplicate')] },
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
          ...EMPTY_WORKFLOW_GRAPH,
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
    const graph = { ...EMPTY_WORKFLOW_GRAPH, nodes: [node('usage')] };
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
  let graph: unknown = EMPTY_WORKFLOW_GRAPH;
  for (let index = 0; index < depth; index += 1) {
    graph = {
      ...EMPTY_WORKFLOW_GRAPH,
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
    expect(parseWorkflowGraphDraft(EMPTY_WORKFLOW_GRAPH)).toEqual(
      EMPTY_WORKFLOW_GRAPH,
    );
    expect(workflowCompatibilityReport(EMPTY_WORKFLOW_GRAPH)).toEqual({
      compatible: true,
      fingerprint:
        'wf-compat:sha256:1b272141677a1d308d454d2f22a9d00cfe040d48b54ef926e9c02132b206239e',
      issues: [],
    });
    expect(workflowCompatibilityReport(fixture())).toEqual({
      compatible: false,
      fingerprint:
        'wf-compat:sha256:1b272141677a1d308d454d2f22a9d00cfe040d48b54ef926e9c02132b206239e',
      issues: [
        { code: 'unknown_definition', definitionKey: 'core.set', version: 1 },
      ],
    });
  });

  it('strictly rejects unknown schema versions, graph fields, settings, and nested fields', () => {
    for (const input of [
      { ...EMPTY_WORKFLOW_GRAPH, schemaVersion: 2 },
      { ...EMPTY_WORKFLOW_GRAPH, unknown: true },
      { ...EMPTY_WORKFLOW_GRAPH, settings: { unknown: true } },
      {
        ...EMPTY_WORKFLOW_GRAPH,
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
        ...EMPTY_WORKFLOW_GRAPH,
        nodes: exactNodes,
      }),
    ).toHaveProperty('nodes.length', WORKFLOW_GRAPH_LIMITS.nodes);
    expect(() =>
      parseWorkflowGraphDraft({
        ...EMPTY_WORKFLOW_GRAPH,
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
        ...EMPTY_WORKFLOW_GRAPH,
        nodes: [node('a'), node('b')],
        edges: exactEdges,
      }),
    ).toHaveProperty('edges.length', WORKFLOW_GRAPH_LIMITS.edges);
    expect(() =>
      parseWorkflowGraphDraft({
        ...EMPTY_WORKFLOW_GRAPH,
        nodes: [node('a'), node('b')],
        edges: [...exactEdges, { ...exactEdges[0], id: 'over' }],
      }),
    ).toThrow();

    expect(
      parseWorkflowGraphDraft({
        ...EMPTY_WORKFLOW_GRAPH,
        settings: { maxRunDurationMs: 3_600_000 },
      }),
    ).toHaveProperty('settings.maxRunDurationMs', 3_600_000);
    expect(() =>
      parseWorkflowGraphDraft({
        ...EMPTY_WORKFLOW_GRAPH,
        settings: { maxRunDurationMs: 3_600_001 },
      }),
    ).toThrow();

    const byteTemplate = {
      ...EMPTY_WORKFLOW_GRAPH,
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
    expect(workflowGraphSchema.safeParse(exactBytes).success).toBe(true);
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
    expect(
      workflowGraphSchema.safeParse({
        ...exactBytes,
        nodes: [
          {
            ...first(exactBytes.nodes),
            label: `${first(exactBytes.nodes).label}x`,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('enforces structured-loop bounds through the parser seam', () => {
    const loop = {
      ...node('loop'),
      structured: {
        kind: 'for_each' as const,
        maxIterations: WORKFLOW_GRAPH_LIMITS.maxLoopIterations,
        maxConcurrency: WORKFLOW_GRAPH_LIMITS.maxLoopConcurrency,
        body: {
          ...EMPTY_WORKFLOW_GRAPH,
          inputPorts: ['item'],
          outputPorts: ['result'],
        },
      },
    };
    expect(
      parseWorkflowGraphDraft({ ...EMPTY_WORKFLOW_GRAPH, nodes: [loop] }),
    ).toHaveProperty(
      'nodes.0.structured.maxIterations',
      WORKFLOW_GRAPH_LIMITS.maxLoopIterations,
    );
    expect(() =>
      parseWorkflowGraphDraft({
        ...EMPTY_WORKFLOW_GRAPH,
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
    for (const population of [
      1,
      Math.ceil(WORKFLOW_GRAPH_LIMITS.structuredDepth / 2),
      WORKFLOW_GRAPH_LIMITS.structuredDepth,
    ]) {
      const setupStarted = performance.now();
      const input = nestedStructuredGraph(population);
      const setupMs = performance.now() - setupStarted;
      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      expect(parseWorkflowGraphDraft(input)).toBeDefined();
      const operationMs = performance.now() - started;
      const processHeapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
      console.info(
        `Q9_BOUNDED_WORK_V1=${JSON.stringify({
          schemaVersion: 1,
          family: 'workflow-model-structured-graph-validation',
          contractVersion: 'workflow-graph-v1',
          population,
          upperSupportedPopulation: WORKFLOW_GRAPH_LIMITS.structuredDepth,
          completedOperations: population,
          setupMs,
          operationMs,
          sql: null,
          clients: null,
          attributableMemory: {
            available: false,
            reason:
              'The probe shares a Vitest process and garbage collector; process heap delta is diagnostic, not attributable workload memory.',
            processHeapDeltaBytes,
          },
        })}`,
      );
    }
    const overStructured = nestedStructuredGraph(
      WORKFLOW_GRAPH_LIMITS.structuredDepth + 1,
    );
    const overConfig = {
      ...EMPTY_WORKFLOW_GRAPH,
      nodes: [
        {
          ...node('config-depth'),
          config: nestedObject(WORKFLOW_GRAPH_LIMITS.jsonValueDepth + 1),
        },
      ],
    };
    const structuredError = contractError(overStructured);
    expect(structuredError).toMatchObject({ code: 'structured_depth' });
    expect(structuredError.path).toBe(
      `$${'.nodes[0].structured.body'.repeat(
        WORKFLOW_GRAPH_LIMITS.structuredDepth + 1,
      )}`,
    );
    const configError = contractError(overConfig);
    expect(configError).toMatchObject({ code: 'json_value_depth' });
    expect(configError.path).toMatch(/^\$\.nodes\[0\]\.config(?:\.child)+$/u);
    for (const input of [
      overStructured,
      nestedStructuredGraph(500),
      overConfig,
      {
        ...EMPTY_WORKFLOW_GRAPH,
        nodes: [{ ...node('deep-object'), config: nestedObject(500) }],
      },
      {
        ...EMPTY_WORKFLOW_GRAPH,
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
        ...EMPTY_WORKFLOW_GRAPH,
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
      ...EMPTY_WORKFLOW_GRAPH,
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
  });
});

describe('workflow draft representation tag', () => {
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
      '"draft.QqrJbZejFAbUNwXK_kmy-dfSWGsZmWGq7hl1KEvtzDU"',
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
