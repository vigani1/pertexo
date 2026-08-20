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
    const loop = {
      ...node('loop'),
      structured: {
        kind: 'for_each' as const,
        maxIterations: 10,
        maxConcurrency: 2,
        body: {
          ...graph([node('inner')]),
          inputPorts: ['item'],
          outputPorts: ['result'],
        },
      },
    };
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
          inputPorts: ['item'],
          outputPorts: ['result'],
        },
      },
    };
    expect(
      validateWorkflowGraph(graph([nested]), {
        maxExpandedInvocations: 100,
      }).issues.some((issue) => issue.code === 'expansion_limit'),
    ).toBe(true);
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
  });
});
