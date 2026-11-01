// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  readCondition,
  writeCondition,
} from '@/features/workflow-editor/model/inspector/condition/rules';
import {
  expressionOf,
  FIELD,
  OPERATORS,
  rule,
  storedAs,
  VALUE_FOR,
} from './fixture';

describe('a saved condition reopens as what it was', () => {
  const FIELDS = [
    'runInput."a"',
    'runInput."customer-name"."b"',
    'nodeOutputs."fetch"."items"[0]."id"',
    'loop.item."id"',
    '$vars.CURRENCY',
  ];

  it.each(OPERATORS)('%s reopens with its field and value', (operator) => {
    for (const field of FIELDS) {
      const value = VALUE_FOR[operator];
      expect(
        readCondition(storedAs(expressionOf([rule(operator, value, field)]))),
      ).toEqual({
        kind: 'rules',
        draft: {
          combinator: 'and',
          rules: [{ id: 'rule-0', field, operator, value }],
        },
      });
    }
  });

  it('writes back byte for byte what it read, for each comparison', () => {
    for (const operator of OPERATORS) {
      const expression = expressionOf([rule(operator, VALUE_FOR[operator])]);
      const reading = readCondition(storedAs(expression));
      if (reading.kind !== 'rules') throw new Error(`${operator} didn't read`);
      expect(writeCondition(reading.draft)).toEqual({
        kind: 'written',
        expression,
      });
    }
  });

  it('keeps All or Any and every row in order', () => {
    for (const combinator of ['and', 'or'] as const) {
      const expression = expressionOf(
        [
          rule('greater', '3', 'runInput."a"'),
          rule('is_true', '', 'runInput."b"'),
          rule('not_equals', 'x', 'runInput."c"'),
        ],
        combinator,
      );
      const reading = readCondition(storedAs(expression));
      expect(reading).toMatchObject({
        kind: 'rules',
        draft: {
          combinator,
          rules: [
            { field: 'runInput."a"', operator: 'greater', value: '3' },
            { field: 'runInput."b"', operator: 'is_true', value: '' },
            { field: 'runInput."c"', operator: 'not_equals', value: 'x' },
          ],
        },
      });
    }
  });

  it('reads a blank step as one empty rule, and a pointed-at field as is true', () => {
    expect(readCondition(undefined)).toMatchObject({
      kind: 'rules',
      draft: { rules: [{ field: '', value: '' }] },
    });
    expect(
      readCondition({ kind: 'node_output', nodeId: 'check', path: '$.ok' }),
    ).toMatchObject({
      kind: 'rules',
      draft: {
        rules: [{ field: 'nodeOutputs."check"."ok"', operator: 'is_true' }],
      },
    });
    expect(readCondition({ kind: 'literal', value: true })).toEqual({
      kind: 'other',
    });
  });

  it.each([
    ['an unquoted field', 'nodeOutputs."id".status = 200'],
    ['a function count', 'runInput.a > 1 and $count(runInput.b) > 2'],
    [
      'a rule-shaped expression with extra whitespace',
      '$lowercase($string(runInput."a"))  =  $lowercase("x")',
    ],
    [
      'mixed and and or',
      '(runInput."a" = true) and (runInput."b" = true) or (runInput."c" = true)',
    ],
    [
      'a rule with an empty text value',
      '$lowercase($string(runInput."a")) = $lowercase("")',
    ],
  ])('leaves %s as an expression', (_name, expression) => {
    expect(readCondition(storedAs(expression))).toEqual({
      kind: 'expression',
      expression,
    });
  });
});

describe('rules that aren’t whole yet', () => {
  it('names what each rule still needs and writes nothing', () => {
    const noField = { id: 'a', field: '', operator: 'equals', value: 'x' };
    const noText = { id: 'b', field: FIELD, operator: 'equals', value: '' };
    const noNumber = { id: 'c', field: FIELD, operator: 'greater', value: '' };
    const badNumber = { id: 'd', field: FIELD, operator: 'less', value: '4x' };
    const noValueNeeded = {
      id: 'e',
      field: FIELD,
      operator: 'exists',
      value: '',
    };
    expect(
      writeCondition({
        combinator: 'and',
        rules: [noField, noText, noNumber, badNumber, noValueNeeded],
      } as Parameters<typeof writeCondition>[0]),
    ).toEqual({
      kind: 'unfinished',
      problems: {
        a: { field: 'Choose a field.' },
        b: { value: 'Enter a value.' },
        c: { value: 'Enter a number.' },
        d: { value: 'Enter a number.' },
      },
    });
  });

  it('refuses rules too long for a stored expression', () => {
    expect(
      writeCondition({
        combinator: 'and',
        rules: [rule('equals', 'x'.repeat(70_000))],
      }).kind,
    ).toBe('too_long');
  });
});
