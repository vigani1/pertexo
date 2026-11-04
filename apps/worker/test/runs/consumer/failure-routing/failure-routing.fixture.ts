import { node } from '../../../support/coordinator/workflows/graph.js';
import { describe } from 'vitest';

import type { WorkflowGraph } from '@pertexo/workflow-model';

import { coordinatorFixture as fixture } from '../../../support/coordinator/consumer.js';

export function graph(): WorkflowGraph {
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      node('manual', 'core.manual'),
      {
        ...node('choice', 'core.condition'),
        inputMappings: { condition: { kind: 'literal', value: true } },
      },
      node('source', 'core.set'),
      node('normal-stop', 'core.terminate'),
      node('off-path', 'core.terminate'),
      {
        ...node('handler', 'core.set'),
        inputMappings: {
          failure: { kind: 'node_failure', nodeId: 'source', path: '$' },
        },
      },
      {
        ...node('handler-stop', 'core.terminate'),
        inputMappings: {
          result: { kind: 'node_output', nodeId: 'handler', path: '$' },
        },
      },
    ],
    edges: (
      [
        ['manual', 'choice', 'out'],
        ['choice', 'source', 'true'],
        ['choice', 'off-path', 'false'],
        ['source', 'normal-stop', 'out'],
        ['source', 'handler', '__failure'],
        ['handler', 'handler-stop', 'out'],
      ] as const
    ).map(([source, target, port], i) => ({
      id: `link-${String(i)}`,
      source: { nodeId: source, port: port },
      target: { nodeId: target, port: 'in' },
    })),
  };
}

export function assertCleanup(
  errors: readonly unknown[],
  primary: unknown,
): void {
  if (errors.length > 0)
    throw new AggregateError(
      primary === undefined ? errors : [primary, ...errors],
      'Failure handling qualification cleanup failed',
    );
}

export const qualified = fixture.enabled ? describe : describe.skip;
