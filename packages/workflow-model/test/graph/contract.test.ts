import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { workflowGraphSchema } from '../../src/graph/contract.js';
import { EMPTY_WORKFLOW_GRAPH } from '../../src/graph/contract.js';
import {
  parseWorkflowGraphForPublish,
  workflowCompatibilityReport,
} from '../../src/graph/identity.js';
import { parseWorkflowGraphDraft } from '../../src/graph/validation/preflight.js';
import {
  InvalidWorkflowGraphError,
  WORKFLOW_GRAPH_LIMITS,
  WorkflowGraphContractError,
} from '../../src/graph/validation/contract.js';
import {
  TEST_DEFINITION_CATALOG,
  node,
  fixture,
  first,
  nestedObject,
  nestedStructuredGraph,
  contractError,
} from '../support/graph-contract.js';
describe('workflow graph public contract', () => {
  it('parses the empty graph and reports deterministic empty-catalog compatibility', () => {
    expect(parseWorkflowGraphDraft(EMPTY_WORKFLOW_GRAPH)).toEqual(
      EMPTY_WORKFLOW_GRAPH,
    );
    expect(workflowCompatibilityReport(EMPTY_WORKFLOW_GRAPH)).toEqual({
      compatible: true,
      fingerprint:
        'wf-compat:sha256:16d5657818e64f80125a016b47a7bf2797b35d723d2259a216ffc7c167b58e74',
      issues: [],
    });
    expect(workflowCompatibilityReport(fixture())).toEqual({
      compatible: false,
      fingerprint:
        'wf-compat:sha256:16d5657818e64f80125a016b47a7bf2797b35d723d2259a216ffc7c167b58e74',
      issues: [
        { code: 'unknown_definition', definitionKey: 'core.set', version: 1 },
      ],
    });
  });

  it('strictly rejects unknown graph fields, settings, and nested fields', () => {
    for (const input of [
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

  it('preserves format-like field names inside literal user input', () => {
    const value = {
      schemaVersion: 17,
      engineVersion: 'customer-engine',
      policyVersion: 42,
      formatVersion: 3,
    };
    const graph = {
      ...EMPTY_WORKFLOW_GRAPH,
      nodes: [
        { ...node('a'), inputMappings: { value: { kind: 'literal', value } } },
      ],
    };
    expect(parseWorkflowGraphDraft(graph)).toEqual(graph);
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
        `Q9_BOUNDED_WORK=${JSON.stringify({
          family: 'workflow-model-structured-graph-validation',

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
      parseWorkflowGraphForPublish(intermediate, TEST_DEFINITION_CATALOG),
    ).toThrow(InvalidWorkflowGraphError);
    expect(() => parseWorkflowGraphForPublish(fixture())).toThrow(
      InvalidWorkflowGraphError,
    );
    expect(
      parseWorkflowGraphForPublish(fixture(), TEST_DEFINITION_CATALOG),
    ).toEqual(fixture());
  });
});
