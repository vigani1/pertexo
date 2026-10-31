import { afterAll, expect, it } from 'vitest';

import { JsonataEvaluator } from '../../src/values/expressions/evaluator.js';
import { canonicalJson } from '../../src/values/json/canonical.js';
import {
  workspaceVariableDescriptionsSchema,
  workspaceVariableNameSchema,
  workspaceVariableValuesSchema,
} from '../../src/values/variables/contract.js';

const evaluator = new JsonataEvaluator();
afterAll(() => evaluator.shutdown());
const valid = (name: string) =>
  workspaceVariableNameSchema.safeParse(name).success;

it.each(['A', 'BASE_URL', 'RETRY_2', 'A_', `A${'B'.repeat(63)}`])(
  'accepts the name %s',
  (name) => {
    expect(valid(name)).toBe(true);
  },
);

it.each([
  '',
  '_A',
  '1A',
  'a',
  'Aa',
  'A-B',
  'A B',
  'A.B',
  'Ä',
  `A${'B'.repeat(64)}`,
])('refuses the name %j', (name) => {
  expect(valid(name)).toBe(false);
});

it('accepts a text value of exactly 4,096 characters, counted as characters', () => {
  expect(
    workspaceVariableValuesSchema.safeParse({ TEXT: 'a'.repeat(4096) }).success,
  ).toBe(true);
});

it.each([
  [{ EMPTY: '' }],
  [{ ZERO: 0 }],
  [{ NEGATIVE: -1.5 }],
  [{ OFF: false }],
  [{ ON: true }],
])('keeps %j as a value', (values) => {
  expect(workspaceVariableValuesSchema.parse(values)).toEqual(values);
});

it.each([
  [{ OBJECT: {} }],
  [{ LIST: [1] }],
  [{ NOTHING: null }],
  [{ LATER: undefined }],
])('refuses %j, which is not text, a number or a boolean', (values) => {
  expect(workspaceVariableValuesSchema.safeParse(values).success).toBe(false);
});

const size = (value: Record<string, string>) =>
  new TextEncoder().encode(canonicalJson(value)).length;

/** Several long texts plus a shorter one with room to grow, at an exact total size. */
function filled(bytes: number, longText: number): Record<string, string> {
  let values: Record<string, string> = { TOTAL: '' };
  for (let i = 0; ; i += 1) {
    const next = { ...values, [`LONG_${String(i)}`]: 'a'.repeat(longText) };
    if (size(next) > bytes) break;
    values = next;
  }
  values.TOTAL = 'a'.repeat(bytes - size(values));
  expect(size(values)).toBe(bytes);
  return values;
}

it('holds values to 32,768 bytes even when every text is within its own limit', () => {
  const values = filled(32_768, 4_000);
  expect(workspaceVariableValuesSchema.safeParse(values).success).toBe(true);
  values.TOTAL = `${values.TOTAL ?? ''}a`;
  expect(values.TOTAL.length).toBeLessThan(4_096);
  expect(workspaceVariableValuesSchema.safeParse(values).success).toBe(false);
});

it('holds descriptions to 16,384 bytes even when each is within its own limit', () => {
  const descriptions = filled(16_384, 400);
  expect(
    workspaceVariableDescriptionsSchema.safeParse(descriptions).success,
  ).toBe(true);
  descriptions.TOTAL = `${descriptions.TOTAL ?? ''}a`;
  expect(descriptions.TOTAL.length).toBeLessThan(500);
  expect(
    workspaceVariableDescriptionsSchema.safeParse(descriptions).success,
  ).toBe(false);
});

const context = {
  runInput: { name: 'ABSENT' },
  nodeOutputs: {},
  variables: {},
};

it.each([
  ['$exists($vars.ABSENT)'],
  ['$vars.ABSENT ? "yes" : "no"'],
  ['$vars.ABSENT ?? "fallback"'],
  ['$vars.PATH'],
  ['$vars.HOME'],
])('fails %s clearly, whatever guards the direct read', async (expression) => {
  expect(await evaluator.evaluate({ expression, context })).toMatchObject({
    kind: 'error',
    code: 'variable_missing',
  });
});

it('fails a dynamic lookup with no match when it is the mapping result', async () => {
  expect(
    await evaluator.evaluate({
      expression: '$lookup($vars,runInput.name)',
      context,
    }),
  ).toMatchObject({ kind: 'error', code: 'variable_missing' });
});

it('lets a lookup of an optional name fall back', async () => {
  expect(
    await evaluator.evaluate({
      expression: '$lookup($vars,runInput.name) ?? "EUR"',
      context,
    }),
  ).toMatchObject({ kind: 'value', value: 'EUR' });
});
