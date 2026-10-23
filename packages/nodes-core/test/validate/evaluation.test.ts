import { describe, expect, it } from 'vitest';

import {
  CORE_VALIDATE_ISSUE_MESSAGES,
  CORE_VALIDATE_MAX_ISSUES,
  type CoreValidateInput,
  evaluateCoreValidate,
} from '../../src/index.js';

import { config } from '../support/validate.js';
describe('core.validate deterministic evaluation', () => {
  it('uses rule order and one issue per rule with documented precedence', () => {
    const parsed = config([
      { id: 'required', path: '$.missing', required: true },
      { id: 'type', path: '$.value', type: 'string', enum: ['x'] },
      { id: 'enum', path: '$.value', enum: ['other'] },
      { id: 'minimum', path: '$.number', type: 'number', minimum: 5 },
      { id: 'maximum', path: '$.number', type: 'number', maximum: 1 },
      { id: 'minLength', path: '$.text', type: 'string', minLength: 3 },
      { id: 'maxLength', path: '$.text', type: 'string', maxLength: 1 },
      { id: 'minItems', path: '$.items', type: 'array', minItems: 3 },
      { id: 'maxItems', path: '$.items', type: 'array', maxItems: 0 },
    ]);
    expect(
      evaluateCoreValidate(parsed, {
        value: 2,
        number: 2,
        text: '😀😀',
        items: [1, 2],
      }),
    ).toEqual({
      valid: false,
      issues: [
        {
          ruleId: 'required',
          path: '$.missing',
          code: 'required',
          message: CORE_VALIDATE_ISSUE_MESSAGES.required,
        },
        {
          ruleId: 'type',
          path: '$.value',
          code: 'type',
          message: CORE_VALIDATE_ISSUE_MESSAGES.type,
        },
        {
          ruleId: 'enum',
          path: '$.value',
          code: 'enum',
          message: CORE_VALIDATE_ISSUE_MESSAGES.enum,
        },
        {
          ruleId: 'minimum',
          path: '$.number',
          code: 'minimum',
          message: CORE_VALIDATE_ISSUE_MESSAGES.minimum,
        },
        {
          ruleId: 'maximum',
          path: '$.number',
          code: 'maximum',
          message: CORE_VALIDATE_ISSUE_MESSAGES.maximum,
        },
        {
          ruleId: 'minLength',
          path: '$.text',
          code: 'min_length',
          message: CORE_VALIDATE_ISSUE_MESSAGES.minLength,
        },
        {
          ruleId: 'maxLength',
          path: '$.text',
          code: 'max_length',
          message: CORE_VALIDATE_ISSUE_MESSAGES.maxLength,
        },
        {
          ruleId: 'minItems',
          path: '$.items',
          code: 'min_items',
          message: CORE_VALIDATE_ISSUE_MESSAGES.minItems,
        },
        {
          ruleId: 'maxItems',
          path: '$.items',
          code: 'max_items',
          message: CORE_VALIDATE_ISSUE_MESSAGES.maxItems,
        },
      ],
      truncated: false,
    });
  });

  it('distinguishes missing from null and counts Unicode code points', () => {
    const parsed = config([
      { id: 'optional', path: '$.missing', type: 'string' },
      { id: 'null', path: '$.value', type: 'null', required: true },
      { id: 'emoji', path: '$.emoji', type: 'string', minLength: 2 },
    ]);
    expect(
      evaluateCoreValidate(parsed, { value: null, emoji: '😀😀' }),
    ).toEqual({
      valid: true,
      issues: [],
      truncated: false,
    });
  });

  it.each([
    {
      description: 'zero maximum accepts empty',
      value: '',
      minLength: undefined,
      maxLength: 0,
      expectedCode: undefined,
    },
    {
      description: 'zero maximum rejects one code point',
      value: 'a',
      minLength: undefined,
      maxLength: 0,
      expectedCode: 'max_length',
    },
    {
      description: 'exact maximum succeeds',
      value: 'abc',
      minLength: undefined,
      maxLength: 3,
      expectedCode: undefined,
    },
    {
      description: 'one over maximum fails',
      value: 'abcd',
      minLength: undefined,
      maxLength: 3,
      expectedCode: 'max_length',
    },
    {
      description: 'minimum-only succeeds at its bound',
      value: 'abc',
      minLength: 3,
      maxLength: undefined,
      expectedCode: undefined,
    },
    {
      description: 'both constraints preserve minimum precedence',
      value: 'a',
      minLength: 2,
      maxLength: 4,
      expectedCode: 'min_length',
    },
    {
      description: 'astral symbols count as one code point',
      value: '😀😀',
      minLength: 2,
      maxLength: 2,
      expectedCode: undefined,
    },
    {
      description: 'combining marks count separately',
      value: 'e\u0301',
      minLength: 2,
      maxLength: 2,
      expectedCode: undefined,
    },
    {
      description: 'lone surrogates count as one code point',
      value: '\ud800',
      minLength: 1,
      maxLength: 1,
      expectedCode: undefined,
    },
    {
      description: 'no length constraint accepts a long string',
      value: 'x'.repeat(100_000),
      minLength: undefined,
      maxLength: undefined,
      expectedCode: undefined,
    },
  ])('$description', ({ value, minLength, maxLength, expectedCode }) => {
    const rule = {
      id: 'length',
      path: '$.value',
      type: 'string',
      ...(minLength === undefined ? {} : { minLength }),
      ...(maxLength === undefined ? {} : { maxLength }),
    };
    const result = evaluateCoreValidate(config([rule]), { value });
    expect(result.issues[0]?.code).toBe(expectedCode);
    expect(result.valid).toBe(expectedCode === undefined);
  });

  it('resolves root, quoted own properties and array paths without echoing input', () => {
    const parsed = config([
      { id: 'root', path: '$', type: 'object' },
      { id: 'quoted', path: "$['a.b']", type: 'number', minimum: 5 },
      { id: 'array', path: '$.items[1]', type: 'boolean', enum: [true] },
    ]);
    const input = JSON.parse(
      '{"a.b":7,"items":[false,true]}',
    ) as CoreValidateInput;
    expect(evaluateCoreValidate(parsed, input)).toEqual({
      valid: true,
      issues: [],
      truncated: false,
    });
    expect(input).toEqual({ 'a.b': 7, items: [false, true] });
  });

  it('stops at 16 issues and marks only unevaluated rules as truncated', () => {
    const rules = Array.from({ length: 17 }, (_, index) => ({
      id: `rule-${String(index)}`,
      path: `$.missing${String(index)}`,
      required: true,
    }));
    const parsed = config(rules);
    const result = evaluateCoreValidate(parsed, {});
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(CORE_VALIDATE_MAX_ISSUES);
    expect(result.truncated).toBe(true);
    expect(result.issues.at(-1)?.ruleId).toBe('rule-15');

    const exact = evaluateCoreValidate(config(rules.slice(0, 16)), {});
    expect(exact.issues).toHaveLength(CORE_VALIDATE_MAX_ISSUES);
    expect(exact.truncated).toBe(false);
  });

  it('fails with the normal cancellation contract when aborted', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      evaluateCoreValidate(
        config([{ id: 'value', path: '$.value' }]),
        { value: true },
        controller.signal,
      ),
    ).toThrow('Validate execution was canceled');
  });
});
