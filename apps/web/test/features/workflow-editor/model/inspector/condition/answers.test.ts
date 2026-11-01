// @vitest-environment node
import type { JsonValue } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';
import {
  CONDITION_OPERATOR_CHOICES,
  readCondition,
  type ConditionCombinator,
  type ConditionOperator,
} from '@/features/workflow-editor/model/inspector/condition/rules';
import {
  evaluate,
  evaluator,
  expressionOf,
  FIELD,
  MISSING,
  OPERATORS,
  rule,
  storedAs,
  VALUE_FOR,
  type Field,
} from './fixture';

describe('what each comparison answers in a real run', () => {
  it('offers every comparison the rule list promises', () => {
    expect(CONDITION_OPERATOR_CHOICES.map(({ label }) => label)).toEqual([
      'is equal to',
      'is not equal to',
      'contains',
      'doesn’t contain',
      'starts with',
      'ends with',
      'is greater than',
      'is at least',
      'is less than',
      'is at most',
      'is true',
      'is false',
      'exists',
      'doesn’t exist',
      'is empty',
      'isn’t empty',
    ]);
  });

  const SHAPES: readonly (readonly [string, Field])[] = [
    ['present text', 'paid'],
    ['a missing field', MISSING],
    ['a number', 42],
    ['zero', 0],
    ['true', true],
    ['false', false],
    ['null', null],
    ['an object', { a: 1 }],
    ['an empty object', {}],
    ['a list', [1, 2]],
    ['an empty list', []],
    ['an empty string', ''],
  ];

  it.each(OPERATORS)(
    '%s routes to true or false whatever the field holds, never failing the step',
    async (operator) => {
      const expression = expressionOf([rule(operator, VALUE_FOR[operator])]);
      for (const [shape, field] of SHAPES) {
        const result = await evaluate(expression, field);
        expect(
          result.kind === 'value' ? typeof result.value : result,
          `${operator} on ${shape}`,
        ).toBe('boolean');
      }
    },
  );

  const TRUTH: readonly (readonly [
    ConditionOperator,
    string,
    Field,
    boolean,
  ])[] = [
    ['equals', 'paid', 'Paid', true],
    ['equals', 'PAID', 'paid', true],
    ['equals', 'paid', 'unpaid', false],
    ['equals', 'paid', MISSING, false],
    ['equals', '200', 200, true],
    ['equals', '200', 201, false],
    ['equals', 'TRUE', true, true],
    ['equals', 'false', true, false],
    ['not_equals', 'paid', 'Paid', false],
    ['not_equals', 'paid', 'open', true],
    ['not_equals', 'paid', MISSING, true],
    ['not_equals', '200', 200, false],
    ['contains', 'a', 'BAR', true],
    ['contains', 'a', 'xyz', false],
    ['contains', 'a', MISSING, false],
    ['contains', '20', 1200, true],
    ['contains', '9', 1200, false],
    ['not_contains', 'a', 'BAR', false],
    ['not_contains', 'a', 'xyz', true],
    ['not_contains', 'a', MISSING, true],
    ['equals', 'null', null, false],
    ['equals', '[1,2]', [1, 2], false],
    ['not_equals', 'null', null, true],
    ['contains', 'u', null, false],
    ['contains', 'a', { a: 1 }, false],
    ['contains', '1', [1, 2], false],
    ['not_contains', 'u', null, true],
    ['starts_with', 'nu', null, false],
    ['starts_with', '{', { a: 1 }, false],
    ['ends_with', 'll', null, false],
    ['ends_with', ']', [1, 2], false],
    ['starts_with', 'ab', 'ABC', true],
    ['starts_with', 'ab', 'cab', false],
    ['starts_with', 'ab', MISSING, false],
    ['starts_with', '12', 123, true],
    ['starts_with', 'abcd', 'abc', false],
    ['ends_with', 'bc', 'ABC', true],
    ['ends_with', 'bc', 'bca', false],
    ['ends_with', 'bc', MISSING, false],
    ['ends_with', '23', 123, true],
    ['ends_with', 'xabc', 'abc', false],
    ['greater', '3', 5, true],
    ['greater', '3', 3, false],
    ['greater', '3', 2, false],
    ['greater', '3', '42', false],
    ['greater', '3', MISSING, false],
    ['greater', '-1', 0, true],
    ['greater', '1.5', 1.75, true],
    ['at_least', '3', 3, true],
    ['at_least', '3', 2, false],
    ['at_least', '3', '42', false],
    ['less', '3', 2, true],
    ['less', '3', 3, false],
    ['less', '3', '2', false],
    ['at_most', '3', 3, true],
    ['at_most', '3', 4, false],
    ['at_most', '3', '2', false],
    ['is_true', '', true, true],
    ['is_true', '', false, false],
    ['is_true', '', 'true', false],
    ['is_true', '', MISSING, false],
    ['is_false', '', false, true],
    ['is_false', '', true, false],
    ['is_false', '', 0, false],
    ['is_false', '', MISSING, false],
    ['exists', '', 'x', true],
    ['exists', '', 0, true],
    ['exists', '', false, true],
    ['exists', '', '', true],
    ['exists', '', MISSING, false],
    ['not_exists', '', MISSING, true],
    ['not_exists', '', 'x', false],
    ['is_empty', '', MISSING, true],
    ['is_empty', '', null, true],
    ['is_empty', '', '', true],
    ['is_empty', '', {}, true],
    ['is_empty', '', [], true],
    ['is_empty', '', [0], false],
    ['not_empty', '', [], false],
    ['is_empty', '', 0, false],
    ['is_empty', '', false, false],
    ['is_empty', '', 'x', false],
    ['is_empty', '', { a: 1 }, false],
    ['not_empty', '', MISSING, false],
    ['not_empty', '', null, false],
    ['not_empty', '', '', false],
    ['not_empty', '', {}, false],
    ['not_empty', '', 0, true],
    ['not_empty', '', false, true],
    ['not_empty', '', 'x', true],
  ];

  it.each(TRUTH)(
    '%s %j on %j is %j',
    async (operator, value, field, expected) => {
      const result = await evaluate(
        expressionOf([rule(operator, value)]),
        field,
      );
      expect(result).toMatchObject({ kind: 'value', value: expected });
    },
  );
});

/** Text a person might type that means something to an expression. */
const AWKWARD_VALUES = [
  'say "hi"',
  "it's",
  'a]b[c',
  '(round) {curly}',
  'back\\slash',
  'trailing\\',
  'this and that',
  'this or that',
  ') and (',
  '$vars.SECRET',
  'line\nbreak',
  'Zürich 東京 🙂',
  'İstanbul',
];

describe('values save and evaluate as typed', () => {
  it.each(AWKWARD_VALUES)('%j', async (value) => {
    const text = `before${value}after`;
    for (const [operator, field, expected] of [
      ['equals', value, true],
      ['equals', text, false],
      ['not_equals', text, true],
      ['contains', text, true],
      ['not_contains', text, false],
      ['starts_with', `${value}after`, true],
      ['ends_with', `before${value}`, true],
    ] as const) {
      const expression = expressionOf([rule(operator, value)]);
      await expect(
        evaluate(expression, field),
        `${operator} ${value} on ${field}`,
      ).resolves.toMatchObject({ kind: 'value', value: expected });
      expect(readCondition(storedAs(expression))).toMatchObject({
        kind: 'rules',
        draft: { rules: [{ operator, value, field: FIELD }] },
      });
    }
  });

  it.each(AWKWARD_VALUES)('%j survives inside two joined rules', (value) => {
    for (const combinator of ['and', 'or'] as const) {
      const expression = expressionOf(
        [rule('equals', value), rule('contains', value, 'runInput."other"')],
        combinator,
      );
      expect(readCondition(storedAs(expression))).toMatchObject({
        kind: 'rules',
        draft: {
          combinator,
          rules: [
            { operator: 'equals', value, field: FIELD },
            { operator: 'contains', value, field: 'runInput."other"' },
          ],
        },
      });
    }
  });
});

describe('several rules', () => {
  const rules = [
    rule('at_least', '200', 'runInput."status"'),
    rule('equals', 'paid', 'runInput."state"'),
  ];
  const decide = (combinator: ConditionCombinator, runInput: JsonValue) =>
    evaluator.evaluate({
      expression: expressionOf(rules, combinator),
      context: { runInput, nodeOutputs: {} },
    });

  it.each([
    ['and', { status: 200, state: 'Paid' }, true],
    ['and', { status: 200, state: 'open' }, false],
    ['and', { status: 100, state: 'Paid' }, false],
    ['and', { status: 100, state: 'open' }, false],
    ['or', { status: 200, state: 'Paid' }, true],
    ['or', { status: 200, state: 'open' }, true],
    ['or', { status: 100, state: 'Paid' }, true],
    ['or', { status: 100, state: 'open' }, false],
    ['and', {}, false],
    ['or', {}, false],
  ] as const)('%s on %j is %j', async (combinator, runInput, expected) => {
    await expect(decide(combinator, runInput)).resolves.toMatchObject({
      kind: 'value',
      value: expected,
    });
  });

  it('reads comparisons that hold their own and and or', async () => {
    const empties = expressionOf(
      [
        rule('is_empty', '', 'runInput."a"'),
        rule('contains', 'x', 'runInput."b"'),
        rule('not_empty', '', 'runInput."c"'),
      ],
      'or',
    );
    expect(readCondition(storedAs(empties))).toMatchObject({
      kind: 'rules',
      draft: {
        combinator: 'or',
        rules: [
          { operator: 'is_empty' },
          { operator: 'contains', value: 'x' },
          { operator: 'not_empty' },
        ],
      },
    });
    await expect(
      evaluator.evaluate({
        expression: empties,
        context: { runInput: { a: 'full', b: 'y' }, nodeOutputs: {} },
      }),
    ).resolves.toMatchObject({ kind: 'value', value: false });
  });
});
