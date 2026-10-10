import { describe, expect, it } from 'vitest';

import {
  callableTypeIssues,
  callableTypeStructuralSchema,
  validateCallableValue,
  type CallableType,
  type JsonValue,
} from '../../src/index.js';

describe('callable type declarations', () => {
  const order: CallableType = {
    type: 'object',
    properties: [
      { name: 'id', valueType: { type: 'string' }, required: true },
      {
        name: 'lines',
        valueType: {
          type: 'array',
          maxItems: 2,
          items: {
            type: 'object',
            properties: [
              {
                name: 'quantity',
                valueType: { type: 'number' },
                required: true,
              },
            ],
          },
        },
        required: true,
      },
      { name: 'note', valueType: { type: 'string' }, required: false },
    ],
  };

  it('roundtrips the small contract without inserting defaults', () => {
    expect(
      callableTypeStructuralSchema.parse(JSON.parse(JSON.stringify(order))),
    ).toEqual(order);
    expect(callableTypeIssues(order)).toEqual([]);
    const input = Object.freeze({ id: 'one', lines: [] });
    expect(validateCallableValue(order, input)).toBeUndefined();
    expect(input).toEqual({ id: 'one', lines: [] });
  });

  it.each([
    { type: 'array', items: { type: 'string' } },
    { type: 'array', items: { type: 'string' }, maxItems: 10_001 },
    { type: 'array', items: { type: 'string' }, maxItems: -1 },
    { type: 'array', items: { type: 'string' }, maxItems: 1.5 },
    { type: 'string', default: 'value' },
    { type: 'object', properties: {}, additionalProperties: true },
    {
      type: 'object',
      properties: [{ name: 'id', valueType: { type: 'string' } }],
    },
    { $ref: 'https://example.com/contract' },
    { type: 'integer' },
  ])('rejects unsupported or unbounded declarations: %j', (input) => {
    expect(callableTypeStructuralSchema.safeParse(input).success).toBe(false);
  });

  it('rejects duplicate property names and impossible value depths', () => {
    expect(
      callableTypeIssues({
        type: 'object',
        properties: [
          { name: 'id', valueType: { type: 'string' }, required: true },
          { name: 'id', valueType: { type: 'number' }, required: false },
        ],
      }),
    ).toEqual([{ path: '$.properties[1].name', code: 'duplicate_property' }]);
    let type: CallableType = { type: 'null' };
    for (let depth = 1; depth < 64; depth += 1)
      type = { type: 'array', items: type, maxItems: 1 };
    expect(callableTypeIssues(type)).toEqual([]);
    expect(
      callableTypeIssues({ type: 'array', items: type, maxItems: 1 }),
    ).toEqual([{ path: `$${'.items'.repeat(64)}`, code: 'type_depth' }]);
  });

  it.each<{ value: JsonValue; code: string; path: (string | number)[] }>([
    { value: { lines: [] }, code: 'missing_property', path: ['id'] },
    { value: { id: 1, lines: [] }, code: 'type_mismatch', path: ['id'] },
    {
      value: { id: 'one', lines: [], extra: true },
      code: 'unknown_property',
      path: ['extra'],
    },
    {
      value: { id: 'one', lines: [{ quantity: '2' }] },
      code: 'type_mismatch',
      path: ['lines', 0, 'quantity'],
    },
    {
      value: { id: 'one', lines: [{ quantity: 1, extra: null }] },
      code: 'unknown_property',
      path: ['lines', 0, 'extra'],
    },
    {
      value: {
        id: 'one',
        lines: [{ quantity: 1 }, { quantity: 2 }, { quantity: 3 }],
      },
      code: 'array_limit',
      path: ['lines'],
    },
    {
      value: { id: 'one', lines: [], note: null },
      code: 'type_mismatch',
      path: ['note'],
    },
  ])(
    'checks nested values with a safe reason: $code at $path',
    ({ value, code, path }) => {
      expect(validateCallableValue(order, value)).toEqual({ code, path });
    },
  );

  it.each([
    { type: 'null', valid: null, invalid: false },
    { type: 'boolean', valid: true, invalid: 'true' },
    { type: 'number', valid: 2.5, invalid: '2.5' },
    { type: 'string', valid: '', invalid: 0 },
  ] as const)(
    'checks the $type scalar without coercion',
    ({ type, valid, invalid }) => {
      expect(validateCallableValue({ type }, valid)).toBeUndefined();
      expect(validateCallableValue({ type }, invalid)).toEqual({
        path: [],
        code: 'type_mismatch',
      });
    },
  );

  it('treats prototype-like names as ordinary own JSON properties', () => {
    const type: CallableType = {
      type: 'object',
      properties: [
        { name: '__proto__', valueType: { type: 'string' }, required: true },
        { name: 'constructor', valueType: { type: 'number' }, required: false },
      ],
    };
    expect(callableTypeStructuralSchema.parse(type)).toEqual(type);
    expect(validateCallableValue(type, {})).toEqual({
      path: ['__proto__'],
      code: 'missing_property',
    });
    expect(
      validateCallableValue(
        type,
        JSON.parse('{"__proto__":"value","constructor":1}') as JsonValue,
      ),
    ).toBeUndefined();
  });

  it('checks a maximum-depth value and bounded empty arrays', () => {
    let type: CallableType = { type: 'boolean' };
    let value: JsonValue = true;
    for (let depth = 1; depth < 64; depth += 1) {
      type = { type: 'array', items: type, maxItems: 1 };
      value = [value];
    }
    expect(validateCallableValue(type, value)).toBeUndefined();
    const empty: CallableType = {
      type: 'array',
      items: { type: 'null' },
      maxItems: 0,
    };
    expect(validateCallableValue(empty, [])).toBeUndefined();
    expect(validateCallableValue(empty, [null])).toEqual({
      path: [],
      code: 'array_limit',
    });
  });
});
