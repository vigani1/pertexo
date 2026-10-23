import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { describe } from 'vitest';

import { coordinatorFixture as fixture } from '../../../support/coordinator/consumer.js';

export const node = (
  id: string,
  key: string,
  config: WorkflowNode['config'] = {},
  inputMappings: WorkflowNode['inputMappings'] = {},
): WorkflowNode => ({
  id,
  definition: { key, version: 1 },
  config,
  configVersion: 1,
  position: { x: 0, y: 0 },
  inputMappings,
  connectionRefs: {},
});

export const output = (nodeId: string, path: string) => ({
  kind: 'node_output' as const,
  nodeId,
  path,
});

export const links = (ids: readonly string[]) =>
  ids.flatMap((source, index) => {
    const target = ids[index + 1];
    return target === undefined
      ? []
      : [
          {
            id: `link-${String(index)}`,
            source: { nodeId: source, port: 'out' },
            target: { nodeId: target, port: 'in' },
          },
        ];
  });

export function graph(): WorkflowGraph {
  const body = [
    node(
      'date',
      'core.date',
      { operation: 'to_epoch_millis' },
      { value: { kind: 'literal', value: '2026-01-01T01:00:00+01:00' } },
    ),
    node(
      'filter',
      'core.filter',
      { path: '$', operator: 'greater_than' },
      {
        items: { kind: 'structured_input', port: 'item', path: '$' },
        value: {
          kind: 'expression',
          language: 'jsonata',
          expression: '$number("0")',
        },
      },
    ),
    node(
      'sort',
      'core.sort',
      {
        path: '$',
        valueType: 'number',
        direction: 'descending',
        missing: 'last',
      },
      { items: output('filter', '$.items') },
    ),
    node(
      'unique',
      'core.unique',
      { path: '$', missing: 'error' },
      { items: output('sort', '$.items') },
    ),
    node(
      'take',
      'core.take',
      { count: 10 },
      { items: output('unique', '$.items') },
    ),
    node(
      'concat',
      'core.concat',
      {},
      {
        items: output('take', '$.items'),
        otherItems: { kind: 'literal', value: [0] },
      },
    ),
    node(
      'batch',
      'core.batch',
      { size: 3 },
      { items: output('concat', '$.items') },
    ),
    node(
      'summary',
      'core.summarize',
      { valuePath: '$', missing: 'error' },
      { items: output('batch', '$.batches[0]') },
    ),
    node('result', 'core.set', {}, { summary: output('summary', '$') }),
  ];
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      node('manual', 'core.manual'),
      {
        ...node(
          'loop',
          'core.foreach',
          {},
          {
            items: {
              kind: 'literal',
              value: [
                [3, -2, 1, 3],
                [4, 4, 2, 0],
              ],
            },
          },
        ),
        structured: {
          kind: 'for_each',
          maxIterations: 2,
          maxConcurrency: 1,
          body: {
            settings: {},
            inputPorts: ['item', 'ordinal'],
            outputPorts: ['result'],
            nodes: body,
            edges: links(body.map((n) => n.id)),
          },
        },
      },
      node('stop', 'core.terminate', {}, { result: output('loop', '$') }),
    ],
    edges: links(['manual', 'loop', 'stop']),
  };
}

export const qualified = fixture.enabled ? describe : describe.skip;
