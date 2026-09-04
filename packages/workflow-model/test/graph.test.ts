import { describe, expect, it } from 'vitest';
import {
  invocationIdentity,
  validateWorkflowGraph,
  type WorkflowGraph,
} from '../src/graph.js';

const node = (id: string) => ({
  id,
  definition: { key: 'core.set', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
});
const forEachNode = (id: string, bodyNodes = [node(`${id}-body`)]) => ({
  ...node(id),
  definition: { key: 'core.foreach', version: 1 },
  structured: {
    kind: 'for_each' as const,
    maxIterations: 10,
    maxConcurrency: 2,
    body: {
      ...graph(bodyNodes),
      inputPorts: ['item', 'ordinal'],
      outputPorts: ['result'],
    },
  },
});
const graph = (
  nodes: WorkflowGraph['nodes'],
  edges: WorkflowGraph['edges'] = [],
): WorkflowGraph => ({ schemaVersion: 1, nodes, edges, settings: {} });

describe('workflow graph validation', () => {
  it('accepts a DAG and rejects duplicate IDs, dangling edges, and arbitrary cycles', () => {
    expect(
      validateWorkflowGraph(
        graph(
          [node('a'), node('b')],
          [
            {
              id: 'e',
              source: { nodeId: 'a', port: 'out' },
              target: { nodeId: 'b', port: 'in' },
            },
          ],
        ),
      ).ok,
    ).toBe(true);
    expect(
      validateWorkflowGraph(graph([node('a'), node('a')])).issues[0]?.code,
    ).toBe('duplicate_node_id');
    expect(
      validateWorkflowGraph(
        graph(
          [node('a')],
          [
            {
              id: 'e',
              source: { nodeId: 'a', port: 'out' },
              target: { nodeId: 'missing', port: 'in' },
            },
          ],
        ),
      ).issues[0]?.code,
    ).toBe('dangling_edge');
    const cycle = graph(
      [node('a'), node('b')],
      [
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
      ],
    );
    expect(
      validateWorkflowGraph(cycle).issues.some(
        (issue) => issue.code === 'cycle',
      ),
    ).toBe(true);
  });
  it('validates structured For Each bodies and bounded nested expansion', () => {
    const loop = forEachNode('loop', [node('inner')]);
    expect(
      validateWorkflowGraph(graph([loop]), { maxExpandedInvocations: 11 }).ok,
    ).toBe(true);
    expect(
      validateWorkflowGraph(
        graph([
          { ...loop, structured: { ...loop.structured, maxConcurrency: 11 } },
        ]),
      ).issues[0]?.code,
    ).toBe('invalid_loop_limit');
    const nested = {
      ...loop,
      structured: {
        ...loop.structured,
        body: {
          ...graph([{ ...loop, id: 'nested' }]),
          inputPorts: ['item', 'ordinal'],
          outputPorts: ['result'],
        },
      },
    };
    expect(
      validateWorkflowGraph(graph([nested]), {
        maxExpandedInvocations: 100,
      }).issues.some((issue) => issue.code === 'expansion_limit'),
    ).toBe(true);
    expect(
      validateWorkflowGraph(graph([loop]), { nodes: 1 }).issues.some(
        (issue) => issue.code === 'graph_limit',
      ),
    ).toBe(true);
    expect(
      validateWorkflowGraph(
        graph([
          {
            ...loop,
            structured: {
              ...loop.structured,
              kind: 'other' as never,
            },
          },
        ]),
      ).issues.some((issue) => issue.code === 'invalid_structured_body'),
    ).toBe(true);
  });
  it('requires core.foreach@1 ownership, exact ports, and a nonempty single-sink body', () => {
    const loop = forEachNode('loop');
    const invalid = [
      { ...node('owner'), structured: loop.structured },
      (() => {
        const missing = { ...loop };
        delete (missing as { structured?: unknown }).structured;
        return missing;
      })(),
      {
        ...loop,
        structured: {
          ...loop.structured,
          body: { ...loop.structured.body, inputPorts: ['item'] },
        },
      },
      {
        ...loop,
        structured: {
          ...loop.structured,
          body: { ...loop.structured.body, outputPorts: ['other'] },
        },
      },
      {
        ...loop,
        structured: {
          ...loop.structured,
          body: { ...loop.structured.body, nodes: [] },
        },
      },
      forEachNode('two-sinks', [node('left'), node('right')]),
    ];

    for (const candidate of invalid)
      expect(validateWorkflowGraph(graph([candidate])).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'invalid_structured_body' }),
        ]),
      );
  });
  it('rejects node-output mappings that cross either side of a body seam', () => {
    const loop = forEachNode('loop', [
      {
        ...node('inner'),
        inputMappings: {
          value: { kind: 'node_output' as const, nodeId: 'outer', path: '$' },
        },
      },
    ]);
    const outer = {
      ...node('outer'),
      inputMappings: {
        value: {
          kind: 'node_output' as const,
          nodeId: 'inner',
          path: '$',
        },
      },
    };

    expect(validateWorkflowGraph(graph([outer, loop])).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_structured_body' }),
        expect.objectContaining({ code: 'invalid_structured_body' }),
      ]),
    );
  });
  it('caps worst-case loop iterations separately from expanded invocations', () => {
    const nested = forEachNode('outer', [forEachNode('inner')]);
    const result = validateWorkflowGraph(graph([nested]), {
      maxExpandedInvocations: 1_000,
      maxTotalLoopIterations: 109,
    });

    expect(result.expandedInvocations).toBe(111);
    expect(result.worstCaseLoopIterations).toBe(110);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'loop_iteration_limit' }),
      ]),
    );
  });
  it('scopes structured input to the nearest declared body port', () => {
    const mapped = {
      ...node('inner'),
      inputMappings: {
        value: { kind: 'structured_input' as const, port: 'item', path: '$' },
      },
    };
    const loop = {
      ...node('loop'),
      definition: { key: 'core.foreach', version: 1 },
      structured: {
        kind: 'for_each' as const,
        maxIterations: 2,
        maxConcurrency: 1,
        body: {
          ...graph([mapped]),
          inputPorts: ['item', 'ordinal'],
          outputPorts: ['result'],
        },
      },
    };
    expect(validateWorkflowGraph(graph([loop])).ok).toBe(true);
    expect(validateWorkflowGraph(graph([mapped])).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_structured_body' }),
      ]),
    );
    expect(
      validateWorkflowGraph(
        graph([
          {
            ...loop,
            structured: {
              ...loop.structured,
              body: { ...loop.structured.body, inputPorts: ['ordinal'] },
            },
          },
        ]),
      ).issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_structured_body' }),
      ]),
    );
  });
  it('requires the exact published graph and structured schema versions', () => {
    expect(
      validateWorkflowGraph({ ...graph([]), schemaVersion: 2 }).issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_graph',
          path: '$.schemaVersion',
        }),
      ]),
    );
  });
  it('derives stable keys from run, version, node, and ordered scope only', () => {
    const input = {
      workflowRunId: 'run-1',
      workflowVersionId: 'v1',
      nodeId: 'send',
      scope: [
        { kind: 'branch' as const, branchId: 'b' },
        { kind: 'iteration' as const, loopNodeId: 'loop', ordinal: 3 },
      ],
    };
    const first = invocationIdentity(input);
    expect(invocationIdentity(input)).toEqual(first);
    expect(
      invocationIdentity({ ...input, workflowRunId: 'replay' }).invocationKey,
    ).toBe(first.invocationKey);
    expect(first.canonicalScope).toBe('branch:b/loop:loop[3]');
    expect(() =>
      invocationIdentity({
        ...input,
        scope: [{ kind: 'iteration', loopNodeId: 'loop', ordinal: -1 }],
      }),
    ).toThrow('zero-based');
    expect(() =>
      invocationIdentity({
        ...input,
        scope: [
          { kind: 'unexpected', loopNodeId: 'loop', ordinal: 0 } as never,
        ],
      }),
    ).toThrow('scope');
    expect(() =>
      invocationIdentity({ ...input, unexpected: true } as never),
    ).toThrow('scope');
  });
});
