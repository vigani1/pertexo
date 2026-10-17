import { expect, it } from 'vitest';
import type { DataTableColumn } from '@pertexo/node-sdk';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import {
  tableColumnNames,
  isColumnNameReviewCurrent,
} from '@/features/workflow-editor/model/inspector/data-tables/names';
import { tableColumnReferences } from '@/features/workflow-editor/model/inspector/data-tables/references';
import { step, link, loopStep } from '../../../../support/fixtures/for-each';
const column = (id: string, name: string): DataTableColumn => ({
  id,
  name,
  type: 'number',
  required: false,
});
it('adopts current names together without retargeting IDs or adding unbound columns', () => {
  const bindings = Object.freeze({ amount: 'first', total: 'second' });
  const plan = tableColumnNames(
    [
      column('first', 'total'),
      column('second', 'amount'),
      column('new', 'currency'),
    ],
    bindings,
  );
  expect(plan.changes).toHaveLength(2);
  expect(plan.bindings).toEqual({ total: 'first', amount: 'second' });
  expect(bindings).toEqual({ amount: 'first', total: 'second' });
  expect(
    tableColumnNames([column('amount', 'total')], undefined).bindings,
  ).toEqual({ total: 'amount' });
});
it('refuses adoption with a missing column even when a new column has reused its old name', () => {
  const plan = tableColumnNames([column('new', 'amount')], {
    amount: 'removed',
  });
  expect(plan.fields).toEqual([
    { alias: 'amount', id: 'removed', name: undefined },
  ]);
  expect(plan.missing).toBe(true);
  expect(plan.bindings).toBeUndefined();
});
it('lists exact and whole-output mappings, nested paths, programs and callable results, excluding unrelated inputs', () => {
  const graph: WorkflowGraphContract = {
    nodes: [
      {
        ...step('before', 'Before'),
        inputMappings: {
          value: {
            kind: 'expression',
            language: 'jsonata',
            expression: 'runInput.amount',
          },
        },
      },
      step('table', 'Find rows'),
      {
        ...step('nested-json', 'Unchanged JSON field'),
        inputMappings: {
          value: {
            kind: 'node_output',
            nodeId: 'table',
            path: '$.rows[0].values.extra.values.amount',
          },
        },
      },
      {
        ...step('reader', 'Reader'),
        inputMappings: {
          amount: {
            kind: 'node_output',
            nodeId: 'table',
            path: "$.rows[0].values['amount']",
          },
        },
      },
      {
        ...step('whole', 'Whole result'),
        inputMappings: {
          list: { kind: 'node_output', nodeId: 'table', path: '$.rows' },
        },
      },
      {
        ...step('count', 'Count'),
        inputMappings: {
          count: { kind: 'node_output', nodeId: 'table', path: '$.affected' },
        },
      },
      loopStep('loop', 'Each row', {
        nodes: [
          {
            ...step('inside', 'Inside loop'),
            inputMappings: {
              value: {
                kind: 'structured_input',
                port: 'item',
                path: '$.values.amount',
              },
            },
            config: { path: '$.values.amount' },
          },
        ],
        edges: [],
      }),
      {
        ...step('expr', 'Expression'),
        inputMappings: {
          value: {
            kind: 'expression',
            language: 'jsonata',
            expression: '$lookup(nodeOutputs, runInput.step)',
          },
          unchanged: { kind: 'run_input', path: '$.values.amount' },
        },
      },
      {
        ...step('code', 'Program'),
        definition: { key: 'core.code', version: 1 },
        config: { source: 'return input[name]' },
      },
      {
        ...step('other', 'Unrelated'),
        inputMappings: {
          value: {
            kind: 'node_output',
            nodeId: 'before',
            path: '$.rows[0].values.amount',
          },
        },
      },
    ],
    edges: [
      link('1', 'before', 'table'),
      link('2', 'table', 'reader'),
      link('3', 'reader', 'whole'),
      link('4', 'whole', 'loop'),
      link('5', 'loop', 'expr'),
      link('6', 'expr', 'code'),
      link('7', 'table', 'count'),
      link('8', 'table', 'nested-json'),
    ],
    settings: {},
    callable: {
      input: { type: 'null' },
      resultType: { type: 'number' },
      result: {
        kind: 'node_output',
        nodeId: 'table',
        path: '$.rows[0].values.amount',
      },
    },
  };
  const refs = tableColumnReferences(graph, 'table', ['amount']);
  expect(new Set(refs.map((ref) => ref.step))).toEqual(
    new Set([
      'Reader',
      'Whole result',
      'Inside loop',
      'Expression',
      'Program',
      'Workflow result',
    ]),
  );
  expect(refs.find((ref) => ref.step === 'Reader')?.detail).toContain(
    "$.rows[0].values['amount']",
  );
  expect(refs.find((ref) => ref.step === 'Whole result')?.detail).toContain(
    'Receives fields',
  );
  expect(refs.filter((ref) => ref.input === 'unchanged')).toEqual([]);
});
it('reviews consumers after the containing loop without treating earlier body steps as later', () => {
  const expression = {
    kind: 'expression',
    language: 'jsonata',
    expression: 'nodeOutputs',
  } as const;
  const graph: WorkflowGraphContract = {
    nodes: [
      loopStep('loop', 'Each', {
        nodes: [
          {
            ...step('before', 'Earlier body'),
            inputMappings: { value: expression },
          },
          step('table', 'Find'),
        ],
        edges: [link('body', 'before', 'table')],
      }),
      { ...step('after', 'After loop'), inputMappings: { value: expression } },
    ],
    edges: [link('after', 'loop', 'after')],
    settings: {},
  };
  expect(
    tableColumnReferences(graph, 'table', ['amount']).map((ref) => ref.step),
  ).toEqual(['After loop']);
});
it('requires a fresh review after either the draft or the table schema changes', () => {
  const graph: WorkflowGraphContract = { nodes: [], edges: [], settings: {} };
  const review = { graph, tableId: 'table', bindings: { total: 'amount' } };
  const table = {
    id: 'table',
    columns: [column('amount', 'total')],
    revision: 3,
  };
  expect(isColumnNameReviewCurrent(review, graph, table)).toBe(true);
  const rowsChanged = { ...table, revision: 4 };
  expect(isColumnNameReviewCurrent(review, graph, rowsChanged)).toBe(true);
  expect(isColumnNameReviewCurrent(review, { ...graph }, table)).toBe(false);
  expect(
    isColumnNameReviewCurrent(review, graph, {
      ...table,
      columns: [column('amount', 'sum')],
    }),
  ).toBe(false);
});
