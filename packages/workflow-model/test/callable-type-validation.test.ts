import { describe, expect, it } from 'vitest';
import { validateCallableValueV1 } from '../src/callable-type-validation.js';

const object = (
  properties: Record<string, unknown> = {},
  required: readonly string[] = [],
) => ({ type: 'object', properties, required });
describe('callable value validation V1', () => {
  it.each([
    ['string', 'text'],
    ['number', 1.5],
    ['integer', 1],
    ['boolean', false],
    ['null', null],
  ])('validates %s without coercion', (type, value) => {
    expect(validateCallableValueV1({ type }, value)).toEqual({ ok: true });
    expect(
      validateCallableValueV1({ type }, type === 'null' ? 'null' : null).ok,
    ).toBe(false);
  });
  it('enforces finite numeric values and integers', () => {
    expect(validateCallableValueV1({ type: 'integer' }, 1.5)).toEqual({
      ok: false,
      issue: { code: 'type_mismatch', path: '$' },
    });
    for (const value of [NaN, Infinity, -Infinity])
      expect(validateCallableValueV1({ type: 'number' }, value)).toEqual({
        ok: false,
        issue: { code: 'invalid_json', path: '$' },
      });
  });
  it('enforces required and closed properties without value/key leakage', () => {
    const descriptor = object({ value: { type: 'string' } }, ['value']);
    expect(validateCallableValueV1(descriptor, {})).toEqual({
      ok: false,
      issue: { code: 'required_property', path: '$.value' },
    });
    expect(
      validateCallableValueV1(descriptor, {
        value: 'valid',
        secret_input_key: 'secret_input_value',
      }),
    ).toEqual({ ok: false, issue: { code: 'undeclared_property', path: '$' } });
    expect(validateCallableValueV1(descriptor, { value: 3 })).toEqual({
      ok: false,
      issue: { code: 'type_mismatch', path: '$.value' },
    });
    expect(validateCallableValueV1(object(), Object.create(null))).toEqual({
      ok: true,
    });
  });
  it('enforces array bounds and safe nested issue paths', () => {
    const descriptor = {
      type: 'array',
      items: object({ enabled: { type: 'boolean' } }, ['enabled']),
      maxItems: 2,
    };
    expect(
      validateCallableValueV1(descriptor, [
        { enabled: true },
        { enabled: false },
      ]),
    ).toEqual({ ok: true });
    expect(
      validateCallableValueV1(descriptor, [{ enabled: 'secret' }]),
    ).toEqual({
      ok: false,
      issue: { code: 'type_mismatch', path: '$[0].enabled' },
    });
    expect(validateCallableValueV1(descriptor, [{}, {}, {}])).toEqual({
      ok: false,
      issue: { code: 'array_limit', path: '$' },
    });
  });
  it('preserves independent node value byte and total member limits', () => {
    expect(
      validateCallableValueV1({ type: 'string' }, 'a'.repeat(1_048_574)),
    ).toEqual({ ok: true });
    expect(
      validateCallableValueV1({ type: 'string' }, 'a'.repeat(1_048_575)),
    ).toEqual({ ok: false, issue: { code: 'json_limit', path: '$' } });
    const descriptor = {
      type: 'array',
      maxItems: 1_000,
      items: { type: 'array', maxItems: 1_000, items: { type: 'integer' } },
    };
    expect(
      validateCallableValueV1(
        descriptor,
        Array.from({ length: 10 }, () => Array.from({ length: 999 }, () => 1)),
      ),
    ).toEqual({ ok: true });
    expect(
      validateCallableValueV1(
        descriptor,
        Array.from({ length: 10 }, () =>
          Array.from({ length: 1_000 }, () => 1),
        ),
      ).ok,
    ).toBe(false);
  });
  it('never invokes getters and safely rejects hostile reflection and non-JSON containers', () => {
    let reads = 0;
    const getter = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        reads += 1;
        return 'secret';
      },
    });
    const descriptor = object({ value: { type: 'string' } });
    const hidden = Object.defineProperty({}, 'value', { value: 'secret' });
    for (const value of [
      getter,
      hidden,
      new Date(),
      { [Symbol('secret')]: 'secret' },
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('secret');
          },
        },
      ),
    ]) {
      expect(validateCallableValueV1(descriptor, value).ok).toBe(false);
    }
    expect(reads).toBe(0);
    expect(
      validateCallableValueV1(
        { type: 'array', maxItems: 1, items: { type: 'null' } },
        new Array(1),
      ).ok,
    ).toBe(false);
  });
  it('rejects repeated references, cycles, enormous sparse arrays and invalid schemas', () => {
    const descriptor = { type: 'array', maxItems: 2, items: object() };
    const shared = {};
    expect(validateCallableValueV1(descriptor, [shared, shared]).ok).toBe(
      false,
    );
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(validateCallableValueV1(descriptor, cycle).ok).toBe(false);
    expect(
      validateCallableValueV1(descriptor, new Array(1_000_000_000)).ok,
    ).toBe(false);
    expect(validateCallableValueV1({ type: 'ref', ref: 'secret' }, {})).toEqual(
      { ok: false, issue: { code: 'invalid_descriptor', path: '$' } },
    );
  });
});
