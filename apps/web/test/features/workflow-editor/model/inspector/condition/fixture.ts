import type { JsonValue } from '@pertexo/workflow-model';
import { JsonataEvaluator } from '@pertexo/workflow-model/server';
import { afterAll } from 'vitest';
import {
  CONDITION_OPERATOR_CHOICES,
  writeCondition,
  type ConditionCombinator,
  type ConditionOperator,
} from '@/features/workflow-editor/model/inspector/condition/rules';

export const evaluator = new JsonataEvaluator();
afterAll(() => evaluator.shutdown());

export const FIELD = 'runInput."value"';
export const MISSING = Symbol('missing');
export type Field = JsonValue | typeof MISSING;

export function rule(
  operator: ConditionOperator,
  value: string,
  field = FIELD,
) {
  return { id: `${operator}-${field}`, field, operator, value };
}

export function expressionOf(
  rules: readonly ReturnType<typeof rule>[],
  combinator: ConditionCombinator = 'and',
): string {
  const written = writeCondition({ combinator, rules });
  if (written.kind !== 'written')
    throw new Error(`Not a whole condition: ${written.kind}`);
  return written.expression;
}

/** What a real run's Condition would get for this field. */
export async function evaluate(expression: string, field: Field) {
  return evaluator.evaluate({
    expression,
    context: {
      runInput: field === MISSING ? {} : { value: field },
      nodeOutputs: {},
    },
  });
}

export const VALUE_FOR: Readonly<Record<ConditionOperator, string>> = {
  equals: 'paid',
  not_equals: 'paid',
  contains: 'a',
  not_contains: 'a',
  starts_with: 'a',
  ends_with: 'a',
  greater: '3',
  at_least: '3',
  less: '3',
  at_most: '3',
  is_true: '',
  is_false: '',
  exists: '',
  not_exists: '',
  is_empty: '',
  not_empty: '',
};

export const OPERATORS = CONDITION_OPERATOR_CHOICES.map(({ value }) => value);

export function storedAs(expression: string) {
  return { kind: 'expression', language: 'jsonata', expression } as const;
}
