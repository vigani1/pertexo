import {
  EMPTY_WORKFLOW_GRAPH,
  type WorkflowGraph,
} from '../../src/graph/contract.js';

import { parseWorkflowGraphDraft } from '../../src/graph/validation/preflight.js';
import { WorkflowGraphContractError } from '../../src/graph/validation/contract.js';
export const TEST_DEFINITION_CATALOG = {
  definitions: [
    { key: 'core.other', version: 1 },
    { key: 'core.set', version: 1 },
    { key: 'core.set', version: 2 },
  ],
};
export const node = (id: string) => ({
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
export const fixture = (): WorkflowGraph => ({
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
export function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('fixture must not be empty');
  return value;
}
export function nestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let index = 1; index < depth; index += 1) value = { child: value };
  return value;
}
export function nestedStructuredGraph(depth: number): unknown {
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
export function contractError(input: unknown): WorkflowGraphContractError {
  try {
    parseWorkflowGraphDraft(input);
  } catch (error) {
    if (error instanceof WorkflowGraphContractError) return error;
    throw error;
  }
  throw new Error('expected workflow graph contract rejection');
}
