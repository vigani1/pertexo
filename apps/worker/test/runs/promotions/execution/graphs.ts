import { expect } from 'vitest';
import { FIND_ROWS_V2 } from '@pertexo/node-sdk';
import { HTTP_REQUEST_CONNECTION_SLOT } from '@pertexo/integrations';

import type { WorkflowGraph } from '@pertexo/workflow-model';

import { controlledActionUrl } from '../../../support/editor-browser/controlled-http.js';

import { node, edge } from '../../calls/calls.fixture.js';

const tableConfig = {
  table: 'Orders',
  columnBindings: { key: 'key', amount: 'amount' },
};

export function createPromotionChildGraph(
  sourceConnection: string,
  sourceTableId: string,
) {
  const resultType = {
    type: 'object' as const,
    properties: [
      {
        name: 'rate',
        valueType: { type: 'number' as const },
        required: true,
      },
      {
        name: 'amount',
        valueType: { type: 'number' as const },
        required: true,
      },
    ],
  };
  const child: WorkflowGraph = {
    settings: { maxRunDurationMs: 60000 },
    callable: {
      input: { type: 'object', properties: [] },
      resultType,
      result: { kind: 'node_output', nodeId: 'set', path: '$' },
    },
    nodes: [
      node('manual', 'core.manual'),
      {
        ...node('find', 'core.table_find'),
        config: tableConfig,
        inputMappings: {
          query: {
            kind: 'literal',
            value: { filters: [], limit: 1, offset: 0 },
          },
        },
      },
      {
        ...node('find-by-id', FIND_ROWS_V2.key),
        definition: FIND_ROWS_V2,
        config: { ...tableConfig, tableId: sourceTableId },
      },
      {
        ...node('http', 'http.request'),
        config: {
          method: 'POST',
          url: controlledActionUrl,
          headers: { 'content-type': 'application/json' },
          timeoutMillis: 5000,
          maxRedirects: 0,
          maxResponseBytes: 4096,
          inlineResponseBytes: 4096,
        },
        connectionRefs: {
          [HTTP_REQUEST_CONNECTION_SLOT]: sourceConnection,
        },
        inputMappings: {
          body: {
            kind: 'literal',
            value: {
              encoding: 'utf8',
              value: '{"marker":"promoted-target"}',
            },
          },
        },
      },
      {
        ...node('set', 'core.set'),
        inputMappings: {
          rate: { kind: 'workspace_variable', name: 'RATE' },
          amount: {
            kind: 'node_output',
            nodeId: 'find-by-id',
            path: '$.rows[0].values.amount',
          },
        },
      },
      node('finish', 'core.terminate'),
    ],
    edges: [
      edge('manual', 'http'),
      edge('http', 'find'),
      edge('find', 'find-by-id'),
      edge('find-by-id', 'set'),
      edge('set', 'finish'),
    ],
  };

  return { resultType, child };
}

export function expectPromotedTableBindings(
  graph: WorkflowGraph | undefined,
  targetTableId: string,
) {
  expect(graph?.nodes.find((step) => step.id === 'find')?.config).toEqual(
    tableConfig,
  );
  expect(graph?.nodes.find((step) => step.id === 'find-by-id')?.config).toEqual(
    {
      ...tableConfig,
      tableId: targetTableId,
    },
  );
}
