import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { measureBoundedJson } from '../../../src/values/json/bounded-json-size.js';

const bounds = { bytes: 1_000, depth: 4, members: 10 };
const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

describe('bounded JSON size', () => {
  it('counts the bytes of compact JSON text, the container depth and the members', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const measured = measureBoundedJson(value);
        expect(measured).toMatchObject({
          ok: true,
          bytes: utf8(JSON.stringify(value)),
        });
      }),
    );
    expect(measureBoundedJson({ a: [1, { b: null }] })).toEqual({
      ok: true,
      bytes: utf8('{"a":[1,{"b":null}]}'),
      depth: 3,
      members: 4,
    });
    expect(measureBoundedJson('scalar')).toMatchObject({
      depth: 0,
      members: 0,
    });
  });

  it.each([
    ['bytes', 'x'.repeat(1_000)],
    ['depth', { a: { b: { c: { d: { e: 1 } } } } }],
    [
      'members',
      Object.fromEntries(
        Array.from({ length: 11 }, (_, i) => [`k${String(i)}`, i]),
      ),
    ],
    ['not_json', { a: undefined }],
    ['not_json', Number.NaN],
    ['not_plain', new Date(0)],
    // A trailing hole leaves fewer keys than items; a middle one breaks the key order.
    // eslint-disable-next-line no-sparse-arrays -- the value under test
    ['sparse_array', [1, ,]],
    // eslint-disable-next-line no-sparse-arrays -- the value under test
    ['array_extra_keys', [1, , 3]],
  ] as const)('refuses %s', (refusal, value) => {
    expect(measureBoundedJson(value, bounds)).toEqual({ ok: false, refusal });
  });

  it('refuses a cycle and an array with extra keys', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(measureBoundedJson(cyclic, bounds)).toEqual({
      ok: false,
      refusal: 'cycle',
    });
    const extra = Object.assign([1], { name: 'x' });
    expect(measureBoundedJson(extra, bounds)).toEqual({
      ok: false,
      refusal: 'array_extra_keys',
    });
  });

  it('bounds an array by its own item limit, or by the member limit without one', () => {
    const items = Array.from({ length: 6 }, () => 0);
    expect(measureBoundedJson(items, { ...bounds, arrayItems: 5 })).toEqual({
      ok: false,
      refusal: 'array_items',
    });
    expect(measureBoundedJson(items, { ...bounds, members: 5 })).toEqual({
      ok: false,
      refusal: 'array_items',
    });
    expect(measureBoundedJson(items, bounds)).toMatchObject({ ok: true });
  });
});
