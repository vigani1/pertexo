import { describe, expect, it } from 'vitest';
import {
  callableObjectTypeDescriptorSchemaV1,
  callableTypeDescriptorSchemaV1,
  callableTypeJsonSchemaV1,
} from '../src/callable-type-contract.js';

const scalar = (): { type: 'string' } => ({ type: 'string' });
const object = (
  properties: Record<string, unknown> = {},
  required: unknown = [],
) => ({ type: 'object', properties, required });
const nested = (depth: number): unknown =>
  depth === 1
    ? scalar()
    : { type: 'array', maxItems: 1, items: nested(depth - 1) };

describe('callable portable type descriptors V1', () => {
  it.each(['string', 'number', 'integer', 'boolean', 'null'])(
    'admits %s',
    (type) => {
      expect(callableTypeDescriptorSchemaV1.parse({ type })).toEqual({ type });
    },
  );
  it('admits a closed object root and freezes an independent snapshot', () => {
    const input = object({ value: scalar() }, ['value']);
    const parsed = callableObjectTypeDescriptorSchemaV1.parse(input);
    input.properties.value = { type: 'boolean' };
    expect(parsed.properties.value).toEqual(scalar());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.properties)).toBe(true);
    expect(Object.isFrozen(parsed.required)).toBe(true);
    expect(
      callableObjectTypeDescriptorSchemaV1.safeParse(scalar()).success,
    ).toBe(false);
  });
  it('projects the same closed descriptor to documentation JSON schema', () => {
    const parsed = callableObjectTypeDescriptorSchemaV1.parse(
      object(
        { list: { type: 'array', items: { type: 'integer' }, maxItems: 2 } },
        ['list'],
      ),
    );
    expect(callableTypeJsonSchemaV1(parsed)).toEqual({
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'integer' }, maxItems: 2 },
      },
      required: ['list'],
      additionalProperties: false,
    });
  });
  it.each([
    { type: 'string', default: 'secret' },
    { type: 'array', items: scalar(), maxItems: 0 },
    { type: 'array', items: scalar(), maxItems: 1_001 },
    { type: 'array', items: scalar(), maxItems: 1.5 },
    { type: 'union' },
    object({ value: scalar() }, ['value', 'value']),
    object({}, ['missing']),
    object({ 'bad.name': scalar() }),
    object({ ['__proto__']: scalar() }),
    object({ prototype: scalar() }),
    object({ constructor: scalar() }),
    object({ ['x'.repeat(65)]: scalar() }),
  ])('rejects malformed or unsupported descriptors %#', (input) => {
    expect(callableTypeDescriptorSchemaV1.safeParse(input).success).toBe(false);
  });
  it('enforces exact depth and per-object property bounds', () => {
    expect(callableTypeDescriptorSchemaV1.safeParse(nested(8)).success).toBe(
      true,
    );
    expect(callableTypeDescriptorSchemaV1.safeParse(nested(9)).success).toBe(
      false,
    );
    const properties = Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [
        `p${String(index)}`,
        scalar(),
      ]),
    );
    expect(
      callableTypeDescriptorSchemaV1.safeParse(object(properties)).success,
    ).toBe(true);
    properties.extra = scalar();
    expect(
      callableTypeDescriptorSchemaV1.safeParse(object(properties)).success,
    ).toBe(false);
  });
  it('rejects extremely deep input without traversing beyond the descriptor bound', () => {
    let descriptor: unknown = scalar();
    for (let index = 0; index < 20_000; index += 1)
      descriptor = { type: 'array', maxItems: 1, items: descriptor };
    expect(callableTypeDescriptorSchemaV1.safeParse(descriptor).success).toBe(
      false,
    );
  });
  it('admits array bounds and never reads proxy accessors for required arrays', () => {
    expect(
      callableTypeDescriptorSchemaV1.safeParse({
        type: 'array',
        maxItems: 1_000,
        items: scalar(),
      }).success,
    ).toBe(true);
    let reads = 0;
    const required = new Proxy([], {
      get() {
        reads += 1;
        throw new Error('secret');
      },
    });
    expect(
      callableTypeDescriptorSchemaV1.safeParse(object({}, required)).success,
    ).toBe(true);
    expect(reads).toBe(0);
  });
  it('counts all descriptors rather than unique descriptor identities', () => {
    const properties: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 127 }, (_, index) => [
        `p${String(index)}`,
        { type: 'array', maxItems: 1, items: scalar() },
      ]),
    );
    properties.last = scalar();
    expect(
      callableTypeDescriptorSchemaV1.safeParse(object(properties)).success,
    ).toBe(true); // 256
    properties.last = { type: 'array', maxItems: 1, items: scalar() };
    expect(
      callableTypeDescriptorSchemaV1.safeParse(object(properties)).success,
    ).toBe(false); // 257
  });
  it('rejects cycles, getters, symbols, hidden properties and throwing reflection safely', () => {
    let reads = 0;
    const getter = Object.defineProperty({}, 'type', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('secret');
      },
    });
    const cycle: Record<string, unknown> = { type: 'array', maxItems: 1 };
    cycle.items = cycle;
    const hidden = Object.defineProperty(scalar(), 'hidden', {
      value: 'secret',
    });
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('secret');
        },
      },
    );
    for (const input of [
      getter,
      cycle,
      hidden,
      hostile,
      { type: 'string', [Symbol('secret')]: 1 },
      Object.create({ type: 'string' }),
      object({}, new Array(1)),
    ]) {
      const parsed = callableTypeDescriptorSchemaV1.safeParse(input);
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.message).not.toContain('secret');
    }
    expect(reads).toBe(0);
  });
});
