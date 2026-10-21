import { describe, expect, it } from 'vitest';
import {
  inspectWorkflowFailureRoutes,
  type FailureRoutingGraph,
} from '../../src/flow/failure-routing/validation.js';
import { WORKFLOW_FAILURE_PORT } from '../../src/flow/failure-routing/contract.js';
const node = (
  id: string,
  key = 'core.set',
): FailureRoutingGraph['nodes'][number] => ({
  id,
  definition: { key, version: 1 },
  inputMappings: {},
});
const edge = (from: string, to: string, port = 'out') => ({
  id: `${from}-${to}-${port}`,
  source: { nodeId: from, port },
  target: { nodeId: to, port: 'in' },
});
function graph(): FailureRoutingGraph {
  return {
    nodes: [
      node('root', 'core.manual'),
      node('choice', 'core.condition'),
      node('action'),
      node('success', 'core.terminate'),
      node('other', 'core.terminate'),
      node('handler'),
      node('handled', 'core.terminate'),
    ],
    edges: [
      edge('root', 'choice'),
      edge('choice', 'action', 'true'),
      edge('choice', 'other', 'false'),
      edge('action', 'success'),
      edge('action', 'handler', WORKFLOW_FAILURE_PORT),
      edge('handler', 'handled'),
    ],
  };
}
describe('explicit disjoint failure routes', () => {
  it('keeps the root choice tree separate from its handler and records the exact sink', () => {
    const inspected = inspectWorkflowFailureRoutes(graph());
    expect(inspected.kind).toBe('routed');
    if (inspected.kind !== 'routed') throw new Error('Route missing');
    expect(inspected.value.routes.get('action')).toEqual({
      sourceNodeId: 'action',
      entryNodeId: 'handler',
      sinkNodeId: 'handled',
      handlerNodeIds: ['handler', 'handled'],
    });
    expect(inspected.value.main.outgoing.get('choice')).toHaveLength(2);
    expect(inspected.value.handlerOwners.get('handled')).toBe('action');
  });
  it('preserves ordinary graphs without imposing the narrower topology', () => {
    expect(
      inspectWorkflowFailureRoutes({
        nodes: [node('a'), node('b')],
        edges: [],
      }),
    ).toEqual({ kind: 'ordinary' });
  });
  it.each([
    'core.manual',
    'core.webhook',
    'core.schedule',
    'core.condition',
    'core.switch',
    'core.parallel',
    'core.merge',
    'core.foreach',
    'core.wait',
    'core.call',
    'core.terminate',
  ])('refuses %s as a failure source', (key) => {
    const current = graph();
    expect(
      inspectWorkflowFailureRoutes({
        ...current,
        nodes: current.nodes.map((n) =>
          n.id === 'action' ? node(n.id, key) : n,
        ),
      }),
    ).toMatchObject({ kind: 'invalid' });
  });
  it.each(['core.condition', 'core.wait', 'core.call', 'core.parallel'])(
    'refuses %s inside a handler',
    (key) => {
      const current = graph();
      expect(
        inspectWorkflowFailureRoutes({
          ...current,
          nodes: current.nodes.map((n) =>
            n.id === 'handler' ? node(n.id, key) : n,
          ),
        }),
      ).toMatchObject({ kind: 'invalid' });
    },
  );
  it.each([
    'core.manual',
    'core.webhook',
    'core.schedule',
    'core.form',
    'core.workflow_error',
  ])('never treats a %s trigger as an action with a failure handler', (key) => {
    const current = graph();
    for (const version of [1, 2])
      expect(
        inspectWorkflowFailureRoutes({
          ...current,
          nodes: current.nodes.map((n) =>
            n.id === 'action'
              ? { ...node(n.id, key), definition: { key, version } }
              : n,
          ),
        }).kind,
      ).toBe('invalid');
  });
  it('allows a skipped ordinary source but never a disabled handler', () => {
    const current = graph();
    expect(
      inspectWorkflowFailureRoutes({
        ...current,
        nodes: current.nodes.map((n) =>
          n.id === 'action' ? { ...n, disabled: true } : n,
        ),
      }).kind,
    ).toBe('routed');
    expect(
      inspectWorkflowFailureRoutes({
        ...current,
        nodes: current.nodes.map((n) =>
          n.id === 'handler' ? { ...n, disabled: true } : n,
        ),
      }).kind,
    ).toBe('invalid');
  });
  it.each([
    [edge('action', 'other', WORKFLOW_FAILURE_PORT)],
    [edge('handler', 'action')],
    [edge('handler', 'success')],
    [edge('other', 'handler')],
    [edge('handler', 'other', WORKFLOW_FAILURE_PORT)],
    [edge('handled', 'other')],
    [edge('choice', 'success', 'false')],
  ])(
    'refuses duplicate owners, nested routes, cycles, convergence or fan-out: %#',
    (extra) => {
      const current = graph();
      expect(
        inspectWorkflowFailureRoutes({
          ...current,
          edges: [...current.edges, extra],
        }).kind,
      ).toBe('invalid');
    },
  );
  it('allows only its entry to map the source’s bounded failure fields', () => {
    const current = graph();
    const mapped = (
      id: string,
      source: { kind: string; nodeId: string; path: string },
    ) => ({
      ...current,
      nodes: current.nodes.map((n) =>
        n.id === id ? { ...n, inputMappings: { code: source } } : n,
      ),
    });
    expect(
      inspectWorkflowFailureRoutes(
        mapped('handler', {
          kind: 'node_failure',
          nodeId: 'action',
          path: '$.safeErrorCode',
        }),
      ).kind,
    ).toBe('routed');
    for (const [id, source] of [
      [
        'handler',
        { kind: 'node_failure', nodeId: 'other', path: '$.safeErrorCode' },
      ],
      [
        'handled',
        { kind: 'node_failure', nodeId: 'action', path: '$.safeErrorCode' },
      ],
      [
        'success',
        { kind: 'node_failure', nodeId: 'action', path: '$.safeErrorCode' },
      ],
      [
        'handler',
        { kind: 'node_failure', nodeId: 'action', path: '$.providerMessage' },
      ],
      ['handler', { kind: 'node_output', nodeId: 'action', path: '$' }],
    ] as const)
      expect(inspectWorkflowFailureRoutes(mapped(id, source)).kind).toBe(
        'invalid',
      );
  });
  it('refuses failure data without a route or inside a loop body', () => {
    const current = graph();
    expect(
      inspectWorkflowFailureRoutes({
        nodes: [
          {
            ...node('a'),
            inputMappings: {
              code: { kind: 'node_failure', nodeId: 'b', path: '$' },
            },
          },
        ],
        edges: [],
      }).kind,
    ).toBe('invalid');
    expect(
      inspectWorkflowFailureRoutes({
        nodes: [
          { ...node('loop', 'core.foreach'), structured: { body: current } },
        ],
        edges: [],
      }).kind,
    ).toBe('invalid');
  });
});
