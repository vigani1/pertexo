import { describe, expect, it } from 'vitest';

import {
  CORE_VALIDATE_CONFIG_SCHEMA,
  CORE_VALIDATE_ISSUE_CODES,
  CORE_VALIDATE_ISSUE_CODE_VALUES,
  CORE_VALIDATE_ISSUE_MESSAGES,
  CORE_VALIDATE_ISSUE_SCHEMA,
  CORE_VALIDATE_RULE_SCHEMA,
  CORE_VALIDATE_VALUE_TYPES,
} from '../../src/index.js';

import { invalidCases, fixedIssueMetadata } from '../support/validate.js';
describe('core.validate configuration contract', () => {
  it.each([
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
  ])('requires a compatible declared type for %s', (field) => {
    const parsed = CORE_VALIDATE_RULE_SCHEMA.safeParse({
      id: 'typed',
      path: '$',
      type: 'boolean',
      [field]: 1,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ path: [field] }),
      );
  });
  it('accepts exact rule and enum limits and rejects the next entry', () => {
    const rules = Array.from({ length: 64 }, (_, index) => ({
      id: `rule-${String(index)}`,
      path: '$',
    }));
    expect(CORE_VALIDATE_CONFIG_SCHEMA.safeParse({ rules }).success).toBe(true);
    expect(
      CORE_VALIDATE_CONFIG_SCHEMA.safeParse({
        rules: [...rules, { id: 'extra', path: '$' }],
      }).success,
    ).toBe(false);
    const values = Array.from({ length: 32 }, (_, index) => index);
    expect(
      CORE_VALIDATE_RULE_SCHEMA.safeParse({
        id: 'enum',
        path: '$',
        enum: values,
      }).success,
    ).toBe(true);
    expect(
      CORE_VALIDATE_RULE_SCHEMA.safeParse({
        id: 'enum',
        path: '$',
        enum: [...values, 32],
      }).success,
    ).toBe(false);
  });

  it.each([
    { type: 'number', minimum: Infinity },
    { type: 'number', maximum: NaN },
    { type: 'string', minLength: -1 },
    { type: 'array', maxItems: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'array', minItems: 3, maxItems: 2 },
    { type: 'number', enum: ['1'] },
    { type: 'object', enum: [null] },
  ])('rejects incoherent rule limits %j', (constraint) => {
    expect(
      CORE_VALIDATE_RULE_SCHEMA.safeParse({
        id: 'bounded',
        path: '$',
        ...constraint,
      }).success,
    ).toBe(false);
  });
  it('accepts the bounded rule vocabulary and defaults required to false', () => {
    expect(
      CORE_VALIDATE_CONFIG_SCHEMA.parse({
        rules: [{ id: 'name', path: '$.name' }],
      }),
    ).toEqual({
      rules: [{ id: 'name', path: '$.name', required: false }],
    });
    expect(CORE_VALIDATE_VALUE_TYPES).toEqual([
      'string',
      'number',
      'boolean',
      'object',
      'array',
      'null',
    ]);
  });

  it.each(
    invalidCases.map(
      ([candidate, description]) => [description, candidate] as const,
    ),
  )('rejects %s', (_description, candidate) => {
    expect(CORE_VALIDATE_CONFIG_SCHEMA.safeParse(candidate).success).toBe(
      false,
    );
  });

  it('rejects paths over the byte or segment bounds while preserving quoted names', () => {
    expect(
      CORE_VALIDATE_RULE_SCHEMA.safeParse({
        id: 'quoted',
        path: "$['a.b'][0]['quote\\'key']",
      }).success,
    ).toBe(true);
    expect(
      CORE_VALIDATE_RULE_SCHEMA.safeParse({
        id: 'segments',
        path: '$' + '.segment'.repeat(65),
      }).success,
    ).toBe(false);
    expect(
      CORE_VALIDATE_RULE_SCHEMA.safeParse({
        id: 'bytes',
        path: '$.' + '😀'.repeat(170),
      }).success,
    ).toBe(false);
  });

  it('pins fixed issue codes and messages without observed values', () => {
    expect(CORE_VALIDATE_ISSUE_CODES).toEqual({
      required: 'required',
      type: 'type',
      enum: 'enum',
      minimum: 'minimum',
      maximum: 'maximum',
      minLength: 'min_length',
      maxLength: 'max_length',
      minItems: 'min_items',
      maxItems: 'max_items',
    });
    expect(CORE_VALIDATE_ISSUE_MESSAGES).toEqual({
      required: 'Required value is missing.',
      type: 'Value has an unexpected type.',
      enum: 'Value is not an allowed enum member.',
      minimum: 'Number is below the minimum.',
      maximum: 'Number is above the maximum.',
      minLength: 'String is shorter than the minimum length.',
      maxLength: 'String is longer than the maximum length.',
      minItems: 'Array has fewer than the minimum items.',
      maxItems: 'Array has more than the maximum items.',
    });
    expect(CORE_VALIDATE_ISSUE_CODE_VALUES).toEqual(
      fixedIssueMetadata.map(({ code }) => code),
    );
    expect(Object.isFrozen(CORE_VALIDATE_ISSUE_CODES)).toBe(true);
    expect(Object.isFrozen(CORE_VALIDATE_ISSUE_CODE_VALUES)).toBe(true);
    expect(Object.isFrozen(CORE_VALIDATE_ISSUE_MESSAGES)).toBe(true);
    for (const [index, expected] of fixedIssueMetadata.entries()) {
      expect(
        CORE_VALIDATE_ISSUE_SCHEMA.safeParse({
          ruleId: 'value',
          path: '$.value',
          ...expected,
        }).success,
      ).toBe(true);
      const wrong = fixedIssueMetadata[(index + 1) % fixedIssueMetadata.length];
      if (wrong === undefined)
        throw new Error('Missing Validate issue metadata');
      const rejected = CORE_VALIDATE_ISSUE_SCHEMA.safeParse({
        ruleId: 'value',
        path: '$.value',
        code: expected.code,
        message: wrong.message,
      });
      expect(rejected.success).toBe(false);
      if (rejected.success) throw new Error('Wrong Validate message accepted');
      expect(rejected.error.issues).toContainEqual({
        code: 'custom',
        path: ['message'],
        message: 'Validate issue message does not match its code',
      });
    }
  });
});
