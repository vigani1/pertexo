import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { describe } from 'vitest';

import { coordinatorFixture as fixture } from '../../../support/coordinator/consumer.js';

export function graph(): WorkflowGraph {
  const node = (id: string, key: string): WorkflowNode => ({
    id,
    definition: { key, version: 1 },
    config: {},
    configVersion: 1,
    position: { x: 0, y: 0 },
    inputMappings: {},
    connectionRefs: {},
  });
  return {
    settings: { maxRunDurationMs: 60_000 },
    callable: {
      input: {
        type: 'object',
        properties: [
          { name: 'name', valueType: { type: 'string' }, required: true },
        ],
      },
      resultType: { type: 'string' },
      result: { kind: 'node_output', nodeId: 'prefix', path: '$.name' },
    },
    nodes: [
      node('manual', 'core.manual'),
      {
        ...node('prefix', 'core.set'),
        inputMappings: { name: { kind: 'workspace_variable', name: 'NAME' } },
      },
      {
        ...node('choice', 'core.condition'),
        inputMappings: { condition: { kind: 'literal', value: true } },
      },
      {
        ...node('target', 'core.set'),
        inputMappings: {
          name: { kind: 'node_output', nodeId: 'prefix', path: '$.name' },
        },
      },
      node('stop', 'core.terminate'),
      node('other', 'core.terminate'),
    ],
    edges: [
      ['manual', 'choice', 'out'],
      ['choice', 'prefix', 'true'],
      ['prefix', 'target', 'out'],
      ['choice', 'other', 'false'],
      ['target', 'stop', 'out'],
    ].map(([source, target, port], i) => ({
      id: `link-${String(i)}`,
      source: { nodeId: source ?? '', port: port ?? '' },
      target: { nodeId: target ?? '', port: 'in' },
    })),
  };
}

export async function closeOwned(
  owners: readonly (() => Promise<void>)[],
  primary: { error: unknown } | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  for (const close of [...owners].reverse())
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length > 0)
    throw new AggregateError(
      primary === undefined ? errors : [primary.error, ...errors],
      'Recovery qualification cleanup failed',
    );
}

export const qualified = fixture.enabled ? describe : describe.skip;
