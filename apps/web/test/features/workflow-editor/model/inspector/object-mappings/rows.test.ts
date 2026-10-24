import jsonata from 'jsonata';
import { expect, it } from 'vitest';
import {
  contextMapping,
  contextRows,
} from '@/features/workflow-editor/model/inspector/object-mappings/rows';

it('builds ordinary JSONata for mixed sources and preserves plain lists and exact names', async () => {
  const mapping = contextMapping({
    'Customer "name"': { kind: 'run_input', path: '$.customer' },
    Amount: {
      kind: 'node_output',
      nodeId: 'step-with-dashes',
      path: '$.amount',
    },
    Currency: { kind: 'workspace_variable', name: 'CURRENCY' },
    Choices: { kind: 'literal', value: ['A'] },
    Ready: {
      kind: 'expression',
      language: 'jsonata',
      expression: 'runInput.count > 1',
    },
  });
  if (mapping?.kind !== 'expression')
    throw new Error('Expected object expression');
  const actual: unknown = await jsonata(mapping.expression).evaluate(
    {
      runInput: { customer: 'Ada', count: 2 },
      nodeOutputs: { 'step-with-dashes': { amount: 0 } },
    },
    { vars: { CURRENCY: 'EUR' } },
  );
  expect(actual).toEqual({
    'Customer "name"': 'Ada',
    Amount: 0,
    Currency: 'EUR',
    Choices: ['A'],
    Ready: true,
  });
  const rows = contextRows(mapping);
  expect(rows?.map((row) => row.destinationKey)).toEqual([
    'Customer "name"',
    'Amount',
    'Currency',
    'Choices',
    'Ready',
  ]);
  expect(rows?.find((row) => row.destinationKey === 'Choices')).toMatchObject({
    kind: 'literal',
    literalJson: '["A"]',
  });
});
it('keeps existing whole-object mappings and noncanonical expressions untouched', () => {
  expect(contextRows({ kind: 'run_input', path: '$.details' })).toBeUndefined();
  expect(
    contextRows({
      kind: 'expression',
      language: 'jsonata',
      expression: '$merge(runInput)',
    }),
  ).toBeUndefined();
  expect(
    contextRows({
      kind: 'expression',
      language: 'jsonata',
      expression: "{'name': runInput.name}",
    }),
  ).toBeUndefined();
  expect(
    contextRows({
      kind: 'expression',
      language: 'jsonata',
      expression: '{"a": 1, "a": 2}',
    }),
  ).toBeUndefined();
});
it('parses without evaluating advanced values and retains nested punctuation inside expressions', () => {
  const mapping = contextMapping({
    Check: {
      kind: 'expression',
      language: 'jsonata',
      expression: '$error("must never execute, {x}")',
    },
  });
  expect(contextRows(mapping)).toMatchObject([
    { kind: 'expression', expression: '$error("must never execute, {x}")' },
  ]);
});
it('retains literal objects and excludes unsupported alternate context bindings', () => {
  expect(
    contextMapping({
      Ready: { kind: 'literal', value: false },
      IDs: { kind: 'literal', value: [0, null] },
    }),
  ).toEqual({ kind: 'literal', value: { Ready: false, IDs: [0, null] } });
  expect(
    contextMapping({
      Item: { kind: 'structured_input', port: 'item', path: '$' },
    }),
  ).toBeUndefined();
});

it('preserves comments around parenthesized advanced values and Unicode labels', async () => {
  const source = {
    kind: 'expression',
    language: 'jsonata',
    expression: '{"客户 🧵": /* keep this */ (runInput.amount)}',
  } as const;
  expect(contextRows(source)).toMatchObject([
    {
      destinationKey: '客户 🧵',
      kind: 'expression',
      expression: '/* keep this */ (runInput.amount)',
    },
  ]);
  const mapping = contextMapping({
    '客户 🧵': { kind: 'run_input', path: "$['odd-key'][0]" },
  });
  if (mapping?.kind !== 'expression')
    throw new Error('Expected object mapping');
  const result: unknown = await jsonata(mapping.expression).evaluate({
    runInput: { 'odd-key': [0] },
  });
  expect(result).toEqual({ '客户 🧵': 0 });
});

it('restores ordinary picker sources after reload instead of turning them into advanced expressions', () => {
  const mapping = contextMapping({
    Input: { kind: 'run_input', path: '$.customer[0]' },
    Step: {
      kind: 'node_output',
      nodeId: 'previous-step',
      path: "$['odd-key'][1]",
    },
    Variable: { kind: 'workspace_variable', name: 'CURRENCY' },
    Root: { kind: 'run_input', path: '$' },
  });
  expect(contextRows(mapping)).toMatchObject([
    { destinationKey: 'Input', kind: 'run_input', path: '$.customer[0]' },
    {
      destinationKey: 'Step',
      kind: 'node_output',
      nodeId: 'previous-step',
      path: "$['odd-key'][1]",
    },
    {
      destinationKey: 'Variable',
      kind: 'workspace_variable',
      name: 'CURRENCY',
    },
    { destinationKey: 'Root', kind: 'run_input', path: '$' },
  ]);
});
it('preserves singleton/empty list mappings and safely quotes picker property names', async () => {
  const { propertyPath } =
    await import('@/features/workflow-editor/model/inspector/input-mappings/draft');
  const key = `Customer's "name"\\code`;
  const path = propertyPath(key);
  const mapping = contextMapping({
    Customer: { kind: 'run_input', path },
    Items: { kind: 'node_output', nodeId: 'previous', path: '$.items' },
    Empty: { kind: 'run_input', path: '$.empty' },
  });
  if (mapping?.kind !== 'expression') throw new Error('Expected mapping');
  const value: unknown = await jsonata(mapping.expression).evaluate({
    runInput: { [key]: 'Ada', empty: [] },
    nodeOutputs: { previous: { items: ['one'] } },
  });
  expect(value).toEqual({ Customer: 'Ada', Items: ['one'], Empty: [] });
  expect(contextRows(mapping)?.[0]).toMatchObject({ kind: 'run_input', path });
});
