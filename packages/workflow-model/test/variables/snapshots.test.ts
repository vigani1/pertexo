import { resolveValueSource } from '../../src/mapping/resolve.js';
import { afterAll, expect, it } from 'vitest';
import {
  workspaceVariableValuesSchema,
  workspaceVariableSnapshotSchema,
} from '../../src/variables/contract.js';
import { canonicalJson } from '../../src/json/canonical.js';
import { JsonataEvaluator } from '../../src/expressions/evaluator.js';
import { validateExpression } from '../../src/expressions/policy.js';
import {
  workflowVariableSources,
  inspectWorkflowVariableSource,
} from '../../src/expressions/variable-usage.js';
function workflowVariableReferences(graph: WorkflowGraph) {
  const inspected = [...workflowVariableSources(graph)].map(
    inspectWorkflowVariableSource,
  );
  return {
    references: inspected.flatMap((item) =>
      item.reference === null ? [] : [item.reference],
    ),
    incomplete: inspected.some((item) => item.incomplete),
  };
}
import type { WorkflowGraph } from '../../src/graph/contract.js';
const evaluator = new JsonataEvaluator();
afterAll(() => evaluator.shutdown());
const context = {
  runInput: {},
  nodeOutputs: {},
  variables: { CURRENCY: 'EUR', AMOUNT: 0, ENABLED: false, EMPTY: '' },
};
it('keeps empty text, zero, false and Unicode without coercion', () => {
  expect(
    workspaceVariableSnapshotSchema.parse({
      revision: 1,
      values: { ...context.variables, NOTE: '🧵' },
    }),
  ).toEqual({ revision: 1, values: { ...context.variables, NOTE: '🧵' } });
});
it.each([
  { bad: 'x' },
  { KEY: null },
  { KEY: [] },
  { KEY: Infinity },
  { KEY: NaN },
  { KEY: '\0' },
  { KEY: '\uD800' },
  { KEY: 'a'.repeat(4097) },
])('refuses invalid stored configuration %j', (values) => {
  expect(workspaceVariableValuesSchema.safeParse(values).success).toBe(false);
});
it('measures the complete 32 KiB envelope and the 100-name boundary', () => {
  const values: Record<string, string> = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [
      `TEXT_${String(i)}`,
      'a'.repeat(4000),
    ]),
  );
  let spare = 32_768 - new TextEncoder().encode(canonicalJson(values)).length;
  for (const key of Object.keys(values)) {
    const add = Math.min(96, spare);
    values[key] = 'a'.repeat(4000 + add);
    spare -= add;
  }
  expect(new TextEncoder().encode(canonicalJson(values)).length).toBe(32_768);
  expect(workspaceVariableValuesSchema.safeParse(values).success).toBe(true);
  values.TEXT_2 = `${values.TEXT_2 ?? ''}a`;
  expect(workspaceVariableValuesSchema.safeParse(values).success).toBe(false);
  const many = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`VALUE_${String(i)}`, i]),
  );
  expect(workspaceVariableValuesSchema.safeParse(many).success).toBe(true);
  expect(
    workspaceVariableValuesSchema.safeParse({ ...many, EXTRA: 1 }).success,
  ).toBe(false);
});
it.each([
  ['$vars.CURRENCY', 'EUR'],
  ['$vars.AMOUNT', 0],
  ['$vars.ENABLED', false],
  ['$vars.EMPTY', ''],
  ['$lookup($vars,"ABSENT") ?? "fallback"', 'fallback'],
])('binds immutable values for %s', async (expression, value) => {
  expect(await evaluator.evaluate({ expression, context })).toMatchObject({
    kind: 'value',
    value,
  });
});
it('refuses direct missing names even when another optional lookup exists', async () => {
  expect(
    await evaluator.evaluate({
      expression: '$vars.ABSENT & $lookup($vars,"CURRENCY")',
      context,
    }),
  ).toMatchObject({ kind: 'error', code: 'variable_missing' });
  expect(
    await evaluator.evaluate({
      expression: '$lookup($vars,"ABSENT")',
      context,
    }),
  ).toMatchObject({ kind: 'error', code: 'variable_missing' });
});
it.each(['$other.VALUE', '$vars := 1', '$vars()', '$eval("1")', '$now()'])(
  'keeps unavailable constructs blocked: %s',
  (expression) => {
    expect(validateExpression(expression).kind).toBe('error');
  },
);
it('finds exact and dynamic references in bodies and results, not literal lookalikes', () => {
  const makeNode = (id: string, expression: string) => ({
    id,
    definition: { key: 'core.map', version: 1 },
    configVersion: 1,
    config: {},
    position: { x: 0, y: 0 },
    inputMappings: {
      result: {
        kind: 'expression' as const,
        language: 'jsonata' as const,
        expression,
      },
    },
    connectionRefs: {},
  });
  const graph: WorkflowGraph = {
    settings: {},
    edges: [],
    nodes: [
      makeNode('exact', '$vars.CURRENCY'),
      makeNode('optional', '$lookup($vars,"CURRENCY")'),
      makeNode('dynamic', '$lookup($vars,runInput.name)'),
      makeNode('literal', '"$vars.FAKE"'),
      {
        ...makeNode('body', '1'),
        structured: {
          kind: 'for_each',
          maxIterations: 1,
          maxConcurrency: 1,
          body: {
            inputPorts: ['item'],
            outputPorts: ['out'],
            settings: {},
            edges: [],
            nodes: [makeNode('nested', '$vars.ENABLED')],
          },
        },
      },
    ],
    callable: {
      input: { type: 'object', properties: [] },
      resultType: { type: 'string' },
      result: {
        kind: 'expression',
        language: 'jsonata',
        expression: '$vars.CURRENCY',
      },
    },
  };
  const usage = workflowVariableReferences(graph);
  expect(usage.incomplete).toBe(false);
  expect(
    usage.references.map(({ nodeId, names, dynamic }) => ({
      nodeId,
      names,
      dynamic,
    })),
  ).toEqual([
    { nodeId: null, names: ['CURRENCY'], dynamic: false },
    { nodeId: 'exact', names: ['CURRENCY'], dynamic: false },
    { nodeId: 'optional', names: ['CURRENCY'], dynamic: false },
    { nodeId: 'dynamic', names: [], dynamic: true },
    { nodeId: 'nested', names: ['ENABLED'], dynamic: false },
  ]);
  expect(
    workflowVariableReferences({
      ...graph,
      nodes: [makeNode('invalid', '$vars.(')],
    }).incomplete,
  ).toBe(true);
});

it('rejects variable accessors without invoking them', async () => {
  let invoked = false;
  const variables = Object.defineProperty({}, 'SECRET', {
    enumerable: true,
    get() {
      invoked = true;
      return 'should never be read';
    },
  });
  expect(
    await evaluator.evaluate({
      expression: '$vars.SECRET',
      context: { runInput: {}, nodeOutputs: {}, variables },
    }),
  ).toMatchObject({ kind: 'error', code: 'evaluation_failed' });
  expect(invoked).toBe(false);
});

it('resolves direct scalar mappings without an evaluator, including missing values', async () => {
  expect(
    await resolveValueSource(
      { kind: 'workspace_variable', name: 'AMOUNT' },
      context,
    ),
  ).toEqual({ kind: 'value', value: 0 });
  expect(
    await resolveValueSource(
      { kind: 'workspace_variable', name: 'ENABLED' },
      context,
    ),
  ).toEqual({ kind: 'value', value: false });
  expect(
    await resolveValueSource(
      { kind: 'workspace_variable', name: 'ABSENT' },
      context,
    ),
  ).toMatchObject({ kind: 'error', code: 'variable_missing' });
});
it('includes configured values only in expressions that can read their binding', async () => {
  const variables = Object.defineProperty({}, 'BAD', {
    enumerable: true,
    get() {
      throw new Error('Unused configuration must not be read.');
    },
  });
  expect(
    await evaluator.evaluate({
      expression: 'runInput',
      context: { runInput: 42, nodeOutputs: {}, variables },
    }),
  ).toMatchObject({ kind: 'value', value: 42 });
  const values = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [
      `VALUE_${String(i)}`,
      'a'.repeat(300),
    ]),
  );
  expect(
    await evaluator.evaluate({
      expression: '$count($keys($vars))',
      context: { runInput: {}, nodeOutputs: {}, variables: values },
    }),
  ).toMatchObject({ kind: 'value', value: 100 });
});
