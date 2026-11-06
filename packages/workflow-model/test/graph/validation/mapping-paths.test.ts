import { expect, it } from 'vitest';
import { validateWorkflowGraph } from '../../../src/graph/validation/validate-workflow-graph.js';
import { parseWorkflowGraphDraft } from '../../../src/graph/validation/preflight.js';
import type {
  ValueSource,
  WorkflowGraph,
} from '../../../src/graph/workflow-graph.schemas.js';
import { node } from '../../support/graph-contract.js';

function mappedGraph(
  kind: 'run_input' | 'node_output' | 'node_failure' | 'structured_input',
  path: string,
): WorkflowGraph {
  const source: ValueSource =
    kind === 'node_output' || kind === 'node_failure'
      ? { kind, nodeId: 'source', path }
      : kind === 'structured_input'
        ? { kind, port: 'item', path }
        : { kind, path };
  const sink = {
    ...node('sink'),
    connectionRefs: {},
    inputMappings: { email: source },
  };
  if (kind === 'node_failure') {
    const plain = (id: string, key = 'core.set') => ({
      ...node(id),
      definition: { key, version: 1 },
      inputMappings: {},
      connectionRefs: {},
    });
    const link = (from: string, to: string, port = 'out') => ({
      id: `${from}-${to}`,
      source: { nodeId: from, port },
      target: { nodeId: to, port: 'in' },
    });
    return {
      settings: {},
      nodes: [
        plain('manual', 'core.manual'),
        plain('source'),
        plain('success', 'core.terminate'),
        sink,
        plain('handled', 'core.terminate'),
      ],
      edges: [
        link('manual', 'source'),
        link('source', 'success'),
        link('source', 'sink', '__failure'),
        link('sink', 'handled'),
      ],
    };
  }
  if (kind === 'structured_input')
    return {
      settings: {},
      nodes: [
        {
          ...node('loop'),
          definition: { key: 'core.foreach', version: 1 },
          connectionRefs: {},
          inputMappings: { items: { kind: 'literal', value: [] } },
          structured: {
            kind: 'for_each',
            maxIterations: 1,
            maxConcurrency: 1,
            body: {
              settings: {},
              inputPorts: ['item', 'ordinal'],
              outputPorts: ['result'],
              nodes: [sink],
              edges: [],
            },
          },
        },
      ],
      edges: [],
    };
  return {
    settings: {},
    nodes: [{ ...node('source'), connectionRefs: {}, inputMappings: {} }, sink],
    edges: [
      {
        id: 'link',
        source: {
          nodeId: 'source',
          port: 'out',
        },
        target: { nodeId: 'sink', port: 'in' },
      },
    ],
  };
}

it.each([
  'run_input',
  'node_output',
  'node_failure',
  'structured_input',
] as const)(
  'checks %s path syntax while preserving editable drafts and missing-data paths',
  (kind) => {
    for (const path of [
      'customer.email',
      '$.',
      '$[01]',
      '$..email',
      '$["email"]',
    ]) {
      const draft = parseWorkflowGraphDraft(mappedGraph(kind, path));
      const result = validateWorkflowGraph(draft);
      expect(result.ok, `${kind}: ${path}`).toBe(false);
      expect(result.issues).toContainEqual({
        code: 'invalid_mapping',
        path: `${kind === 'structured_input' ? '$.nodes.loop.structured.body' : '$'}.nodes.sink.inputMappings.email`,
        message:
          "Use a JSON path such as $.customer.email, $[0], or $['email address'].",
      });
    }
    for (const path of kind === 'node_failure'
      ? ['$', '$.safeErrorCode']
      : [
          '$',
          '$.customer.email',
          '$[0]',
          "$['email address']",
          "$.customer['email-address']",
        ]) {
      const result = validateWorkflowGraph(mappedGraph(kind, path));
      expect(
        result.ok,
        `${kind}: ${path}: ${JSON.stringify(result.issues)}`,
      ).toBe(true);
    }
  },
);
